/**
 * 首次使用引导：判断这台机器上「有没有可用的豆包接入方式」，并给出可执行的修复建议。
 *
 * 设计原则：
 * - 纯模块（只依赖 Node 内置 + 本包其它纯模块），可单测；
 * - 只读探测，不写任何文件、不改配置；
 * - 不打印凭据内容（只看「有没有」与「能否解析」）；
 * - 探测结果可缓存，避免每次打开设置卡片都拉子进程。
 */

import fs from 'node:fs'
import { loadCredentials, loadAccountList, DEFAULT_CREDENTIALS_PATH } from './credentials.js'
import { probeCli } from './cli-backend.js'

/** 引导步骤的状态常量：done 已就绪 / todo 待用户操作 / warn 可用但需要注意 / blocked 不可用 */
export const STEP_STATUS = {
  done: 'done',
  todo: 'todo',
  warn: 'warn',
  blocked: 'blocked',
}

/**
 * 只在「凭据文件存在」的前提下判断其结构，不读取也不返回 cookie 本体。
 * 返回值刻意不含任何凭据字段，避免引导信息把机密带进日志或 UI。
 */
function describeCredentialsFile(filePath) {
  if (filePath === '') return { exists: false, reason: 'missing' }
  let stat
  try {
    stat = fs.statSync(filePath)
  } catch {
    return { exists: false, reason: 'missing' }
  }
  if (!stat.isFile()) return { exists: false, reason: 'missing' }
  // 权限位是否过宽（group/other 可读）：仅提示，不阻塞
  const loose = (stat.mode & 0o077) !== 0
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return { exists: true, parseable: false, loose, reason: 'unparsable' }
  }
  const hasAccounts = Array.isArray(parsed?.accounts) && parsed.accounts.length > 0
  const hasCookie = typeof parsed?.cookie === 'string' && parsed.cookie.includes('sessionid=')
  return {
    exists: true,
    parseable: true,
    loose,
    // 只报告形状，不外泄内容
    accountCount: hasAccounts ? parsed.accounts.length : hasCookie ? 1 : 0,
    reason: hasAccounts || hasCookie ? 'ok' : 'no-cookie',
  }
}

/**
 * 汇总当前机的接入能力。
 *
 * @param {object} options
 * @param {string} [options.credentialsFile] 自定义凭据路径（空 = 默认路径）
 * @param {boolean} [options.autoDiscover] 是否允许读桌面端登录态
 * @param {string} [options.cliPath] doubao 可执行路径（空 = 自动探测）
 * @param {Function} [options.probe] 注入的 CLI 探测函数（测试用）
 * @param {object} [options.env] 环境变量
 * @returns {Promise<{ready: boolean, backend: 'cli'|'http'|'', steps: object[], summary: object}>}
 */
