/**
 * 插件自有 HTTP 路由：供 Web 设置卡片读取账号池/保活状态、手动触发巡检。
 *
 * 与 workbuddy 的 /plugins/<id>/... 端点同构：宿主 webServer 服务上注册
 * exact 路由，方法闸 → loopback 闸（DNS-rebinding 防御）→ try/catch → json。
 * webServer 用 ctx.get() 软探测：宿主不提供时静默跳过（设置卡片降级为
 * 只读配置，不影响主功能）。
 */
export const PLUGIN_STATUS_PATH = '/plugins/dsh-connect-doubaowork/status'
export const PLUGIN_SETUP_PATH = '/plugins/dsh-connect-doubaowork/setup'
export const PLUGIN_KEEPALIVE_RUN_PATH = '/plugins/dsh-connect-doubaowork/keepalive/run'
export const PLUGIN_CLI_REFRESH_PATH = '/plugins/dsh-connect-doubaowork/cli/refresh'
export const PLUGIN_LOGIN_START_PATH = '/plugins/dsh-connect-doubaowork/login/start'
export const PLUGIN_LOGIN_POLL_PATH = '/plugins/dsh-connect-doubaowork/login/poll'
export const PLUGIN_LOGIN_CANCEL_PATH = '/plugins/dsh-connect-doubaowork/login/cancel'

function json(res, status, payload) {
  if (res.writableEnded || res.destroyed) return
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

/**
 * 读取并解析请求体（上限 64KB）。
 * 用于登录 poll：body 里只有 loginId，超限即视为异常请求。
 */
function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy?.()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/** 仅接受本机回环来源（防御 DNS rebinding / 跨源读取）。 */
function requireLoopback(req) {
  const remote = req?.socket?.remoteAddress ?? ''
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
}

/**
 * 注册插件路由；返回卸载函数（未注册时返回 no-op）。
 * @param {object} ctx cordis 上下文
 * @param {object} deps { status(), runKeepalive(), refreshCli?() }
 */
export function registerPluginRoutes(ctx, deps) {
  /**
   * 用 `ctx.inject(['webServer'], …)` 响应式挂载，而不是一次性 `ctx.get()`。
   *
   * 宿主启动顺序不保证插件 activate 时 `webServer` 已就绪：早期实现用
   * `ctx.get('webServer')` 同步探测，拿到 undefined 就整个跳过注册——结果是
   * 设置卡片所有区块都显示「状态读取失败（主进程路由不可用）」，而日志里没有
   * 任何报错（因为走的是「静默降级」这条设计路径）。cordis 的 inject 会在服务
   * 上线时回调、下线时执行清理函数，启动顺序就不再有影响。
   */
  if (typeof ctx?.inject !== 'function' && typeof ctx?.get !== 'function') return () => {}
  // 插件已被卸载后，晚到的挂载必须立刻自我注销，否则会留下一批没人负责的路由。
  // cordis 通常不会在 scope 销毁后再回调 inject，但这层防护让行为不依赖该假设。
  let disposed = false
  let disposeMounted = null

  /** 在拿到 webServer 的上下文上登记路由；返回注销函数。 */
  const mount = (webCtx) => {
    const webServer = webCtx?.webServer ?? webCtx?.get?.('webServer')
    if (!webServer || typeof webServer.register !== 'function') return () => {}
    const disposers = []
    const route = (entry) => disposers.push(webServer.register(entry))
    registerAll(route, deps)
    return () => {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose?.()
        } catch {}
      }
    }
  }

  /**
   * 与 dsh-connect-workbuddy 相同的形态：在 inject 回调里用 `webCtx.effect`
   * 把「登记 + 注销」交给 cordis 的 scope 管理，服务下线/插件卸载时自动清理。
   */
  const mountInScope = (webCtx) => {
    if (typeof webCtx?.effect !== 'function') return mount(webCtx)
    let dispose = null
    webCtx.effect(() => {
      dispose = mount(webCtx)
      return () => {
        const run = dispose
        dispose = null
        run?.()
      }
    }, 'dsh-connect-doubaowork: plugin routes')
    return () => dispose?.()
  }

  if (typeof ctx?.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => {
      const dispose = mountInScope(webCtx)
      if (disposed) dispose()
      else disposeMounted = dispose
    })
    return () => {
      disposed = true
      try {
        disposeMounted?.()
      } catch {}
      disposeMounted = null
    }
  }

  // 兜底：老宿主没有 inject，退回同步探测（行为与旧版一致）
  const syncDisposer = mount(ctx)
  return () => {
    disposed = true
    try {
      syncDisposer?.()
    } catch {}
  }
}

