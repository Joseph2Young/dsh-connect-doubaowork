/**
 * 本地回环 OpenAI 兼容网关。
 *
 *   POST /v1/chat/completions  OpenAI 请求 → 豆包工作模式 → OpenAI SSE
 *   GET  /v1/models            静态目录
 *   GET  /healthz              存活探针（免鉴权）
 *
 * 仅监听 127.0.0.1 随机端口；bearer token 进程内随机生成，凭据不落盘、不外发
 * （除发给豆包上游）。
 */
import http from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { shortHash } from './doubao-protocol.js'

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

/**
 * @param {object} options
 * @param {() => Array<{id:string}>} options.catalog 运行时目录
 * @param {(id: string) => object|undefined} options.resolveModel id/别名 → 目录条目
 * @param {() => object|undefined} options.credentials 凭据提供者
 * @param {(input: object) => object} options.buildBody 请求体构造（注入 doubao-protocol.buildRequestBody）
 * @param {(stream: object, sink: object) => Promise<void>} options.pump SSE 泵（注入 pumpSse）
 * @param {typeof fetch} [options.fetchImpl] 测试可注入
 * @param {object} options.defaults 运行参数（normalizeConfig + DOUBAO_DEFAULTS 合并结果）
 * @param {(level: string, message: string, error?: unknown) => void} [options.log]
 */
export function createDoubaoShim(options) {
  const {
    catalog,
    resolveModel,
    credentials,
    buildBody,
    pump,
    fetchImpl = fetch,
    defaults,
    log = () => {},
  } = options

  const token = randomToken()
  let server = null
  let port = 0
  let closed = false
  let conversations = new Map()

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

  /** 会话键：显式 metadata 优先，否则按「模型 + 首条消息」哈希（对照 handler.go）。 */
  function conversationKey(payload, messages) {
    const meta = payload?.metadata ?? {}
    const explicit = meta.conversation_id ?? meta.conversationId ?? meta.session_id
    if (typeof explicit === 'string' && explicit !== '') return explicit
    const first = messages.length > 0 ? JSON.stringify(messages[0]) : ''
    return shortHash(`${payload?.model ?? ''}\u0000${first}`)
  }

  function rememberConversation(convKey, conversationId) {
    if (conversationId === '') return
    conversations.set(convKey, { conversationId })
    while (conversations.size > MAX_CONVERSATIONS) {
      const oldest = conversations.keys().next().value
      conversations.delete(oldest)
    }
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
    const entry = resolveModel(payload?.model) ?? resolveModel(defaults.defaultModel)
    if (entry === undefined) {
      fail(res, 400, `未知模型: ${payload?.model}`)
      return
    }
    const credential = credentials()
    if (credential === undefined) {
      fail(res, 503, '豆包凭据未配置：请创建 ~/.dsh-doubao/credentials.json（完整 cookie + device_id）')
      return
    }

    // single 模式下所有请求共用固定键 → 豆包侧只保留一条会话记录
    const convKey = defaults.conversationMode === 'single'
      ? SINGLE_CONVERSATION_KEY
      : conversationKey(payload, messages)
    const previous = conversations.get(convKey)
    const conversationId = previous?.conversationId ?? ''

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
        localAppId: credential.localAppId,
        localDeviceId: credential.deviceId,
      },
    })

    const isStream = payload?.stream !== false
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new Error('上游请求超时')),
      Math.max(1, defaults.timeoutSeconds) * 1000,
    )
    let finished = false
    res.on('close', () => {
      if (!finished) controller.abort(new Error('客户端断开'))
    })

    let response
    try {
      response = await fetchImpl(buildUpstreamUrl(credential), {
        method: 'POST',
        headers: upstreamHeaders(credential),
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (error) {
      finished = true
      clearTimeout(timer)
      const reason = error?.name === 'AbortError' ? (error?.cause?.message ?? '请求中断') : error?.message
      fail(res, 502, `上游请求失败: ${reason}`)
      return
    }
    if (!response.ok) {
      finished = true
      clearTimeout(timer)
      const detail = (await response.text().catch(() => '')).trim().slice(0, 4096)
      fail(res, 502, `上游 HTTP ${response.status}${detail === '' ? '' : `: ${detail}`}`)
      return
    }
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
        rememberConversation(convKey, conversation || '')
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

