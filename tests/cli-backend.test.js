import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import {
  parseStreamJsonLine,
  parseModelListResult,
  createTaskQueue,
  createCliClient,
  probeCli,
  fetchCliModels,
  cliCandidatePaths,
} from '../cli-backend.js'

/** 造一个假子进程：可控 stdout/stderr 输出与退出码。 */
function fakeChild() {
  const child = new EventEmitter()
  child.stdout = new Readable({ read() {} })
  child.stderr = new Readable({ read() {} })
  child.killed = false
  child.kill = () => {
    child.killed = true
  }
  return child
}

/** 按脚本顺序吐出 stdout 行，然后 close。 */
function scriptedSpawn(lines, { code = 0, stderr = '' } = {}) {
  const calls = []
  const spawnImpl = (cmd, args, options) => {
    const child = fakeChild()
    calls.push({ cmd, args, options })
    setImmediate(() => {
      for (const line of lines) child.stdout.push(`${line}\n`)
      if (stderr !== '') child.stderr.push(stderr)
      child.stdout.push(null)
      child.stderr.push(null)
      child.emit('close', code)
    })
    return child
  }
  return { spawnImpl, calls }
}

test('parseStreamJsonLine 解析 init / delta / assistant / result', () => {
  assert.deepEqual(
    parseStreamJsonLine('{"type":"system","subtype":"init","session_id":"c-1"}'),
    { kind: 'init', sessionId: 'c-1', subtype: 'init' },
  )
  assert.deepEqual(
    parseStreamJsonLine('{"type":"stream_event","message_id":"m1","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"你好"}}}'),
    { kind: 'delta', messageId: 'm1', text: '你好' },
  )
  const message = parseStreamJsonLine('{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"答案"}]}}')
  assert.equal(message.kind, 'message')
  assert.equal(message.role, 'assistant')
  assert.equal(message.text, '答案')
  const withTool = parseStreamJsonLine('{"type":"assistant","message":{"id":"m2","content":[{"type":"tool_use","name":"Read","input_status":"ready"}]}}')
  assert.deepEqual(withTool.tools, [{ name: 'Read', status: 'ready' }])
  const result = parseStreamJsonLine('{"type":"result","subtype":"success","is_error":false,"session_id":"c-1","result":{"type":"text","content":"收尾"},"permission_denials":[{"tool_name":"Bash","prompt":"允许吗"}]}')
  assert.equal(result.kind, 'result')
  assert.equal(result.ok, true)
  assert.equal(result.text, '收尾')
  assert.deepEqual(result.denials, [{ toolName: 'Bash', prompt: '允许吗' }])
})

test('parseStreamJsonLine 非 JSON 行（未登录提示）归一为 stray', () => {
  const event = parseStreamJsonLine('login_required: 当前未登录，请运行 `doubao login` 登录')
  assert.equal(event.kind, 'stray')
  assert.match(event.text, /login_required/)
  assert.equal(parseStreamJsonLine('   ').kind, 'empty')
  assert.equal(parseStreamJsonLine('{"type":"weird.event"}').kind, 'unknown')
})

test('parseModelListResult 归一模型清单', () => {
  const models = parseModelListResult({
    type: 'result',
    result: {
      type: 'model_list',
      models: [
        { id: 'doubao-2.1-pro', name: '豆包 2.1 Pro', is_default: false, efforts: ['low', 'high'], default_effort: 'high' },
        { id: '', name: '空的要丢掉' },
        { id: 'deepseek-v4-flash', name: '' },
      ],
    },
  })
  assert.deepEqual(models.map(m => m.id), ['doubao-2.1-pro', 'deepseek-v4-flash'])
  assert.equal(models[0].defaultEffort, 'high')
  assert.deepEqual(models[0].efforts, ['low', 'high'])
  // name 为空时回落 id
  assert.equal(models[1].name, 'deepseek-v4-flash')
  assert.deepEqual(parseModelListResult(null), [])
})

test('createTaskQueue 串行执行，超限排队', async () => {
  const queue = createTaskQueue(1)
  const order = []
  const task = id => () => new Promise(resolve => {
    order.push(`start-${id}`)
    setTimeout(() => {
      order.push(`end-${id}`)
      resolve(id)
    }, 5)
  })
  const [a, b] = await Promise.all([queue.run(task('a')), queue.run(task('b'))])
  assert.equal(a, 'a')
  assert.equal(b, 'b')
  assert.deepEqual(order, ['start-a', 'end-a', 'start-b', 'end-b'])
})

