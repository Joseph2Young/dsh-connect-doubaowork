import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  nextRunDelay,
  probeAccount,
  readPoolState,
  writePoolState,
  createKeepalive,
} from '../keepalive.js'

function tmpStatePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-doubao-ka-'))
  return path.join(dir, 'pool-state.json')
}

test('nextRunDelay：今天未到 → 今天；已过 → 明天', () => {
  const morning = new Date('2026-11-16T07:00:00')
  const delay = nextRunDelay(morning, 8, 30)
  assert.equal(delay, 90 * 60 * 1000)
  const evening = new Date('2026-11-16T23:00:00')
  const delay2 = nextRunDelay(evening, 8, 30)
  assert.equal(delay2, (9 * 60 + 30) * 60 * 1000)
  // 恰好等于巡检时刻 → 顺延一天
  const exact = new Date('2026-11-16T08:30:00')
  assert.equal(nextRunDelay(exact, 8, 30), 24 * 60 * 60 * 1000)
})

test('probeAccount：按业务码判定登录态（不看 HTTP 状态码）', async () => {
  // 登录态有效：HTTP 200 + code 0
  const ok = await probeAccount({ cookie: 'sessionid=a' }, {
    fetchImpl: async () => ({ status: 200, text: async () => JSON.stringify({ code: 0, data: {} }) }),
  })
  assert.equal(ok.ok, true)
  assert.equal(ok.loggedIn, true)
  assert.equal(ok.code, 0)
  assert.equal(ok.status, 200)

  // 登录已过期：HTTP 仍 200，业务码 710012001
  const expired = await probeAccount({ cookie: 'sessionid=a' }, {
    fetchImpl: async () => ({ status: 200, text: async () => JSON.stringify({ code: 710012001, msg: '登录已过期，请重新登录' }) }),
  })
  assert.equal(expired.ok, false)
  assert.equal(expired.loggedIn, false)
  assert.equal(expired.code, 710012001)

  // 即使 HTTP 非 200，只要业务码是 0 也算有效（判定与状态码解耦）
  const oddStatus = await probeAccount({ cookie: 'sessionid=a' }, {
    fetchImpl: async () => ({ status: 302, text: async () => JSON.stringify({ code: 0 }) }),
  })
  assert.equal(oddStatus.ok, true)

  const network = await probeAccount({ cookie: 'sessionid=a' }, { fetchImpl: async () => { throw new Error('ECONNREFUSED') } })
  assert.equal(network.ok, false)
  assert.equal(network.status, 0)
  assert.match(network.detail, /ECONNREFUSED/)

  // 请求形态：POST 探针接口、带 cookie、手动 redirect
  let captured
  await probeAccount({ cookie: 'sessionid=probe' }, {
    fetchImpl: async (url, init) => {
      captured = { url, init }
      return { status: 200, text: async () => JSON.stringify({ code: 0 }) }
    },
  })
  assert.equal(captured.url, 'https://www.doubao.com/samantha/user/preference/get')
  assert.equal(captured.init.method, 'POST')
  assert.equal(captured.init.redirect, 'manual')
  assert.match(captured.init.headers.Cookie, /sessionid=probe/)
})

test('probeAccount 回归：首页 302 不再被误判为登录失效', async () => {
  // 早期实现 GET 首页并判定 2xx，但首页无论 cookie 是否有效都 302 → 长期误报。
  // 现在探针是 preference 接口，业务码 0 即有效，与首页重定向无关。
  const result = await probeAccount({ cookie: 'sessionid=a' }, {
    fetchImpl: async () => ({ status: 200, text: async () => JSON.stringify({ code: 0 }) }),
  })
  assert.equal(result.ok, true)
  assert.doesNotMatch(JSON.stringify(result), /302/)
})

test('runNow：逐账号巡检并落盘；失败账号记录非 ok', async () => {
  const statePath = tmpStatePath()
  const warnings = []
  const keepalive = createKeepalive({
    accounts: () => [
      { id: 'good', cookie: 'sessionid=1' },
      { id: 'bad', cookie: 'sessionid=2' },
      { id: 'off', cookie: 'sessionid=3', enabled: false },
    ],
    fetchImpl: async (url, init) => ({
      status: 200,
      text: async () => JSON.stringify(init.headers.Cookie.includes('sessionid=1') ? { code: 0 } : { code: 710012001 }),
    }),
    statePath,
    log: level => warnings.push(level),
  })
  const state = await keepalive.runNow('manual')
  assert.deepEqual(Object.keys(state.results), ['good', 'bad'])
  assert.equal(state.results.good.ok, true)
  assert.equal(state.results.bad.ok, false)
  assert.equal(state.reason, 'manual')
  // 落盘可回读
  const fromDisk = readPoolState(statePath)
  assert.equal(fromDisk.results.good.ok, true)
  assert.equal(warnings.length, 1)
})

test('runNow：巡检中幂等（不并发）', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const statePath = tmpStatePath()
  const keepalive = createKeepalive({
    accounts: () => [{ id: 'a', cookie: 'sessionid=1' }],
    fetchImpl: async () => {
      await gate
      return { status: 200, text: async () => JSON.stringify({ code: 0 }) }
    },
    statePath,
  })
  const first = keepalive.runNow('manual')
  const second = await keepalive.runNow('manual')
  release()
  const done = await first
  // 第二次调用撞上 running → 直接回读当前（空）状态，不重跑
  assert.deepEqual(second.results, {})
  assert.equal(done.results.a.ok, true)
  assert.equal(keepalive.running(), false)
})

test('schedule：开关关闭不定时；stop 清理', () => {
  const off = createKeepalive({ accounts: () => [], enabled: false })
  off.schedule()
  off.stop()
  const on = createKeepalive({ accounts: () => [], enabled: true })
  on.schedule()
  on.stop()
  // 写读往返
  const statePath = tmpStatePath()
  writePoolState({ lastRun: 'x', results: {} }, statePath)
  assert.equal(readPoolState(statePath).lastRun, 'x')
})
