import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createDoubaoShim } from '../shim.js'
import { buildRequestBody, pumpSse } from '../doubao-protocol.js'
import { deriveCatalog, resolveModel, DOUBAO_DEFAULT_MODEL } from '../catalog.js'
import { DOUBAO_DEFAULTS, DOUBAO_QUERY } from '../config.js'

/** mock 豆包上游：记录请求并回放固定 SSE。 */
const SSE_PAYLOAD = [
  ': ping',
  '',
  'event: SSE_HEARTBEAT',
  'data: {}',
  '',
  'event: SSE_ACK',
  'data: {"ack_client_meta":{"conversation_id":"conv-123","section_id":"sec-1"}}',
  '',
  'event: STREAM_CHUNK',
  'data: {"patch_op":[{"patch_value":{"content_block":[{"block_type":10040,"content":{"thinking_block":{"streaming_title":"正在思考"}}}]}}]}',
  '',
  'event: CHUNK_DELTA',
  'data: {"text":"你好，"}',
  '',
  'event: CHUNK_DELTA',
  'data: {"text":"我是豆包工作模式。"}',
  '',
  'event: SSE_REPLY_END',
  'data: {"end_type":1,"msg_finish_attr":{"brief":"完整答案兜底"}}',
  '',
].join('\n')

async function startMockUpstream(requests) {
  return await new Promise(resolve => {
    const server = http.createServer((req, res) => {
      let raw = ''
      req.on('data', chunk => {
        raw += chunk
      })
      req.on('end', () => {
        let body = {}
        try {
          body = JSON.parse(raw)
        } catch {}
        requests.push({ url: req.url, headers: req.headers, body })
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.end(SSE_PAYLOAD)
      })
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

const CREDENTIAL = Object.freeze({
  cookie: 'sessionid=abc; sid_tt=x;',
  deviceId: 'dev-1',
  webId: 'web-9',
  teaUuid: '',
  localAppId: '582478',
})

function makeShim(mockPort, { withCredential = true, conversationMode } = {}) {
  return createDoubaoShim({
    catalog: () => deriveCatalog([]),
    resolveModel,
    credentials: () => (withCredential ? { ...CREDENTIAL } : undefined),
    buildBody: buildRequestBody,
    pump: pumpSse,
    defaults: {
      ...DOUBAO_DEFAULTS,
      query: DOUBAO_QUERY,
      defaultModel: DOUBAO_DEFAULT_MODEL,
      chatUrl: `http://127.0.0.1:${mockPort}/chat/completion`,
      timeoutSeconds: 5,
      heartbeatSeconds: 0,
      ...(conversationMode !== undefined ? { conversationMode } : {}),
    },
  })
}

function parseSse(text) {
  const lines = text.split('\n\n').filter(Boolean).filter(line => line.startsWith('data: '))
  const done = lines[lines.length - 1]
  assert.equal(done, 'data: [DONE]')
  return lines.slice(0, -1).map(line => JSON.parse(line.slice(6)))
}

test('shim 全链路：OpenAI 请求 → 豆包工作模式 → OpenAI SSE', async () => {
  const requests = []
  const mock = await startMockUpstream(requests)
  const shim = makeShim(mock.address().port)
  await shim.start()
  try {
    const response = await fetch(`${shim.baseUrl()}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${shim.token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        messages: [
          { role: 'system', content: '你是助手' },
          { role: 'user', content: '打个招呼' },
        ],
        max_completion_tokens: 1024,
        store: false,
        stream: true,
      }),
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'text/event-stream')
    const chunks = parseSse(await response.text())
    const deltas = chunks.map(chunk => chunk.choices[0].delta)
    assert.deepEqual(deltas, [
      { reasoning_content: '正在思考' },
      { content: '你好，' },
      { content: '我是豆包工作模式。' },
      {},
    ])
    assert.equal(chunks[chunks.length - 1].choices[0].finish_reason, 'stop')
    assert.equal(chunks[0].object, 'chat.completion.chunk')
    assert.equal(chunks[0].model, 'deepseek-v4-flash')
    assert.ok(chunks[0].id.startsWith('chatcmpl-'))

    // 上游侧断言：请求头 / URL / 请求体
    const sent = requests[0]
    assert.equal(sent.headers.cookie, CREDENTIAL.cookie)
    assert.equal(sent.headers['x-flow-trace'], '04-0000000000000000000000000000000-0000000000000000-01')
    assert.equal(sent.headers.referer, 'https://www.doubao.com/')
    assert.ok(sent.url.includes('aid=582478'))
    assert.ok(sent.url.includes('device_id=dev-1'))
    assert.ok(sent.url.includes('fp=verify_dev-1'))
    assert.ok(sent.url.includes('tea_uuid=dev-1'))
    assert.ok(sent.url.includes('web_id=web-9'))
    assert.ok(sent.url.includes('web_tab_id='))
    assert.equal(sent.body.option.agent_mode, 1)
    assert.equal(sent.body.option.conversation_mode, 2)
    assert.equal(sent.body.option.need_create_conversation, true)
    assert.equal(sent.body.client_meta.conversation_id, '')
    assert.equal(sent.body.client_meta.bot_id, DOUBAO_DEFAULTS.botId)
    assert.equal(sent.body.option.model_config.model_item_key, 'person-deepseek-v4-1-flash-261017')

    // 第二次同会话（首条消息一致 → 同一 convKey）：SSE_ACK 的 conversation_id 被复用
    await fetch(`${shim.baseUrl()}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${shim.token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        messages: [
          { role: 'system', content: '你是助手' },
          { role: 'user', content: '打个招呼' },
          { role: 'assistant', content: '你好，我是豆包工作模式。' },
          { role: 'user', content: '再来一次' },
        ],
        stream: true,
      }),
    })
    const second = requests[1]
    assert.equal(second.body.client_meta.conversation_id, 'conv-123')
    assert.equal(second.body.option.need_create_conversation, false)
    assert.equal(second.body.option.model_config.model_item_key, 'person-deepseek-v4-1-flash-261017')
  } finally {
    await shim.close()
    await new Promise(resolve => mock.close(() => resolve()))
  }
})

test('shim 会话键漂移防御：第二轮首条消息由 system 变 user 仍复用同一豆包会话', async () => {
  // 真实场景：pi-ai 对不支持会话中 system 的模型，第二轮起把 system 移除，
  // messages[0] 从 {system,…} 变成 {user,…}。旧实现按 messages[0] 哈希做键，
  // 键漂移导致第二轮 need_create=true、豆包客户端多出一条窗口。
  // 修复后按「首条 user 消息文本」锚定，跨轮稳定。
  const requests = []
  const mock = await startMockUpstream(requests)
  const shim = makeShim(mock.address().port, { conversationMode: 'per-chat' })
  await shim.start()
  try {
    // 第一轮：system + user（DSH agent 会话的典型首轮形状）
    const first = await fetch(`${shim.baseUrl()}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${shim.token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        messages: [
          { role: 'system', content: 'DeepSeek Harness 系统提示' },
          { role: 'user', content: '生成A股全绿图片' },
        ],
        stream: true,
      }),
    })
    assert.equal(first.status, 200)
    await first.text()
    // 第二轮：system 被 pi-ai 移除，首条消息变为同文本 user
    const second = await fetch(`${shim.baseUrl()}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${shim.token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        messages: [
          { role: 'user', content: '生成A股全绿图片' },
          { role: 'assistant', content: '好的' },
          { role: 'user', content: '换个风格再来一张' },
        ],
        stream: true,
      }),
    })
    assert.equal(second.status, 200)
    await second.text()
    assert.equal(requests[0].body.option.need_create_conversation, true)
    assert.equal(requests[1].body.client_meta.conversation_id, 'conv-123')
    assert.equal(requests[1].body.option.need_create_conversation, false)
  } finally {
    await shim.close()
    await new Promise(resolve => mock.close(() => resolve()))
  }
})

test('shim single 模式：不同首条消息也复用同一条豆包会话', async () => {
  const requests = []
  const mock = await startMockUpstream(requests)
  const shim = makeShim(mock.address().port, { conversationMode: 'single' })
  await shim.start()
  try {
    for (const question of ['第一个问题', '另一个不同开头的问题']) {
      const response = await fetch(`${shim.baseUrl()}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${shim.token()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'glm-5.3', messages: [{ role: 'user', content: question }], stream: true }),
      })
      assert.equal(response.status, 200)
      await response.text()
    }
    // 两次请求首条消息不同，但 single 模式下第二条仍复用 conv-123
    assert.equal(requests[0].body.option.need_create_conversation, true)
    assert.equal(requests[1].body.client_meta.conversation_id, 'conv-123')
    assert.equal(requests[1].body.option.need_create_conversation, false)
  } finally {
    await shim.close()
    await new Promise(resolve => mock.close(() => resolve()))
  }
})

test('shim 反问块 10082 → 问题转正文并立即收尾，下一轮复用会话继续', async () => {
  // 真实行为：豆包工作模式反问时发 interaction_ask_block（10082）后不发
  // SSE_REPLY_END，长连等待用户在豆包端回答。shim 必须把问题转成正文、
  // 主动断开上游收尾；DSH 侧下一轮回答凭同一 conversation_id 续跑。
  const requests = []
  let call = 0
  const server = await new Promise(resolve => {
    const s = http.createServer((req, res) => {
      let raw = ''
      req.on('data', chunk => {
        raw += chunk
      })
      req.on('end', () => {
        let body = {}
        try {
          body = JSON.parse(raw)
        } catch {}
        requests.push({ url: req.url, body })
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        call += 1
        if (call === 1) {
          res.write('event: SSE_ACK\ndata: {"ack_client_meta":{"conversation_id":"conv-77","section_id":"sec-7"}}\n\n')
          res.write('event: STREAM_CHUNK\ndata: {"patch_op":[{"patch_value":{"content_block":[{"block_type":10000,"content":{"text_block":{"text":"我先确认一个关键信息。"}}}]}}]}\n\n')
          res.write('event: STREAM_CHUNK\ndata: {"patch_op":[{"patch_value":{"content_block":[{"block_type":10082,"content":{"interaction_ask_block":{"questions":[{"question_id":"q1","title":"请提供目标文件路径"}]}}}]}}]}\n\n')
          // 故意不 end()：模拟长连等待；shim 应主动 abort 收尾
          res.on('error', () => {})
        } else {
          res.end(SSE_PAYLOAD)
        }
      })
    })
    s.listen(0, '127.0.0.1', () => resolve(s))
  })
  const shim = makeShim(server.address().port)
  await shim.start()
  try {
    const post = messages => fetch(`${shim.baseUrl()}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${shim.token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', messages, stream: true }),
    })
    const firstMessages = [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '帮我补全代码' },
    ]
    const started = Date.now()
    const res1 = await post(firstMessages)
    assert.equal(res1.status, 200)
    const chunks1 = parseSse(await res1.text())
    const deltas1 = chunks1.map(chunk => chunk.choices[0].delta)
    assert.deepEqual(deltas1, [
      { content: '我先确认一个关键信息。' },
      { content: '\n\n❓ 请提供目标文件路径' },
      {},
    ])
    assert.equal(chunks1[chunks1.length - 1].choices[0].finish_reason, 'stop')
    // 反问轮必须远快于 timeoutSeconds=5：主动 abort 而非挂到超时
    assert.ok(Date.now() - started < 4000, `反问轮耗时 ${Date.now() - started}ms，应立即收尾`)
    assert.equal(requests[0].body.option.need_create_conversation, true)

    // 第二轮：DSH 侧回答凭同一 conversation_id 回到同一豆包会话
    const res2 = await post([
      ...firstMessages,
      { role: 'assistant', content: '我先确认一个关键信息。\n\n❓ 请提供目标文件路径' },
      { role: 'user', content: '路径是 src/a.ts' },
    ])
    assert.equal(res2.status, 200)
    const chunks2 = parseSse(await res2.text())
    assert.ok(chunks2.length > 0)
    assert.equal(requests[1].body.client_meta.conversation_id, 'conv-77')
    assert.equal(requests[1].body.option.need_create_conversation, false)
  } finally {
    await shim.close()
    await new Promise(resolve => server.close(() => resolve()))
  }
})

test('shim 非流式返回 chat.completion JSON', async () => {
  const requests = []
  const mock = await startMockUpstream(requests)
  const shim = makeShim(mock.address().port)
  await shim.start()
  try {
    const response = await fetch(`${shim.baseUrl()}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${shim.token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }], stream: false }),
    })
    assert.equal(response.status, 200)
    const data = await response.json()
    assert.equal(data.object, 'chat.completion')
    assert.equal(data.choices[0].message.role, 'assistant')
    assert.equal(data.choices[0].message.content, '你好，我是豆包工作模式。')
    assert.equal(data.choices[0].finish_reason, 'stop')
    assert.equal(requests[0].body.option.model_config.model_item_key, '9')
  } finally {
    await shim.close()
    await new Promise(resolve => mock.close(() => resolve()))
  }
})

test('shim 模型别名与默认模型', async () => {
  const requests = []
  const mock = await startMockUpstream(requests)
  const shim = makeShim(mock.address().port)
  await shim.start()
  try {
    await fetch(`${shim.baseUrl()}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${shim.token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'doubao', messages: [{ role: 'user', content: 'q' }] }),
    })
    assert.equal(requests[0].body.option.model_config.model_item_key, 'person-deepseek-v4-1-flash-261017')
    await fetch(`${shim.baseUrl()}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${shim.token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'q2' }] }),
    })
    assert.equal(requests[1].body.option.model_config.model_item_key, 'person-deepseek-v4-1-flash-261017')
  } finally {
    await shim.close()
    await new Promise(resolve => mock.close(() => resolve()))
  }
})

test('shim 鉴权：401 / 404 / healthz 免鉴权', async () => {
  const mock = await startMockUpstream([])
  const shim = makeShim(mock.address().port)
  await shim.start()
  try {
    const unauth = await fetch(`${shim.baseUrl()}/chat/completions`, { method: 'POST', body: '{}' })
    assert.equal(unauth.status, 401)
    const notFound = await fetch(`${shim.baseUrl()}/other`, { headers: { Authorization: `Bearer ${shim.token()}` } })
    assert.equal(notFound.status, 404)
    const health = await fetch(`${shim.baseUrl().replace('/v1', '')}/healthz`)
    assert.equal(health.status, 200)
    assert.equal(await health.text(), 'ok')
  } finally {
    await shim.close()
    await new Promise(resolve => mock.close(() => resolve()))
  }
})

test('shim /v1/models 列出目录', async () => {
  const mock = await startMockUpstream([])
  const shim = makeShim(mock.address().port)
  await shim.start()
  try {
    const response = await fetch(`${shim.baseUrl()}/models`, {
      headers: { Authorization: `Bearer ${shim.token()}` },
    })
    const data = await response.json()
    assert.equal(data.object, 'list')
    assert.equal(data.data.length, 10)
    assert.ok(data.data.some(m => m.id === 'deepseek-v4-flash'))
  } finally {
    await shim.close()
    await new Promise(resolve => mock.close(() => resolve()))
  }
})

test('shim 无凭据 → 503；坏 JSON → 400', async () => {
  const mock = await startMockUpstream([])
  const shim = makeShim(mock.address().port, { withCredential: false })
  await shim.start()
  try {
    const noCredential = await fetch(`${shim.baseUrl()}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${shim.token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(noCredential.status, 503)
    const badJson = await fetch(`${shim.baseUrl()}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${shim.token()}`, 'Content-Type': 'application/json' },
      body: '{oops',
    })
    assert.equal(badJson.status, 400)
    const noMessages = await fetch(`${shim.baseUrl()}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${shim.token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'auto', messages: [] }),
    })
    assert.equal(noMessages.status, 400)
  } finally {
    await shim.close()
    await new Promise(resolve => mock.close(() => resolve()))
  }
})

test('shim 上游错误透传为 502', async () => {
  const mock = await new Promise(resolve => {
    const server = http.createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        res.writeHead(401, { 'Content-Type': 'text/plain' })
        res.end('login required')
      })
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
  const shim = makeShim(mock.address().port)
  await shim.start()
  try {
    const response = await fetch(`${shim.baseUrl()}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${shim.token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(response.status, 502)
    const data = await response.json()
    assert.ok(data.error.message.includes('401'))
    assert.ok(data.error.message.includes('login required'))
  } finally {
    await shim.close()
    await new Promise(resolve => mock.close(() => resolve()))
  }
})
