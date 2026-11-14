/**
 * dsh-connect-doubaowork 入口：薄接线层。
 *
 * apply() 同步返回，内部异步完成「起 shim → 动态 import 宿主包 → 构造适配器 →
 * 注册」。任一失败仅记日志并放弃注册，不影响宿主其它插件（与参考实现
 * dsh-connect-workbuddy 的 attach 范式一致）。
 */
import z from '@deepseek-ai/schemastery'
import { createConfigSchema, normalizeConfig, DOUBAO_DEFAULTS, DOUBAO_QUERY, DOUBAO_SETTINGS_NS } from './config.js'
import { DOUBAO_PROVIDER, DOUBAO_PROVIDER_DISPLAY_NAME, DOUBAO_DEFAULT_MODEL, deriveCatalog, resolveModel } from './catalog.js'
import { loadCredentials } from './credentials.js'
import { buildRequestBody, pumpSse } from './doubao-protocol.js'
import { createDoubaoShim } from './shim.js'
import { createDoubaoAdapter } from './adapter.js'
import { bootstrap } from './plugin.js'

export const name = 'dsh-connect-doubaowork'
export const inject = ['llm']
export const Config = createConfigSchema(z)

export function apply(ctx, config) {
  const settingsNs = settingsNamespaceOf(ctx)
  const normalized = normalizeConfig(config)
  const log = (level, message, error) => {
    const fn = ctx.logger?.[level]
    if (typeof fn === 'function') fn.call(ctx.logger, message, error)
    else console[level === 'error' ? 'error' : 'log'](`[dsh-connect-doubaowork] ${message}`, error ?? '')
  }

  // 目录每次现读活配置；normalizeConfig 是 apply 期快照，volatile 变更随重挂生效
  const enabledIds = () => (Array.isArray(config?.enabledModelIds) ? config.enabledModelIds.map(String) : normalized.enabledModelIds)
  const models = () => deriveCatalog(enabledIds())
  const credentials = () => loadCredentials({
    credentialsFile: typeof config?.credentialsFile === 'string' ? config.credentialsFile : normalized.credentialsFile,
    autoDiscover: config?.autoDiscoverCredentials !== false,
  })

  const shim = createDoubaoShim({
    catalog: models,
    resolveModel,
    credentials,
    buildBody: buildRequestBody,
    pump: pumpSse,
    defaults: {
      ...DOUBAO_DEFAULTS,
      query: DOUBAO_QUERY,
      defaultModel: DOUBAO_DEFAULT_MODEL,
      reasoningEffort: normalized.reasoningEffort,
      chatUrl: normalized.chatUrl,
      userAgent: normalized.userAgent,
      timeoutSeconds: normalized.timeoutSeconds,
      heartbeatSeconds: normalized.heartbeatSeconds,
      flattenHistory: normalized.flattenHistory,
      workMode: normalized.workMode,
      conversationMode: normalized.conversationMode,
    },
    log,
  })

  let stopped = false
  ctx.effect(() => () => {
    stopped = true
    void shim.close()
  })

  void shim.start()
    .then(async () => {
      if (stopped) return
      const [piAiModule, dshLlmModule, piAiPackage, lazyApi] = await Promise.all([
        import('@deepseek-ai/dsh-llm-pi-ai'),
        import('@deepseek-ai/dsh-llm'),
        import('@earendil-works/pi-ai'),
        import('@earendil-works/pi-ai/api/openai-completions.lazy'),
      ])
      if (stopped) return
      const { adapter } = createDoubaoAdapter(
        {
          createProvider: piAiPackage.createProvider,
          openAICompletionsApi: lazyApi.openAICompletionsApi,
          resolveRetryPolicy: dshLlmModule.resolveRetryPolicy,
          PiAiAdapter: piAiModule.PiAiAdapter,
        },
        {
          providerId: DOUBAO_PROVIDER,
          displayName: DOUBAO_PROVIDER_DISPLAY_NAME,
          baseUrl: () => shim.baseUrl(),
          models,
          token: () => shim.token(),
        },
      )
      bootstrap(ctx, {
        providerId: DOUBAO_PROVIDER,
        displayName: DOUBAO_PROVIDER_DISPLAY_NAME,
        settingsNs,
        adapter,
        models,
      })
      log('info', `豆包工作模式网关已就绪：${shim.baseUrl()}（模型：${models().map(m => m.id).join(', ')}）`)
    })
    .catch(error => {
      if (!stopped) log('error', 'loopback endpoint failed to start; providers not registered', error)
    })
}

function settingsNamespaceOf(ctx) {
  const id = ctx?.fiber?.entry?.options?.id
  return typeof id === 'string' && id !== '' ? id : DOUBAO_SETTINGS_NS
}
