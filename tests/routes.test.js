import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  registerPluginRoutes,
  PLUGIN_STATUS_PATH,
  PLUGIN_SETUP_PATH,
  PLUGIN_KEEPALIVE_RUN_PATH,
  PLUGIN_CHECKIN_RUN_PATH,
  PLUGIN_CLI_REFRESH_PATH,
  PLUGIN_LOGIN_START_PATH,
  PLUGIN_LOGIN_POLL_PATH,
  PLUGIN_LOGIN_CANCEL_PATH,
} from '../routes.js'

/**
 * 插件路由测试：用一个假的 webServer 收集注册项，再用假的 req/res 打过去。
 * 重点是闸门语义（方法 / loopback）和「能力缺席时不注册」。
 */

function makeFakeCtx({ withWebServer = true, withInject = true } = {}) {
  const routes = []
  const webServer = {
    register: entry => {
      routes.push(entry)
      let disposed = false
      return () => { disposed = true; entry.disposed = disposed }
    },
  }
  // inject 回调的调用时机由测试掌握：真实宿主里它在 webServer 上线时才触发，
  // 这里通过 `deliver()` 模拟「晚到」，用来断言启动顺序不再影响注册。
  const pending = []
  const ctx = {
    get: name => (name === 'webServer' && withWebServer ? webServer : undefined),
  }
  if (withInject) {
    ctx.inject = (names, callback) => {
      pending.push({ names, callback })
      // 立即投递一次（模拟 webServer 已就绪的常规情形）
      if (withWebServer) callback({ webServer, get: ctx.get })
    }
  }
  return {
    routes,
    webServer,
    /** 之后再触发一次 inject 回调（测试「挂载晚到」路径时用）。 */
    deliver: () => {
      for (const item of pending.splice(0)) item.callback({ webServer, get: ctx.get })
    },
    ctx,
  }
}

/** 假 res：记录状态码与 body，writableEnded 语义与真实 Response 对齐。 */
function makeRes() {
  const res = new EventEmitter()
  res.status = 0
  res.headers = {}
  res.body = ''
  res.writableEnded = false
  res.destroyed = false
  res.writeHead = (status, headers) => {
    res.status = status
    res.headers = headers ?? {}
  }
  res.end = chunk => {
    if (chunk !== undefined) res.body += String(chunk)
    res.writableEnded = true
  }
  res.json = () => JSON.parse(res.body)
  return res
}

/** 假 req：loopback 来源可选，可带 JSON body。 */
function makeReq({ method = 'GET', remote = '127.0.0.1', body } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.socket = { remoteAddress: remote }
  req.destroy = () => {}
  if (body !== undefined) {
    const text = typeof body === 'string' ? body : JSON.stringify(body)
    setImmediate(() => {
      req.emit('data', Buffer.from(text))
      req.emit('end')
    })
  }
  return req
}

const findRoute = (routes, path) => routes.find(entry => entry.path === path)

/** 最小可用的 deps：把四个能力都给上，便于断言「全都注册了」。 */
const makeDeps = () => ({
  status: () => ({ ok: 1 }),
  runKeepalive: async () => ({ ok: true }),
  runCheckin: async () => ({ ok: true }),
  refreshCli: async () => ({ available: false }),
  refreshSetup: async () => ({ ready: false }),
  login: { start: async () => ({ ok: true }), poll: async () => ({ done: false }), cancel: () => ({ ok: true }) },
})
/** inject 回调收到的第二个参数在这里没用到，只是让 deliver 有实参。 */
const needWebServer = undefined

test('routes：webServer 缺席时静默降级为 no-op', () => {
  const { ctx } = makeFakeCtx({ withWebServer: false })
  const dispose = registerPluginRoutes(ctx, { status: () => ({}) })
  assert.equal(typeof dispose, 'function')
  dispose()
})

