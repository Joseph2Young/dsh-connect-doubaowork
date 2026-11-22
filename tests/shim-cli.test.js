import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDoubaoShim } from '../shim.js'
import { buildRequestBody, pumpSse } from '../doubao-protocol.js'
import { catalogFromCli, deriveCatalog, resolveModel, DOUBAO_DEFAULT_MODEL } from '../catalog.js'
import { DOUBAO_DEFAULTS, DOUBAO_QUERY } from '../config.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 假 CLI 后端：可编排每次 run 的行为，并记录收到的任务。
 * 与真实 cli-backend.createCliClient 的契约完全一致（available/run）。
 */
function makeFakeCli({ available = true, script = null } = {}) {
  const calls = []
  return {
    calls,
    available: () => available,
    async run(task) {
      calls.push(task)
      const steps = typeof script === 'function' ? script(task, calls.length) : script ?? []
      for (const step of steps) {
        if (step.kind === 'init') task.onInit?.(step.sessionId)
        else if (step.kind === 'delta') task.onDelta?.(step.text)
        else if (step.kind === 'tool') task.onTool?.([{ name: step.name, status: 'ready' }])
        else if (step.kind === 'stray') task.onStray?.(step.text)
      }
      return {
        ok: steps.some(step => step.kind === 'ok') || !steps.some(step => step.kind === 'fail'),
        sessionId: steps.find(step => step.kind === 'session')?.sessionId ?? '',
        text: steps.filter(step => step.kind === 'delta').map(step => step.text).join(''),
        errors: steps.filter(step => step.kind === 'fail').map(step => step.text),
        denials: [],
      }
    },
  }
}

function makeShim({ cli, backend, catalogModels, conversationMode } = {}) {
  const base = catalogModels ?? deriveCatalog([])
  return createDoubaoShim({
    catalog: () => base,
    resolveModel: (id, list) => resolveModel(id, list ?? base),
    // CLI 后端不需要账号池；返回空数组以证明 CLI 路径不依赖 Cookie
    accounts: () => [],
    buildBody: buildRequestBody,
    pump: pumpSse,
    log: () => {},
    cli,
    defaults: {
      ...DOUBAO_DEFAULTS,
      query: DOUBAO_QUERY,
      defaultModel: DOUBAO_DEFAULT_MODEL,
      chatUrl: 'http://127.0.0.1:1/never',
      timeoutSeconds: 5,
      heartbeatSeconds: 0,
      backend: backend ?? 'auto',
      ...(conversationMode === undefined ? {} : { conversationMode }),
    },
  })
}

function parseSse(text) {
  const lines = text.split('\n\n').filter(Boolean).filter(line => line.startsWith('data: '))
  const done = lines[lines.length - 1]
  assert.equal(done, 'data: [DONE]')
  return lines.slice(0, -1).map(line => JSON.parse(line.slice(6)))
}

