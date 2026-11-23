import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  CHECKIN_DEFAULT_HOUR,
  CHECKIN_DEFAULT_MINUTE,
  dayKey,
  nextCheckinDelay,
  checkinAccount,
  readCheckinState,
  writeCheckinState,
  createCheckin,
} from '../checkin.js'

function tmpStatePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-doubao-ci-'))
  return path.join(dir, 'checkin-state.json')
}

/** 造一个按 cookie 决定登录态的 fetch 替身；记录调用序列。 */
function fakeFetch({ loggedInCookies = ['sessionid=1'], calls = [] } = {}) {
  return async (url, init) => {
    calls.push({ url, init })
    if (url.endsWith('/chat/')) return { status: 302, text: async () => '' }
    const cookie = init?.headers?.Cookie ?? ''
    const valid = loggedInCookies.some(c => cookie.includes(c))
    return {
      status: 200,
      text: async () => JSON.stringify(valid ? { code: 0, data: { close_sidebar: false } } : { code: 710012001, msg: '登录已过期，请重新登录' }),
    }
  }
}

test('dayKey：本地日期 YYYY-MM-DD', () => {
  assert.equal(dayKey(new Date('2026-11-23T05:06:07')), '2026-11-23')
  assert.equal(dayKey(new Date('2026-01-02T23:59:59')), '2026-01-02')
})

test('nextCheckinDelay：今天未到 → 今天；已过 → 明天', () => {
  assert.equal(nextCheckinDelay(new Date('2026-11-23T07:00:00'), 8, 10), (70 * 60 + 0) * 1000)
  assert.equal(nextCheckinDelay(new Date('2026-11-23T23:00:00'), 8, 10), (9 * 60 + 10) * 60 * 1000)
  // 恰好等于签到时刻 → 顺延一天
  assert.equal(nextCheckinDelay(new Date('2026-11-23T08:10:00'), 8, 10), 24 * 60 * 60 * 1000)
  assert.equal(CHECKIN_DEFAULT_HOUR, 8)
  assert.equal(CHECKIN_DEFAULT_MINUTE, 10)
})

test('checkinAccount：先访问首页再发登录态探针；业务码 0 才算成功', async () => {
  const calls = []
  const result = await checkinAccount({ cookie: 'sessionid=1' }, { fetchImpl: fakeFetch({ calls }) })
  assert.equal(result.ok, true)
  assert.equal(result.loggedIn, true)
  assert.equal(result.code, 0)
  assert.equal(result.homeStatus, 302)
  // 两次请求：首页（模拟「来豆包」）+ 探针（判定登录态）
  assert.equal(calls.length, 2)
  assert.match(calls[0].url, /\/chat\/$/)
  assert.equal(calls[1].url, 'https://www.doubao.com/samantha/user/preference/get')
  assert.equal(calls[1].init.method, 'POST')
  assert.equal(calls[1].init.body, '{}')
})

test('checkinAccount：登录已过期 → ok:false 且带业务码', async () => {
  const result = await checkinAccount({ cookie: 'sessionid=stale' }, { fetchImpl: fakeFetch() })
  assert.equal(result.ok, false)
  assert.equal(result.loggedIn, false)
  assert.equal(result.code, 710012001)
})

test('checkinAccount：首页失败不阻塞判定', async () => {
  const fetchImpl = async (url, init) => {
    if (url.endsWith('/chat/')) throw new Error('home down')
    return { status: 200, text: async () => JSON.stringify({ code: 0 }) }
  }
  const result = await checkinAccount({ cookie: 'sessionid=1' }, { fetchImpl })
  assert.equal(result.ok, true)
  assert.equal(result.homeStatus, 0)
})

test('checkinAccount：网络错误 / 超时都降级为失败并带 detail', async () => {
  const network = await checkinAccount({ cookie: 'sessionid=1' }, {
    fetchImpl: async () => { throw new Error('ECONNREFUSED') },
  })
  assert.equal(network.ok, false)
  assert.match(network.detail, /ECONNREFUSED/)

  const timeout = await checkinAccount({ cookie: 'sessionid=1' }, {
    fetchImpl: async (url, init) => {
      // 首页正常，探针抛 AbortError 模拟超时
      if (url.endsWith('/chat/')) return { status: 302, text: async () => '' }
      const error = new Error('aborted')
      error.name = 'AbortError'
      throw error
    },
  })
  assert.equal(timeout.ok, false)
  assert.equal(timeout.detail, '签到超时')
})