test('routes：status 只允许 GET + loopback', async () => {
  const { ctx, routes } = makeFakeCtx()
  registerPluginRoutes(ctx, { status: () => ({ ok: 1 }) })
  const route = findRoute(routes, PLUGIN_STATUS_PATH)

  const wrongMethod = makeRes()
  await route.handler(makeReq({ method: 'POST' }), wrongMethod)
  assert.equal(wrongMethod.status, 405)

  const offHost = makeRes()
  await route.handler(makeReq({ remote: '10.0.0.7' }), offHost)
  assert.equal(offHost.status, 403)

  const ok = makeRes()
  await route.handler(makeReq(), ok)
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.json(), { ok: 1 })
  assert.match(ok.headers['Content-Type'], /application\/json/)
})

test('routes：status 抛错 → 500 且带错误消息（不崩宿主）', async () => {
  const { ctx, routes } = makeFakeCtx()
  registerPluginRoutes(ctx, { status: () => { throw new Error('炸了') } })
  const res = makeRes()
  await findRoute(routes, PLUGIN_STATUS_PATH).handler(makeReq(), res)
  assert.equal(res.status, 500)
  assert.match(res.json().error, /炸了/)
})

test('routes：登录三条路由在 deps.login 缺席时都不注册', () => {
  const { ctx, routes } = makeFakeCtx()
  registerPluginRoutes(ctx, { status: () => ({}) })
  assert.equal(findRoute(routes, PLUGIN_LOGIN_START_PATH), undefined)
  assert.equal(findRoute(routes, PLUGIN_LOGIN_POLL_PATH), undefined)
  assert.equal(findRoute(routes, PLUGIN_LOGIN_CANCEL_PATH), undefined)
})

test('routes：登录 start 走 POST + loopback 闸，返回 login 结果', async () => {
  const { ctx, routes } = makeFakeCtx()
  let started = 0
  registerPluginRoutes(ctx, {
    status: () => ({}),
    login: {
      start: async () => { started += 1; return { ok: true, loginId: 'dbl_x', imageDataUrl: 'data:image/png;base64,AAA' } },
      poll: async () => ({ done: false }),
      cancel: () => ({ ok: true }),
    },
  })
  const route = findRoute(routes, PLUGIN_LOGIN_START_PATH)

  const wrongMethod = makeRes()
  await route.handler(makeReq({ method: 'GET' }), wrongMethod)
  assert.equal(wrongMethod.status, 405)
  assert.equal(started, 0)

  const offHost = makeRes()
  await route.handler(makeReq({ method: 'POST', remote: '192.168.1.5' }), offHost)
  assert.equal(offHost.status, 403)
  assert.equal(started, 0)

  const ok = makeRes()
  await route.handler(makeReq({ method: 'POST' }), ok)
  assert.equal(ok.status, 200)
  assert.equal(ok.json().loginId, 'dbl_x')
  assert.equal(started, 1)
})

test('routes：登录 poll 从 body 读 loginId 并透传', async () => {
  const { ctx, routes } = makeFakeCtx()
  const seen = []
  registerPluginRoutes(ctx, {
    status: () => ({}),
    login: {
      start: async () => ({ ok: true }),
      poll: async id => { seen.push(id); return { done: true, loggedIn: true } },
      cancel: () => ({ ok: true }),
    },
  })
  const res = makeRes()
  await findRoute(routes, PLUGIN_LOGIN_POLL_PATH).handler(
    makeReq({ method: 'POST', body: { loginId: 'dbl_abc' } }),
    res,
  )
  assert.equal(res.status, 200)
  assert.deepEqual(seen, ['dbl_abc'])
  assert.equal(res.json().loggedIn, true)
})

test('routes：登录 poll 缺 loginId → 传空串（Host 侧回「会话不存在」）', async () => {
  const { ctx, routes } = makeFakeCtx()
  const seen = []
  registerPluginRoutes(ctx, {
    status: () => ({}),
    login: {
      start: async () => ({ ok: true }),
      poll: async id => { seen.push(id); return { done: true, error: '登录会话不存在或已结束，请重新获取二维码' } },
      cancel: () => ({ ok: true }),
    },
  })
  const res = makeRes()
  await findRoute(routes, PLUGIN_LOGIN_POLL_PATH).handler(makeReq({ method: 'POST', body: {} }), res)
  assert.deepEqual(seen, [''])
  assert.match(res.json().error, /登录会话不存在/)
})

