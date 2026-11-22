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
  // 豆包侧会话归属：single = 全部复用同一条豆包会话（默认，避免客户端窗口膨胀）；
  // per-chat = 每个 DSH 会话对应一条豆包记录
  conversationMode: 'single',
  // 账号池故障转移与每日保活巡检：均 opt-in（默认关），不替用户改变请求行为
  poolEnabled: false,
  keepaliveEnabled: false,
  // 后端：auto = 装好 CLI 且已登录则用 CLI，否则回落 HTTP 抓包（默认，零配置最省心）
  backend: 'auto',
  cliPath: '',
  cliWorkspace: '',
  cliPermissionMode: 'ask_risky',
  cliConcurrency: 1,
  // CLI 推理强度：空 = 不传 --effort，用模型默认（与 HTTP 侧 reasoningEffort 的 0-4 语义不同，故单列）
  cliEffort: '',
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

/**
 * 可在设置页直接编辑、且改动后不需要重挂插件的字段名。
 *
 * 这份清单同时喂两处，避免漂移：
 *   1. `createConfigSchema` 里对应字段会被 `.volatile()` 包裹；
 *   2. `unwrapConfig` 按这些键把 volatile 引用对象还原成普通值。
 *
 * 宿主侧机制（@deepseek-ai/dsh-settings `describe()`）：只有 Config schema 里
 * 至少有一个 volatile 字段的插件，才会出现在 settings 的命名空间列表里；
 * 而「设置 → 模型」页只列出 settingsNs 命中该列表的 provider——所以这份清单
 * 是豆包 provider 能否出现在模型页的唯一开关。
 *
 * `account` 故意不在此列：它内含 cookie，不该出现在可编辑表单里。
 */
export const VOLATILE_FIELDS = Object.freeze([
  'enabledModelIds',
  'workMode',
  'reasoningEffort',
  'autoDiscoverCredentials',
  'credentialsFile',
  'timeoutSeconds',
  'heartbeatSeconds',
  'flattenHistory',
  'conversationMode',
  'poolEnabled',
  'keepaliveEnabled',
  'backend',
  'cliPath',
  'cliWorkspace',
  'cliPermissionMode',
  'cliConcurrency',
  'cliEffort',
])

/**
 * 标记为 volatile（宿主新版才有该方法；老版 schemastery 退化为原样返回）。
 *
 * schemastery 3.18.3+ 的 `.volatile()` 会让 Loader 在配置变更时只更新引用而不
 * 重挂插件，也让 settings 服务把这个插件纳入可编辑命名空间。
 */
function volatileField(schema) {
  return typeof schema?.volatile === 'function' ? schema.volatile() : schema
}

export function createConfigSchema(z) {
  return z.object({
    enabledModelIds: volatileField(z.array(z.string()).default([]).description('启用的模型 ID；留空 = 全部')),
    workMode: volatileField(z.boolean().default(DOUBAO_DEFAULTS.workMode).description('启用豆包工作模式（agent_mode=1 / mode_id=3）')),
    reasoningEffort: volatileField(z.string().default(DOUBAO_DEFAULTS.reasoningEffort).description('工作模式思考强度：0-4')),
    autoDiscoverCredentials: volatileField(z.boolean().default(true).description('无凭据文件时尝试从豆包桌面端自动发现登录态（实验性）')),
    credentialsFile: volatileField(z.string().default('').description('凭据 JSON 路径；留空用 ~/.dsh-doubao/credentials.json，可用 DSH_DOUBAO_CREDENTIALS_FILE 覆盖')),
    chatUrl: z.string().default(DOUBAO_DEFAULTS.chatUrl).description('上游工作模式端点'),
    userAgent: z.string().default(DOUBAO_DEFAULTS.userAgent).description('上游 User-Agent'),
    timeoutSeconds: volatileField(z.number().default(DOUBAO_DEFAULTS.timeoutSeconds).description('上游请求超时（秒）')),
    heartbeatSeconds: volatileField(z.number().default(DOUBAO_DEFAULTS.heartbeatSeconds).description('SSE 心跳间隔（秒）')),
    flattenHistory: volatileField(z.boolean().default(DOUBAO_DEFAULTS.flattenHistory).description('首轮把历史消息压平为一段')),
    conversationMode: volatileField(z.string().default(DOUBAO_DEFAULTS.conversationMode).description('豆包侧会话归属：single = 全部落进同一条豆包会话（默认）；per-chat = 每个 DSH 会话一条豆包记录')),
    account: z.object({
      id: z.string().default('').description('账号唯一 ID；留空由插件生成'),
      label: z.string().default('').description('账号备注名'),
      cookie: z.string().default('').description('完整 cookie 串（须含 sessionid=）'),
      deviceId: z.string().default('').description('device_id'),
      webId: z.string().default('').description('web_id'),
      enabled: z.boolean().default(true).description('是否参与账号池调度'),
    }).description('主账号（兼容旧单账号凭据；账号池的保底成员）'),
    poolEnabled: volatileField(z.boolean().default(DOUBAO_DEFAULTS.poolEnabled).description('账号池故障转移：请求失败时自动换下一个启用账号重试')),
    keepaliveEnabled: volatileField(z.boolean().default(DOUBAO_DEFAULTS.keepaliveEnabled).description('每日保活巡检：定时检查各账号 cookie 是否仍被豆包接受并记录健康状态（读操作，默认关）')),
    backend: volatileField(z.string().default(DOUBAO_DEFAULTS.backend).description('上游后端：auto = 装好豆包 CLI 且已登录时优先 CLI，否则用 HTTP 抓包（默认）；cli = 只用 CLI；http = 只用 HTTP 抓包')),
    cliPath: volatileField(z.string().default('').description('doubao 可执行文件路径；留空自动探测 npm 全局 bin / PATH')),
    cliWorkspace: volatileField(z.string().default('').description('CLI 任务工作目录（-C）；留空用用户主目录')),
    cliPermissionMode: volatileField(z.string().default(DOUBAO_DEFAULTS.cliPermissionMode).description('CLI 权限模式：ask_always / ask_risky（默认）/ always_allow')),
    cliConcurrency: volatileField(z.number().default(DOUBAO_DEFAULTS.cliConcurrency).description('CLI 并发任务上限（CLI 是单账号共享后台，建议保持 1）')),
    cliEffort: volatileField(z.string().default('').description('CLI 推理强度：none/minimal/low/medium/high/xhigh/max；留空用模型默认')),
  })
}

