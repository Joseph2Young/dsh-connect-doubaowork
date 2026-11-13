/**
 * 豆包登录态凭据。
 *
 * 方案 B（推荐）：手动导入 ~/.dsh-doubao/credentials.json（完整 cookie 串 +
 * device_id / web_id），从浏览器 F12 复制，约 30 天过期。
 * 方案 A（实验性）：从豆包桌面端 Local State 自动发现——只能取到 sessionid
 * 一对（x-tt-multi-sids），不含 ttwid/odin_tt 等设备 Cookie，风控可能拒绝。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const CREDENTIALS_FILE_ENV = 'DSH_DOUBAO_CREDENTIALS_FILE'
export const DEFAULT_CREDENTIALS_PATH = path.join(os.homedir(), '.dsh-doubao', 'credentials.json')
export const DOUBAO_LOCAL_STATE_PATH = path.join(os.homedir(), 'Library', 'Application Support', 'Doubao', 'Local State')

function str(value) {
  if (typeof value === 'string') return value
  return value === undefined || value === null ? '' : String(value)
}

/** 校验并归一凭据；cookie 必须含 sessionid=。 */
export function normalizeCredentials(raw) {
  if (!raw || typeof raw.cookie !== 'string') return undefined
  const cookie = raw.cookie.trim()
  if (cookie === '' || !/(^|;\s*)sessionid=/.test(cookie)) return undefined
  return {
    cookie,
    deviceId: str(raw.device_id ?? raw.deviceId),
    webId: str(raw.web_id ?? raw.webId),
    teaUuid: str(raw.tea_uuid ?? raw.teaUuid),
    localAppId: str(raw.local_app_id ?? raw.localAppId) || '582478',
  }
}

/** 读取并归一凭据文件；文件缺失/损坏/无 sessionid 时返回 undefined。 */
export function loadCredentialsFromFile(filePath) {
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return undefined
  }
  return normalizeCredentials(raw)
}

/**
 * 依次尝试：环境变量覆盖 → 配置路径 → 默认路径 → 自动发现。
 * @param {object} [input] { credentialsFile, autoDiscover, env }
 * @returns {object|undefined} 归一化凭据
 */
export function loadCredentials({ credentialsFile = '', autoDiscover = true, env = process.env } = {}) {
  const fromEnv = env[CREDENTIALS_FILE_ENV]
  const candidates = [fromEnv, credentialsFile, DEFAULT_CREDENTIALS_PATH]
  const tried = new Set()
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate === '' || tried.has(candidate)) continue
    tried.add(candidate)
    const found = loadCredentialsFromFile(candidate)
    if (found !== undefined) return found
  }
  if (autoDiscover) return discoverCredentialsFromDoubaoApp()
  return undefined
}

/**
 * 从豆包桌面端 Local State 自动发现（实验性）。
 * @param {string} [localStatePath] 测试可注入
 */
export function discoverCredentialsFromDoubaoApp(localStatePath = DOUBAO_LOCAL_STATE_PATH) {
  let state
  try {
    state = JSON.parse(fs.readFileSync(localStatePath, 'utf8'))
  } catch {
    return undefined
  }
  const raw = JSON.stringify(state?.saman?.local_storage_app_for_web ?? '')
  // Local State 里该值可能以对象（引号未转义）或内嵌字符串（引号转义）两种形态出现
  const flat = raw.replace(/\\"/g, '"')
  const match = raw.match(/x-tt-multi-sids":"([^"]+)/) ?? flat.match(/x-tt-multi-sids":"([^"]+)/)
  if (match === null) return undefined
  let decoded
  try {
    decoded = decodeURIComponent(match[1])
  } catch {
    decoded = match[1]
  }
  // 常规形态是 uid:sid 竖线分隔；兜底容忍整段就是一个裸 sid 的形态
  const entries = decoded.split('|').filter(entry => entry !== '')
  const picked = entries.find(entry => entry.includes(':')) ?? entries[0]
  if (picked === undefined) return undefined
  const sid = picked.includes(':') ? picked.slice(picked.indexOf(':') + 1) : picked
  if (sid === '') return undefined
  const device = state?.aha?.device ?? state?.saman?.aha_device ?? {}
  return normalizeCredentials({
    cookie: `sessionid=${sid}; sessionid_ss=${sid}`,
    device_id: str(device.device_id ?? ''),
    web_id: str(device.web_id ?? ''),
    tea_uuid: str(device.install_id ?? device.device_id ?? ''),
    local_app_id: '582478',
  })
}
