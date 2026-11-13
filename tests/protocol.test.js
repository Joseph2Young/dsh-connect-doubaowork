import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRequestBody, pumpSse, extractText, homeDir, atoiSafe, shortHash, randomDigits } from '../doubao-protocol.js'

const WORK = Object.freeze({
  botId: 'bot-1',
  modeId: '3',
  reasoningEffort: '4',
  memoryProfile: '300k_230',
  totalWindowSize: '300000',
  enableSandbox: false,
  workspace: '',
  deviceName: 'USER',
  localAppId: '582478',
  localDeviceId: 'dev-1',
})

test('buildRequestBody 工作模式字段齐全', () => {
  const body = buildRequestBody({
    messages: [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '你好' },
    ],
    modelItemKey: 'person-deepseek-v4-1-flash-261017',
    work: WORK,
    options: { workMode: true, flatten: false },
  })
  assert.equal(body.option.agent_mode, 1)
  assert.equal(body.option.conversation_mode, 2)
  assert.equal(body.option.sse_recv_event_options.support_chunk_delta, true)
  assert.equal(body.option.need_create_conversation, true)
  // model_item_key 三处一致
  assert.equal(body.option.model_config.model_item_key, 'person-deepseek-v4-1-flash-261017')
  assert.equal(body.option.aggregate_params.model_item_key, 'person-deepseek-v4-1-flash-261017')
  assert.equal(body.option.conversation_init_ext.model_item_key, 'person-deepseek-v4-1-flash-261017')
  // reasoning_effort：init ext 字符串 / model_config 数字
  assert.equal(body.option.conversation_init_ext.reasoning_effort, '4')
  assert.equal(body.option.model_config.reasoning_effort, 4)
  assert.equal(body.option.aggregate_params.reasoning_effort, '4')
  // 工作模式专属块
  assert.equal(typeof body.option.general_task_param, 'object')
  assert.equal(body.option.ext.agent_mode, '1')
  assert.ok(body.option.ext.general_task_param.includes('"agent_workspace"'))
  assert.ok(body.option.conversation_init_ext.agent_task_param.includes('"local_app_id":"582478"'))
  assert.equal(body.client_meta.bot_id, 'bot-1')
  assert.equal(body.client_meta.conversation_id, '')
  // 未压平 → 正文就是最后一条 user
  assert.equal(body.messages[0].content_block[0].content.text_block.text, '你好')
})

test('buildRequestBody 首轮压平历史', () => {
  const body = buildRequestBody({
    messages: [
      { role: 'user', content: '问题一' },
      { role: 'assistant', content: '答案一' },
      { role: 'user', content: '问题二' },
    ],
    modelItemKey: '5',
    work: WORK,
    options: { workMode: true, flatten: true },
  })
  const text = body.messages[0].content_block[0].content.text_block.text
  assert.equal(text, '用户：问题一\n助手：答案一\n用户：问题二')
})

test('buildRequestBody 已有会话不压平且 need_create=false', () => {
  const body = buildRequestBody({
    messages: [
      { role: 'user', content: '问题一' },
      { role: 'user', content: '问题二' },
    ],
    modelItemKey: '5',
    work: WORK,
    options: { workMode: true, flatten: true, conversationId: 'conv-9' },
  })
  assert.equal(body.client_meta.conversation_id, 'conv-9')
  assert.equal(body.option.need_create_conversation, false)
  const text = body.messages[0].content_block[0].content.text_block.text
  assert.equal(text, '问题二')
})

test('buildRequestBody 非工作模式回落 ext 并置零 agent 字段', () => {
  const body = buildRequestBody({
    messages: [{ role: 'user', content: 'hi' }],
    modelItemKey: '9',
    work: WORK,
    options: { workMode: false },
  })
  assert.equal(body.option.agent_mode, 0)
  assert.equal(body.option.conversation_mode, 0)
  assert.equal(body.option.general_task_param, undefined)
  assert.deepEqual(body.ext, { use_deep_think: '10001', is_finish: '1' })
})

test('buildRequestBody content 数组与纯串等价', () => {
  const body = buildRequestBody({
    messages: [{ role: 'user', content: [{ type: 'text', text: '数组文本' }] }],
    modelItemKey: '9',
    work: WORK,
  })
  assert.equal(body.messages[0].content_block[0].content.text_block.text, '数组文本')
})

test('buildRequestBody 校验错误', () => {
  assert.throws(() => buildRequestBody({ messages: [], modelItemKey: '9', work: WORK }), /messages 不能为空/)
  assert.throws(() => buildRequestBody({ messages: [{ role: 'assistant', content: 'x' }], modelItemKey: '9', work: WORK }), /缺少 user 消息/)
})

function streamFrom(strings) {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const s of strings) controller.enqueue(encoder.encode(s))
      controller.close()
    },
  })
}

