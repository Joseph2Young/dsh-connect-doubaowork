/**
 * 本地回环 OpenAI 兼容网关。
 *
 *   POST /v1/chat/completions  OpenAI 请求 → 豆包工作模式 → OpenAI SSE
 *   GET  /v1/models            静态目录
 *   GET  /healthz              存活探针（免鉴权）
 *
 * 仅监听 127.0.0.1 随机端口；bearer token 进程内随机生成，凭据不落盘、不外发
 * （除发给豆包上游）。
 *
 * 双后端：
 *   - http（默认）：直接打豆包工作模式 HTTP 端点，靠 sessionid Cookie；
 *   - cli：拉起 `doubao -p … --output-format stream-json` 子进程，靠 CLI 自有登录态。
 *   由 defaults.backend（auto/cli/http）与 cliAvailable() 决定实际走哪条。
 */
import http from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { extractText, shortHash } from './doubao-protocol.js'

const CHAT_PATH = '/v1/chat/completions'
const MODELS_PATH = '/v1/models'
const HEALTH_PATH = '/healthz'
const MAX_BODY_BYTES = 32 * 1024 * 1024
const MAX_CONVERSATIONS = 512
/** single 会话模式下的固定键：所有请求复用同一条豆包会话。 */
const SINGLE_CONVERSATION_KEY = 'dsh-single'

function randomToken() {
  return randomBytes(24).toString('base64url')
}

/** 把 OpenAI 消息数组压平成一段文本（CLI 单提示词入参用）。 */
function flattenMessages(messages, includeLast = true) {
  const lines = []
  const limit = includeLast ? messages.length : messages.length - 1
  for (let i = 0; i < limit; i++) {
    const message = messages[i]
    const text = extractText(message?.content).trim()
    if (text === '') continue
    const role = String(message?.role ?? 'unknown')
    const label = role === 'user' ? '用户' : role === 'assistant' ? '助手' : role === 'system' ? '系统' : role
    lines.push(`${label}：${text}`)
  }
  return lines.join('\n')
}

/** 最后一条 user 消息的纯文本（CLI 续会话时的增量提示词）。 */
function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (String(messages[i]?.role ?? '') !== 'user') continue
    return extractText(messages[i]?.content).trim()
  }
  return ''
}


/**
 * @param {object} options
 * @param {() => Array<{id:string}>} options.catalog 运行时目录
 * @param {(id: string) => object|undefined} options.resolveModel id/别名 → 目录条目
 * @param {() => Array<object>} options.accounts 账号池提供者（loadAccountList 产物）
 * @param {(input: object) => object} options.buildBody 请求体构造（注入 doubao-protocol.buildRequestBody）
 * @param {(stream: object, sink: object) => Promise<void>} options.pump SSE 泵（注入 pumpSse）
 * @param {typeof fetch} [options.fetchImpl] 测试可注入
 * @param {object} options.defaults 运行参数（normalizeConfig + DOUBAO_DEFAULTS 合并结果）
 * @param {(level: string, message: string, error?: unknown) => void} [options.log]
 * @param {object} [options.cli] CLI 后端 { available(): boolean, run(task): Promise<object>, client? }
 *   available() 返回 true 且 backend 允许时，聊天请求走 CLI 子进程而非 HTTP。
 */
