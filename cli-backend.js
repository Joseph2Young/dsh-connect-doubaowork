/**
 * 豆包 CLI 后端：`doubao -p <prompt> --output-format stream-json` 子进程桥。
 *
 * 为什么需要它：HTTP 抓包路线依赖 sessionid Cookie（约 30 天过期、受风控），
 * 而官方 CLI 走自有 passport 登录态，能长期稳定地拿到豆包聚合模型，并且自带
 * 工具执行与本地文件能力。两条路线在本插件里并存，由 backend 配置切换。
 *
 * 本模块只做三件事：
 *   1. 定位可执行的 `doubao`（npm 全局 bin → PATH → 配置覆盖）；
 *   2. 拉起子进程、逐行解析 NDJSON 事件（协议见 parseStreamJsonLine）；
 *   3. 串行化调用队列——CLI 是「单账号共享后台」模型，并发拉起多个实例
 *      容易撞实例锁，因此默认一次只跑一个任务。
 *
 * 不 import 宿主包，纯 Node 内置模块，便于单测注入 spawnImpl。
 */
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

/** CLI 数据目录（macOS/Linux/Windows 三端），用于判断是否装过 CLI。 */
export const CLI_DATA_DIRS = Object.freeze({
  darwin: path.join(os.homedir(), 'Library', 'Application Support', 'doubao_cli'),
  linux: path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), 'doubao_cli'),
  win32: path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'doubao_cli'),
})

/** 常见安装位置，按优先级探测。 */
export function cliCandidatePaths(env = process.env) {
  const home = env.HOME ?? os.homedir()
  const candidates = []
  const npmPrefix = env.npm_config_prefix ?? env.NPM_CONFIG_PREFIX ?? path.join(home, '.npm-global')
  candidates.push(path.join(npmPrefix, 'bin', 'doubao'))
  candidates.push(path.join(home, '.local', 'bin', 'doubao'))
  candidates.push('/opt/homebrew/bin/doubao')
  candidates.push('/usr/local/bin/doubao')
  if (process.platform === 'win32') {
    candidates.push(path.join(npmPrefix, 'doubao.cmd'))
  }
  // PATH 里的 doubao（不依赖 which，避免额外进程）
  for (const dir of String(env.PATH ?? '').split(path.delimiter)) {
    if (dir === '') continue
    candidates.push(path.join(dir, process.platform === 'win32' ? 'doubao.cmd' : 'doubao'))
  }
  return [...new Set(candidates)]
}

/**
 * 解析一行 stream-json 输出为归一事件。
 *
 * 协议（对照 resources/js_app/entry-cli-chat/main.js 的 stream-json 分支）：
 *   {"type":"system","subtype":"init","session_id":"<conversationId>"}
 *   {"type":"stream_event",...,"event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}}
 *   {"type":"assistant","session_id":..,"message":{"id":..,"content":[{"type":"text","text":"..."}]}}
 *   {"type":"assistant",...,"message":{"content":[{"type":"tool_use","id","name","input","input_status"}]}}
 *   {"type":"user",...,"message":{"content":[{"type":"tool_result","tool_use_id",...}]}}
 *   {"type":"result","subtype":"success"|"error_during_execution","is_error":bool,"session_id",
 *    "result":{"type":"text","content":"..."} | "errors":[..],"permission_denials":[..]}
 *
 * 非 JSON 行（例如未登录时的 `login_required: ...`）归一为 {kind:'stray'}，
 * 由调用方决定当成错误还是忽略。
 */
export function parseStreamJsonLine(line) {
  const text = String(line ?? '').trim()
  if (text === '') return { kind: 'empty' }
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    return { kind: 'stray', text }
  }
  if (payload === null || typeof payload !== 'object') return { kind: 'stray', text }
  const type = String(payload.type ?? '')
  if (type === 'system') {
    const sessionId = String(payload.session_id ?? '')
    return sessionId === '' ? { kind: 'unknown', type } : { kind: 'init', sessionId, subtype: String(payload.subtype ?? '') }
  }
  if (type === 'stream_event') {
    const event = payload.event ?? {}
    const delta = event.delta ?? {}
    const chunk = delta.type === 'text_delta' ? String(delta.text ?? '') : ''
    if (chunk === '') return { kind: 'unknown', type }
    return { kind: 'delta', messageId: String(payload.message_id ?? ''), text: chunk }
  }
  if (type === 'assistant' || type === 'user') {
    const message = payload.message ?? {}
    const blocks = Array.isArray(message.content) ? message.content : []
    const texts = []
    const tools = []
    for (const block of blocks) {
      const blockType = String(block?.type ?? '')
      if (blockType === 'text') texts.push(String(block.text ?? ''))
      else if (blockType === 'tool_use') tools.push({ name: String(block.name ?? ''), status: String(block.input_status ?? '') })
    }
    return {
      kind: 'message',
      role: type,
      messageId: String(message.id ?? ''),
      text: texts.join(''),
      tools,
    }
  }
  if (type === 'result') {
    const errors = Array.isArray(payload.errors) ? payload.errors.map(item => String(item)) : []
    const result = payload.result
    const finalText = typeof result?.content === 'string'
      ? result.content
      : Array.isArray(result?.content)
        ? result.content.map(part => String(part?.text ?? '')).join('')
        : ''
    const denials = Array.isArray(payload.permission_denials)
      ? payload.permission_denials.map(item => ({ toolName: String(item?.tool_name ?? ''), prompt: String(item?.prompt ?? '') }))
      : []
    return {
      kind: 'result',
      ok: payload.is_error !== true,
      subtype: String(payload.subtype ?? ''),
      sessionId: String(payload.session_id ?? ''),
      text: finalText,
      errors,
      denials,
      logId: String(payload.log_id ?? ''),
    }
  }
  return { kind: 'unknown', type }
}

