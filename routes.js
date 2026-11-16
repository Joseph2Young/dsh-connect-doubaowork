/**
 * 插件自有 HTTP 路由：供 Web 设置卡片读取账号池/保活状态、手动触发巡检。
 *
 * 与 workbuddy 的 /plugins/<id>/... 端点同构：宿主 webServer 服务上注册
 * exact 路由，方法闸 → loopback 闸（DNS-rebinding 防御）→ try/catch → json。
 * webServer 用 ctx.get() 软探测：宿主不提供时静默跳过（设置卡片降级为
 * 只读配置，不影响主功能）。
 */
export const PLUGIN_STATUS_PATH = '/plugins/dsh-connect-doubaowork/status'
export const PLUGIN_KEEPALIVE_RUN_PATH = '/plugins/dsh-connect-doubaowork/keepalive/run'

function json(res, status, payload) {
  if (res.writableEnded || res.destroyed) return
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

/** 仅接受本机回环来源（防御 DNS rebinding / 跨源读取）。 */
function requireLoopback(req) {
  const remote = req?.socket?.remoteAddress ?? ''
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
}

/**
 * 注册插件路由；返回卸载函数（未注册时返回 no-op）。
 * @param {object} ctx cordis 上下文
 * @param {object} deps { status(), runKeepalive() }
 */
export function registerPluginRoutes(ctx, deps) {
  const webServer = ctx?.get?.('webServer')
  if (!webServer || typeof webServer.register !== 'function') return () => {}
  const disposers = []
  const route = (entry) => disposers.push(webServer.register(entry))

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

  return () => {
    for (const dispose of disposers) {
      try {
        dispose?.()
      } catch {}
    }
  }
}
