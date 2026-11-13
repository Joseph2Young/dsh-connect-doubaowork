/**
 * 豆包工作模式静态模型目录。
 *
 * 条目对照豆包桌面端工作模式 2026-11 实测清单（与 yyydsz/doubao2api 的
 * config.example.json model_params / model_aliases 表一致）。GLM 两个模型
 * 上游目前报错，仍保留条目以便上游恢复后立即可用。
 */

export const DOUBAO_PROVIDER = 'doubao'
export const DOUBAO_PROVIDER_DISPLAY_NAME = '豆包工作模式'
export const DOUBAO_DEFAULT_MODEL = 'deepseek-v4-flash'

/** 上游协议不接收 max_tokens，此值仅用于宿主展示与请求夹取。 */
const OUTPUT_TOKENS_256K = 32768
const OUTPUT_TOKENS_300K = 65536

export const DOUBAO_MODELS = [
  { id: 'auto', name: '自动', modelItemKey: '9', ratio: '免费', contextWindow: 256000, maxTokens: OUTPUT_TOKENS_256K },
  { id: 'doubao-2.1-lite', name: '豆包 2.1 Lite', modelItemKey: 'seed-lite-7b', ratio: '限时 0.01x', contextWindow: 256000, maxTokens: OUTPUT_TOKENS_256K },
  { id: 'doubao-2.1-pro', name: '豆包 2.1 Pro', modelItemKey: '5', ratio: '0.65x', contextWindow: 256000, maxTokens: OUTPUT_TOKENS_256K },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4.1 Flash', modelItemKey: 'person-deepseek-v4-1-flash-261017', ratio: '限时 0.01x', contextWindow: 300000, maxTokens: OUTPUT_TOKENS_300K },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', modelItemKey: 'person-deepseek-v4-pro-ga-260813', ratio: '0.46x', contextWindow: 300000, maxTokens: OUTPUT_TOKENS_300K },
  { id: 'kimi-k3', name: 'Kimi K3', modelItemKey: 'person-kimi-k3-261111', ratio: '1.48x', contextWindow: 300000, maxTokens: OUTPUT_TOKENS_300K },
  { id: 'kimi-k3.1-pro', name: 'Kimi K3.1 Pro', modelItemKey: 'person-kimi-k3-1-pro-261111', ratio: '0.95x', contextWindow: 300000, maxTokens: OUTPUT_TOKENS_300K },
  { id: 'kimi-k3.1-pro-fast', name: 'Kimi K3.1 Pro 高速', modelItemKey: 'person-kimi-k3-1-pro-highspeed-261111', ratio: '1.44x', contextWindow: 300000, maxTokens: OUTPUT_TOKENS_300K },
  { id: 'glm-5.3', name: 'GLM 5.3', modelItemKey: 'person-glm-5-3-261111', ratio: '0.80x', contextWindow: 300000, maxTokens: OUTPUT_TOKENS_300K },
  { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', modelItemKey: 'person-glm-5-3-flash-261111', ratio: '0.08x', contextWindow: 300000, maxTokens: OUTPUT_TOKENS_300K },
]

/** 对外别名（与上游 doubao2api 保持一致）。 */
export const DOUBAO_MODEL_ALIASES = Object.freeze({
  doubao: 'deepseek-v4-flash',
  deepseek: 'deepseek-v4-flash',
})

/** 按 id / 别名 / 上游 model_item_key 解析目录条目；解析失败返回 undefined。 */
export function resolveModel(idOrKey) {
  const id = String(idOrKey ?? '').trim()
  if (id === '') return undefined
  const wanted = DOUBAO_MODEL_ALIASES[id] ?? id
  return DOUBAO_MODELS.find(model => model.id === wanted || model.modelItemKey === wanted)
}

/**
 * 计算运行时目录：enabledIds 为空 = 全部启用；否则按集合过滤（别名先归一）。
 * 过滤结果为空时回落全部目录，避免出现不可用的空路由。
 * @param {string[]} [enabledIds]
 * @returns {Array<{id:string,name:string,modelItemKey:string,ratio:string,contextWindow:number,maxTokens:number}>}
 */
export function deriveCatalog(enabledIds) {
  const raw = Array.isArray(enabledIds) ? enabledIds : []
  if (raw.length === 0) return [...DOUBAO_MODELS]
  const wanted = new Set()
  for (const entry of raw) {
    const resolved = resolveModel(entry)
    wanted.add(resolved === undefined ? String(entry) : resolved.id)
  }
  const picked = DOUBAO_MODELS.filter(model => wanted.has(model.id))
  return picked.length > 0 ? picked : [...DOUBAO_MODELS]
}