/** `model list --json` 的 result 归一为插件目录条目。 */
export function parseModelListResult(payload) {
  const models = Array.isArray(payload?.result?.models) ? payload.result.models : []
  const out = []
  for (const item of models) {
    const id = String(item?.id ?? '').trim()
    if (id === '') continue
    const efforts = Array.isArray(item?.efforts) ? item.efforts.map(String) : []
    out.push({
      id,
      name: String(item?.name ?? id).trim() || id,
      isDefault: item?.is_default === true,
      efforts,
      defaultEffort: item?.default_effort === undefined || item.default_effort === null ? '' : String(item.default_effort),
    })
  }
  return out
}

/**
 * 串行调用闸门：保证同一时刻最多 concurrency 个 CLI 任务。
 * CLI 是单账号共享后台，并发拉起容易撞实例锁；默认 1。
 */
export function createTaskQueue(concurrency = 1) {
  const limit = Number.isFinite(concurrency) && concurrency >= 1 ? Math.floor(concurrency) : 1
  let running = 0
  const waiting = []
  const start = (task, resolve, reject) => {
    running += 1
    Promise.resolve()
      .then(task)
      .then(resolve, reject)
      .finally(() => {
        running -= 1
        const next = waiting.shift()
        if (next !== undefined) start(next.task, next.resolve, next.reject)
      })
  }
  return {
    size: () => waiting.length + running,
    run(task) {
      return new Promise((resolve, reject) => {
        if (running < limit) start(task, resolve, reject)
        else waiting.push({ task, resolve, reject })
      })
    },
  }
}

/**
 * CLI 客户端。
 *
 * @param {object} options
 * @param {string} [options.cliPath] 显式二进制/包装脚本路径（空 = 自动探测）
 * @param {string} [options.workspace] 任务工作目录（-C）；空 = 用户 home
 * @param {string} [options.permissionMode] ask_always|ask_risky|always_allow
 * @param {string[]} [options.extraArgs] 追加的 CLI 参数（测试/高级用途）
 * @param {number} [options.timeoutSeconds] 单次任务超时
 * @param {number} [options.concurrency] 并发上限
 * @param {Function} [options.spawnImpl] 测试注入
 * @param {(level:string, message:string, error?:unknown)=>void} [options.log]
 */