export function createDoubaoShim(options) {
  const {
    catalog,
    resolveModel,
    accounts,
    buildBody,
    pump,
    fetchImpl = fetch,
    defaults,
    log = () => {},
    cli = null,
  } = options

  const token = randomToken()
  let server = null
  let port = 0
  let closed = false
  let conversations = new Map()
  // 账号池粘性轮换锚点：上次成功请求的账号 id（'', 初始未定）
  const state = { lastGoodId: '' }

  const ready = new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      handle(req, res).catch(error => fail(res, 500, `内部错误: ${error?.message ?? error}`))
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port
      resolve()
    })
  })

  async function start() {
    await ready
  }

  async function close() {
    closed = true
    conversations = new Map()
    if (server === null) return
    const closing = server
    server = null
    await new Promise(resolve => closing.close(() => resolve()))
  }

  function baseUrl() {
    return `http://127.0.0.1:${port}/v1`
  }

  function tokenOf() {
    return token
  }

  function toModelEntry(entry) {
    return { id: entry.id, object: 'model', created: 0, owned_by: 'doubao-workmode' }
  }

  /** 当前生效的后端：'cli' 或 'http'。auto 下 CLI 可用就优先 CLI。 */
  function activeBackend() {
    const wanted = defaults.backend ?? 'auto'
    if (wanted === 'http') return 'http'
    const usable = cli !== null && typeof cli.available === 'function' && cli.available() === true
    if (wanted === 'cli') return 'cli'
    return usable ? 'cli' : 'http'
  }

  async function handle(req, res) {
    if (closed) {
      fail(res, 503, 'shim 已关闭')
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const pathname = url.pathname
    if (pathname === HEALTH_PATH) {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('ok')
      return
    }
    if (pathname !== MODELS_PATH && pathname !== CHAT_PATH) {
      fail(res, 404, 'not found')
      return
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      fail(res, 401, 'missing or invalid bearer token')
      return
    }
    if (pathname === MODELS_PATH) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: catalog().map(toModelEntry) }))
      return
    }
    if (req.method !== 'POST') {
      fail(res, 405, 'method not allowed')
      return
    }
    await handleChat(req, res, await readBody(req))
  }

  async function readBody(req) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
      chunks.push(chunk)
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  /**
   * 会话键：显式 metadata 优先；否则按「模型 + 首条 user 消息文本」哈希。
   * 不用 messages[0]（对照 handler.go 的做法已弃用）：pi-ai 对不支持会话中
   * system 的模型会在第二轮起改写首条消息（system 被移除/转移），导致键漂移、
   * 每个 agent 轮次都新建一条豆包会话。首条 user 消息文本在所有轮次都会被
   * pi-ai 原样保留，是唯一跨轮稳定的历史锚点。
   */
  function conversationKey(payload, messages) {
    const meta = payload?.metadata ?? {}
    const explicit = meta.conversation_id ?? meta.conversationId ?? meta.session_id
    if (typeof explicit === 'string' && explicit !== '') return explicit
    let firstUser = ''
    for (const message of messages) {
      if (String(message?.role ?? '') !== 'user') continue
      firstUser = extractText(message?.content).trim()
      break
    }
    return shortHash(`${payload?.model ?? ''}\u0000${firstUser}`)
  }

  function rememberConversation(convKey, conversationId, accountId) {
    if (conversationId === '') return
    conversations.set(convKey, { conversationId, accountId })
    while (conversations.size > MAX_CONVERSATIONS) {
      const oldest = conversations.keys().next().value
      conversations.delete(oldest)
    }
  }

  /**
   * 账号池调度顺序：会话已绑定账号 → 绑定账号置首（豆包 conversation_id 是
   * 账号作用域，换账号旧会话作废，必须粘住）；新会话 → 上次成功账号之后开始
   * 轮转（粘性轮换，避免每次都从第一个账号起步把负载压在同一个账号上）。
   */
  function orderedAccounts(convKey) {
    const all = Array.isArray(accounts?.()) ? accounts().filter(a => a?.enabled !== false && typeof a?.cookie === 'string' && a.cookie !== '') : []
    if (all.length <= 1) return all
    const boundId = conversations.get(convKey)?.accountId
    const startId = boundId ?? state.lastGoodId
    const head = startId === '' ? [] : all.filter(a => a.id === startId)
    const rest = all.filter(a => a.id !== startId)
    return [...head, ...rest]
  }

  function upstreamHeaders(credential) {
    return {
      'Content-Type': 'application/json',
      Accept: '*/*',
      'agw-js-conv': 'str, str',
      'last-event-id': 'undefined',
      // 固定 trace 形状即可通过网关；无需 a_bogus 签名
      'x-flow-trace': '04-0000000000000000000000000000000-0000000000000000-01',
      'User-Agent': defaults.userAgent,
      Referer: 'https://www.doubao.com/',
      Cookie: credential.cookie,
    }
  }

  function buildUpstreamUrl(credential) {
    const url = new URL(defaults.chatUrl)
    const dev = credential.deviceId !== '' ? credential.deviceId : shortHash(credential.cookie)
    for (const [key, value] of Object.entries(defaults.query)) url.searchParams.set(key, value)
    url.searchParams.set('device_id', dev)
    url.searchParams.set('fp', `verify_${dev}`)
    url.searchParams.set('tea_uuid', dev)
    if (credential.webId !== '') url.searchParams.set('web_id', credential.webId)
    url.searchParams.set('web_tab_id', randomUUID())
    return url.toString()
  }

  /**
   * CLI 后端：把一次 OpenAI chat 请求翻译成 `doubao -p … --output-format stream-json`。
   *
   * 与 HTTP 后端的差异（都是有意的）：
   *   - 会话归属由 CLI 的 session_id 承载，不再需要 conversation_id 协调；
   *   - single 模式下复用同一个 CLI session（--resume），保证豆包侧只有一条记录；
   *   - per-chat 模式下每个 convKey 各自绑定一条 CLI session；
   *   - CLI 自带工具执行/文件能力，工具事件只记日志，不冒充 OpenAI delta。
   */
  async function handleCliChat(res, { payload, messages, entry, convKey, previous, isStream }) {
    // 会话归属：single 模式下 convKey 已是固定键，per-chat 模式下每键各一条，
    // 两种情况都从同一个 conversations 表取绑定会话
    const boundSession = previous?.conversationId ?? ''

    // 首轮（无绑定会话）把历史压平，续轮只发最后一条 user 文本（历史已在 CLI 侧）
    const prompt = boundSession === ''
      ? flattenMessages(messages, true) || lastUserText(messages)
      : lastUserText(messages)
    if (prompt === '') {
      fail(res, 400, '没有可发送的用户文本')
      return
    }

    const id = 'chatcmpl-' + shortHash(convKey)
    const created = Math.floor(Date.now() / 1000)
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new Error('CLI 请求超时')),
      Math.max(1, defaults.timeoutSeconds) * 1000,
    )
    let finished = false
    res.on('close', () => {
      if (!finished) controller.abort(new Error('客户端断开'))
    })

    if (isStream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      res.flushHeaders()
    }

    const writeDelta = (delta, finishReason = null) => {
      res.write(`data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model: entry.id,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`)
    }

    let wrote = false
    let finalText = ''
    let lastError = ''

    const heartbeat = isStream && defaults.heartbeatSeconds > 0
      ? setInterval(() => {
        if (!finished) res.write(': ping\n\n')
      }, defaults.heartbeatSeconds * 1000)
      : null

    let outcome
    try {
      outcome = await cli.run({
        prompt,
        // 模型：CLI 用模型 ID 直传；目录里的 id 就是 CLI 的 modelId
        model: entry.id === 'auto' ? '' : entry.id,
        effort: defaults.cliEffort ?? '',
        sessionId: boundSession,
        signal: controller.signal,
        onInit(sessionId) {
          rememberConversation(convKey, sessionId, 'cli')
        },
        onDelta(text) {
          wrote = true
          finalText += text
          if (isStream) writeDelta({ content: text })
        },
        onTool(tools) {
          for (const tool of tools) log('info', `CLI 工具调用：${tool.name}${tool.status === '' ? '' : ` (${tool.status})`}`)
        },
        onStray(text) {
          lastError = text
        },
      })
    } catch (error) {
      outcome = { ok: false, errors: [String(error?.message ?? error)], sessionId: boundSession, text: '' }
    }

    finished = true
    clearTimeout(timer)
    if (heartbeat !== null) clearInterval(heartbeat)

    if (!outcome.ok) {
      const detail = outcome.errors.filter(item => item !== '').join('; ') || lastError || '豆包 CLI 调用失败'
      if (!wrote) {
        if (isStream && res.headersSent) {
          writeDelta({ content: `调用豆包 CLI 失败：${detail}` })
          writeDelta({}, 'stop')
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }
        fail(res, 502, `调用豆包 CLI 失败：${detail}`)
        return
      }
      log('warn', `CLI 任务以失败收尾但有部分输出：${detail}`)
    }

    if (outcome.sessionId !== '' && outcome.sessionId !== boundSession) {
      rememberConversation(convKey, outcome.sessionId, 'cli')
    }
    if (outcome.text !== '' && finalText === '') {
      finalText = outcome.text
      wrote = true
      if (isStream) writeDelta({ content: finalText })
    }

    if (isStream) {
      if (!wrote) writeDelta({ content: '(空响应)' })
      writeDelta({}, 'stop')
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    if (finalText === '') {
      fail(res, 502, '豆包 CLI 没有返回内容')
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      id,
      object: 'chat.completion',
      created,
      model: entry.id,
      choices: [{ index: 0, message: { role: 'assistant', content: finalText }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }))
  }

  async function handleChat(req, res, raw) {
    let payload
    try {
      payload = JSON.parse(raw)
    } catch {
      fail(res, 400, '请求体不是合法 JSON')
      return
    }
    const messages = Array.isArray(payload?.messages) ? payload.messages : []
    if (messages.length === 0) {
      fail(res, 400, 'messages 不能为空')
      return
    }
    const entry = resolveModel(payload?.model, catalog()) ?? resolveModel(defaults.defaultModel, catalog())
    if (entry === undefined) {
      fail(res, 400, `未知模型: ${payload?.model}`)
      return
    }
    // single 模式下所有请求共用固定键 → 豆包侧只保留一条会话记录
    const convKey = defaults.conversationMode === 'single'
      ? SINGLE_CONVERSATION_KEY
      : conversationKey(payload, messages)
    const previous = conversations.get(convKey)
    const isStream = payload?.stream !== false

    // CLI 后端：可用且未被配置排除时，整条请求交给 CLI 子进程
    if (activeBackend() === 'cli') {
      await handleCliChat(res, { payload, messages, entry, convKey, previous, isStream })
      return
    }

    const candidates = orderedAccounts(convKey)
    if (candidates.length === 0) {
      fail(res, 503, '豆包凭据未配置：请创建 ~/.dsh-doubao/credentials.json（完整 cookie + device_id），或在设置页添加账号；或安装豆包 CLI 并执行 doubao login 后改用 CLI 后端')
      return
    }
    // 池故障转移：只在「请求尚未触达成功响应」阶段换账号重试（流头已写则无法回退）
    const pool = defaults.poolEnabled === true && candidates.length > 1

    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new Error('上游请求超时')),
      Math.max(1, defaults.timeoutSeconds) * 1000,
    )
    let finished = false
    res.on('close', () => {
      if (!finished) controller.abort(new Error('客户端断开'))
    })

    // 逐账号尝试：fetch 网络失败 / HTTP 非 2xx 时换下一个（AbortError 除外——
    // 超时或客户端断开时连接已不可用，重试无意义）。成功（response.ok）即锁定
    // 该账号：记 lastGoodId 供后续粘性轮换。
    let response = null
    let credential = null
    let upstreamError = null
    for (const candidate of candidates) {
      // 会话复用仅限同一账号：豆包 conversation_id 是账号作用域的，
      // 换账号必须重新建会话（conversationId 置空 → need_create_conversation=true）
      const conversationId = previous?.accountId === candidate.id ? previous?.conversationId ?? '' : ''
      const body = buildBody({
        messages,
        modelItemKey: entry.modelItemKey,
        options: { conversationId, flatten: defaults.flattenHistory, workMode: defaults.workMode },
        work: {
          botId: defaults.botId,
          modeId: defaults.modeId,
          reasoningEffort: defaults.reasoningEffort,
          memoryProfile: defaults.memoryProfile,
          totalWindowSize: defaults.totalWindowSize,
          enableSandbox: defaults.enableSandbox,
          workspace: defaults.workspace,
          deviceName: 'USER',
          localAppId: candidate.localAppId,
          localDeviceId: candidate.deviceId,
        },
      })
      let attempt
      try {
        attempt = await fetchImpl(buildUpstreamUrl(candidate), {
          method: 'POST',
          headers: upstreamHeaders(candidate),
          body: JSON.stringify(body),
          signal: controller.signal,
        })
      } catch (error) {
        const isAbort = error?.name === 'AbortError'
        if (isAbort || !pool || candidate === candidates[candidates.length - 1]) {
          finished = true
          clearTimeout(timer)
          const reason = isAbort ? (error?.cause?.message ?? '请求中断') : error?.message
          fail(res, 502, `上游请求失败: ${reason}`)
          return
        }
        log('warn', `账号 ${candidate.id} 请求失败，池故障转移尝试下一个: ${error?.message}`)
        continue
      }
      if (!attempt.ok) {
        const detail = (await attempt.text().catch(() => '')).trim().slice(0, 4096)
        if (!pool || candidate === candidates[candidates.length - 1]) {
          finished = true
          clearTimeout(timer)
          fail(res, 502, `上游 HTTP ${attempt.status}${detail === '' ? '' : `: ${detail}`}`)
          return
        }
        log('warn', `账号 ${candidate.id} 上游 HTTP ${attempt.status}，池故障转移尝试下一个`)
        continue
      }
      response = attempt
      credential = candidate
      state.lastGoodId = candidate.id
      break
    }
    if (response === null || credential === null) {
      finished = true
      clearTimeout(timer)
      fail(res, 502, '账号池全部账号请求失败')
      return
    }
    if (finished) return
    if (isStream) {
      // OpenAI 兼容流式响应头；flushHeaders 让 content-type 在首个 delta 前就绪
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      res.flushHeaders()
    }

    const id = 'chatcmpl-' + shortHash(convKey)
    const created = Math.floor(Date.now() / 1000)
    let wrote = false
    let clarified = false
    let finalText = ''
    const writeDelta = (delta, finishReason = null) => {
      res.write(`data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model: entry.id,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`)
    }
    const sink = {
      onText(text) {
        wrote = true
        finalText += text
        if (isStream) writeDelta({ content: text })
      },
      onReasoning(text) {
        if (isStream) writeDelta({ reasoning_content: text })
      },
      onConversation(conversation, section) {
        rememberConversation(convKey, conversation || '', credential.id)
      },
      onClarify(titles) {
        // 豆包工作模式反问：把问题文本转成正文流给调用方，然后主动断开上游。
        // 服务端发出反问后会长连等用户在豆包端回答（可达数十分钟），DSH 侧的
        // 回答走下一轮请求（复用同一 conversation_id），所以这里必须提前收尾，
        // 否则调用方会挂到 timeoutSeconds 超时且看不到问题。
        if (clarified) return
        clarified = true
        const formatted = titles.map(title => `❓ ${title}`).join('\n\n')
        wrote = true
        finalText += (finalText === '' ? '' : '\n\n') + formatted
        if (isStream) writeDelta({ content: `${finalText === formatted ? '' : '\n\n'}${formatted}` })
        controller.abort(new Error('豆包进入等待回答状态，已提前收尾'))
      },
      onFinish(endType, brief) {
        if (endType !== 1 && !wrote && brief !== '') {
          wrote = true
          finalText += brief
          if (isStream) writeDelta({ content: brief })
        }
      },
    }

    const heartbeat = isStream && defaults.heartbeatSeconds > 0
      ? setInterval(() => {
        if (!finished) res.write(': ping\n\n')
      }, defaults.heartbeatSeconds * 1000)
      : null

    let pumpError
    try {
      await pump(response.body, sink)
    } catch (error) {
      pumpError = error
    }
    finished = true
    clearTimeout(timer)
    if (heartbeat !== null) clearInterval(heartbeat)

    if (isStream) {
      if (!wrote) writeDelta({ content: '(空响应)' })
      // pi-ai 的 openai-completions 消费端要求 finish_reason，否则抛
      // "Stream ended without finish_reason"
      writeDelta({}, 'stop')
      res.write('data: [DONE]\n\n')
      res.end()
    } else {
      if (finalText === '') {
        fail(res, 502, pumpError !== undefined ? `上游流读取失败: ${pumpError.message}` : '上游没有返回内容')
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        id,
        object: 'chat.completion',
        created,
        model: entry.id,
        choices: [{ index: 0, message: { role: 'assistant', content: finalText }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }))
    }
    if (pumpError !== undefined) log('warn', `pump_error: ${pumpError?.message ?? pumpError}`)
  }

  return { start, ready, close, baseUrl, token: tokenOf, port: () => port }
}

function fail(res, status, message) {
  if (res.writableEnded || res.destroyed) return
  if (res.headersSent) {
    // 头已发出（流已开始）：只能截断连接，无法再改状态码
    res.end()
    return
  }
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({
    error: {
      message,
      type: status === 401 ? 'authentication_error' : 'api_error',
      code: status,
    },
  }))
}

