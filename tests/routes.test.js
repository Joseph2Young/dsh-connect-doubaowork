import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  registerPluginRoutes,
  PLUGIN_STATUS_PATH,
  PLUGIN_SETUP_PATH,
  PLUGIN_KEEPALIVE_RUN_PATH,
  PLUGIN_CLI_REFRESH_PATH,
  PLUGIN_LOGIN_START_PATH,
  PLUGIN_LOGIN_POLL_PATH,
  PLUGIN_LOGIN_CANCEL_PATH,
} from '../routes.js'

/**
 * 插件路由测试：用一个假的 webServer 收集注册项，再用假的 req/res 打过去。
 * 重点是闸门语义（方法 / loopback）和「能力缺席时不注册」。
 */

function makeFakeCtx({ withWebServer = true } = {}) {
  const routes = []
  const webServer = {
    register: entry => {
      routes.push(entry)
      let disposed = false
      return () => { disposed = true; entry.disposed = disposed }
    },
  }
  return {
    routes,
    ctx: {
      get: name => (name === 'webServer' && withWebServer ? webServer : undefined),
    },
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

test('routes：四个既有能力路由都注册（status/setup/keepalive/cli）', () => {
  const { ctx, routes } = makeFakeCtx()
  registerPluginRoutes(ctx, {
    status: () => ({}),
    runKeepalive: async () => ({}),
    refreshCli: async () => ({}),
    refreshSetup: async () => ({}),
  })
  assert.ok(findRoute(routes, PLUGIN_STATUS_PATH))
  assert.ok(findRoute(routes, PLUGIN_SETUP_PATH))
  assert.ok(findRoute(routes, PLUGIN_KEEPALIVE_RUN_PATH))
  assert.ok(findRoute(routes, PLUGIN_CLI_REFRESH_PATH))
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