test('checkinAccount：非 JSON 响应不崩，code 记 -1', async () => {
  const result = await checkinAccount({ cookie: 'sessionid=1' }, {
    fetchImpl: async (url) => (url.endsWith('/chat/')
      ? { status: 302, text: async () => '' }
      : { status: 200, text: async () => '<html>not json</html>' }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, -1)
})

test('状态文件：写入 0600、可回读、损坏降级为空表', () => {
  const statePath = tmpStatePath()
  writeCheckinState({ version: 1, lastDay: '2026-11-23', signedCount: 1, results: { a: { ok: true } } }, statePath)
  assert.equal(readCheckinState(statePath).signedCount, 1)
  assert.equal(fs.statSync(statePath).mode & 0o777, 0o600)

  fs.writeFileSync(statePath, '{ broken json')
  assert.deepEqual(readCheckinState(statePath), { results: {} })

  assert.deepEqual(readCheckinState(path.join(os.tmpdir(), 'definitely-missing-xyz.json')), { results: {} })
})

test('状态文件：不含 cookie/会话内容（隐私回归）', async () => {
  const statePath = tmpStatePath()
  const checkin = createCheckin({
    accounts: () => [{ id: 'account-1', cookie: 'sessionid=SECRET_TOKEN_XYZ; sessionid_ss=SECRET_TOKEN_XYZ' }],
    fetchImpl: fakeFetch(),
    statePath,
    log: () => {},
  })
  await checkin.runNow('manual', { force: true })
  const raw = fs.readFileSync(statePath, 'utf8')
  assert.doesNotMatch(raw, /SECRET_TOKEN_XYZ/)
  assert.doesNotMatch(raw, /"(cookie|sessionid|messages|content|prompt)"/)
  assert.match(raw, /"day": "\d{4}-\d{2}-\d{2}"/)
})

test('runNow：逐账号签到；失效账号记 ok:false', async () => {
  const statePath = tmpStatePath()
  const logs = []
  const checkin = createCheckin({
    accounts: () => [
      { id: 'good', cookie: 'sessionid=1' },
      { id: 'bad', cookie: 'sessionid=stale' },
      { id: 'off', cookie: 'sessionid=1', enabled: false },
    ],
    fetchImpl: fakeFetch(),
    statePath,
    log: (level, message) => logs.push({ level, message }),
    now: () => new Date('2026-11-23T08:10:00'),
  })
  const state = await checkin.runNow('manual', { force: true })
  assert.deepEqual(Object.keys(state.results), ['good', 'bad'])
  assert.equal(state.results.good.ok, true)
  assert.equal(state.results.good.day, '2026-11-23')
  assert.equal(state.results.bad.ok, false)
  assert.equal(state.results.bad.code, 710012001)
  assert.equal(state.signedCount, 1)
  assert.equal(state.reason, 'manual')
  // 成功记 info、失效记 warn
  assert.equal(logs.filter(l => l.level === 'info').length, 1)
  assert.equal(logs.filter(l => l.level === 'warn').length, 1)
  assert.match(logs.find(l => l.level === 'warn').message, /710012001/)
})

test('runNow：定时触发时今日已签则跳过；force 重签', async () => {
  const statePath = tmpStatePath()
  let calls = 0
  const fetchImpl = async (url, init) => {
    calls += 1
    if (url.endsWith('/chat/')) return { status: 302, text: async () => '' }
    return { status: 200, text: async () => JSON.stringify({ code: 0 }) }
  }
  const now = () => new Date('2026-11-23T08:10:00')
  const checkin = createCheckin({
    accounts: () => [{ id: 'a', cookie: 'sessionid=1' }],
    fetchImpl,
    statePath,
    log: () => {},
    now,
  })

  const first = await checkin.runNow('scheduled')
  assert.equal(first.signedCount, 1)
  const callsAfterFirst = calls

  // 同一账号同一天，定时再跑 → 跳过，不发请求
  const second = await checkin.runNow('scheduled')
  assert.equal(second.signedCount, 0)
  assert.equal(second.skipped, 1)
  assert.equal(calls, callsAfterFirst)

  // 手动 force → 真跑
  const third = await checkin.runNow('manual', { force: true })
  assert.equal(third.signedCount, 1)
  assert.ok(calls > callsAfterFirst)
})

test('runNow：上一轮失败的账号下一轮会重试（不写「今日已签」）', async () => {
  const statePath = tmpStatePath()
  let valid = false
  const fetchImpl = async (url) => (url.endsWith('/chat/')
    ? { status: 302, text: async () => '' }
    : { status: 200, text: async () => JSON.stringify(valid ? { code: 0 } : { code: 710012001 }) })
  const now = () => new Date('2026-11-23T08:10:00')
  const checkin = createCheckin({
    accounts: () => [{ id: 'a', cookie: 'sessionid=1' }],
    fetchImpl,
    statePath,
    log: () => {},
    now,
  })

  const failed = await checkin.runNow('scheduled')
  assert.equal(failed.results.a.ok, false)
  assert.equal(failed.skipped, 0)

  // 登录态恢复后，定时再跑不会因为「今天跑过」而跳过
  valid = true
  const retried = await checkin.runNow('scheduled')
  assert.equal(retried.results.a.ok, true)
  assert.equal(retried.signedCount, 1)
  assert.equal(retried.skipped, 0)
})

test('runNow：巡检中幂等（不并发）', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const statePath = tmpStatePath()
  const checkin = createCheckin({
    accounts: () => [{ id: 'a', cookie: 'sessionid=1' }],
    fetchImpl: async () => {
      await gate
      return { status: 200, text: async () => JSON.stringify({ code: 0 }) }
    },
    statePath,
    log: () => {},
  })
  const first = checkin.runNow('manual', { force: true })
  const second = await checkin.runNow('manual', { force: true })
  release()
  const done = await first
  assert.deepEqual(second.results, {})
  assert.equal(done.results.a.ok, true)
  assert.equal(checkin.running(), false)
})

test('schedule/stop/nextRunAt：开关决定是否定时', () => {
  let enabled = false
  const checkin = createCheckin({
    accounts: () => [],
    enabledOf: () => enabled,
    now: () => new Date('2026-11-23T07:00:00'),
    log: () => {},
  })
  checkin.schedule()
  assert.equal(checkin.nextRunAt(), null)

  enabled = true
  checkin.reschedule()
  const next = checkin.nextRunAt()
  assert.equal(typeof next, 'string')
  // 08:10 本地时刻（ISO 是 UTC，所以按本地小时/分钟断言，不受时区影响）
  const nextDate = new Date(next)
  assert.equal(nextDate.getHours(), 8)
  assert.equal(nextDate.getMinutes(), 10)
  checkin.stop()
  assert.equal(checkin.nextRunAt(), null)
})

test('reschedule：开关关掉后清理定时器（volatile 改动立即生效）', () => {
  let enabled = true
  const checkin = createCheckin({
    accounts: () => [],
    enabledOf: () => enabled,
    now: () => new Date('2026-11-23T07:00:00'),
    log: () => {},
  })
  checkin.schedule()
  assert.ok(checkin.nextRunAt() !== null)
  enabled = false
  checkin.reschedule()
  assert.equal(checkin.nextRunAt(), null)
  checkin.stop()
})

test('hourOf/minuteOf：活配置改动立刻影响下一次触发时间', () => {
  let hour = 8
  let minute = 10
  const checkin = createCheckin({
    accounts: () => [],
    enabled: true,
    hourOf: () => hour,
    minuteOf: () => minute,
    now: () => new Date('2026-11-23T07:00:00'),
    log: () => {},
  })
  checkin.schedule()
  assert.deepEqual([new Date(checkin.nextRunAt()).getHours(), new Date(checkin.nextRunAt()).getMinutes()], [8, 10])
  // 改成 09:45 后重新 arm
  hour = 9
  minute = 45
  checkin.reschedule()
  assert.deepEqual([new Date(checkin.nextRunAt()).getHours(), new Date(checkin.nextRunAt()).getMinutes()], [9, 45])
  checkin.stop()
})

test('非法时刻回落默认值，不会排到错误时间', () => {
  const checkin = createCheckin({
    accounts: () => [],
    enabled: true,
    hourOf: () => 99,
    minuteOf: () => -5,
    now: () => new Date('2026-11-23T07:00:00'),
    log: () => {},
  })
  checkin.schedule()
  // 非法时刻回落默认 08:10
  assert.deepEqual([new Date(checkin.nextRunAt()).getHours(), new Date(checkin.nextRunAt()).getMinutes()], [8, 10])
  checkin.stop()
})

test('无账号时签到是空操作，仍写出状态', async () => {
  const statePath = tmpStatePath()
  const checkin = createCheckin({ accounts: () => [], fetchImpl: fakeFetch(), statePath, log: () => {} })
  const state = await checkin.runNow('manual', { force: true })
  assert.deepEqual(state.results, {})
  assert.equal(state.signedCount, 0)
  assert.equal(readCheckinState(statePath).signedCount, 0)
})
