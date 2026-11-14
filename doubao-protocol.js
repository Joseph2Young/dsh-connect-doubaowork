/**
 * 豆包工作模式协议层：请求体构造 + SSE 事件解析。
 *
 * 逐行复刻自 yyydsz/doubao2api 的 internal/doubao/doubao.go（BuildBody / Pump），
 * 仅做 JS 化改写；字段顺序与结构保持一致。
 *
 * 协议要点（来自实抓）：
 *   - 正文增量优先取 CHUNK_DELTA 的 {"text":"..."}；
 *   - 没有 CHUNK_DELTA 时退回 STREAM_CHUNK 里 block_type=10000 的 text_block.text；
 *   - 思考过程是 block_type=10040 的 thinking_block（标题文案）；
 *   - 会话 id 从 SSE_ACK 的 ack_client_meta 取；
 *   - 收尾看 SSE_REPLY_END.end_type，end_type=1 且 msg_finish_attr.brief 是完整答案。
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'

export function uuid() {
  return randomUUID()
}

export function randomDigits(n) {
  const bytes = randomBytes(Math.max(1, n))
  let out = ''
  for (let i = 0; i < n; i++) out += String(bytes[i % bytes.length] % 10)
  return out
}

export function nowMillis() {
  return Date.now()
}

export function shortHash(text) {
  return createHash('sha256').update(String(text)).digest('hex').slice(0, 12)
}

export function jsonSafeString(value) {
  return JSON.stringify(value)
}

export function boolToInt(value) {
  return value ? 1 : 0
}

export function modeInt(workMode) {
  return workMode ? 2 : 0
}

export function itoa(value) {
  return String(Math.trunc(value))
}

export function atoiSafe(text) {
  let n = 0
  for (const ch of String(text ?? '')) {
    const code = ch.charCodeAt(0)
    if (code < 48 || code > 57) break
    n = n * 10 + (code - 48)
  }
  return n
}

/** Windows 工作区路径 → home_dir（取 `\Doubao` 之前的部分）。 */
export function homeDir(workspace) {
  const ws = String(workspace ?? '')
  if (ws === '') return ''
  const index = ws.indexOf('\\Doubao')
  return index > 0 ? ws.slice(0, index) : ''
}

/** OpenAI content 的纯文本：兼容 string 与 [{type,text}] 数组。 */
export function extractText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    let text = ''
    for (const part of content) {
      if (part && typeof part.text === 'string' && part.text !== '') text += part.text
    }
    return text
  }
  return ''
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return extractText(messages[i]?.content)
  }
  return ''
}

/**
 * 构造 /chat/completion 请求体（BuildBody 的 JS 版）。
 *
 * @param {object} input
 * @param {Array<{role:string,content:string|Array}>} input.messages OpenAI 消息
 * @param {string} input.modelItemKey 上游 model_item_key（三处必须一致）
 * @param {object} input.work 工作模式参数 { botId, modeId, reasoningEffort, memoryProfile,
 *   totalWindowSize, enableSandbox, workspace, deviceName, localAppId, localDeviceId }
 * @param {object} [input.options] { conversationId, flatten, workMode }
 * @returns {object} 请求体（调用方自行 JSON.stringify）
 */