test('routes：登录 poll 的 body 不是合法 JSON → 500 而不是崩', async () => {
  const { ctx, routes } = makeFakeCtx()
  registerPluginRoutes(ctx, {
    status: () => ({}),
    login: {
      start: async () => ({ ok: true }),
      poll: async () => ({ done: false }),
      cancel: () => ({ ok: true }),
    },
  })
  const res = makeRes()
  await findRoute(routes, PLUGIN_LOGIN_POLL_PATH).handler(makeReq({ method: 'POST', body: '{not json' }), res)
  assert.equal(res.status, 500)
  assert.match(res.json().error, /JSON/)
})

test('routes：登录 cancel 调 deps.login.cancel', async () => {
  const { ctx, routes } = makeFakeCtx()
  let cancelled = 0
  registerPluginRoutes(ctx, {
    status: () => ({}),
    login: {
      start: async () => ({ ok: true }),
      poll: async () => ({ done: false }),
      cancel: () => { cancelled += 1; return { ok: true } },
    },
  })
  const res = makeRes()
  await findRoute(routes, PLUGIN_LOGIN_CANCEL_PATH).handler(makeReq({ method: 'POST' }), res)
  assert.equal(res.status, 200)
  assert.equal(cancelled, 1)
})

test('routes：既有能力路由都注册（status/setup/keepalive/checkin/cli）', () => {
  const { ctx, routes } = makeFakeCtx()
  registerPluginRoutes(ctx, {
    status: () => ({}),
    runKeepalive: async () => ({}),
    runCheckin: async () => ({}),
    refreshCli: async () => ({}),
    refreshSetup: async () => ({}),
  })
  assert.ok(findRoute(routes, PLUGIN_STATUS_PATH))
  assert.ok(findRoute(routes, PLUGIN_SETUP_PATH))
  assert.ok(findRoute(routes, PLUGIN_KEEPALIVE_RUN_PATH))
  assert.ok(findRoute(routes, PLUGIN_CHECKIN_RUN_PATH))
  assert.ok(findRoute(routes, PLUGIN_CLI_REFRESH_PATH))
})

test('routes：签到路由的闸门（方法/loopback）与返回体', async () => {
  const { ctx, routes } = makeFakeCtx()
  registerPluginRoutes(ctx, { status: () => ({}), runCheckin: async () => ({ signedCount: 1 }) })
  const route = findRoute(routes, PLUGIN_CHECKIN_RUN_PATH)
  assert.ok(route)

  // GET 被拒
  const getRes = makeRes()
  await route.handler(makeReq({ method: 'GET' }), getRes)
  assert.equal(getRes.status, 405)

  // 非 loopback 被拒
  const remoteRes = makeRes()
  await route.handler(makeReq({ method: 'POST', remote: '10.0.0.5' }), remoteRes)
  assert.equal(remoteRes.status, 403)

  // 正常 POST 返回 handler 结果
  const okRes = makeRes()
  await route.handler(makeReq({ method: 'POST' }), okRes)
  assert.equal(okRes.status, 200)
  assert.match(String(okRes.body), /"signedCount":1/)
})

test('routes：runCheckin 未提供时不注册签到路由（不给会失败的按钮）', () => {
  const { ctx, routes } = makeFakeCtx()
  registerPluginRoutes(ctx, { status: () => ({}) })
  assert.equal(findRoute(routes, PLUGIN_CHECKIN_RUN_PATH), undefined)
})

test('routes：卸载函数把注册的每条路由都 dispose 掉', () => {
  const { ctx, routes } = makeFakeCtx()
  const dispose = registerPluginRoutes(ctx, {
    status: () => ({}),
    runKeepalive: async () => ({}),
    login: { start: async () => ({}), poll: async () => ({}), cancel: () => ({}) },
  })
  assert.ok(routes.length >= 4)
  dispose()
  assert.ok(routes.every(entry => entry.disposed === true), '所有路由都应被卸载')
})

