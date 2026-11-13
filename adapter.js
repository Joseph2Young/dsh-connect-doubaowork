/**
 * 适配器装配：createProvider + openAICompletionsApi + PiAiAdapter。
 *
 * 与参考实现 dsh-connect-workbuddy/src/adapter.ts 同构，但去掉双 region、
 * EffortNormalizing 与 legacy context（本插件只用宿主单份 pi-ai，无 generation skew）。
 * 所有宿主符号经 host 注入，便于本地无宿主环境做单测。
 *
 * 关键点：
 *   - model.provider 必须等于 provider.id（pi-ai ModelsImpl.getModel 按 provider 查找）；
 *   - baseUrl 指向本地 shim（OpenAI SDK 会自动追加 /chat/completions）；
 *   - reasoning:false → pi-ai 不注入 reasoning_effort 参数，豆包的思考强度由
 *     shim 侧配置控制；
 *   - INERT_AUTH 禁掉 pi-ai 的凭据/环境自动发现，凭据只来自 resolveApiKey。
 */

export const DOUBAO_STREAM_IDLE_TIMEOUT_MS = 300_000

const NO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

/** 文本-only 工作模式：放开图片预算上限以免宿主预裁剪（实际不支持图片）。 */
const REQUEST_IMAGE_BUDGETS = Object.freeze({
  maxRequestImages: 1_000_000,
  imageOffloadCountQuantum: 1_000_000,
  maxRequestImageBytes: 20_971_520,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576,
})

const INERT_AUTH = Object.freeze({
  credentials: Object.freeze({
    async read() {
      return undefined
    },
    async list() {
      return []
    },
    async modify() {
      throw new Error('dsh-connect-doubaowork: the doubao route has no pi-ai credential lifecycle')
    },
    async delete() {},
  }),
  authContext: Object.freeze({
    async env() {
      return undefined
    },
    async fileExists() {
      return false
    },
  }),
})

/** 目录条目 → pi-ai Model。 */
export function toPiModel(info, baseUrl, identity) {
  return {
    id: info.id,
    name: info.name,
    api: 'openai-completions',
    provider: identity,
    baseUrl,
    input: ['text'],
    cost: { ...NO_COST },
    contextWindow: info.contextWindow,
    maxTokens: info.maxTokens,
    reasoning: false,
    compat: {
      // 豆包走本地 shim：无需 store / stream_options / developer role，
      // 线上请求保持最小形状。
      supportsStore: false,
      supportsUsageInStreaming: false,
      supportsDeveloperRole: false,
    },
  }
}

/**
 * @param {object} host 宿主符号 { createProvider, openAICompletionsApi, resolveRetryPolicy, PiAiAdapter }
 * @param {object} options { providerId, displayName, baseUrl(): string, models(): entries,
 *   token(): string, streamIdleTimeoutMs? }
 */
export function createDoubaoAdapter(host, options) {
  const { createProvider, openAICompletionsApi, resolveRetryPolicy, PiAiAdapter } = host
  const providerId = options.providerId ?? 'doubao'
  const identity = providerId
  const displayName = options.displayName ?? '豆包工作模式'

  const buildModels = () => options.models().map(info => toPiModel(info, options.baseUrl(), identity))

  const base = createProvider({
    id: providerId,
    name: displayName,
    auth: {
      apiKey: {
        name: 'Doubao loopback token',
        async resolve({ credential } = {}) {
          const key = credential?.key
          return key === undefined || key.length === 0 ? undefined : { auth: { apiKey: key }, source: 'Doubao' }
        },
      },
    },
    models: buildModels(),
    api: openAICompletionsApi(),
  })
  // getModels 保持 live：目录刷新后无需重建 provider
  const provider = { ...base, getModels: () => buildModels() }

  const buildProfiles = () => {
    const profiles = new Map()
    profiles.set(providerId, {
      provider: providerId,
      displayName,
      streamIdleTimeoutMs: options.streamIdleTimeoutMs ?? DOUBAO_STREAM_IDLE_TIMEOUT_MS,
      retryPolicy: resolveRetryPolicy(undefined, 'dsh-connect-doubaowork retryPolicy'),
      configuredMaxTokens: new Map(),
      modelErrors: new Map(),
      reasoning: undefined,
      ...REQUEST_IMAGE_BUDGETS,
      headers: undefined,
      piProvider: provider,
    })
    return profiles
  }
  let profiles = buildProfiles()

  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    auth: INERT_AUTH,
    resolveApiKey: async () => options.token(),
    prepareHeaders: (_request, headers) => headers,
  })

  return {
    adapter,
    /** 目录变化后调用：更换 profiles Map 身份，强制 PiAiAdapter 重建快照。 */
    invalidate() {
      profiles = buildProfiles()
    },
  }
}