/**
 * 把全部插件路由登记到给定的 `route(entry)` 上。
 * 抽成独立函数，是为了让「响应式挂载」与「同步兜底」共用同一份路由清单。
 */
function registerAll(route, deps) {
  route({
    kind: 'exact',
    path: PLUGIN_STATUS_PATH,
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        json(res, 405, { error: 'method not allowed' })
        return
      }
      if (!requireLoopback(req)) {
        json(res, 403, { error: 'loopback only' })
        return
      }
      try {
        json(res, 200, deps.status())
      } catch (error) {
        json(res, 500, { error: error?.message ?? String(error) })
      }
    },
  })

  route({
    kind: 'exact',
    path: PLUGIN_KEEPALIVE_RUN_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        json(res, 405, { error: 'method not allowed' })
        return
      }
      if (!requireLoopback(req)) {
        json(res, 403, { error: 'loopback only' })
        return
      }
      try {
        json(res, 200, await deps.runKeepalive())
      } catch (error) {
        json(res, 500, { error: error?.message ?? String(error) })
      }
    },
  })

  // CLI 状态刷新：设置卡片「重新探测 CLI」按钮用（会拉 --version / auth status 子进程）
  if (typeof deps.refreshCli === 'function') {
    route({
      kind: 'exact',
      path: PLUGIN_CLI_REFRESH_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          json(res, 405, { error: 'method not allowed' })
          return
        }
        if (!requireLoopback(req)) {
          json(res, 403, { error: 'loopback only' })
          return
        }
        try {
          json(res, 200, await deps.refreshCli())
        } catch (error) {
          json(res, 500, { error: error?.message ?? String(error) })
        }
      },
    })
  }

  // 首次使用引导重新检查：设置卡片「重新检查」按钮用（只读探测，不改任何配置）
  if (typeof deps.refreshSetup === 'function') {
    route({
      kind: 'exact',
      path: PLUGIN_SETUP_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          json(res, 405, { error: 'method not allowed' })
          return
        }
        if (!requireLoopback(req)) {
          json(res, 403, { error: 'loopback only' })
          return
        }
        try {
          json(res, 200, await deps.refreshSetup())
        } catch (error) {
          json(res, 500, { error: error?.message ?? String(error) })
        }
      },
    })
  }

  /**
   * 登录三条路由（start/poll/cancel）共用的 POST 处理器工厂：
   * 方法闸 → loopback 闸 → 调 deps 里的动作 → json。
   * 抽出来是因为三者的差异只有「调哪个函数、要不要读 body」。
   */
  const loginRoute = (path, action, readBody = false) => {
    if (typeof action !== 'function') return
    route({
      kind: 'exact',
      path,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          json(res, 405, { error: 'method not allowed' })
          return
        }
        if (!requireLoopback(req)) {
          json(res, 403, { error: 'loopback only' })
          return
        }
        try {
          let payload
          if (readBody) payload = await readJsonBody(req)
          json(res, 200, await action(payload))
        } catch (error) {
          json(res, 500, { error: error?.message ?? String(error) })
        }
      },
    })
  }

  // 扫码登录：把 `doubao login --qr=png` 的二维码搬到卡片里。
  // start 拉起子进程并回 data URL；poll 轮询是否已登录；cancel 取消并杀进程。
  if (deps.login && typeof deps.login === 'object') {
    loginRoute(PLUGIN_LOGIN_START_PATH, deps.login.start)
    loginRoute(PLUGIN_LOGIN_POLL_PATH, body => deps.login.poll(String(body?.loginId ?? '')), true)
    loginRoute(PLUGIN_LOGIN_CANCEL_PATH, () => deps.login.cancel())
  }

}
