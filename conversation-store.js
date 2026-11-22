/**
 * 会话绑定持久化：把「DSH 会话键 → 豆包侧会话/账号」的映射存到磁盘。
 *
 * 为什么需要它：豆包侧的历史记录是服务端产物，插件无法删除（`doubao` 没有删会话
 * 的子命令）。唯一能减少留痕的手段是「反复复用同一条豆包会话」——即 `--resume`
 * 一个已存在的 session_id。原实现把绑定放在内存 Map 里，进程一重挂（插件重载、
 * 宿主重启、DSH 升级）绑定就丢，下一次请求立刻在豆包侧新建一条会话，历史因此
 * 越积越多。持久化之后，进程重启仍能接上同一条会话，豆包侧条数趋于稳定。
 *
 * 设计约束：
 * - 只存会话标识与账号 id，不存任何对话内容、不存 cookie（隐私：这个文件不含
 *   个人信息，删掉只会导致下一次请求新建会话）。
 * - 任何读写失败都不阻塞聊天：读失败按空表处理，写失败只记 debug 日志。
 * - `file` 为空时退化为纯内存表（测试与不支持持久化的场景用，不碰磁盘）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 默认落盘位置（与 pool-state.json 同目录）。 */
export const DEFAULT_CONVERSATIONS_PATH = path.join(os.homedir(), '.dsh-doubao', 'conversations.json')

/** 覆盖默认路径的环境变量（测试与多实例隔离用）。 */
export const CONVERSATIONS_FILE_ENV = 'DSH_DOUBAO_CONVERSATIONS_FILE'

/** 文件格式版本：将来结构变化时用它决定是否丢弃旧数据。 */
const FORMAT_VERSION = 1

/**
 * 解析实际的落盘路径：显式传入优先，其次环境变量，最后默认值。
 * @param {string} [explicit] 显式路径（设置页 cliWorkspace 之外的独立覆盖）
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
export function resolveConversationsPath(explicit = '', env = process.env) {
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim()
  const fromEnv = env?.[CONVERSATIONS_FILE_ENV]
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return DEFAULT_CONVERSATIONS_PATH
}

/**
 * 单条绑定的形状校验：必须是非空 conversationId 的纯对象。
 * @param {unknown} value
 * @returns {boolean}
 */
function isBinding(value) {
  return typeof value === 'object' && value !== null && typeof value.conversationId === 'string' && value.conversationId !== ''
}

/**
 * 创建会话绑定表。
 * @param {object} [options]
 * @param {string} [options.file] 落盘路径；空串 = 纯内存
 * @param {(level: string, message: string, error?: unknown) => void} [options.log]
 * @param {() => number} [options.now]
 * @param {number} [options.max] 最多保留多少条绑定（超出按 updatedAt 淘汰最旧）
 */
export function createConversationStore({ file = '', log = () => {}, now = () => Date.now(), max = 512 } = {}) {
  const target = typeof file === 'string' ? file.trim() : ''
  /** @type {Map<string, {conversationId: string, accountId: string, backend?: string, updatedAt: number}>} */
  const entries = new Map()
  let dirty = false

  load()

  function load() {
    if (target === '') return
    let raw
    try {
      raw = fs.readFileSync(target, 'utf8')
    } catch (error) {
      // ENOENT 是常态（首次运行），其余错误只记 debug，不打扰用户
      if (error?.code !== 'ENOENT') log('debug', `读取会话绑定失败（按空表继续）：${error?.message ?? error}`)
      return
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      log('debug', '会话绑定文件不是合法 JSON，已按空表继续（下次写入会覆盖）')
      return
    }
    const stored = parsed?.entries
    if (parsed?.version !== FORMAT_VERSION || typeof stored !== 'object' || stored === null) return
    for (const [key, value] of Object.entries(stored)) {
      if (typeof key !== 'string' || key === '' || !isBinding(value)) continue
      entries.set(key, {
        conversationId: value.conversationId,
        accountId: typeof value.accountId === 'string' ? value.accountId : '',
        backend: typeof value.backend === 'string' ? value.backend : undefined,
        updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
      })
    }
    prune()
  }

  function snapshot() {
    const out = {}
    for (const [key, value] of entries) {
      out[key] = {
        conversationId: value.conversationId,
        accountId: value.accountId,
        ...(value.backend === undefined ? {} : { backend: value.backend }),
        updatedAt: value.updatedAt,
      }
    }
    return { version: FORMAT_VERSION, entries: out }
  }

  /** 原子写：先写临时文件再 rename，避免半截文件毁掉整张表。 */
  function flush() {
    if (target === '' || !dirty) return
    dirty = false
    const text = JSON.stringify(snapshot())
    const temp = `${target}.tmp`
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      // 0o600：只有当前用户可读（文件里是会话标识，虽非凭据仍按最小暴露处理）
      fs.writeFileSync(temp, text, { encoding: 'utf8', mode: 0o600 })
      fs.renameSync(temp, target)
    } catch (error) {
      log('debug', `写入会话绑定失败（不影响聊天）：${error?.message ?? error}`)
      try {
        fs.rmSync(temp, { force: true })
      } catch {
        // 临时文件清理失败无需上报
      }
    }
  }

  function prune() {
    if (entries.size <= max) return
    const ordered = [...entries.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)
    const overflow = entries.size - max
    for (let index = 0; index < overflow; index += 1) {
      entries.delete(ordered[index][0])
      dirty = true
    }
  }

  return {
    /** 落盘路径（空串表示纯内存）。 */
    file: target,
    /**
     * 取绑定。
     * @param {string} key
     * @returns {{conversationId: string, accountId: string, backend?: string, updatedAt: number}|undefined}
     */
    get(key) {
      if (typeof key !== 'string' || key === '') return undefined
      return entries.get(key)
    },
    /**
     * 写入绑定（同键覆盖）。
     * @param {string} key
     * @param {{conversationId: string, accountId?: string, backend?: string}} binding
     */
    set(key, binding) {
      if (typeof key !== 'string' || key === '' || !isBinding(binding)) return
      entries.set(key, {
        conversationId: binding.conversationId,
        accountId: typeof binding.accountId === 'string' ? binding.accountId : '',
        backend: typeof binding.backend === 'string' ? binding.backend : undefined,
        updatedAt: now(),
      })
      dirty = true
      prune()
      flush()
    },
    /**
     * 删除绑定（会话在豆包侧失效时用）。
     * @param {string} key
     * @returns {boolean} 是否真的删掉了
     */
    delete(key) {
      if (typeof key !== 'string' || key === '') return false
      const removed = entries.delete(key)
      if (removed) {
        dirty = true
        flush()
      }
      return removed
    },
    /** 清空所有绑定（含磁盘）。 */
    clear() {
      if (entries.size === 0) return
      entries.clear()
      dirty = true
      flush()
    },
    /** 当前绑定条数。 */
    size() {
      return entries.size
    },
  }
}