/**
 * 解包 volatile 引用：schemastery 把 `.volatile()` 字段解析成 `{get(), write()}`
 * 引用对象，凡是「读配置值」的地方都过一遍这里，行为与老版普通值一致。
 *
 * 与 workbuddy 的 unwrapVolatileDeep 同构：剥一层 get()，对象/数组逐层递归；
 * 非引用值原样返回。
 */
export function unwrapVolatile(value) {
  if (value === null || value === undefined) return value
  if (typeof value.get === 'function') return unwrapVolatile(value.get())
  if (Array.isArray(value)) return value.map(entry => unwrapVolatile(entry))
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out = {}
    for (const [key, entry] of Object.entries(value)) out[key] = unwrapVolatile(entry)
    return out
  }
  return value
}

/**
 * 配置快照读取器：每次调用返回「解包后」的普通值对象。
 *
 * 为什么不是一次性解包：volatile 字段在宿主里是活引用，配置一改引用就地更新
 * （http://Volatile configuration），每次现读才能拿到最新值，也让「改了就生效」
 * 不需要重挂插件。`raw` 保留原对象供需要身份比较的老路径使用。
 * @param {object} rawHostConfig apply() 收到的宿主配置对象（可能含 volatile 引用）
 */
export function createConfigReader(rawHostConfig) {
  return () => unwrapVolatile(rawHostConfig ?? {}) ?? {}
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
  // 宿主可能把 volatile 字段解析成 {get()} 引用对象，先整体解包再收口
  const raw = unwrapVolatile(config) ?? {}
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
    // 只认 'per-chat'，其余一律回落 single（默认），避免配置笔误改变落库行为
    conversationMode: raw.conversationMode === 'per-chat' ? 'per-chat' : 'single',
    // 主账号：config.account 形状收口（cookie 校验在 credentials.js，这里只做形状收口）
    account: normalizeAccountShape(raw.account),
    poolEnabled: pick('poolEnabled', DOUBAO_DEFAULTS.poolEnabled) === true,
    keepaliveEnabled: pick('keepaliveEnabled', DOUBAO_DEFAULTS.keepaliveEnabled) === true,
    // 后端选择：只认 cli / http，其余一律 auto（含空值与笔误）
    backend: normalizeBackend(raw.backend),
    cliPath: typeof raw.cliPath === 'string' ? raw.cliPath.trim() : '',
    cliWorkspace: typeof raw.cliWorkspace === 'string' ? raw.cliWorkspace.trim() : '',
    cliPermissionMode: normalizePermissionMode(raw.cliPermissionMode),
    cliConcurrency: clampPositiveInt(pick('cliConcurrency', DOUBAO_DEFAULTS.cliConcurrency), DOUBAO_DEFAULTS.cliConcurrency),
    cliEffort: normalizeCliEffort(raw.cliEffort),
  }
}

/** CLI 推理强度收口：空 = 用模型默认；只认 CLI 支持的七档，其余回落空。 */
export function normalizeCliEffort(value) {
  const text = String(value ?? '').trim()
  return ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(text) ? text : ''
}

/** 后端选择收口：只认 cli / http，其余（含空值、笔误）回落 auto。 */
export function normalizeBackend(value) {
  const text = String(value ?? '').trim().toLowerCase()
  return text === 'cli' || text === 'http' ? text : 'auto'
}

/** CLI 权限模式收口：只认三档，其余回落 ask_risky。 */
export function normalizePermissionMode(value) {
  const text = String(value ?? '').trim()
  return ['ask_always', 'ask_risky', 'always_allow'].includes(text) ? text : DOUBAO_DEFAULTS.cliPermissionMode
}

/** 主账号形状收口：非对象 → 空对象；字段逐个收口为合法类型。 */
export function normalizeAccountShape(value) {
  const raw = value && typeof value === 'object' ? value : {}
  const pick = (key, fallback) => {
    const v = raw[key]
    return v === undefined || v === null ? fallback : v
  }
  return {
    id: typeof raw.id === 'string' ? raw.id.trim() : '',
    label: typeof raw.label === 'string' ? raw.label : '',
    cookie: typeof raw.cookie === 'string' ? raw.cookie.trim() : '',
    deviceId: typeof (raw.deviceId ?? raw.device_id) === 'string' ? String(raw.deviceId ?? raw.device_id).trim() : '',
    webId: typeof (raw.webId ?? raw.web_id) === 'string' ? String(raw.webId ?? raw.web_id).trim() : '',
    enabled: pick('enabled', true) !== false,
  }
}
