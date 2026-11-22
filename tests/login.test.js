import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLoginManager, parseLoginOutput, LOGIN_TTL_MS } from '../login.js'

/** 最小真 PNG（1x1）；用来验证魔数校验不是碰运气通过的。 */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-login-'))
}

/**
 * 假 CLI 进程：EventEmitter + 两个 Readable 当 stdout/stderr，
 * 测试用 emitStdout() 往里灌输出，用 close() 模拟退出。
 */
function fakeChild() {
  const child = new EventEmitter()
  child.stdout = new Readable({ read() {} })
  child.stderr = new Readable({ read() {} })
  child.killed = false
  child.kill = signal => {
    child.killed = true
    child.emit('close', 0)
    return true
  }
  child.emitStdout = text => child.stdout.emit('data', text)
  child.emitStderr = text => child.stderr.emit('data', text)
  child.closeWith = code => child.emit('close', code)
  return child
}

/** 造一个假 spawn：按顺序回放 script 里的动作。 */
function scriptedSpawn(actions) {
  const calls = []
  const impl = (command, args, options) => {
    const child = fakeChild()
    calls.push({ command, args, options, child })
    // 动作在下一个 tick 回放，模拟异步输出
    setImmediate(() => {
      for (const action of actions) {
        if (action.kind === 'stdout') child.emitStdout(action.text)
        else if (action.kind === 'stderr') child.emitStderr(action.text)
        else if (action.kind === 'close') child.closeWith(action.code ?? 0)
      }
    })
    return child
  }
  return { impl, calls }
}

/** 假探测器：默认「已安装未登录」。 */
const probeOf = (state = {}) => async () => ({
  installed: true, version: '2.37.2', loggedIn: false, message: '', ...state,
})

test('parseLoginOutput：认出 QR_IMAGE 路径', () => {
  const parsed = parseLoginOutput('QR_IMAGE=/var/folders/x/T/qrcode.png\n请使用豆包移动端扫码并在手机上确认；按 Ctrl+C 可取消')
  assert.deepEqual(parsed, { kind: 'qr', path: '/var/folders/x/T/qrcode.png' })
})

test('parseLoginOutput：认出 conflict（单实例锁）', () => {
  const parsed = parseLoginOutput('conflict: 已有登录正在进行，或当前无法显示登录信息。请稍后重试。')
  assert.equal(parsed.kind, 'conflict')
})

test('parseLoginOutput：认出 auth_unavailable 并保留原文', () => {
  const parsed = parseLoginOutput('auth_unavailable: 当前输出无法交互显示二维码，请使用 `doubao login --qr=png` 输出临时二维码图片路径')
  assert.equal(parsed.kind, 'unavailable')
  assert.match(parsed.message, /qr=png/)
})

test('parseLoginOutput：无关输出 → none', () => {
  assert.equal(parseLoginOutput('随便什么东西').kind, 'none')
  assert.equal(parseLoginOutput('').kind, 'none')
  assert.equal(parseLoginOutput(null).kind, 'none')
})