export function createCliClient(options = {}) {
  const {
    extraArgs = [],
    spawnImpl = spawn,
    log = () => {},
  } = options

  // 以下选项支持「函数形态」：插件里传入 ()=>config.cliPath 之类的读取器，
  // 这样 volatile 配置改了立刻生效，不必重挂插件（队列/超时/权限都是现读）。
  const live = (value, fallback) => {
    const resolved = typeof value === 'function' ? value() : value
    return resolved === undefined || resolved === null ? fallback : resolved
  }
  const cliPathOf = () => String(live(options.cliPath, '') ?? '').trim()
  const workspaceOf = () => String(live(options.workspace, '') ?? '').trim()
  const permissionModeOf = () => String(live(options.permissionMode, 'ask_risky') ?? '')
  const timeoutSecondsOf = () => {
    const n = Number(live(options.timeoutSeconds, 300))
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 300
  }
  const concurrencyOf = () => {
    const n = Number(live(options.concurrency, 1))
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1
  }

  /** 队列在并发上限变化时重建：阈值只在取任务时读取，不影响已在跑的任务。 */
  let queue = createTaskQueue(concurrencyOf())
  let queueLimit = concurrencyOf()

  const cwdOf = () => {
    const workspace = workspaceOf()
    return workspace !== '' && path.isAbsolute(workspace) ? workspace : os.homedir()
  }

  /**
   * 跑一次 CLI 任务，事件通过回调流出。
   * @param {object} task { prompt, model?, effort?, sessionId?, signal?, onInit?, onDelta?, onResult?, onStray? }
   * @returns {Promise<{ok:boolean, sessionId:string, text:string, errors:string[], denials:object[]}>}
   */
  function run(task) {
    const limit = concurrencyOf()
    if (limit !== queueLimit) {
      queue = createTaskQueue(limit)
      queueLimit = limit
    }
    return queue.run(() => execute(task))
  }

  function execute(task) {
    // 信号可能在排队期间就已 abort（队列串行时很常见），必须先检查一次，
    // 否则 abort 事件已错过、监听器不会再触发，任务会一直挂着
    if (task.signal?.aborted === true) {
      return Promise.resolve({ ok: false, sessionId: '', text: '', errors: ['调用方已断开'], denials: [] })
    }
    const cliPath = cliPathOf()
    const cwd = cwdOf()
    const permissionMode = permissionModeOf()
    const timeoutSeconds = timeoutSecondsOf()
    const args = []
    if (cwd !== '') args.push('-C', cwd)
    const isResume = typeof task.sessionId === 'string' && task.sessionId !== ''
    if (isResume) args.push('--resume', task.sessionId)
    args.push('-p', task.prompt)
    if (typeof task.model === 'string' && task.model !== '') args.push('--model', task.model)
    if (typeof task.effort === 'string' && task.effort !== '') args.push('--effort', task.effort)
    if (permissionMode !== '') args.push('--permission-mode', permissionMode)
    args.push('--output-format', 'stream-json')
    for (const extra of extraArgs) args.push(extra)

    return new Promise(resolvePromise => {
      let settled = false
      const state = { sessionId: '', text: '', errors: [], denials: [], ok: false }
      const finish = extra => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolvePromise({ ...state, ...extra })
      }

      let child
      try {
        child = spawnImpl(cliPath === '' ? 'doubao' : cliPath, args, {
          cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: process.env,
        })
      } catch (error) {
        finish({ ok: false, errors: [`无法启动豆包 CLI：${error?.message ?? error}`] })
        return
      }

      const timer = setTimeout(() => {
        state.errors.push(`豆包 CLI 超时（${timeoutSeconds}s）`)
        killChild('timeout')
        finish({ ok: false })
      }, Math.max(1, timeoutSeconds) * 1000)

      const abortHandler = () => {
        state.errors.push('调用方已断开')
        killChild('abort')
        finish({ ok: false })
      }
      task.signal?.addEventListener('abort', abortHandler, { once: true })

      function killChild(reason) {
        log('warn', `豆包 CLI 任务终止：${reason}`)
        try {
          child.kill('SIGTERM')
        } catch {}
      }

      // 已流出的文本长度按 messageId 记录，避免「增量 + 全量」重复输出
      const emitted = new Map()
      const emitDelta = (messageId, text) => {
        if (text === '') return
        state.text += text
        emitted.set(messageId, (emitted.get(messageId) ?? 0) + text.length)
        task.onDelta?.(text)
      }

      let stdoutBuffer = ''
      child.stdout?.setEncoding?.('utf8')
      child.stdout?.on('data', chunk => {
        stdoutBuffer += chunk
        let newline = stdoutBuffer.indexOf('\n')
        while (newline >= 0) {
          const line = stdoutBuffer.slice(0, newline)
          stdoutBuffer = stdoutBuffer.slice(newline + 1)
          handleLine(line)
          newline = stdoutBuffer.indexOf('\n')
        }
      })

      const handleLine = line => {
        const event = parseStreamJsonLine(line)
        if (event.kind === 'empty') return
        if (event.kind === 'stray') {
          state.errors.push(event.text)
          task.onStray?.(event.text)
          return
        }
        if (event.kind === 'init') {
          state.sessionId = event.sessionId
          task.onInit?.(event.sessionId)
          return
        }
        if (event.kind === 'delta') {
          emitDelta(event.messageId, event.text)
          return
        }
        if (event.kind === 'message') {
          if (event.role !== 'assistant') return
          if (event.tools.length > 0) task.onTool?.(event.tools)
          const already = emitted.get(event.messageId) ?? 0
          if (event.text !== '' && event.text.length > already) {
            emitDelta(event.messageId, event.text.slice(already))
          } else if (event.text !== '' && already === 0) {
            emitDelta(event.messageId, event.text)
          }
          return
        }
        if (event.kind === 'result') {
          if (event.sessionId !== '') state.sessionId = event.sessionId
          state.ok = event.ok
          state.errors = [...state.errors, ...event.errors]
          state.denials = [...state.denials, ...event.denials]
          // 全程没有增量时（json/text 退路）用 result 里的最终文本兜底
          if (state.text === '' && event.text !== '') {
            state.text = event.text
            task.onDelta?.(event.text)
          }
          return
        }
      }

      let stderrText = ''
      child.stderr?.setEncoding?.('utf8')
      child.stderr?.on('data', chunk => {
        stderrText = (stderrText + chunk).slice(-8192)
      })

      child.on('error', error => {
        finish({ ok: false, errors: [`豆包 CLI 进程错误：${error?.message ?? error}`] })
      })

      child.on('close', code => {
        task.signal?.removeEventListener('abort', abortHandler)
        if (stdoutBuffer.trim() !== '') handleLine(stdoutBuffer)
        if (!state.ok) {
          if (stderrText.trim() !== '') state.errors.push(stderrText.trim().slice(0, 2048))
          state.errors.push(`豆包 CLI 退出码 ${code ?? 'unknown'}`)
        }
        finish({ ok: state.ok })
      })
    })
  }

  return { run, cwd: cwdOf, queueSize: () => queue.size() }
}

