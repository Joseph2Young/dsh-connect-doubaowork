import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { inspectSetup, formatSetupGuide, STEP_STATUS } from '../onboarding.js'

/** 建一个临时目录，返回写入器与清理函数。 */
function tmpWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-onboarding-'))
  return {
    dir,
    write(name, content) {
      const file = path.join(dir, name)
      fs.writeFileSync(file, content, { mode: 0o600 })
      return file
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** 假 CLI 探测器：不拉子进程。 */
const probeOf = state => async () => ({
  installed: false, version: '', loggedIn: false, message: '', ...state,
})

function stepOf(result, id) {
  return result.steps.find(step => step.id === id)
}

test('引导：什么都没有 → 不可用，三步里前两步都是待办', async () => {
  const ws = tmpWorkspace()
  try {
    const file = path.join(ws.dir, 'absent.json')
    const result = await inspectSetup({
      credentialsFile: file,
      autoDiscover: false,
      probe: probeOf({ installed: false }),
    })
    assert.equal(result.ready, false)
    assert.equal(result.backend, '')
    assert.equal(stepOf(result, 'credentials').status, STEP_STATUS.todo)
    assert.equal(stepOf(result, 'cli').status, STEP_STATUS.todo)
    assert.equal(stepOf(result, 'ready').status, STEP_STATUS.blocked)
    // 必须给出可执行的安装命令
    const cliFix = stepOf(result, 'cli').fix.join(' ')
    assert.match(cliFix, /npm i -g @bytedance\/doubao-cli/)
    assert.match(cliFix, /doubao login/)
  } finally {
    ws.cleanup()
  }
})

test('引导：只有 CLI 已安装已登录 → 可用且建议 cli 后端', async () => {
  const ws = tmpWorkspace()
  try {
    const result = await inspectSetup({
      credentialsFile: path.join(ws.dir, 'absent.json'),
      autoDiscover: false,
      probe: probeOf({ installed: true, version: '2.37.2', loggedIn: true }),
    })
    assert.equal(result.ready, true)
    assert.equal(result.backend, 'cli')
    assert.equal(stepOf(result, 'cli').status, STEP_STATUS.done)
    assert.equal(stepOf(result, 'ready').status, STEP_STATUS.done)
    assert.deepEqual(stepOf(result, 'cli').fix, [])
  } finally {
    ws.cleanup()
  }
})

test('引导：CLI 已安装但未登录 → warn，提示只差 doubao login', async () => {
  const ws = tmpWorkspace()
  try {
    const result = await inspectSetup({
      credentialsFile: path.join(ws.dir, 'absent.json'),
      autoDiscover: false,
      probe: probeOf({ installed: true, version: '2.37.2', loggedIn: false }),
    })
    assert.equal(result.ready, false)
    const cli = stepOf(result, 'cli')
    assert.equal(cli.status, STEP_STATUS.warn)
    assert.match(cli.detail, /未登录/)
    assert.equal(cli.fix.length, 1)
    assert.match(cli.fix[0], /doubao login/)
    // 已安装时不该再让用户去 npm install
    assert.doesNotMatch(cli.fix.join(' '), /npm i -g/)
  } finally {
    ws.cleanup()
  }
})

test('引导：账号来自桌面端自动发现 → 明确告知用户（不是静默读取）', async () => {
  const ws = tmpWorkspace()
  try {
    const emptyFile = path.join(ws.dir, 'absent.json')
    // 造一个假的 Local State：x-tt-multi-sids 形态
    const localStatePath = ws.write('Local State', JSON.stringify({
      saman: { local_storage_app_for_web: JSON.stringify({ 'x-tt-multi-sids': '12345%3Asid-value' }) },
      aha: { device: { device_id: 'dev', web_id: 'web' } },
    }))
    const result = await inspectSetup({
      credentialsFile: emptyFile,
      autoDiscover: true,
      probe: probeOf({ installed: true, version: '2.37.2', loggedIn: false }),
      // 注入桌面端路径（走 loadAccountList 的默认常量不好改，这里直接给 account）
      account: { cookie: 'sessionid=from-app; sessionid_ss=from-app', device_id: 'dev' },
    })
    // 无凭据文件但有账号 → 说明来自桌面端发现
    assert.equal(result.summary.httpReady, true)
    assert.equal(result.summary.fromDesktopApp, true)
    assert.match(stepOf(result, 'credentials').detail, /自动发现/)
    assert.match(stepOf(result, 'credentials').detail, /autoDiscoverCredentials/)
  } finally {
    ws.cleanup()
  }
})

test('引导：凭据文件存在时不该被标成「桌面端发现」', async () => {
  const ws = tmpWorkspace()
  try {
    const file = ws.write('credentials.json', JSON.stringify({ cookie: 'sessionid=abc' }))
    const result = await inspectSetup({ credentialsFile: file, autoDiscover: false, probe: probeOf({}) })
    assert.equal(result.summary.fromDesktopApp, false)
    assert.doesNotMatch(stepOf(result, 'credentials').detail, /桌面端/)
  } finally {
    ws.cleanup()
  }
})

test('引导：只有凭据文件（单账号）→ 可用，建议 http', async () => {
  const ws = tmpWorkspace()
  try {
    const file = ws.write('credentials.json', JSON.stringify({ cookie: 'sessionid=abc; sid_tt=x' }))
    const result = await inspectSetup({
      credentialsFile: file,
      autoDiscover: false,
      probe: probeOf({ installed: false }),
    })
    assert.equal(result.ready, true)
    assert.equal(result.backend, 'http')
    assert.equal(stepOf(result, 'credentials').status, STEP_STATUS.done)
    assert.match(stepOf(result, 'credentials').detail, /1 个账号/)
  } finally {
    ws.cleanup()
  }
})

test('引导：accounts 数组多账号 → 计数正确', async () => {
  const ws = tmpWorkspace()
  try {
    const file = ws.write('credentials.json', JSON.stringify({
      accounts: [
        { id: 'a1', label: '主号', cookie: 'sessionid=aaa' },
        { id: 'a2', label: '备号', cookie: 'sessionid=bbb' },
      ],
    }))
    const result = await inspectSetup({ credentialsFile: file, autoDiscover: false, probe: probeOf({}) })
    assert.equal(result.summary.accountCount, 2)
    assert.match(stepOf(result, 'credentials').detail, /2 个账号/)
  } finally {
    ws.cleanup()
  }
})

test('引导：凭据文件存在但无 sessionid → 明确提示缺什么', async () => {
  const ws = tmpWorkspace()
  try {
    const file = ws.write('credentials.json', JSON.stringify({ cookie: 'ttwid=only' }))
    const result = await inspectSetup({ credentialsFile: file, autoDiscover: false, probe: probeOf({}) })
    assert.equal(result.ready, false)
    assert.equal(stepOf(result, 'credentials').status, STEP_STATUS.todo)
    assert.match(stepOf(result, 'credentials').detail, /缺少 sessionid/)
  } finally {
    ws.cleanup()
  }
})

test('引导：凭据文件损坏 → 提示无法解析而不是崩', async () => {
  const ws = tmpWorkspace()
  try {
    const file = ws.write('credentials.json', '{ not json')
    const result = await inspectSetup({ credentialsFile: file, autoDiscover: false, probe: probeOf({}) })
    assert.equal(result.ready, false)
    assert.match(stepOf(result, 'credentials').detail, /无法解析/)
  } finally {
    ws.cleanup()
  }
})

test('引导：凭据文件权限过宽 → 只提示不阻塞', async () => {
  const ws = tmpWorkspace()
  try {
    const file = path.join(ws.dir, 'credentials.json')
    fs.writeFileSync(file, JSON.stringify({ cookie: 'sessionid=abc' }))
    fs.chmodSync(file, 0o644) // group/other 可读
    const result = await inspectSetup({ credentialsFile: file, autoDiscover: false, probe: probeOf({}) })
    const step = stepOf(result, 'credentials')
    assert.equal(step.status, STEP_STATUS.done, '权限宽不该让可用性失败')
    assert.match(step.warn, /chmod 600/)
  } finally {
    ws.cleanup()
  }
})

test('引导：双后端都可用 → 优先 cli，且说明双通', async () => {
  const ws = tmpWorkspace()
  try {
    const file = ws.write('credentials.json', JSON.stringify({ cookie: 'sessionid=abc' }))
    const result = await inspectSetup({
      credentialsFile: file,
      autoDiscover: false,
      probe: probeOf({ installed: true, version: '2.37.2', loggedIn: true }),
    })
    assert.equal(result.ready, true)
    assert.equal(result.backend, 'cli')
    assert.match(stepOf(result, 'ready').detail, /双后端均可用/)
  } finally {
    ws.cleanup()
  }
})

test('引导：探测器抛错 → 当作不可用而不是让整个引导失败', async () => {
  const ws = tmpWorkspace()
  try {
    const result = await inspectSetup({
      credentialsFile: path.join(ws.dir, 'absent.json'),
      autoDiscover: false,
      probe: async () => {
        throw new Error('spawn 失败')
      },
    })
    assert.equal(result.ready, false)
    assert.equal(stepOf(result, 'cli').status, STEP_STATUS.todo)
  } finally {
    ws.cleanup()
  }
})

test('引导：summary 不含任何凭据内容（隐私回归）', async () => {
  const ws = tmpWorkspace()
  try {
    const secret = 'sessionid=SUPER_SECRET_VALUE_123'
    const file = ws.write('credentials.json', JSON.stringify({ cookie: secret, device_id: 'D' }))
    const result = await inspectSetup({
      credentialsFile: file,
      autoDiscover: false,
      probe: probeOf({ installed: true, version: '2.37.2', loggedIn: true }),
    })
    const serialized = JSON.stringify(result) + formatSetupGuide(result)
    assert.doesNotMatch(serialized, /SUPER_SECRET_VALUE_123/, '引导结果不得包含 cookie 值')
    assert.doesNotMatch(serialized, /sessionid=SUPER/, '引导结果不得包含凭据串')
    // 路径可以出现（用户需要知道去哪配），但内容不行
    assert.match(serialized, /credentials\.json/)
  } finally {
    ws.cleanup()
  }
})

test('引导：formatSetupGuide 输出三种状态标记', async () => {
  const ws = tmpWorkspace()
  try {
    const result = await inspectSetup({
      credentialsFile: path.join(ws.dir, 'absent.json'),
      autoDiscover: false,
      probe: probeOf({ installed: true, version: '2.37.2', loggedIn: false }),
    })
    const text = formatSetupGuide(result)
    assert.match(text, /\[ \]/, '待办应显示空框')
    assert.match(text, /\[!\]/, '警告应显示感叹号')
    assert.match(text, /\[x\]/, '阻塞应显示叉号')
  } finally {
    ws.cleanup()
  }
})