test('start：成功拿到二维码 → 返回 data URL 与 loginId', async () => {
  const dir = tmpDir()
  const pngPath = path.join(dir, 'qrcode.png')
  fs.writeFileSync(pngPath, PNG_1PX)
  try {
    const { impl, calls } = scriptedSpawn([{ kind: 'stdout', text: `QR_IMAGE=${pngPath}\n请使用豆包移动端扫码` }])
    const manager = createLoginManager({ spawnImpl: impl, probe: probeOf(), cliPath: () => '' })
    const result = await manager.start()
    assert.equal(result.ok, true)
    assert.equal(result.reused, false)
    assert.match(result.imageDataUrl, /^data:image\/png;base64,/)
    assert.ok(result.loginId.startsWith('dbl_'))
    assert.ok(result.expiresInSeconds > 0)
    // 参数必须是 login --qr=png（--qr=small/full 在非 TTY 下会失败）
    assert.deepEqual(calls[0].args, ['login', '--qr=png'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('start：未安装 CLI → 明确报 not-installed 并给出安装命令', async () => {
  const { impl, calls } = scriptedSpawn([])
  const manager = createLoginManager({
    spawnImpl: impl,
    probe: probeOf({ installed: false, version: '' }),
    cliPath: () => '',
  })
  const result = await manager.start()
  assert.equal(result.ok, false)
  assert.equal(result.code, 'not-installed')
  assert.match(result.error, /npm i -g @bytedance\/doubao-cli/)
  // 没装就不该拉起登录进程
  assert.equal(calls.length, 0)
})

test('start：CLI 报 conflict → 提示先在终端处理', async () => {
  const { impl } = scriptedSpawn([{ kind: 'stdout', text: 'conflict: 已有登录正在进行，或当前无法显示登录信息。请稍后重试。' }])
  const manager = createLoginManager({ spawnImpl: impl, probe: probeOf(), cliPath: () => '' })
  const result = await manager.start()
  assert.equal(result.ok, false)
  assert.equal(result.code, 'conflict')
  assert.match(result.error, /单实例锁/)
})

test('start：CLI 报 auth_unavailable（输出不支持）→ 原样透传', async () => {
  const { impl } = scriptedSpawn([{ kind: 'stdout', text: 'auth_unavailable: 当前输出无法交互显示二维码，请使用 `doubao login --qr=png`' }])
  const manager = createLoginManager({ spawnImpl: impl, probe: probeOf(), cliPath: () => '' })
  const result = await manager.start()
  assert.equal(result.ok, false)
  assert.equal(result.code, 'unavailable')
  assert.match(result.error, /qr=png/)
})

test('start：二维码文件还没落盘 → 后续 chunk 触发重读仍能成功', async () => {
  const dir = tmpDir()
  const pngPath = path.join(dir, 'late.png')
  const child = fakeChild()
  const impl = () => child
  try {
    const manager = createLoginManager({ spawnImpl: impl, probe: probeOf(), cliPath: () => '' })
    const pending = manager.start()
    // 第一条 chunk 只给路径，此时文件还不存在 → 不该 settle
    await new Promise(resolve => setTimeout(resolve, 5))
    child.emitStdout(`QR_IMAGE=${pngPath}\n`)
    const early = await Promise.race([
      pending,
      new Promise(resolve => setTimeout(() => resolve({ pending: true }), 60)),
    ])
    assert.equal(early.pending, true, '文件不存在时不该返回成功')
    // 文件补上后任意 chunk 都会重试读取
    fs.writeFileSync(pngPath, PNG_1PX)
    child.emitStdout('请使用豆包移动端扫码并在手机上确认\n')
    const result = await pending
    assert.equal(result.ok, true)
    assert.match(result.imageDataUrl, /^data:image\/png;base64,/)
    manager.cancel()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('start：已登录时也给二维码（允许重新登录换号）', async () => {
  const dir = tmpDir()
  const pngPath = path.join(dir, 'qrcode.png')
  fs.writeFileSync(pngPath, PNG_1PX)
  try {
    const { impl } = scriptedSpawn([{ kind: 'stdout', text: `QR_IMAGE=${pngPath}\n` }])
    const manager = createLoginManager({
      spawnImpl: impl,
      probe: probeOf({ loggedIn: true }),
      cliPath: () => '',
    })
    const result = await manager.start()
    assert.equal(result.ok, true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('start：重复调用复用进行中的会话（CLI 单实例锁）', async () => {
  const dir = tmpDir()
  const pngPath = path.join(dir, 'qrcode.png')
  fs.writeFileSync(pngPath, PNG_1PX)
  try {
    const { impl, calls } = scriptedSpawn([{ kind: 'stdout', text: `QR_IMAGE=${pngPath}\n` }])
    const manager = createLoginManager({ spawnImpl: impl, probe: probeOf(), cliPath: () => '' })
    const first = await manager.start()
    const second = await manager.start()
    assert.equal(second.ok, true)
    assert.equal(second.reused, true)
    assert.equal(second.loginId, first.loginId)
    // 只拉起一个子进程
    assert.equal(calls.length, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('poll：探测到已登录 → done + loggedIn，并回收会话', async () => {
  const dir = tmpDir()
  const pngPath = path.join(dir, 'qrcode.png')
  fs.writeFileSync(pngPath, PNG_1PX)
  try {
    let loggedIn = false
    const { impl } = scriptedSpawn([{ kind: 'stdout', text: `QR_IMAGE=${pngPath}\n` }])
    const manager = createLoginManager({
      spawnImpl: impl,
      probe: async () => ({ installed: true, version: '2.37.2', loggedIn, message: '' }),
      cliPath: () => '',
    })
    const started = await manager.start()
    // 未扫码期间一直 false
    assert.deepEqual(await manager.poll(started.loginId), { done: false })
    loggedIn = true
    const result = await manager.poll(started.loginId)
    assert.equal(result.done, true)
    assert.equal(result.loggedIn, true)
    assert.equal(result.version, '2.37.2')
    // 成功后会话清空
    assert.equal(manager.snapshot().active, false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('poll：未知 loginId → done + error（不静默）', async () => {
  const manager = createLoginManager({ spawnImpl: scriptedSpawn([]).impl, probe: probeOf(), cliPath: () => '' })
  const result = await manager.poll('dbl_does_not_exist')
  assert.equal(result.done, true)
  assert.match(result.error, /登录会话不存在/)
})

test('poll：探测抛错 → done:false（继续等，不误判失败）', async () => {
  const dir = tmpDir()
  const pngPath = path.join(dir, 'qrcode.png')
  fs.writeFileSync(pngPath, PNG_1PX)
  try {
    let calls = 0
    const { impl } = scriptedSpawn([{ kind: 'stdout', text: `QR_IMAGE=${pngPath}\n` }])
    const manager = createLoginManager({
      spawnImpl: impl,
      probe: async () => {
        calls += 1
        if (calls === 1) return { installed: true, version: '2.37.2', loggedIn: false, message: '' }
        throw new Error('探测时断网')
      },
      cliPath: () => '',
    })
    const started = await manager.start()
    const result = await manager.poll(started.loginId)
    assert.equal(result.done, false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('poll：过期 → done + error，并杀进程', async () => {
  const dir = tmpDir()
  const pngPath = path.join(dir, 'qrcode.png')
  fs.writeFileSync(pngPath, PNG_1PX)
  try {
    let clock = Date.now()
    const { impl, calls } = scriptedSpawn([{ kind: 'stdout', text: `QR_IMAGE=${pngPath}\n` }])
    const manager = createLoginManager({
      spawnImpl: impl, probe: probeOf(), cliPath: () => '', now: () => clock,
    })
    const started = await manager.start()
    clock += LOGIN_TTL_MS + 1
    const result = await manager.poll(started.loginId)
    assert.equal(result.done, true)
    assert.match(result.error, /过期/)
    assert.equal(calls[0].child.killed, true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('cancel：杀掉进程并清空会话', async () => {
  const dir = tmpDir()
  const pngPath = path.join(dir, 'qrcode.png')
  fs.writeFileSync(pngPath, PNG_1PX)
  try {
    const { impl, calls } = scriptedSpawn([{ kind: 'stdout', text: `QR_IMAGE=${pngPath}\n` }])
    const manager = createLoginManager({ spawnImpl: impl, probe: probeOf(), cliPath: () => '' })
    await manager.start()
    assert.equal(manager.snapshot().active, true)
    manager.cancel()
    assert.equal(manager.snapshot().active, false)
    assert.equal(calls[0].child.killed, true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('安全：非 PNG 文件不会被当成二维码回给前端', async () => {
  const dir = tmpDir()
  const fakePath = path.join(dir, 'not-a-png.png')
  fs.writeFileSync(fakePath, 'this is not a png')
  try {
    const manager = createLoginManager({
      spawnImpl: scriptedSpawn([]).impl,
      probe: probeOf(),
      cliPath: () => '',
    })
    // 直接产出 QR_IMAGE 指向伪造文件：应落到 30s 超时路径而不是返回 data URL
    const { impl } = scriptedSpawn([{ kind: 'stdout', text: `QR_IMAGE=${fakePath}\n` }])
    const second = createLoginManager({ spawnImpl: impl, probe: probeOf(), cliPath: () => '' })
    const promise = second.start()
    // 不等满 30 秒：只要它没有立刻 resolve 成成功即可
    const raced = await Promise.race([
      promise,
      new Promise(resolve => setTimeout(() => resolve({ pending: true }), 120)),
    ])
    assert.equal(raced.pending, true, '伪造 PNG 不该立刻返回成功')
    second.cancel()
    manager.cancel()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('安全：data URL 不含路径信息（只含图片字节）', async () => {
  const dir = tmpDir()
  const pngPath = path.join(dir, 'qrcode.png')
  fs.writeFileSync(pngPath, PNG_1PX)
  try {
    const { impl } = scriptedSpawn([{ kind: 'stdout', text: `QR_IMAGE=${pngPath}\n` }])
    const manager = createLoginManager({ spawnImpl: impl, probe: probeOf(), cliPath: () => '' })
    const result = await manager.start()
    assert.doesNotMatch(result.imageDataUrl, /tmp|qrcode|file:/)
    assert.match(result.imageDataUrl, /^data:image\/png;base64,[A-Za-z0-9+/=]+$/)
    manager.cancel()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