function asyncIterableFrom(strings) {
  const encoder = new TextEncoder()
  return {
    async *[Symbol.asyncIterator]() {
      for (const s of strings) yield encoder.encode(s)
    },
  }
}

test('pumpSse 全事件类型（ReadableStream 路径）', async () => {
  const sse = [
    ': ping',
    '',
    'event: SSE_HEARTBEAT',
    'data: {}',
    '',
    'event: SSE_ACK',
    'data: {"ack_client_meta":{"conversation_id":"conv-1","section_id":"sec-1"}}',
    '',
    'event: STREAM_CHUNK',
    'data: {"patch_op":[{"patch_value":{"content_block":[{"block_type":10040,"content":{"thinking_block":{"streaming_title":"正在思考"}}}]}}]}',
    '',
    'event: CHUNK_DELTA',
    'data: {"text":"你好，"}',
    '',
    'event: CHUNK_DELTA',
    'data: {"text":"世界"}',
    '',
    'event: SSE_REPLY_END',
    'data: {"end_type":1,"msg_finish_attr":{"brief":"完整答案"}}',
    '',
  ].join('\n')
  const events = []
  await pumpSse(streamFrom([sse]), {
    onText: text => events.push(['text', text]),
    onReasoning: text => events.push(['reasoning', text]),
    onConversation: (conv, section) => events.push(['conv', conv, section]),
    onFinish: (endType, brief) => events.push(['finish', endType, brief]),
  })
  assert.deepEqual(events, [
    ['conv', 'conv-1', 'sec-1'],
    ['reasoning', '正在思考'],
    ['text', '你好，'],
    ['text', '世界'],
    ['finish', 1, '完整答案'],
  ])
})

test('pumpSse CHUNK_DELTA 抑制 STREAM_CHUNK 正文', async () => {
  const sse = [
    'event: STREAM_CHUNK',
    'data: {"patch_op":[{"patch_value":{"content_block":[{"block_type":10000,"content":{"text_block":{"text":"A"}}}]}}]}',
    '',
    'event: STREAM_CHUNK',
    'data: {"patch_op":[{"patch_value":{"content_block":[{"block_type":10000,"content":{"text_block":{"text":"B"}}}]}}]}',
    '',
    'event: CHUNK_DELTA',
    'data: {"text":"C"}',
    '',
    'event: STREAM_CHUNK',
    'data: {"patch_op":[{"patch_value":{"content_block":[{"block_type":10000,"content":{"text_block":{"text":"D"}}}]}}]}',
    '',
  ].join('\n')
  const texts = []
  await pumpSse(streamFrom([sse]), { onText: text => texts.push(text) })
  assert.deepEqual(texts, ['A', 'B', 'C'])
})

test('pumpSse 思考标题回退 finish_title，跨包切分，多行 data 合并', async () => {
  // 多行 data 的合法形态：续行也必须带 data: 前缀，派发时按 \n 拼回再 JSON.parse
  const sse = [
    'event: STREAM_CHUNK',
    'data: {"patch_op":[{"patch_value":{"content_block":[{"block_type":10040,',
    'data: "content":{"thinking_block":{"finish_title":"收尾标题"}}}]}}]}',
    '',
    'event: CHUNK_DELTA',
    'data: {"text":',
    'data: "合并"}',
    '',
  ].join('\n')
  const events = []
  // 在行中间切字节，验证跨包缓冲区重组
  await pumpSse(streamFrom([sse.slice(0, 60), sse.slice(60)]), {
    onReasoning: text => events.push(['reasoning', text]),
    onText: text => events.push(['text', text]),
  })
  assert.deepEqual(events, [['reasoning', '收尾标题'], ['text', '合并']])
})

test('pumpSse 走 async iterable 兜底路径', async () => {
  const texts = []
  await pumpSse(asyncIterableFrom(['event: CHUNK_DELTA\ndata: {"text":"迭代"}\n\n']), {
    onText: text => texts.push(text),
  })
  assert.deepEqual(texts, ['迭代'])
})

test('pumpSse 末尾无换行也派发', async () => {
  const texts = []
  await pumpSse(streamFrom(['event: CHUNK_DELTA\ndata: {"text":"EOF"}']), {
    onText: text => texts.push(text),
  })
  assert.deepEqual(texts, ['EOF'])
})

test('纯工具函数', () => {
  assert.equal(extractText('直接串'), '直接串')
  assert.equal(extractText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'ab')
  assert.equal(homeDir(''), '')
  assert.equal(homeDir('C:\\Users\\me\\Doubao\\ws'), 'C:\\Users\\me')
  assert.equal(atoiSafe('4'), 4)
  assert.equal(atoiSafe('4x'), 4)
  assert.equal(atoiSafe('x4'), 0)
  assert.equal(shortHash('abc').length, 12)
  assert.match(randomDigits(16), /^\d{16}$/)
})
