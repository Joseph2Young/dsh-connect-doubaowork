/**
 * 每日自动签到（对应 workbuddy 的 auto-checkin）。
 *
 * ## 豆包的「签到」是什么
 *
 * 豆包没有签到按钮，也没有 checkin 接口（已穷举 CLI 三个 bundle 与 Web 端全部
 * API：`/samantha/guidance/get_task` 是新手引导任务、`/samantha/fission/*` 是
 * 邀请裂变，都不含每日签到）。它的积分规则写得很直白：
 *
 *   每日免费积分 / 获得方式：在移动端或PC端登录豆包
 *   有效期：当日 24:00 清零（北京时间）
 *   数量：分端当日首次登录豆包可获得 80-150 幸运积分
 *
 * 所以「自动签到」的正确语义是 **每天用登录态真实访问一次豆包**，让服务端把
 * 这一天记为「已登录」，积分自动到账。本模块就做这件事，并用同一次请求判定
 * 登录态是否仍然有效（一次网络往返，两个用途）。
 *
 * ## 为什么用 `/samantha/user/preference/get`
 *
 * 旧的保活探测是 `GET https://www.doubao.com/`（redirect: manual）。但那个
 * URL **无论 cookie 是否有效都会 302 到 `/chat/`**，于是判定「只有 2xx 才算
 * 有效」永远为假——设置卡片长期显示「账号池 异常（HTTP 302）」就是这个误报。
 *
 * 现在改用豆包自己的登录态探针：`POST /samantha/user/preference/get`
 *   · cookie 有效 → `{"code":0,...}`
 *   · cookie 失效 → `{"code":710012001,"msg":"登录已过期，请重新登录"}`
 * 它返回 200 + JSON 业务码，判定不依赖 HTTP 状态码，也不会在豆包侧产生会话
 * 记录（不是 chat 接口）——这点很重要，否则签到本身就会制造留痕。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const CHECKIN_STATE_PATH = path.join(os.homedir(), '.dsh-doubao', 'checkin-state.json')
export const CHECKIN_STATE_ENV = 'DSH_DOUBAO_CHECKIN_STATE_FILE'

/** 登录态探针：豆包自己的 preference 接口。 */
export const LOGIN_PROBE_URL = 'https://www.doubao.com/samantha/user/preference/get'
/** 「来豆包」的页面访问（模拟用户打开首页）。 */
export const HOME_URL = 'https://www.doubao.com/chat/'

/** 登录已过期的业务码。 */
export const CODE_LOGIN_INVALID = 710012001

/** 默认签到时刻（本地时区），早于保活巡检的 08:30 之前一点没必要，取整点。 */
export const CHECKIN_DEFAULT_HOUR = 8
export const CHECKIN_DEFAULT_MINUTE = 10

const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36'

/** 本地日期键（YYYY-MM-DD），用于「今天签过了吗」。 */
export function dayKey(now = new Date()) {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * 登录态探测 + 签到访问：一次网络往返完成两件事。
 *
 * @param {object} account 账号（需要 cookie）
 * @param {object} [options]
 * @returns {Promise<{ok: boolean, loggedIn: boolean, code: number, status: number,
 *   homeStatus: number, detail?: string}>}
 */
export async function checkinAccount(account, { fetchImpl = fetch, userAgent = '', timeoutMs = 15000 } = {}) {
  const cookie = typeof account?.cookie === 'string' ? account.cookie : ''
  const ua = userAgent !== '' ? userAgent : DEFAULT_UA
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('签到超时')), timeoutMs)

  let homeStatus = 0
  try {
    // 1) 打开首页：这就是「来豆包」这个动作本身。失败不阻塞登录态判定。
    try {
      const home = await fetchImpl(HOME_URL, {
        method: 'GET',
        headers: { 'User-Agent': ua, ...(cookie !== '' ? { Cookie: cookie } : {}) },
        redirect: 'manual',
        signal: controller.signal,
      })
      homeStatus = home.status
    } catch {
      // 首页拿不到不算失败，下面的接口才是判定依据
    }

    // 2) 登录态探针：返回 200 + 业务码，不产生会话记录
    const response = await fetchImpl(LOGIN_PROBE_URL, {
      method: 'POST',
      headers: {
        'User-Agent': ua,
        'Content-Type': 'application/json',
        ...(cookie !== '' ? { Cookie: cookie } : {}),
      },
      body: '{}',
      redirect: 'manual',
      signal: controller.signal,
    })
    const text = await response.text()
    let code = -1
    try {
      const parsed = JSON.parse(text)
      code = typeof parsed?.code === 'number' ? parsed.code : -1
    } catch {
      code = -1
    }
    const loggedIn = code === 0
    return { ok: loggedIn, loggedIn, code, status: response.status, homeStatus }
  } catch (error) {
    return {
      ok: false,
      loggedIn: false,
      code: -1,
      status: 0,
      homeStatus,
      detail: error?.name === 'AbortError' ? '签到超时' : (error?.message ?? String(error)),
    }
  } finally {
    clearTimeout(timer)
  }
}

export function readCheckinState(statePath = CHECKIN_STATE_PATH) {
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    if (state === null || typeof state !== 'object') return { results: {} }
    return state.version === 1 || state.results ? state : { results: {} }
  } catch {
    return { results: {} }
  }
}