// ── 启动顺序回归：这是 0.4.1 修的真实缺陷 ──────────────────────────────
// 现场：插件 activate 时 webServer 还没就绪，早期实现用 ctx.get('webServer')
// 同步探测拿到 undefined 就整个跳过注册 → 设置卡片所有区块显示
// 「状态读取失败（主进程路由不可用）」，而日志里一条报错都没有。

test('routes：webServer 晚于插件就绪时才上线，仍能挂上全部路由（启动顺序回归）', () => {
  const { routes, ctx, deliver } = makeFakeCtx({ withWebServer: false })
  const dispose = registerPluginRoutes(ctx, makeDeps())
  assert.equal(routes.length, 0, 'webServer 未就绪时不该有路由')
  // 模拟宿主稍后让 webServer 上线，cordis inject 回调此刻才触发
  deliver(needWebServer)
  assert.ok(routes.length >= 5, `webServer 上线后应挂上路由，实际 ${routes.length}`)
  dispose()
})

test('routes：有 ctx.inject 时优先走响应式挂载，不做一次性同步探测', () => {
  let injectCalls = 0
  const routes = []
  const webServer = {
    register: entry => {
      routes.push(entry)
      return () => {}
    },
  }
  const ctx = {
    get: () => { throw new Error('有 inject 时不该调用 ctx.get') },
    inject: (names, callback) => {
      injectCalls += 1
      assert.deepEqual(names, ['webServer'])
      callback({ webServer })
    },
  }
  const dispose = registerPluginRoutes(ctx, makeDeps())
  assert.equal(injectCalls, 1, 'inject 应被调用一次')
  assert.ok(routes.length >= 5)
  dispose()
})

test('routes：卸载时既注销 webServer 上的路由，也注销 inject 的挂载', () => {
  const { routes, ctx } = makeFakeCtx()
  const dispose = registerPluginRoutes(ctx, makeDeps())
  assert.ok(routes.length >= 5)
  dispose()
  assert.ok(routes.every(entry => entry.disposed === true), '每条路由都应被 dispose')
})

test('routes：插件先卸载、webServer 后上线时，晚到的挂载会自我注销（不泄漏）', () => {
  const { routes, ctx, deliver } = makeFakeCtx({ withWebServer: false })
  const dispose = registerPluginRoutes(ctx, makeDeps())
  dispose() // 卸载发生在 webServer 上线之前
  deliver() // webServer 此刻才上线，inject 回调晚到
  assert.ok(routes.length > 0, '回调确实投递了')
  assert.ok(routes.every(entry => entry.disposed === true), '晚到注册的路由必须立刻被注销')
})

// ── cordis scope 形态：与 dsh-connect-workbuddy 一致的 webCtx.effect 挂载 ──
test('routes：webServer 上下文带 effect 时，通过 effect 管理路由生命周期（cordis 形态）', () => {
  const routes = []
  const webServer = { register: entry => { routes.push(entry); return () => { entry.disposed = true } } }
  const cleanups = []
  let effectLabel = ''
  const webCtx = {
    webServer,
    effect: (callback, label) => {
      effectLabel = label
      cleanups.push(callback())
    },
  }
  const ctx = {
    get: () => { throw new Error('有 inject 时应走 inject') },
    inject: (names, callback) => callback(webCtx),
  }
  const dispose = registerPluginRoutes(ctx, makeDeps())
  assert.equal(routes.length, 8, '八条路由都该登记（status/setup/keepalive/checkin/cli/login×3）')
  assert.match(effectLabel, /dsh-connect-doubaowork/, 'effect 应带可读标签便于宿主排查')
  assert.equal(typeof cleanups[0], 'function', 'effect 回调要返回注销函数')
  dispose()
  assert.ok(routes.every(entry => entry.disposed === true), '卸载后路由全部注销')
})