test('createCliClient 组装参数并流式产出 delta + 会话绑定', async () => {
  const { spawnImpl, calls } = scriptedSpawn([
    '{"type":"system","subtype":"init","session_id":"conv-9"}',
    '{"type":"stream_event","message_id":"m1","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"你"}}}',
    '{"type":"stream_event","message_id":"m1","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"好"}}}',
    '{"type":"result","subtype":"success","is_error":false,"session_id":"conv-9","result":{"type":"text","content":"你好"}}',
  ])
  const client = createCliClient({
    cliPath: '/fake/doubao',
    workspace: '/tmp',
    permissionMode: 'always_allow',
    spawnImpl,
  })
  const deltas = []
  const inits = []
  const outcome = await client.run({
    prompt: '打个招呼',
    model: 'doubao-2.1-pro',
    effort: 'high',
    onDelta: text => deltas.push(text),
    onInit: id => inits.push(id),
  })
  assert.deepEqual(deltas, ['你', '好'])
  assert.deepEqual(inits, ['conv-9'])
  assert.equal(outcome.ok, true)
  assert.equal(outcome.sessionId, 'conv-9')
  assert.equal(outcome.text, '你好')
  const args = calls[0].args
  assert.deepEqual(args.slice(0, 2), ['-C', '/tmp'])
  assert.ok(args.includes('-p') && args.includes('打个招呼'))
  assert.ok(args.includes('--model') && args.includes('doubao-2.1-pro'))
  assert.ok(args.includes('--effort') && args.includes('high'))
  assert.ok(args.includes('--permission-mode') && args.includes('always_allow'))
  assert.deepEqual(args.slice(-2), ['--output-format', 'stream-json'])
  // 首轮不带 --resume
  assert.equal(args.includes('--resume'), false)
})

test('createCliClient 续会话时带 --resume <sessionId>', async () => {
  const { spawnImpl, calls } = scriptedSpawn([
    '{"type":"result","subtype":"success","is_error":false,"session_id":"conv-9","result":{"type":"text","content":"继续"}}',
  ])
  const client = createCliClient({ cliPath: '/fake/doubao', workspace: '/tmp', spawnImpl })
  const outcome = await client.run({ prompt: '第二问', sessionId: 'conv-9' })
  assert.equal(outcome.ok, true)
  const args = calls[0].args
  const resumeIdx = args.indexOf('--resume')
  assert.ok(resumeIdx >= 0)
  assert.equal(args[resumeIdx + 1], 'conv-9')
})

test('createCliClient：干净文本行（未登录）记为错误', async () => {
  const { spawnImpl } = scriptedSpawn(['login_required: 当前未登录，请运行 `doubao login` 登录'], { code: 1 })
  const client = createCliClient({ cliPath: '/fake/doubao', spawnImpl })
  const strays = []
  const outcome = await client.run({ prompt: 'hi', onStray: text => strays.push(text) })
  assert.equal(outcome.ok, false)
  assert.equal(strays.length, 1)
  assert.match(outcome.errors.join(' '), /login_required/)
})

test('createCliClient：没有 result 事件时以退出码判失败', async () => {
  const { spawnImpl } = scriptedSpawn([], { code: 2, stderr: 'boom' })
  const client = createCliClient({ cliPath: '/fake/doubao', spawnImpl })
  const outcome = await client.run({ prompt: 'hi' })
  assert.equal(outcome.ok, false)
  assert.match(outcome.errors.join(' '), /退出码 2/)
  assert.match(outcome.errors.join(' '), /boom/)
})

test('createCliClient：超时终止子进程', async () => {
  const child = fakeChild()
  const spawnImpl = () => {
    setImmediate(() => {
      child.stdout.push('{"type":"system","subtype":"init","session_id":"c-1"}\n')
    })
    return child
  }
  const client = createCliClient({ cliPath: '/fake/doubao', timeoutSeconds: 0.05, spawnImpl })
  const outcome = await client.run({ prompt: '慢任务' })
  assert.equal(child.killed, true)
  assert.equal(outcome.ok, false)
  assert.match(outcome.errors.join(' '), /超时/)
})

test('createCliClient：排队期间就 abort 时不会白跑子进程', async () => {
  let spawned = 0
  const spawnImpl = () => {
    spawned += 1
    return fakeChild()
  }
  const client = createCliClient({ cliPath: '/fake/doubao', spawnImpl })
  const controller = new AbortController()
  controller.abort()
  const outcome = await client.run({ prompt: 'x', signal: controller.signal })
  assert.equal(outcome.ok, false)
  assert.match(outcome.errors.join(' '), /断开/)
  // 信号在拉起前已 abort：直接返回，不浪费一次 CLI 启动
  assert.equal(spawned, 0)
})

