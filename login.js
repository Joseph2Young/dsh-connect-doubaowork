/**
 * 扫码登录：把 `doubao login` 的二维码搬进设置卡片。
 *
 * 豆包 CLI 的登录流程（2.37.x 实测）：
 *   `doubao login --qr=png` 启动后先打印一行 `QR_IMAGE=<临时 png 绝对路径>`，
 *   然后阻塞等待用户扫码；进程存活期间二维码文件一直在磁盘上，Ctrl+C 退出码 130。
 *   `--qr=small|full` 在非 TTY 环境直接失败（「当前输出无法交互显示二维码」），
 *   只有 png 形态可用——这也是唯一适合搬进 Web GUI 的形态。
 *
 * 单实例约束：CLI 有 instance lock，后启动的 `doubao login` 会立刻返回
 *   `conflict: 已有登录正在进行，或当前无法显示登录信息。请稍后重试。`
 *   所以本模块内部只允许一个进行中的登录会话，重复 start 直接复用。
 *
 * 与 workbuddy 的 OAuth 表单对齐的部分：loginId + 轮询 done/error 的交互形态。
 * 差异在于没有 verificationUri（豆包是扫码不是跳转），因此返回值带 imageDataUrl。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { probeCli } from './cli-backend.js'

/** 二维码从出现到过期的时长：豆包侧二维码有效期约 5 分钟，留出余量。 */
export const LOGIN_TTL_MS = 5 * 60 * 1000
/** 读不到有效 PNG 时最多等这么久就判定失败（CLI 正常 1s 内就会打出路径）。 */
const QR_TIMEOUT_MS = 30_000
/** 单张二维码图片上限，防止把异常巨大文件塞进 data URL。 */
const MAX_QR_BYTES = 2 * 1024 * 1024

/**
 * 从一个 PNG 文件读成 data URL。
 * 只接受真实 PNG（魔数校验），避免把任意文件当图片回给前端。
 */
function readPngDataUrl(filePath) {
  let stat
  try {
    stat = fs.statSync(filePath)
  } catch {
    return ''
  }
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_QR_BYTES) return ''
  let buffer
  try {
    buffer = fs.readFileSync(filePath)
  } catch {
    return ''
  }
  // PNG 魔数：89 50 4E 47 0D 0A 1A 0A
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(signature)) return ''
  return `data:image/png;base64,${buffer.toString('base64')}`
}

/**
 * 解析 `doubao login --qr=png` 的启动输出。
 *
 * 正常输出两行：
 *   QR_IMAGE=/var/folders/.../qrcode.png
 *   请使用豆包移动端扫码并在手机上确认；按 Ctrl+C 可取消
 *
 * 失败形态（都出现在 stdout/stderr 里）：
 *   conflict: 已有登录正在进行…
 *   auth_unavailable: 当前输出无法交互显示二维码…
 *
 * @returns {{ kind: 'qr', path: string } | { kind: 'conflict' } | { kind: 'unavailable', message: string } | { kind: 'none' }}
 */
export function parseLoginOutput(text) {
  const raw = String(text ?? '')
  const match = raw.match(/QR_IMAGE=(\S+)/)
  if (match !== null) return { kind: 'qr', path: match[1] }
  if (/conflict:/i.test(raw)) return { kind: 'conflict' }
  if (/auth_unavailable:/i.test(raw)) {
    const line = raw.split('\n').find(entry => /auth_unavailable:/i.test(entry)) ?? raw
    return { kind: 'unavailable', message: line.trim().slice(0, 400) }
  }
  return { kind: 'none' }
}

/**
 * 创建扫码登录管理器。
 *
 * @param {object} options
 * @param {() => string} options.cliPath 返回 doubao 可执行路径（空 = 走 PATH）
 * @param {Function} [options.spawnImpl] 注入 spawn（测试用）
 * @param {Function} [options.probe] 注入 probeCli（测试用）
 * @param {Function} [options.now] 注入时钟（测试用）
 * @param {(level: string, message: string) => void} [options.log] 日志回调
 */
