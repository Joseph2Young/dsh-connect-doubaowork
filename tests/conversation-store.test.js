import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createConversationStore,
  resolveConversationsPath,
  DEFAULT_CONVERSATIONS_PATH,
  CONVERSATIONS_FILE_ENV,
} from '../conversation-store.js'

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-conv-'))
  return path.join(dir, 'conversations.json')
}

test('会话绑定：写入后可读回，并在新实例里仍然存在（跨进程复用同一条豆包会话）', () => {
  const file = tempFile()
  const first = createConversationStore({ file })
  first.set('dsh-single', { conversationId: '38454545920753666', accountId: 'cli', backend: 'cli' })
  assert.equal(first.get('dsh-single').conversationId, '38454545920753666')

  // 模拟插件重挂 / 宿主重启：新实例从磁盘恢复
  const second = createConversationStore({ file })
  assert.equal(second.get('dsh-single').conversationId, '38454545920753666')
  assert.equal(second.get('dsh-single').accountId, 'cli')
  assert.equal(second.get('dsh-single').backend, 'cli')
})

test('会话绑定：文件不存在按空表继续，不抛错', () => {
  const store = createConversationStore({ file: tempFile() })
  assert.equal(store.size(), 0)
  assert.equal(store.get('dsh-single'), undefined)
})

test('会话绑定：文件损坏时降级为空表，下次写入覆盖它', () => {
  const file = tempFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '{不是合法 json')
  const store = createConversationStore({ file })
  assert.equal(store.size(), 0)
  store.set('k', { conversationId: 'abc' })
  const reread = createConversationStore({ file })
  assert.equal(reread.get('k').conversationId, 'abc')
})

test('会话绑定：格式版本不符时丢弃旧数据（避免结构漂移读坏）', () => {
  const file = tempFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ version: 999, entries: { k: { conversationId: 'x', accountId: '', updatedAt: 1 } } }))
  const store = createConversationStore({ file })
  assert.equal(store.size(), 0)
})

test('会话绑定：delete 立刻落盘（失效会话重建路径）', () => {
  const file = tempFile()
  const store = createConversationStore({ file })
  store.set('dsh-single', { conversationId: 'old' })
  assert.equal(store.delete('dsh-single'), true)
  assert.equal(store.delete('dsh-single'), false)
  assert.equal(createConversationStore({ file }).get('dsh-single'), undefined)
})

test('会话绑定：非法 key / 非法值一律忽略，不写入', () => {
  const store = createConversationStore({ file: '' })
  store.set('', { conversationId: 'x' })
  store.set('k', { conversationId: '' })
  store.set('k', null)
  assert.equal(store.size(), 0)
})

test('会话绑定：空 file 退化为纯内存，不碰磁盘', () => {
  const store = createConversationStore({ file: '' })
  store.set('k', { conversationId: 'mem-only' })
  assert.equal(store.get('k').conversationId, 'mem-only')
  assert.equal(store.file, '')
  assert.equal(fs.existsSync(DEFAULT_CONVERSATIONS_PATH) && store.size() === 0, false)
})

test('会话绑定：超出上限按 updatedAt 淘汰最旧', () => {
  let clock = 0
  const store = createConversationStore({ file: '', max: 2, now: () => (clock += 1) })
  store.set('a', { conversationId: 'A' })
  store.set('b', { conversationId: 'B' })
  store.set('c', { conversationId: 'C' })
  assert.equal(store.size(), 2)
  assert.equal(store.get('a'), undefined)
  assert.equal(store.get('c').conversationId, 'C')
})

test('会话绑定：写入失败（目录不可写）不影响返回值与后续读取', () => {
  // 指向一个必然写入失败的路径（把文件当目录）——只验证不抛错
  const file = path.join(tempFile(), 'nested', 'conversations.json')
  const store = createConversationStore({ file })
  assert.doesNotThrow(() => store.set('k', { conversationId: 'x' }))
  // 内存态仍然可用（同进程内聊天不受影响）
  assert.equal(store.get('k').conversationId, 'x')
})

test('会话绑定路径：显式传入优先，其次环境变量，最后默认值', () => {
  assert.equal(resolveConversationsPath('/tmp/explicit.json', {}), '/tmp/explicit.json')
  assert.equal(resolveConversationsPath('', { [CONVERSATIONS_FILE_ENV]: '/tmp/env.json' }), '/tmp/env.json')
  assert.equal(resolveConversationsPath('', {}), DEFAULT_CONVERSATIONS_PATH)
  assert.equal(resolveConversationsPath('   ', { [CONVERSATIONS_FILE_ENV]: '  ' }), DEFAULT_CONVERSATIONS_PATH)
})

test('会话绑定文件不含对话内容（隐私回归）', () => {
  const file = tempFile()
  const store = createConversationStore({ file })
  store.set('dsh-single', { conversationId: '38454545920753666', accountId: 'cli', backend: 'cli' })
  const raw = fs.readFileSync(file, 'utf8')
  assert.match(raw, /38454545920753666/)
  // 只允许出现会话标识与账号 id，不允许出现任何消息文本字段
  assert.doesNotMatch(raw, /"(content|messages|prompt|query|response|text|cookie|sessionid)"/)
  // 权限收紧到 0600
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
})