test('createCliClient：运行中被 abort 时终止子进程', async () => {
  const child = fakeChild()
  const spawnImpl = () => child
  const client = createCliClient({ cliPath: '/fake/doubao', spawnImpl })
  const controller = new AbortController()
  const pending = client.run({ prompt: 'x', signal: controller.signal })
  // 等子进程真正起来（队列用微任务调度）再取消
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  const outcome = await pending
  assert.equal(outcome.ok, false)
  assert.match(outcome.errors.join(' '), /断开/)
  assert.equal(child.killed, true)
})

test('probeCli 报告已安装且已登录', async () => {
  const results = [
    { out: 'doubao 2.37.2\n', code: 0 },
    { out: '已登录：user@example.com\n', code: 0 },
  ]
  let index = 0
  const spawnImpl = () => {
    const child = fakeChild()
    const script = results[index++]
    setImmediate(() => {
      if (script.out.startsWith('doubao')) child.stdout.push(script.out)
      else child.stdout.push(script.out)
      child.stdout.push(null)
      child.stderr.push(null)
      child.emit('close', script.code)
    })
    return child
  }
  const state = await probeCli({ cliPath: '/fake/doubao', spawnImpl })
  assert.equal(state.installed, true)
  assert.equal(state.version, '2.37.2')
  assert.equal(state.loggedIn, true)
})

test('probeCli 报告未登录', async () => {
  const scripts = [
    { out: 'doubao 2.37.2\n', code: 0 },
    { out: 'login_required: 当前未登录，请运行 `doubao login` 登录\n', code: 1 },
  ]
  let index = 0
  const spawnImpl = () => {
    const child = fakeChild()
    const script = scripts[index++] ?? { out: '', code: 1 }
    setImmediate(() => {
      child.stdout.push(script.out)
      child.stdout.push(null)
      child.stderr.push(null)
      child.emit('close', script.code)
    })
    return child
  }
  const state = await probeCli({ cliPath: '/fake/doubao', spawnImpl })
  assert.equal(state.installed, true)
  assert.equal(state.loggedIn, false)
})

test('probeCli 报告未安装（ENOENT 也不会抛）', async () => {
  const spawnImpl = () => {
    const child = fakeChild()
    setImmediate(() => {
      const error = new Error('spawn doubao ENOENT')
      error.code = 'ENOENT'
      child.emit('error', error)
    })
    return child
  }
  const state = await probeCli({ cliPath: '/nope/doubao', spawnImpl })
  assert.equal(state.installed, false)
  assert.equal(state.loggedIn, false)
  assert.match(state.message, /ENOENT/)
})

test('fetchCliModels 解析 result 行的模型清单', async () => {
  const { spawnImpl, calls } = scriptedSpawn([
    '{"type":"result","subtype":"success","is_error":false,"result":{"type":"model_list","models":[{"id":"kimi-k3","name":"Kimi K3","efforts":["high"]}]}}',
  ])
  const listing = await fetchCliModels({ cliPath: '/fake/doubao', spawnImpl })
  assert.equal(listing.error, '')
  assert.deepEqual(listing.models.map(m => m.id), ['kimi-k3'])
  assert.deepEqual(calls[0].args, ['model', 'list', '--json'])
})

test('fetchCliModels 未登录时返回错误文案与空清单', async () => {
  const { spawnImpl } = scriptedSpawn(['login_required: 当前未登录'], { code: 1 })
  const listing = await fetchCliModels({ cliPath: '/fake/doubao', spawnImpl })
  assert.deepEqual(listing.models, [])
  assert.match(listing.error, /login_required/)
})

test('cliCandidatePaths 覆盖 npm 全局 bin / homebrew / PATH', () => {
  const candidates = cliCandidatePaths({ HOME: '/home/u', PATH: '/usr/bin:/opt/bin', npm_config_prefix: '/home/u/.npm-global' })
  assert.ok(candidates.includes('/home/u/.npm-global/bin/doubao'))
  assert.ok(candidates.includes('/opt/homebrew/bin/doubao'))
  assert.ok(candidates.includes('/opt/bin/doubao'))
  assert.ok(candidates.includes('/usr/local/bin/doubao'))
  // 去重
  assert.equal(new Set(candidates).size, candidates.length)
})