export function buildRequestBody({ messages, modelItemKey, work, options = {} }) {
  if (!Array.isArray(messages) || messages.length === 0) throw new Error('messages 不能为空')
  const lastUser = lastUserText(messages)
  if (lastUser === '') throw new Error('缺少 user 消息')
  const { conversationId = '', flatten = true, workMode = true } = options

  let text = lastUser
  if (conversationId === '' && flatten) {
    // 首轮：把历史压成一段，避免丢上下文
    const lastIdx = messages.length - 1
    let prefix = ''
    for (let i = 0; i < messages.length; i++) {
      if (i === lastIdx) break
      const t = extractText(messages[i]?.content).trim()
      if (t === '') continue
      const role = String(messages[i]?.role ?? 'unknown')
      prefix += (role === 'user' ? '用户：' : role === 'assistant' ? '助手：' : `${role}：`) + t + '\n'
    }
    if (prefix !== '') text = prefix + '用户：' + lastUser
  }

  const msgId = uuid()
  const block = {
    block_type: 10000,
    content: {
      text_block: { text, icon_url: '', icon_url_dark: '', summary: '' },
      pc_event_block: '',
    },
    block_id: uuid(),
    parent_id: '',
    meta_info: [],
    append_fields: [],
  }
  const body = {
    client_meta: {
      local_conversation_id: 'local_' + randomDigits(16),
      conversation_id: conversationId,
      bot_id: work.botId,
      last_section_id: '',
      last_message_index: null,
      local_permissions: [
        { permission_name: 'ACCESS_COARSE_LOCATION', status: 1 },
        { permission_name: 'ACCESS_FINE_LOCATION', status: 1 },
        { permission_name: 'ACCESS_BACKGROUND_LOCATION', status: 1 },
      ],
    },
    messages: [{ local_message_id: msgId, content_block: [block], message_status: 0 }],
  }

  const opt = {
    create_time_ms: nowMillis(),
    answer_with_suggest: false,
    agent_mode: boolToInt(workMode),
    need_deep_think: 10001,
    unique_key: uuid(),
    start_seq: 0,
    need_create_conversation: conversationId === '',
    conversation_init_option: { need_ack_conversation: true },
    sse_recv_event_options: { support_chunk_delta: true },
    support_lazy_fetch_stream: true,
    is_old_user: true,
    message_storage_type: 0,
    conversation_mode: modeInt(workMode),
  }

  const taskParam = {
    runtime_type: 2,
    sandbox_auth_type: 1,
    device_name: work.deviceName ?? '',
    folder_name: '',
    local_app_id: work.localAppId ?? '582478',
    local_device_id: work.localDeviceId ?? '',
    workspace: work.workspace ?? '',
  }
  opt.conversation_init_ext = {
    model_item_key: modelItemKey,
    reasoning_effort: work.reasoningEffort,
    mode_id: work.modeId,
    agent_task_param: jsonSafeString(taskParam),
  }
  opt.model_config = {
    model_item_key: modelItemKey,
    model_extra_params: { memory_profile: work.memoryProfile, total_window_size: work.totalWindowSize },
    reasoning_effort: atoiSafe(work.reasoningEffort),
  }
  opt.aggregate_params = {
    mention_skill_list: '[]',
    mention_plugin_list: '[]',
    mention_ext: '[{}]',
    conversation_mode: itoa(modeInt(workMode)),
    mode_id: work.modeId,
    model_item_key: modelItemKey,
    agent_mode: itoa(boolToInt(workMode)),
    reasoning_effort: work.reasoningEffort,
    provider_id: '',
  }

  if (workMode) {
    const shared = work.workspace ? [work.workspace] : []
    const clientOpt = {
      enable_sandbox: work.enableSandbox === true,
      os: 'Windows',
      shared_folder_path: shared,
      agent_workspace: { agent_workspace: work.workspace ?? '', local_skill_paths: [] },
      client_env_id: uuid(),
      sandbox_id: 'sandbox-' + uuid(),
      sandbox_auth_type: 1,
    }
    const gtp = {
      action: 0,
      thread_local_message_id: [msgId],
      client_option: clientOpt,
      runtime_type: 2,
      agent_task_param: taskParam,
      agent_task_param_change: { runtime_changed: false, device_changed: false, sandbox_auth_type_changed: false },
      need_modify_conversation: false,
      task_input_json: jsonSafeString({
        agents_md: { files: [], state: 2 },
        schema_version: 1,
        home_dir: homeDir(work.workspace),
        project_context: {},
        localConnectors: [],
      }),
    }
    opt.general_task_param = gtp
    opt.ext = {
      general_task_param: jsonSafeString(gtp),
      use_deep_think: '10001',
      agent_mode: '1',
      is_finish: '1',
      conversation_init_option: '{"need_ack_conversation":true}',
      commerce_credit_config_enable: '0',
    }
  }

  body.option = opt
  body.user_context = []
  if (opt.ext === undefined) body.ext = { use_deep_think: '10001', is_finish: '1' }
  return body
}

