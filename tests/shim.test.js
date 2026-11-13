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

function makeShim(mockPort, { withCredential = true } = {}) {
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