export async function inspectSetup({
  credentialsFile = '',
  autoDiscover = true,
  cliPath = '',
  account = null,
  probe = probeCli,
  env = process.env,
} = {}) {
  const effectiveCredentialsPath = credentialsFile !== '' ? credentialsFile : DEFAULT_CREDENTIALS_PATH

  // 1) 凭据：先看文件形状，再用账号解析验证「真的能用」
  const files = describeCredentialsFile(effectiveCredentialsPath)
  let accounts = []
  let discovered = false
  try {
    accounts = loadAccountList({ account, credentialsFile, autoDiscover, env }) ?? []
  } catch {
    accounts = []
  }
  if (accounts.length === 0 && autoDiscover) {
    // 账号列表为空时确认是否靠桌面端自动发现拿到过（不改状态，只做判定）
    try {
      discovered = loadCredentials({ credentialsFile, autoDiscover, env }) !== undefined
    } catch {
      discovered = false
    }
  }

  // 2) CLI：探测安装与登录（注入 probe 便于测试）
  let cli = { installed: false, version: '', loggedIn: false, message: '' }
  try {
    cli = await probe({ cliPath, env })
  } catch (error) {
    cli = { installed: false, version: '', loggedIn: false, message: String(error?.message ?? error) }
  }

  const httpReady = accounts.length > 0
  const cliReady = cli.installed === true && cli.loggedIn === true

  const steps = []

  // —— 步骤 1：HTTP 凭据 ——
  steps.push({
    id: 'credentials',
    title: '豆包登录态（HTTP 后端）',
    status: httpReady ? STEP_STATUS.done : STEP_STATUS.todo,
    detail: httpReady
      ? `已配置 ${accounts.length} 个账号`
      : files.exists
        ? files.parseable === false
          ? `凭据文件无法解析：${effectiveCredentialsPath}`
          : files.reason === 'no-cookie'
            ? `凭据文件缺少 sessionid：${effectiveCredentialsPath}`
            : `凭据文件存在但没有可用账号：${effectiveCredentialsPath}`
        : discovered
          ? '已从豆包桌面端自动发现登录态（实验性，可能被风控拒绝）'
          : '未找到豆包登录态',
    path: effectiveCredentialsPath,
    // 权限位过宽只提示，不影响可用性
    warn: files.exists && files.loose === true ? '凭据文件权限过宽（建议 chmod 600）' : '',
    fix: httpReady ? [] : [
      '浏览器打开 https://www.doubao.com 登录，F12 → Network 复制完整 Cookie',
      `写入 ${effectiveCredentialsPath}：{"cookie": "sessionid=..."}（多账号用 accounts 数组）`,
      '或改用 CLI 后端（见下一步），无需 Cookie',
    ],
  })

  // —— 步骤 2：豆包 CLI ——
  let cliStatus = STEP_STATUS.todo
  let cliDetail
  if (cli.installed !== true) {
    cliStatus = STEP_STATUS.todo
    cliDetail = '未检测到 doubao 命令'
  } else if (cli.loggedIn === true) {
    cliStatus = STEP_STATUS.done
    cliDetail = `已安装 v${cli.version} 且已登录`
  } else {
    cliStatus = STEP_STATUS.warn
    cliDetail = `已安装 v${cli.version}，但未登录`
  }
  steps.push({
    id: 'cli',
    title: '豆包 CLI（推荐，无需 Cookie）',
    status: cliStatus,
    detail: cliDetail,
    fix: cli.installed !== true
      ? [
        'npm i -g @bytedance/doubao-cli',
        'doubao login   # 扫码登录一次，登录态长期有效',
      ]
      : cli.loggedIn !== true
        ? ['doubao login   # 扫码登录一次']
        : [],
  })

  // —— 步骤 3：至少一条路可用 ——
  const anyReady = httpReady || cliReady
  steps.push({
    id: 'ready',
    title: '可用接入方式',
    status: anyReady ? STEP_STATUS.done : STEP_STATUS.blocked,
    detail: anyReady
      ? cliReady && httpReady
        ? 'CLI 与 HTTP 双后端均可用（默认优先 CLI）'
        : cliReady
          ? '仅 CLI 可用（默认后端会走 CLI）'
          : '仅 HTTP 可用（CLI 装好并登录后会自动切换）'
      : '当前没有可用接入方式：DSH 里调用豆包模型会返回 503',
    fix: anyReady ? [] : [
      '任选其一完成即可：① 执行 doubao login；② 配置 ~/.dsh-doubao/credentials.json',
    ],
  })

  return {
    ready: anyReady,
    // 建议后端：两条都通时默认 auto（交给插件按 available 决定，实际会走 CLI）
    backend: cliReady ? 'cli' : httpReady ? 'http' : '',
    steps,
    summary: {
      // 注意：这里只放布尔与计数，不放任何凭据内容
      httpReady,
      cliReady,
      cliInstalled: cli.installed === true,
      cliLoggedIn: cli.loggedIn === true,
      cliVersion: cli.version,
      accountCount: accounts.length,
      credentialsPath: effectiveCredentialsPath,
    },
  }
}

/**
 * 生成一段可直接贴进日志/终端的引导文案（不含任何机密）。
 * 设置卡片与启动日志共用，保证两边口径一致。
 */
export function formatSetupGuide(result) {
  const lines = [`豆包插件首次使用引导（可用：${result.ready ? '是' : '否'}）`]
  for (const step of result.steps) {
    const mark = step.status === STEP_STATUS.done
      ? '[✓]'
      : step.status === STEP_STATUS.warn
        ? '[!]'
        : step.status === STEP_STATUS.blocked
          ? '[x]'
          : '[ ]'
    lines.push(`${mark} ${step.title}：${step.detail}`)
    if (step.warn) lines.push(`    注意：${step.warn}`)
    for (const fix of step.fix) lines.push(`    → ${fix}`)
  }
  return lines.join('\n')
}
