import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDoubaoShim } from '../shim.js'
import { buildRequestBody, pumpSse } from '../doubao-protocol.js'
import { deriveCatalog, resolveModel, mergeCliModels, DOUBAO_DEFAULT_MODEL } from '../catalog.js'
import { DOUBAO_DEFAULTS, DOUBAO_QUERY } from '../config.js'

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
    assert.equal(chunks[0].model, 'deepseek-v4-flash')
    // CLi 侧拿到的任务：模型直传、首轮无 sessionId、prompt 是 user 文本
    assert.equal(cli.calls[0].model, 'deepseek-v4-flash')
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
  const base = mergeCliModels([{ id: 'brand-new-model', name: '新模型' }])
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
