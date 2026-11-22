/**
 * 豆包工作模式模型目录。
 *
 * 两套上游共用一份「友好 id → 上游 id」映射表，避免同一个模型在模型选择器里
 * 出现两次：
 *
 *   - HTTP 后端（抓包 www.doubao.com/chat/completion）用 `modelItemKey` 定位模型；
 *   - CLI 后端（doubao -p --model）用 `cliId` 定位模型。
 *
 * 两个上游 id 在绝大多数模型上相同，因此「同一模型」天然按 modelItemKey/cliId
 * 对上；只有一边有的模型才单独出现（HTTP 清单 = 静态表；CLI 清单 = CLI 实报）。
 * 具体二选一逻辑见 catalogForBackend()。
 */

export const DOUBAO_PROVIDER = 'doubao'
export const DOUBAO_PROVIDER_DISPLAY_NAME = '豆包工作模式'
/** 两套后端都存在、语义一致的首选默认模型（CLI 的 is_default 也指向它）。 */
export const DOUBAO_DEFAULT_MODEL = 'deepseek-v4-flash'

/** 上游协议不接收 max_tokens，此值仅用于宿主展示与请求夹取。 */
const OUTPUT_TOKENS_256K = 32768
const OUTPUT_TOKENS_300K = 65536

/**
 * 静态目录（HTTP 后端权威清单）。
 *
 * 条目对照豆包桌面端工作模式 2026-11 实测清单（与 yyydsz/doubao2api 的
 * config.example.json model_params / model_aliases 表一致）。GLM 两个模型
 * 上游目前报错，仍保留条目以便上游恢复后立即可用。
 */
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

/**
 * 条目在两个后端上的上游 id。
 *
 * `cliId` 未显式声明时回落到 `modelItemKey`——两套上游对同一模型的命名一致
 * （CLI `model list` 报的正是抓包时的 model_item_key），这也正是「同一模型
 * 不会出现两次」的依据。
 */
export function upstreamId(entry, backend = 'http') {
  if (entry === undefined || entry === null) return ''
  const cli = String(entry.cliId ?? '').trim()
  const http = String(entry.modelItemKey ?? '').trim()
  if (backend === 'cli') return cli !== '' ? cli : http !== '' ? http : String(entry.id ?? '')
  return http !== '' ? http : cli !== '' ? cli : String(entry.id ?? '')
}

/**
 * 按 id / 别名 / 上游 id 解析目录条目；解析失败返回 undefined。
 * @param {string} idOrKey 友好 id、别名，或任一侧上游 id
 * @param {Array<object>} [base] 基础目录（默认静态表；二选一目录由调用方传入）
 */
export function resolveModel(idOrKey, base = DOUBAO_MODELS) {
  const id = String(idOrKey ?? '').trim()
  if (id === '') return undefined
  const source = Array.isArray(base) && base.length > 0 ? base : DOUBAO_MODELS
  const wanted = DOUBAO_MODEL_ALIASES[id] ?? id
  return source.find(model => (
    model.id === wanted
    || model.modelItemKey === wanted
    || model.cliId === wanted
  ))
}

/**
 * 计算运行时目录：enabledIds 为空 = 全部启用；否则按集合过滤（别名先归一）。
 * 过滤结果为空时回落全部目录，避免出现不可用的空路由。
 * @param {string[]} [enabledIds]
 * @param {Array<object>} [base] 基础目录（默认静态表）
 * @returns {Array<{id:string,name:string,modelItemKey:string,ratio:string,contextWindow:number,maxTokens:number}>}
 */
export function deriveCatalog(enabledIds, base = DOUBAO_MODELS) {
  const source = Array.isArray(base) && base.length > 0 ? base : DOUBAO_MODELS
  const raw = Array.isArray(enabledIds) ? enabledIds : []
  if (raw.length === 0) return [...source]
  const wanted = new Set()
  for (const entry of raw) {
    const resolved = resolveModel(entry, source)
    wanted.add(resolved === undefined ? String(entry) : resolved.id)
  }
  const picked = source.filter(model => wanted.has(model.id))
  return picked.length > 0 ? picked : [...source]
}