function tryParse(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** 把字节流归一为异步迭代（web ReadableStream 或 Node async iterable）。 */
async function* toChunks(stream) {
  if (stream !== undefined && stream !== null && typeof stream.getReader === 'function') {
    const reader = stream.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        yield value
      }
    } finally {
      reader.releaseLock()
    }
    return
  }
  for await (const chunk of stream) yield chunk
}

/**
 * 解析豆包 SSE 流并回调 sink（Pump 的 JS 版）。
 *
 * @param {ReadableStream|AsyncIterable<Uint8Array>} stream 上游响应体
 * @param {object} sink { onText, onReasoning, onConversation, onClarify, onFinish }
 */
export async function pumpSse(stream, sink) {
  const decoder = new TextDecoder()
  let buffer = ''
  let event = ''
  const dataLines = []
  let sawChunkDelta = false

  const dispatch = () => {
    if (event === '' && dataLines.length === 0) return
    const payload = dataLines.join('\n')
    const name = event
    event = ''
    dataLines.length = 0
    if (payload === '') return

    if (name === 'CHUNK_DELTA') {
      const data = tryParse(payload)
      if (data !== undefined && typeof data.text === 'string' && data.text !== '') {
        sawChunkDelta = true
        sink.onText?.(data.text)
      }
      return
    }
    if (name === 'STREAM_CHUNK') {
      const data = tryParse(payload)
      if (data === undefined || !Array.isArray(data.patch_op)) return
      for (const op of data.patch_op) {
        const blocks = op?.patch_value?.content_block
        if (!Array.isArray(blocks)) continue
        for (const block of blocks) {
          if (block?.block_type === 10000) {
            const text = block?.content?.text_block?.text
            if (!sawChunkDelta && typeof text === 'string' && text !== '') sink.onText?.(text)
          } else if (block?.block_type === 10040) {
            const thinking = block?.content?.thinking_block
            const title = thinking?.streaming_title || thinking?.finish_title
            if (typeof title === 'string' && title !== '') sink.onReasoning?.(title)
          } else if (block?.block_type === 10082) {
            // 工作模式反问块（interaction_ask_block）：豆包暂停执行、等待用户补充信息。
            // 问题正文在 questions[].title 里（正文文本块只有引导语）；此时服务端不会
            // 发 SSE_REPLY_END，而是长连用心跳等回答，因此必须回调 onClarify 让
            // shim 立即收尾，否则调用方会一直挂到超时。
            const ask = block?.content?.interaction_ask_block
            const questions = Array.isArray(ask?.questions) ? ask.questions : []
            const titles = []
            for (const question of questions) {
              if (typeof question?.title === 'string' && question.title !== '') titles.push(question.title)
            }
            if (titles.length > 0) sink.onClarify?.(titles)
          }
        }
      }
      return
    }
    if (name === 'SSE_ACK') {
      const data = tryParse(payload)
      const meta = data?.ack_client_meta
      if (meta !== undefined && meta !== null) {
        sink.onConversation?.(String(meta.conversation_id ?? ''), String(meta.section_id ?? ''))
      }
      return
    }
    if (name === 'SSE_REPLY_END') {
      const data = tryParse(payload)
      if (data !== undefined) {
        sink.onFinish?.(Number(data.end_type ?? 0), String(data?.msg_finish_attr?.brief ?? ''))
      }
    }
  }

  const handleLine = rawLine => {
    const line = rawLine.replace(/\r$/, '')
    if (line === '') {
      dispatch()
      return
    }
    if (line.startsWith('event:')) {
      event = line.slice(6).trim()
      return
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim())
      return
    }
    // ':' 注释帧与其余行忽略
  }

  try {
    for await (const value of toChunks(stream)) {
      buffer += decoder.decode(value, { stream: true })
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        handleLine(line)
      }
    }
    buffer += decoder.decode()
    if (buffer !== '') handleLine(buffer)
    buffer = ''
    dispatch()
  } finally {
    // 无需额外清理；reader 的释放由 toChunks 负责
  }
}