/**
 * 探测 CLI 可用性：`--version` 与 `auth status`。
 * 返回 { installed, version, loggedIn, message }，永不 throw。
 */
export function probeCli({ cliPath = '', spawnImpl = spawn, timeoutMs = 15_000, env = process.env } = {}) {
  const command = cliPath === '' ? 'doubao' : cliPath
  const exec = args => new Promise(resolve => {
    let out = ''
    let err = ''
    let child
    try {
      child = spawnImpl(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env })
    } catch (error) {
      resolve({ code: -1, out: '', err: String(error?.message ?? error) })
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM')
      } catch {}
    }, timeoutMs)
    child.stdout?.setEncoding?.('utf8')
    child.stderr?.setEncoding?.('utf8')
    child.stdout?.on('data', chunk => {
      out += chunk
    })
    child.stderr?.on('data', chunk => {
      err += chunk
    })
    child.on('error', error => {
      clearTimeout(timer)
      resolve({ code: -1, out, err: String(error?.message ?? error) })
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, out, err })
    })
  })

  return exec(['--version']).then(versionResult => {
    const raw = `${versionResult.out}${versionResult.err}`.trim()
    const match = raw.match(/doubao\s+([0-9][0-9a-zA-Z.\-+]*)/)
    // 判安装的唯一依据是「打印出了 doubao <版本号>」：只匹配到命令名不算，
    // 否则 `spawn doubao ENOENT` 这类错误文案会被误判成已安装
    if (match === null) {
      return { installed: false, version: '', loggedIn: false, message: raw.slice(0, 400) }
    }
    const version = match[1]
    return exec(['auth', 'status']).then(statusResult => {
      const statusRaw = `${statusResult.out}${statusResult.err}`.trim()
      const loggedIn = statusResult.code === 0 && !/login_required/i.test(statusRaw)
      return {
        installed: true,
        version,
        loggedIn,
        message: (loggedIn ? statusRaw : statusRaw).slice(0, 400),
      }
    })
  })
}

/** 通过 CLI 拉取模型清单（`model list --json`）。失败返回空数组，不抛。 */
export function fetchCliModels({ cliPath = '', spawnImpl = spawn, timeoutMs = 30_000, env = process.env } = {}) {
  const command = cliPath === '' ? 'doubao' : cliPath
  return new Promise(resolve => {
    let out = ''
    let err = ''
    let child
    try {
      child = spawnImpl(command, ['model', 'list', '--json'], { stdio: ['ignore', 'pipe', 'pipe'], env })
    } catch (error) {
      resolve({ models: [], error: String(error?.message ?? error) })
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM')
      } catch {}
    }, timeoutMs)
    child.stdout?.setEncoding?.('utf8')
    child.stderr?.setEncoding?.('utf8')
    child.stdout?.on('data', chunk => {
      out += chunk
    })
    child.stderr?.on('data', chunk => {
      err += chunk
    })
    const done = (models, error) => {
      clearTimeout(timer)
      resolve({ models, error })
    }
    child.on('error', error => done([], String(error?.message ?? error)))
    child.on('close', () => {
      const lines = out.split('\n').map(line => line.trim()).filter(line => line !== '')
      for (const line of lines) {
        let payload
        try {
          payload = JSON.parse(line)
        } catch {
          continue
        }
        if (String(payload?.type ?? '') !== 'result') continue
        if (payload?.is_error === true) {
          done([], `${err}${JSON.stringify(payload?.errors ?? [])}`.trim())
          return
        }
        done(parseModelListResult(payload), '')
        return
      }
      done([], (err || out).trim().slice(0, 400) || '豆包 CLI 没有返回模型清单')
    })
  })
}
