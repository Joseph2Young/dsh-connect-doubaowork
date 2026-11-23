/**
 * 每日保活巡检：定时检查各账号登录态是否仍然有效，结果落
 * ~/.dsh-doubao/pool-state.json 供设置页展示。
 *
 * 与 workbuddy 的「自动签到」对位：豆包的「签到」= 每天用登录态访问一次豆包
 * （见 checkin.js），这里只做等价的健康巡检——默认关闭（opt-in），不替用户
 * 改变任何上游状态。
 *
 * ## 探针为什么不是「GET 首页看状态码」
 *
 * 早期实现带 cookie `GET https://www.doubao.com/` 并判定 2xx 才算有效。但该
 * URL **无论 cookie 是否有效都会 302 到 `/chat/`**（无 cookie 也是 302），于是
 * 判定永远为假，设置卡片长期显示「账号池 异常（HTTP 302）」——那是纯误报。
 *
 * 现在改用豆包自己的登录态探针 `/samantha/user/preference/get`：它总是返回
 * HTTP 200，靠 JSON 业务码区分身份——`code:0` 表示登录态有效，`code:710012001`
 * 表示「登录已过期」。判定不看 HTTP 状态码，不会被重定向误导；这个接口不是
 * chat 接口，也不会在豆包侧产生会话记录。
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
 * 豆包登录态探针：POST `/samantha/user/preference/get`，按业务码判定。
 * 与 checkin.js 共用同一个接口语义（那边是「签到」，这边是「健康巡检」）。
 */
export const LOGIN_PROBE_URL = 'https://www.doubao.com/samantha/user/preference/get'

/** 登录已过期的业务码。 */
export const CODE_LOGIN_INVALID = 710012001

/**
 * 单账号健康探测。
 * @returns {Promise<{ok: boolean, status: number, loggedIn: boolean, code: number, detail?: string}>}
 */
export async function probeAccount(account, { fetchImpl = fetch, userAgent = '', timeoutMs = 15000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('巡检超时')), timeoutMs)
  try {
    const response = await fetchImpl(LOGIN_PROBE_URL, {
      method: 'POST',
      headers: {
        'User-Agent': userAgent !== '' ? userAgent : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
        'Content-Type': 'application/json',
        Cookie: account?.cookie ?? '',
      },
      body: '{}',
      redirect: 'manual',
      signal: controller.signal,
    })
    let code = -1
    try {
      const parsed = JSON.parse(await response.text())
      code = typeof parsed?.code === 'number' ? parsed.code : -1
    } catch {
      code = -1
    }
    // 只有业务码 0 才算登录态有效；710012001 = 登录已过期
    const loggedIn = code === 0
    return {
      ok: loggedIn,
      status: response.status,
      loggedIn,
      code,
      ...(loggedIn || code === CODE_LOGIN_INVALID ? {} : { detail: `未识别的状态码 ${code}` }),
    }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      loggedIn: false,
      code: -1,
      detail: error?.message ?? String(error),
    }
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
        if (probe.ok !== true) {
          const reason = probe.detail ?? (probe.code === CODE_LOGIN_INVALID ? '登录已过期' : `未识别的状态码 ${probe.code}`)
          log('warn', `账号 ${account.id} 保活巡检未通过（业务码 ${probe.code}：${reason}）`)
        }
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