export function createLoginManager({
  cliPath = () => '',
  spawnImpl = spawn,
  probe = probeCli,
  now = () => Date.now(),
  log = () => {},
} = {}) {
  /** 当前会话：{ id, child, imageDataUrl, startedAt, expiresAt, result } */
  let session = null

  const command = () => (typeof cliPath === 'function' ? cliPath() : cliPath) || 'doubao'

  /**
   * 杀掉子进程（幂等）；不等待退出，关闭由 close 事件兜底。
   *
   * 顺序有讲究：先把 session 置空再 kill。kill 触发的 close 事件是同步派发的
   * （测试替身尤其如此），若先 kill 后清空，close 处理器仍会看到「当前会话还是
   * 自己」，从而把主动取消误判成「CLI 自己退出了」。
   */
  const killSession = () => {
    if (session === null) return
    const doomed = session.child
    session = null
    try {
      doomed?.kill?.('SIGTERM')
    } catch {}
  }

  /**
   * 开始一次登录：拉起子进程、等二维码出现、转成 data URL。
   * 若已有进行中的会话，直接返回它（CLI 单实例锁，重开只会 conflict）。
   */
  const start = () => new Promise(resolve => {
    if (session !== null && now() < session.expiresAt && session.result === null) {
      resolve({ ok: true, reused: true, ...publicOf(session) })
      return
    }
    killSession()

    const begin = found => {
      let child
      try {
        child = spawnImpl(command(), ['login', '--qr=png'], { stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (error) {
        resolve({ ok: false, code: 'spawn-failed', error: String(error?.message ?? error) })
        return
      }
      const current = {
        id: `dbl_${randomUUID().replaceAll('-', '')}`,
        child,
        imageDataUrl: '',
        startedAt: now(),
        expiresAt: now() + LOGIN_TTL_MS,
        result: null,
        version: found?.version ?? '',
      }
      session = current

      let buffered = ''
      let settled = false
      const settle = payload => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(payload)
      }

      const timer = setTimeout(() => {
        // 30s 还没拿到二维码路径，多半是 CLI 卡住或输出变了
        if (session === current && current.imageDataUrl === '') {
          killSession()
          settle({ ok: false, code: 'qr-timeout', error: '等待二维码超时：豆包 CLI 没有输出 QR_IMAGE 路径' })
        }
      }, QR_TIMEOUT_MS)

      const onOutput = text => {
        buffered += text
        const parsed = parseLoginOutput(buffered)
        if (parsed.kind === 'qr' && current.imageDataUrl === '') {
          const dataUrl = readPngDataUrl(parsed.path)
          if (dataUrl !== '') {
            current.imageDataUrl = dataUrl
            settle({ ok: true, reused: false, ...publicOf(current) })
            return
          }
          // 文件还没落盘：留待后续 chunk 再试（Chromium 写文件有极短延迟）
        }
        if (parsed.kind === 'conflict') {
          // 先 settle 再 kill：kill 会同步派发 close，幂等标志必须在它之前立起来
          settle({
            ok: false,
            code: 'conflict',
            error: '已有登录正在进行（豆包 CLI 单实例锁）。请先在终端完成或取消那次登录。',
          })
          killSession()
          return
        }
        if (parsed.kind === 'unavailable') {
          settle({ ok: false, code: 'unavailable', error: parsed.message })
          killSession()
        }
      }

      child.stdout?.setEncoding?.('utf8')
      child.stderr?.setEncoding?.('utf8')
      child.stdout?.on('data', onOutput)
      child.stderr?.on('data', onOutput)
      child.on('error', error => {
        if (session === current) session = null
        settle({ ok: false, code: 'spawn-failed', error: String(error?.message ?? error) })
      })
      child.on('close', code => {
        if (session !== current) return
        // 进程自己退出：要么用户扫完登录成功，要么失败/被取消。
        // 真正的结果由随后的 auth status 探测给出。
        if (current.imageDataUrl === '' && !settled) {
          session = null
          settle({ ok: false, code: 'exited', error: `豆包 CLI 在出二维码前退出（退出码 ${code ?? 'unknown'}）` })
        }
      })
    }

    // 先探测安装状态（两次廉价子进程，约 0.2s）：没装就别开登录进程
    Promise.resolve(probe({ cliPath: command() === 'doubao' ? '' : command() }))
      .catch(() => ({ installed: false, version: '', loggedIn: false, message: '' }))
      .then(found => {
        if (found?.installed === false) {
          resolve({
            ok: false,
            code: 'not-installed',
            error: '未检测到豆包 CLI。请先安装：npm i -g @bytedance/doubao-cli',
          })
          return
        }
        begin(found)
      })
      .catch(error => {
        resolve({ ok: false, code: 'spawn-failed', error: String(error?.message ?? error) })
      })
  })

  /**
   * 查询一次登录是否完成。
   *
   * 判定成功用 `auth status`（唯一权威来源），不解析扫码进程的输出——
   * 后者的成功文案在不同版本里会变，而 auth status 是稳定契约。
   */
  const poll = async id => {
    if (session === null || session.id !== id) {
      return { done: true, error: '登录会话不存在或已结束，请重新获取二维码' }
    }
    if (now() > session.expiresAt) {
      killSession()
      return { done: true, error: '二维码已过期，请重新获取' }
    }
    let found
    try {
      found = await probe({ cliPath: command() === 'doubao' ? '' : command() })
    } catch {
      // 探测失败只是「还不知道」，不是失败：让前端继续轮询
      return { done: false }
    }
    if (found?.loggedIn === true) {
      killSession()
      log('info', '豆包 CLI 扫码登录成功')
      return { done: true, loggedIn: true, version: found.version ?? '' }
    }
    return { done: false }
  }

  /** 取消进行中的登录（卡片上「取消」按钮 / 插件卸载时调用）。 */
  const cancel = () => {
    killSession()
    return { ok: true }
  }

  /** 当前会话的公开视图（不含 child，避免把子进程对象漏出去）。 */
  function publicOf(current) {
    return {
      loginId: current.id,
      imageDataUrl: current.imageDataUrl,
      startedAt: new Date(current.startedAt).toISOString(),
      expiresInSeconds: Math.max(0, Math.floor((current.expiresAt - now()) / 1000)),
      cliVersion: current.version,
    }
  }

  /** 供 status 路由读取：有没有进行中的登录。 */
  const snapshot = () => (session === null
    ? { active: false }
    : { active: true, loginId: session.id, expiresInSeconds: Math.max(0, Math.floor((session.expiresAt - now()) / 1000)) })

  return { start, poll, cancel, snapshot }
}
