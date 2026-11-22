/**
 * dsh-connect-doubaowork 入口：薄接线层。
 *
 * apply() 同步返回，内部异步完成「起 shim → 动态 import 宿主包 → 构造适配器 →
 * 注册」。任一失败仅记日志并放弃注册，不影响宿主其它插件（与参考实现
 * dsh-connect-workbuddy 的 attach 范式一致）。
 */
import z from '@deepseek-ai/schemastery'
import { createConfigSchema, normalizeConfig, DOUBAO_DEFAULTS, DOUBAO_QUERY, DOUBAO_SETTINGS_NS } from './config.js'
import { DOUBAO_PROVIDER, DOUBAO_PROVIDER_DISPLAY_NAME, DOUBAO_DEFAULT_MODEL, deriveCatalog, resolveModel, mergeCliModels } from './catalog.js'
import { loadAccountList } from './credentials.js'
import { buildRequestBody, pumpSse } from './doubao-protocol.js'
import { createDoubaoShim } from './shim.js'
import { createDoubaoAdapter } from './adapter.js'
import { createKeepalive } from './keepalive.js'
import { createCliClient, fetchCliModels, probeCli } from './cli-backend.js'
import { registerPluginRoutes } from './routes.js'
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
  // CLI 动态清单：登录后拉一次并缓存；拉取失败/未登录时回落静态表（catalog.js）
  let cliModels = []
  const models = () => deriveCatalog(enabledIds(), mergeCliModels(cliModels))
  // 账号池装配：插件配置主账号 → 凭据文件（数组或旧单账号）→ 自动发现
  const accounts = () => loadAccountList({
    account: config?.account ?? normalized.account,
    credentialsFile: typeof config?.credentialsFile === 'string' ? config.credentialsFile : normalized.credentialsFile,
    autoDiscover: config?.autoDiscoverCredentials !== false,
  })

  // CLI 状态快照：probeCli 是异步的，shim 侧需要同步判断，故用可变快照
  const cliPath = () => (typeof config?.cliPath === 'string' ? config.cliPath.trim() : normalized.cliPath)
  const cliState = { available: false, version: '', loggedIn: false, message: '尚未探测' }
  const cliClient = createCliClient({
    cliPath: cliPath(),
    workspace: typeof config?.cliWorkspace === 'string' ? config.cliWorkspace.trim() : normalized.cliWorkspace,
    permissionMode: normalized.cliPermissionMode,
    timeoutSeconds: normalized.timeoutSeconds,
    concurrency: normalized.cliConcurrency,
    log,
  })
  const refreshCli = async () => {
    const found = await probeCli({ cliPath: cliPath() })
    // backend=cli 时不看登录态也让 shim 走 CLI：错误信息由 CLI 自己透传，
    // 好过静默回落 HTTP 让用户以为在用 CLI
    const forced = (normalized.backend === 'cli')
    cliState.available = found.installed && (found.loggedIn || forced)
    cliState.version = found.version
    cliState.loggedIn = found.loggedIn
    cliState.message = found.message
    if (found.installed && found.loggedIn) {
      const listing = await fetchCliModels({ cliPath: cliPath() })
      cliModels = listing.models
      if (listing.error !== '' && listing.models.length === 0) log('warn', `豆包 CLI 模型清单拉取失败：${listing.error}`)
      else if (cliModels.length > 0) log('info', `豆包 CLI 模型清单：${cliModels.map(m => m.id).join(', ')}`)
    } else {
      cliModels = []
    }
    log('info', `豆包 CLI 状态：${found.installed ? (found.loggedIn ? '已安装且已登录' : '已安装未登录（需执行 doubao login）') : '未安装'}${found.version === '' ? '' : ` v${found.version}`}`)
    return { ...cliState, models: cliModels }
  }

  const shim = createDoubaoShim({
    catalog: models,
    resolveModel,
    accounts,
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
      poolEnabled: normalized.poolEnabled,
      backend: normalized.backend,
      conversationMode: normalized.conversationMode,
    },
    log,
    // CLI 后端：available() 是同步快照，run() 才真正拉子进程
    cli: {
      available: () => cliState.available,
      run: task => cliClient.run(task),
    },
  })

  // 每日保活巡检：opt-in（配置开关），手动按钮与定时器共用同一个巡检器
  const keepalive = createKeepalive({
    accounts,
    log,
    userAgent: normalized.userAgent,
    enabled: normalized.keepaliveEnabled,
  })
  ctx.effect(() => () => {
    keepalive.stop()
  })
  keepalive.schedule()

  // 插件路由：设置卡片读账号健康状态、手动触发巡检（webServer 缺席则降级）
  const disposeRoutes = registerPluginRoutes(ctx, {
    status: () => ({
      accounts: accounts().map(account => ({
        id: account.id,
        label: account.label,
        enabled: account.enabled !== false,
        health: keepalive.readState().results?.[account.id] ?? null,
      })),
      poolEnabled: normalized.poolEnabled,
      keepaliveEnabled: normalized.keepaliveEnabled,
      lastRun: keepalive.readState().lastRun ?? null,
      backend: normalized.backend,
      cli: { ...cliState, models: cliModels.map(model => model.id) },
    }),
    runKeepalive: () => keepalive.runNow('manual'),
    refreshCli: () => refreshCli(),
  })
  ctx.effect(() => () => {
    disposeRoutes?.()
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
      const backend = normalized.backend === 'http'
        ? 'http'
        : cliState.available ? 'cli' : 'http'
      log('info', `豆包工作模式网关已就绪：${shim.baseUrl()}（后端：${backend}；模型：${models().map(m => m.id).join(', ')}）`)
      // CLI 探测放到注册之后：探测要拉两次子进程（--version/auth status），
      // 不该阻塞 provider 上线；探测完成后目录会自然热更新（getModels 是 live 的）
      void refreshCli().then(state => {
        if (!stopped && state.models.length > 0) adapter.invalidate()
      }).catch(error => {
        if (!stopped) log('warn', `豆包 CLI 探测失败（不影响 HTTP 后端）：${error?.message ?? error}`)
      })
    })
    .catch(error => {
      if (!stopped) log('error', 'loopback endpoint failed to start; providers not registered', error)
    })
}

function settingsNamespaceOf(ctx) {
  const id = ctx?.fiber?.entry?.options?.id
  return typeof id === 'string' && id !== '' ? id : DOUBAO_SETTINGS_NS
}