export function writeCheckinState(state, statePath = CHECKIN_STATE_PATH) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true })
  const tmp = `${statePath}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, statePath)
}

/**
 * 距下一次签到执行的毫秒数（每天固定本地时刻；已过则顺延到明天同一时刻）。
 * 与 keepalive 的 nextRunDelay 同构：一次性 setTimeout 重新 arm，休眠唤醒后
 * 由调用方重新计算，不会漂移或补跑风暴。
 */
export function nextCheckinDelay(now = new Date(), hour = CHECKIN_DEFAULT_HOUR, minute = CHECKIN_DEFAULT_MINUTE) {
  const next = new Date(now)
  next.setHours(hour, minute, 0, 0)
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
  return next.getTime() - now.getTime()
}

/**
 * 签到器：手动 runNow() + 每日定时 schedule()。
 *
 * 幂等设计：
 *   · 同一天同一账号成功签过 → 定时触发时跳过（force 强制重签，供手动按钮用）
 *   · 立即执行时若已有任务在跑则直接返回当前状态（不并发）
 *   · 失败不写「今日已签」，下一轮会重试
 *
 * @param {object} [input]
 * @param {() => Array<object>} [input.accounts] 账号提供者（loadAccountList 产物）
 * @param {(level: string, message: string, error?: unknown) => void} [input.log]
 * @param {string} [input.statePath] 状态文件路径（测试注入）
 * @param {typeof fetch} [input.fetchImpl] 测试注入
 * @param {string} [input.userAgent] 签到 UA
 * @param {boolean} [input.enabled] 定时开关（opt-in）
 * @param {(() => boolean) | null} [input.enabledOf] 活配置开关（volatile 立即生效）
 * @param {() => number} [input.hourOf] 活配置小时
 * @param {() => number} [input.minuteOf] 活配置分钟
 * @param {() => Date} [input.now] 测试注入时钟
 */
export function createCheckin({
  accounts,
  log = () => {},
  statePath = CHECKIN_STATE_PATH,
  fetchImpl = fetch,
  userAgent = '',
  enabled = false,
  enabledOf = null,
  hourOf = null,
  minuteOf = null,
  now = () => new Date(),
} = {}) {
  let timer = null
  let running = false

  const isEnabled = () => (typeof enabledOf === 'function' ? enabledOf() === true : enabled === true)
  const hour = () => {
    const value = typeof hourOf === 'function' ? Number(hourOf()) : CHECKIN_DEFAULT_HOUR
    return Number.isInteger(value) && value >= 0 && value <= 23 ? value : CHECKIN_DEFAULT_HOUR
  }
  const minute = () => {
    const value = typeof minuteOf === 'function' ? Number(minuteOf()) : CHECKIN_DEFAULT_MINUTE
    return Number.isInteger(value) && value >= 0 && value <= 59 ? value : CHECKIN_DEFAULT_MINUTE
  }

  /** 立即签到一轮。force=true 时忽略「今日已签」去重（手动按钮用）。 */
  async function runNow(reason = 'manual', { force = false } = {}) {
    if (running) return readCheckinState(statePath)
    running = true
    try {
      const list = Array.isArray(accounts?.()) ? accounts().filter(account => account?.enabled !== false) : []
      const previous = readCheckinState(statePath)
      const today = dayKey(now())
      const results = { ...(previous.results ?? {}) }
      let signedCount = 0
      let skipped = 0

      for (const account of list) {
        const last = results[account.id]
        const alreadyToday = reason === 'scheduled' && !force && last?.day === today && last?.ok === true
        if (alreadyToday) {
          skipped += 1
          continue
        }
        const probe = await checkinAccount(account, { fetchImpl, userAgent })
        results[account.id] = {
          ok: probe.ok,
          loggedIn: probe.loggedIn,
          code: probe.code,
          status: probe.status,
          day: today,
          checkedAt: now().toISOString(),
          ...(probe.detail === undefined ? {} : { detail: probe.detail }),
        }
        if (probe.ok) {
          signedCount += 1
          log('info', `账号 ${account.id} 今日签到完成（登录态有效）`)
        } else {
          log('warn', `账号 ${account.id} 签到未完成：${probe.loggedIn ? '未知错误' : `登录态失效（业务码 ${probe.code}${probe.detail ? `: ${probe.detail}` : ''}）`}`)
        }
      }

      const state = {
        version: 1,
        lastRun: now().toISOString(),
        lastDay: today,
        reason,
        signedCount,
        skipped,
        results,
      }
      try {
        writeCheckinState(state, statePath)
      } catch (error) {
        log('warn', `签到状态写入失败: ${error?.message}`)
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
    }, nextCheckinDelay(now(), hour(), minute()))
    timer.unref?.()
  }

  /** 开关变化后重新安排（volatile 改动立即生效）。 */
  function reschedule() {
    if (isEnabled() !== true) {
      if (timer !== null) clearTimeout(timer)
      timer = null
      return
    }
    schedule()
  }

  return {
    runNow,
    schedule,
    reschedule,
    stop() {
      if (timer !== null) clearTimeout(timer)
      timer = null
    },
    readState: () => readCheckinState(statePath),
    running: () => running,
    /**
     * 下一次执行时刻（ISO 串）；未启用或定时器未 arm 时返回 null。
     * 以「定时器真的在跑」为准：卡片显示的时间必须与实际触发一致，
     * 不能只在开关打开时就报一个并不存在的时间。
     */
    nextRunAt() {
      if (isEnabled() !== true || timer === null) return null
      return new Date(now().getTime() + nextCheckinDelay(now(), hour(), minute())).toISOString()
    },
  }
}
