/**
 * 每日保活巡检：定时检查各账号 cookie 是否仍被豆包接受，结果落
 * ~/.dsh-doubao/pool-state.json 供设置页展示。
 *
 * 与 workbuddy 的「自动签到」对位：豆包侧没有签到/积分概念（免费额度随账号
 * 自带，无需每日领取），这里落地为等价的「账号每日健康巡检」——纯读操作，
 * 默认关闭（opt-in），不替用户改变任何上游状态。
 *
 * 巡检是弱验证：带 cookie GET 豆包首页（redirect: manual）。cookie 被服务端
 * 拒绝（302/403）说明登录态失效；200 不能 100% 证明会话仍有效（可能是登录页
 * SPA），但足以覆盖「cookie 过期」这一最主要的失效形态。更强验证需要真实发
 * 起一次 chat 请求，会在豆包侧留下会话记录，与减少留痕的目标冲突，故不采用。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const POOL_STATE_PATH = path.join(os.homedir(), '.dsh-doubao', 'pool-state.json')

/** 默认巡检时刻（本地时区）。 */
export const KEEPALIVE_DEFAULT_HOUR = 8
export const KEEPALIVE_DEFAULT_MINUTE = 30

/**
 * 距下一次巡检的毫秒数（每天固定本地时刻；已过则顺延到明天同一时刻）。
 * 一次性 setTimeout 重新 arm（而非 setInterval）：休眠唤醒/跨天回卷后由
 * finally 分支重新计算，不会漂移或补跑风暴。
 */
export function nextRunDelay(now = new Date(), hour = KEEPALIVE_DEFAULT_HOUR, minute = KEEPALIVE_DEFAULT_MINUTE) {
  const next = new Date(now)
  next.setHours(hour, minute, 0, 0)
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
  return next.getTime() - now.getTime()
}

/**
 * 单账号健康探测：带 cookie GET 豆包首页。
 * @returns {Promise<{ok: boolean, status: number, detail?: string}>}
 */
export async function probeAccount(account, { fetchImpl = fetch, userAgent = '', timeoutMs = 15000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('巡检超时')), timeoutMs)
  try {
    const response = await fetchImpl('https://www.doubao.com/', {
      method: 'GET',
      headers: {
        'User-Agent': userAgent !== '' ? userAgent : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
        Cookie: account?.cookie ?? '',
      },
      redirect: 'manual',
      signal: controller.signal,
    })
    // 2xx = cookie 被接受；302/403 = 登录态失效
    return { ok: response.status >= 200 && response.status < 300, status: response.status }
  } catch (error) {
    return { ok: false, status: 0, detail: error?.message ?? String(error) }
  } finally {
    clearTimeout(timer)
  }
}

export function readPoolState(statePath = POOL_STATE_PATH) {
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    return state && typeof state === 'object' ? state : { results: {} }
  } catch {
    return { results: {} }
  }
}

export function writePoolState(state, statePath = POOL_STATE_PATH) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true })
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2))
}

/**
 * 保活巡检器：手动 runNow() + 每日重 arm 定时 schedule()。
 * @param {object} [input]
 * @param {() => Array<object>} [input.accounts] 账号提供者（loadAccountList 产物）
 * @param {(level: string, message: string, error?: unknown) => void} [input.log]
 * @param {string} [input.statePath] 状态文件路径（测试注入）
 * @param {typeof fetch} [input.fetchImpl] 测试注入
 * @param {string} [input.userAgent] 巡检 UA（默认与请求 UA 一致）
 * @param {boolean} [input.enabled] 每日巡检开关（opt-in，默认关）
 */
export function createKeepalive({ accounts, log = () => {}, statePath = POOL_STATE_PATH, fetchImpl = fetch, userAgent = '', enabled = false, enabledOf = null } = {}) {
  let timer = null
  let running = false

  /** 当前是否启用：优先读活配置（volatile 开关立刻生效），否则用构造期快照。 */
  const isEnabled = () => (typeof enabledOf === 'function' ? enabledOf() === true : enabled === true)

  /** 立即巡检一轮；已在巡检中时直接返回当前状态（幂等，不并发）。 */
  async function runNow(reason = 'manual') {
    if (running) return readPoolState(statePath)
    running = true
    try {
      const list = Array.isArray(accounts?.()) ? accounts().filter(account => account?.enabled !== false) : []
      const results = {}
      for (const account of list) {
        const probe = await probeAccount(account, { fetchImpl, userAgent })
        results[account.id] = { ...probe, checkedAt: new Date().toISOString() }
        if (probe.ok !== true) log('warn', `账号 ${account.id} 保活巡检未通过（HTTP ${probe.status}${probe.detail ? `: ${probe.detail}` : ''}）`)
      }
      const state = { lastRun: new Date().toISOString(), reason, results }
      try {
        writePoolState(state, statePath)
      } catch (error) {
        log('warn', `保活状态写入失败: ${error?.message}`)
      }
      return state
    } finally {
      running = false
    }
  }

  function schedule() {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (isEnabled() !== true) return
    timer = setTimeout(() => {
      timer = null
      void runNow('scheduled').finally(schedule)
    }, nextRunDelay(new Date()))
    timer.unref?.()
  }

  return {
    runNow,
    schedule,
    stop() {
      if (timer !== null) clearTimeout(timer)
      timer = null
    },
    readState: () => readPoolState(statePath),
    running: () => running,
  }
}