async function chat(shim, body) {
  return await fetch(`${shim.baseUrl()}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${shim.token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('CLI 后端：无 Cookie 也能出流（含 session 绑定与 SSE 形状）', async () => {
  const cli = makeFakeCli({
    script: [
      { kind: 'init', sessionId: 'cli-sess-1' },
      { kind: 'delta', text: '你好，' },
      { kind: 'delta', text: '我是豆包。' },
      { kind: 'ok' },
    ],
  })
  const shim = makeShim({ cli })
  await shim.start()
  try {
    const response = await chat(shim, {
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: '打个招呼' }],
      stream: true,
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'text/event-stream')
    const chunks = parseSse(await response.text())
    assert.deepEqual(chunks.map(c => c.choices[0].delta), [
      { content: '你好，' },
      { content: '我是豆包。' },
      {},
    ])
    assert.equal(chunks[chunks.length - 1].choices[0].finish_reason, 'stop')
    // 响应里回的是目录友好 id（用户看到的），CLI 侧拿到的是上游 id
    assert.equal(chunks[0].model, 'deepseek-v4-flash')
    // CLI 只认自己的上游 id：友好名 deepseek-v4-flash → person-deepseek-v4-1-flash-261017
    assert.equal(cli.calls[0].model, 'person-deepseek-v4-1-flash-261017')
    assert.equal(cli.calls[0].sessionId, '')
    assert.equal(cli.calls[0].prompt, '用户：打个招呼')
  } finally {
    await shim.close()
  }
})

test('CLI 后端 single 模式：第二轮复用同一条 CLI 会话，且只发最后一条 user 文本', async () => {
  const cli = makeFakeCli({
    script: [
      { kind: 'init', sessionId: 'cli-sess-1' },
      { kind: 'delta', text: '第一轮答案' },
      { kind: 'ok' },
    ],
  })
  const shim = makeShim({ cli })
  await shim.start()
  try {
    await (await chat(shim, {
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: '第一问' }],
      stream: true,
    })).text()
    const second = await chat(shim, {
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'user', content: '第一问' },
        { role: 'assistant', content: '第一轮答案' },
        { role: 'user', content: '第二问' },
      ],
      stream: true,
    })
    const chunks = parseSse(await second.text())
    assert.deepEqual(chunks[0].choices[0].delta, { content: '第一轮答案' })
    // 第二轮必须 --resume 到同一 session
    assert.equal(cli.calls[1].sessionId, 'cli-sess-1')
    // 第二轮只发增量，不重复历史
    assert.equal(cli.calls[1].prompt, '第二问')
  } finally {
    await shim.close()
  }
})

test('CLI 后端 per-chat 模式：不同会话各自绑定 session', async () => {
  const cli = makeFakeCli({
    script: (task, index) => [
      { kind: 'init', sessionId: `sess-${index}` },
      { kind: 'delta', text: `答${index}` },
      { kind: 'ok' },
    ],
  })
  const shim = makeShim({ cli, conversationMode: 'per-chat' })
  await shim.start()
  try {
    await (await chat(shim, {
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: '会话甲' }],
      stream: true,
    })).text()
    await (await chat(shim, {
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: '会话乙' }],
      stream: true,
    })).text()
    // 两个不同 convKey → 两个独立 session，都不带 resume
    assert.equal(cli.calls[0].sessionId, '')
    assert.equal(cli.calls[1].sessionId, '')
    // 第三轮回到会话甲，应 resume sess-1
    const third = await chat(shim, {
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'user', content: '会话甲' },
        { role: 'assistant', content: '答1' },
        { role: 'user', content: '继续甲' },
      ],
      stream: true,
    })
    await third.text()
    assert.equal(cli.calls[2].sessionId, 'sess-1')
    assert.equal(cli.calls[2].prompt, '继续甲')
  } finally {
    await shim.close()
  }
})

test('CLI 后端：非流式返回 chat.completion JSON', async () => {
  const cli = makeFakeCli({
    script: [
      { kind: 'init', sessionId: 's1' },
      { kind: 'delta', text: '完整答案' },
      { kind: 'ok' },
    ],
  })
  const shim = makeShim({ cli })
  await shim.start()
  try {
    const response = await chat(shim, {
      model: 'doubao-2.1-pro',
      messages: [{ role: 'user', content: '问' }],
      stream: false,
    })
    assert.equal(response.headers.get('content-type'), 'application/json')
    const payload = await response.json()
    assert.equal(payload.object, 'chat.completion')
    assert.equal(payload.choices[0].message.content, '完整答案')
    assert.equal(payload.model, 'doubao-2.1-pro')
  } finally {
    await shim.close()
  }
})

test('CLI 后端：CLI 失败且无输出 → 502 带错误详情', async () => {
  const cli = makeFakeCli({
    script: [{ kind: 'fail', text: 'login_required: 当前未登录，请运行 `doubao login` 登录' }],
  })
  const shim = makeShim({ cli })
  await shim.start()
  try {
    const response = await chat(shim, {
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: '问' }],
      stream: true,
    })
    // 流头已写（SSE 已开始），错误以正文形式给出
    assert.equal(response.status, 200)
    const chunks = parseSse(await response.text())
    assert.match(chunks[0].choices[0].delta.content, /login_required/)
  } finally {
    await shim.close()
  }
})

test('CLI 后端：CLI 已有部分输出后失败，保留已流出内容', async () => {
  const cli = makeFakeCli({
    script: [
      { kind: 'init', sessionId: 's1' },
      { kind: 'delta', text: '部分答案' },
      { kind: 'fail', text: '网络中断' },
    ],
  })
  const shim = makeShim({ cli })
  await shim.start()
  try {
    const chunks = parseSse(await (await chat(shim, {
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: '问' }],
      stream: true,
    })).text())
    assert.deepEqual(chunks[0].choices[0].delta, { content: '部分答案' })
    assert.equal(chunks[chunks.length - 1].choices[0].finish_reason, 'stop')
  } finally {
    await shim.close()
  }
})

test('backend=http 时不走 CLI（即使 CLI 可用）', async () => {
  const cli = makeFakeCli({ script: [{ kind: 'delta', text: '不该出现' }, { kind: 'ok' }] })
  const shim = makeShim({ cli, backend: 'http' })
  await shim.start()
  try {
    const response = await chat(shim, {
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: '问' }],
      stream: true,
    })
    // 没有 Cookie 也没有 CLI → HTTP 路径报 503
    assert.equal(response.status, 503)
    assert.equal(cli.calls.length, 0)
  } finally {
    await shim.close()
  }
})

test('backend=auto：CLI 不可用时回落 HTTP（无凭据 → 503 提示两种途径）', async () => {
  const cli = makeFakeCli({ available: false })
  const shim = makeShim({ cli, backend: 'auto' })
  await shim.start()
  try {
    const response = await chat(shim, {
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: '问' }],
      stream: true,
    })
    assert.equal(response.status, 503)
    const payload = await response.json()
    assert.match(payload.error.message, /豆包 CLI/)
    assert.match(payload.error.message, /credentials\.json/)
    assert.equal(cli.calls.length, 0)
  } finally {
    await shim.close()
  }
})

test('CLI 后端：模型不在静态表里也能路由（CLI 独有模型）', async () => {
  const base = catalogFromCli([{ id: 'brand-new-model', name: '新模型' }])
  const cli = makeFakeCli({ script: [{ kind: 'delta', text: '新模型回答' }, { kind: 'ok' }] })
  const shim = makeShim({ cli, catalogModels: base })
  await shim.start()
  try {
    const chunks = parseSse(await (await chat(shim, {
      model: 'brand-new-model',
      messages: [{ role: 'user', content: '问' }],
      stream: true,
    })).text())
    assert.deepEqual(chunks[0].choices[0].delta, { content: '新模型回答' })
    assert.equal(cli.calls[0].model, 'brand-new-model')
  } finally {
    await shim.close()
  }
})

test('CLI 后端：auto 模型不传 --model（交给 CLI 默认）', async () => {
  const cli = makeFakeCli({ script: [{ kind: 'delta', text: 'ok' }, { kind: 'ok' }] })
  const shim = makeShim({ cli })
  await shim.start()
  try {
    await (await chat(shim, {
      model: 'auto',
      messages: [{ role: 'user', content: '问' }],
      stream: true,
    })).text()
    assert.equal(cli.calls[0].model, '')
  } finally {
    await shim.close()
  }
})

test('CLI 后端：backend=cli 但未装配 cli 桥 → 503 明确提示，不抛内部异常', async () => {
  const shim = makeShim({ cli: null, backend: 'cli' })
  await shim.start()
  try {
    const response = await chat(shim, { model: DOUBAO_DEFAULT_MODEL, messages: [{ role: 'user', content: '你好' }], stream: true })
    const text = await response.text()
    assert.match(text, /未装配 CLI 桥/)
    assert.doesNotMatch(text, /Cannot read properties/)
  } finally {
    await shim.close()
  }
})

test('CLI 后端：宿主 tools 只记一次提示，不重复刷日志', async () => {
  const logs = []
  const cli = makeFakeCli({ script: [{ kind: 'delta', text: 'ok' }, { kind: 'ok' }] })
  const base = deriveCatalog([])
  const shim = createDoubaoShim({
    catalog: () => base,
    resolveModel: (id, list) => resolveModel(id, list ?? base),
    accounts: () => [],
    buildBody: buildRequestBody,
    pump: pumpSse,
    log: (level, message) => logs.push(`${level}:${message}`),
    cli,
    defaults: {
      ...DOUBAO_DEFAULTS, query: DOUBAO_QUERY, defaultModel: DOUBAO_DEFAULT_MODEL,
      chatUrl: 'http://127.0.0.1:1/never', timeoutSeconds: 5, heartbeatSeconds: 0, backend: 'cli',
    },
  })
  await shim.start()
  try {
    const tool = { type: 'function', function: { name: 'read_file', description: 'x', parameters: {} } }
    for (let i = 0; i < 3; i += 1) {
      const response = await chat(shim, { model: DOUBAO_DEFAULT_MODEL, messages: [{ role: 'user', content: `第 ${i} 轮` }], tools: [tool], stream: false })
      await response.text()
    }
    const notes = logs.filter(line => line.includes('不转发宿主 tools'))
    assert.equal(notes.length, 1, `应只提示一次，实际 ${notes.length} 次`)
  } finally {
    await shim.close()
  }
})

test('CLI 会话绑定落盘：新 shim 实例（模拟宿主重启）继续复用同一条豆包会话', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-shim-conv-'))
  const file = path.join(dir, 'conversations.json')
  const base = deriveCatalog([])

  const makeShimWithFile = cli => createDoubaoShim({
    catalog: () => base,
    resolveModel: (id, list) => resolveModel(id, list ?? base),
    accounts: () => [],
    buildBody: buildRequestBody,
    pump: pumpSse,
    log: () => {},
    cli,
    conversationsFile: file,
    defaults: {
      ...DOUBAO_DEFAULTS, query: DOUBAO_QUERY, defaultModel: DOUBAO_DEFAULT_MODEL,
      chatUrl: 'http://127.0.0.1:1/never', timeoutSeconds: 5, heartbeatSeconds: 0,
      backend: 'cli', conversationMode: 'single',
    },
  })

  const firstCli = makeFakeCli({ script: [{ kind: 'init', sessionId: '38454545920753666' }, { kind: 'delta', text: '收到' }, { kind: 'ok' }] })
  const first = makeShimWithFile(firstCli)
  await first.start()
  try {
    const response = await chat(first, { model: DOUBAO_DEFAULT_MODEL, messages: [{ role: 'user', content: '第一轮' }], stream: false })
    assert.equal(response.status, 200)
    await response.text()
    // 首轮没有绑定，必须不传 sessionId
    assert.equal(firstCli.calls[0].sessionId, '')
  } finally {
    await first.close()
  }

  // 模拟宿主重启：全新 shim，同一个落盘文件
  const secondCli = makeFakeCli({ script: [{ kind: 'delta', text: '继续' }, { kind: 'ok' }] })
  const second = makeShimWithFile(secondCli)
  await second.start()
  try {
    const response = await chat(second, { model: DOUBAO_DEFAULT_MODEL, messages: [{ role: 'user', content: '第二轮' }], stream: false })
    assert.equal(response.status, 200)
    await response.text()
    assert.equal(secondCli.calls[0].sessionId, '38454545920753666', '第二轮必须 --resume 首轮那条会话，否则豆包侧会新建一条记录')
  } finally {
    await second.close()
  }
})

test('CLI 会话失效（712017001 数据不存在）：清掉绑定并无 resume 重建一次', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-shim-stale-'))
  const file = path.join(dir, 'conversations.json')
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    entries: { 'dsh-single': { conversationId: '99999999999999999', accountId: 'cli', backend: 'cli', updatedAt: 1 } },
  }))
  const base = deriveCatalog([])
  const logs = []
  // 第一次调用（带 resume）失败，第二次（无 resume）成功
  const cli = {
    calls: [],
    available: () => true,
    async run(task) {
      this.calls.push(task)
      if (this.calls.length === 1) {
        assert.equal(task.sessionId, '99999999999999999')
        return { ok: false, sessionId: '', text: '', errors: ['数据不存在（错误码 712017001）', '豆包 CLI 退出码 1'], denials: [] }
      }
      assert.equal(task.sessionId, '', '重建时必须不带 --resume')
      task.onInit?.('new-session-42')
      task.onDelta?.('重建成功')
      return { ok: true, sessionId: 'new-session-42', text: '重建成功', errors: [], denials: [] }
    },
  }
  const shim = createDoubaoShim({
    catalog: () => base,
    resolveModel: (id, list) => resolveModel(id, list ?? base),
    accounts: () => [],
    buildBody: buildRequestBody,
    pump: pumpSse,
    log: (level, message) => logs.push(`${level}:${message}`),
    cli,
    conversationsFile: file,
    defaults: {
      ...DOUBAO_DEFAULTS, query: DOUBAO_QUERY, defaultModel: DOUBAO_DEFAULT_MODEL,
      chatUrl: 'http://127.0.0.1:1/never', timeoutSeconds: 5, heartbeatSeconds: 0,
      backend: 'cli', conversationMode: 'single',
    },
  })
  await shim.start()
  try {
    const response = await chat(shim, { model: DOUBAO_DEFAULT_MODEL, messages: [{ role: 'user', content: '你好' }], stream: false })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.choices[0].message.content, '重建成功')
    assert.equal(cli.calls.length, 2)
    assert.ok(logs.some(line => line.includes('已失效')), '应记录失效重建日志')
  } finally {
    await shim.close()
  }

  // 新绑定已落盘
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(stored.entries['dsh-single'].conversationId, 'new-session-42')
})
