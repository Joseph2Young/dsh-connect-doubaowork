/**
 * 插件配置：纯模块（不 import 宿主包），由 index.js 注入 schemastery 的 z，
 * 测试可注入假 z 验证结构。
 */

export const DOUBAO_SETTINGS_NS = 'dsh-connect-doubaowork'

/** 与豆包桌面端工作模式一致的默认常量（对照 yyydsz/doubao2api applyDefaults）。 */
export const DOUBAO_DEFAULTS = Object.freeze({
  chatUrl: 'https://www.doubao.com/chat/completion',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 SamanthaDoubao/2.30.1',
  timeoutSeconds: 300,
  heartbeatSeconds: 15,
  flattenHistory: true,
  workMode: true,
  botId: '7338286299411103781',
  modeId: '3',
  reasoningEffort: '4',
  memoryProfile: '300k_230',
  totalWindowSize: '300000',
  enableSandbox: false,
  workspace: '',
  localAppId: '582478',
})

/** 上游 URL 固定 query（豆包桌面端工作模式 21 项，见 config.example.json）。 */
export const DOUBAO_QUERY = Object.freeze({
  aid: '582478',
  real_aid: '582478',
  channel: 'win',
  client_platform: 'pc_client',
  device_platform: 'web',
  doubao_device_platform: 'desktop',
  doubao_pc_version: '2.30.1',
  pc_version: '2.30.1',
  pkg_type: 'release_version',
  language: 'zh',
  region: 'CN',
  sys_region: 'CN',
  runtime: 'web',
  runtime_version: '3.37.4',
  samantha_web: '1',
  'use-olympus-account': '1',
  version_code: '20800',
  web_platform: 'desktop',
  chromium_version: '147.0.7727.149',
})

export function createConfigSchema(z) {
  return z.object({
    enabledModelIds: z.array(z.string()).default([]).description('启用的模型 ID；留空 = 全部'),
    workMode: z.boolean().default(DOUBAO_DEFAULTS.workMode).description('启用豆包工作模式（agent_mode=1 / mode_id=3）'),
    reasoningEffort: z.string().default(DOUBAO_DEFAULTS.reasoningEffort).description('工作模式思考强度：0-4'),
    autoDiscoverCredentials: z.boolean().default(true).description('无凭据文件时尝试从豆包桌面端自动发现登录态（实验性）'),
    credentialsFile: z.string().default('').description('凭据 JSON 路径；留空用 ~/.dsh-doubao/credentials.json，可用 DSH_DOUBAO_CREDENTIALS_FILE 覆盖'),
    chatUrl: z.string().default(DOUBAO_DEFAULTS.chatUrl).description('上游工作模式端点'),
    userAgent: z.string().default(DOUBAO_DEFAULTS.userAgent).description('上游 User-Agent'),
    timeoutSeconds: z.number().default(DOUBAO_DEFAULTS.timeoutSeconds).description('上游请求超时（秒）'),
    heartbeatSeconds: z.number().default(DOUBAO_DEFAULTS.heartbeatSeconds).description('SSE 心跳间隔（秒）'),
    flattenHistory: z.boolean().default(DOUBAO_DEFAULTS.flattenHistory).description('首轮把历史消息压平为一段'),
  })
}

/** 思考强度收口：只允许 '0'-'4'，越界回落默认。 */
export function clampEffort(value) {
  const effort = String(value ?? '').trim()
  return ['0', '1', '2', '3', '4'].includes(effort) ? effort : DOUBAO_DEFAULTS.reasoningEffort
}

function clampPositiveInt(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

function clampNonNegativeInt(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

/** 把宿主配置归一为内部运行参数（无 schema 环境也能安全读取）。 */
export function normalizeConfig(config) {
  const raw = config ?? {}
  const pick = (key, fallback) => {
    const value = raw[key]
    return value === undefined || value === null || value === '' ? fallback : value
  }
  return {
    enabledModelIds: Array.isArray(raw.enabledModelIds) ? raw.enabledModelIds.map(String) : [],
    workMode: pick('workMode', DOUBAO_DEFAULTS.workMode) !== false,
    reasoningEffort: clampEffort(pick('reasoningEffort', DOUBAO_DEFAULTS.reasoningEffort)),
    autoDiscoverCredentials: pick('autoDiscoverCredentials', true) !== false,
    credentialsFile: typeof raw.credentialsFile === 'string' ? raw.credentialsFile : '',
    chatUrl: String(pick('chatUrl', DOUBAO_DEFAULTS.chatUrl)),
    userAgent: String(pick('userAgent', DOUBAO_DEFAULTS.userAgent)),
    timeoutSeconds: clampPositiveInt(pick('timeoutSeconds', DOUBAO_DEFAULTS.timeoutSeconds), DOUBAO_DEFAULTS.timeoutSeconds),
    // 心跳 0 = 关闭 ping（与上游「HeartbeatSeconds>0 才发」的语义一致）
    heartbeatSeconds: clampNonNegativeInt(pick('heartbeatSeconds', DOUBAO_DEFAULTS.heartbeatSeconds), DOUBAO_DEFAULTS.heartbeatSeconds),
    flattenHistory: pick('flattenHistory', DOUBAO_DEFAULTS.flattenHistory) !== false,
  }
}