/**
 * 把 CLI 实报清单映射成目录条目，复用静态表的友好 id 与元信息。
 *
 * 匹配顺序：`modelItemKey`（= CLI 的 model id，两套上游同源）→ 都没命中才作为
 * CLI 独有条目追加（id 用 CLI 原始 id，HTTP 后端无法路由）。
 *
 * @param {Array<{id:string,name:string,isDefault?:boolean,efforts?:string[]}>} cliModels
 * @returns {Array<object>}
 */
export function catalogFromCli(cliModels) {
  const list = Array.isArray(cliModels) ? cliModels : []
  const merged = []
  const claimed = new Set()
  for (const reported of list) {
    const upstream = String(reported?.id ?? '').trim()
    if (upstream === '') continue
    const base = DOUBAO_MODELS.find(model => (model.cliId ?? model.modelItemKey) === upstream)
    const name = String(reported?.name ?? '').trim()
    const efforts = Array.isArray(reported?.efforts) && reported.efforts.length > 0 ? { efforts: reported.efforts.map(String) } : {}
    if (base === undefined) {
      merged.push({
        id: upstream,
        cliId: upstream,
        name: name !== '' ? name : upstream,
        modelItemKey: '',
        ratio: '',
        contextWindow: 256000,
        maxTokens: OUTPUT_TOKENS_256K,
        cliOnly: true,
        ...efforts,
      })
      continue
    }
    claimed.add(base.id)
    merged.push({
      ...base,
      cliId: upstream,
      name: name !== '' ? name : base.name,
      ...efforts,
    })
  }
  // CLI 未报但静态表里有的模型：CLI 后端无法路由，从 CLI 清单里剔除
  // （这正是「激活哪个后端就只显示哪个模型清单」的落点）。
  return merged
}

/**
 * 按「当前生效后端」产出目录——二选一，绝不合并且集。
 *
 * - `backend === 'cli'`：只用 CLI 实报清单（cliModels 为空时回落静态表，
 *   保证 CLI 探测还没跑完/失败时选择器不至于空白）；
 * - 其余（`http` / `auto`）：只用静态表（HTTP 抓包权威清单）。
 *
 * @param {'cli'|'http'|'auto'} backend
 * @param {Array<object>} [cliModels] CLI `model list --json` 产物
 * @param {string[]} [enabledIds] 用户勾选的模型（空 = 全部）
 * @returns {Array<object>}
 */
export function catalogForBackend(backend, cliModels, enabledIds = []) {
  const cliList = Array.isArray(cliModels) ? cliModels : []
  const useCli = backend === 'cli' && cliList.length > 0
  const base = useCli ? catalogFromCli(cliList) : [...DOUBAO_MODELS]
  return deriveCatalog(enabledIds, base)
}

/**
 * 后端默认模型：CLI 优先用 CLI 自己标了 is_default 的那个（映射回友好 id），
 * 映射不到或没标就回落 DOUBAO_DEFAULT_MODEL（两个后端都存在）。
 *
 * @param {'cli'|'http'|'auto'} backend
 * @param {Array<{id:string,isDefault?:boolean}>} [cliModels]
 * @returns {string}
 */
export function defaultModelForBackend(backend, cliModels) {
  if (backend !== 'cli') return DOUBAO_DEFAULT_MODEL
  const list = Array.isArray(cliModels) ? cliModels : []
  const preferred = list.find(model => model?.isDefault === true)
  const key = String(preferred?.id ?? '').trim()
  if (key === '') return DOUBAO_DEFAULT_MODEL
  const entry = DOUBAO_MODELS.find(model => (model.cliId ?? model.modelItemKey) === key)
  return entry === undefined ? DOUBAO_DEFAULT_MODEL : entry.id
}
