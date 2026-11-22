/**
 * dsh-connect-doubaowork 入口：薄接线层。
 *
 * apply() 同步返回，内部异步完成「起 shim → 动态 import 宿主包 → 构造适配器 →
 * 注册」。任一失败仅记日志并放弃注册，不影响宿主其它插件（与参考实现
 * dsh-connect-workbuddy 的 attach 范式一致）。
 */
import z from '@deepseek-ai/schemastery'
import { createConfigSchema, createConfigReader, normalizeConfig, DOUBAO_DEFAULTS, DOUBAO_QUERY, DOUBAO_SETTINGS_NS } from './config.js'
import { DOUBAO_PROVIDER, DOUBAO_PROVIDER_DISPLAY_NAME, catalogForBackend, defaultModelForBackend, resolveModel } from './catalog.js'
import { loadAccountList } from './credentials.js'
import { buildRequestBody, pumpSse } from './doubao-protocol.js'
import { createDoubaoShim } from './shim.js'
import { createDoubaoAdapter } from './adapter.js'
import { createKeepalive } from './keepalive.js'
import { createCliClient, fetchCliModels, probeCli } from './cli-backend.js'
import { inspectSetup, formatSetupGuide } from './onboarding.js'
import { registerPluginRoutes } from './routes.js'
import { createLoginManager } from './login.js'
import { bootstrap, bindSettingsNamespace } from './plugin.js'

export const name = 'dsh-connect-doubaowork'
// 只硬依赖 llm：settings 走 apply 里的响应式 ctx.inject（老宿主没有 settings
// 服务时插件仍能聊天，只是模型页不列本 provider）。
export const inject = ['llm']
export const Config = createConfigSchema(z)

export function apply(ctx, config) {
  const settingsNs = settingsNamespaceOf(ctx)
  // 活配置读取器：volatile 字段改动是就地更新引用（不重挂插件），
  // 所以任何「用户能改」的配置都必须现读，不能用 apply 期快照。
  const readConfig = createConfigReader(config)
  const normalized = normalizeConfig(config)
  const log = (level, message, error) => {
    const fn = ctx.logger?.[level]
    if (typeof fn === 'function') fn.call(ctx.logger, message, error)
    else console[level === 'error' ? 'error' : 'log'](`[dsh-connect-doubaowork] ${message}`, error ?? '')
  }

  // 把本插件的 Config 挂进宿主 settings 服务：这一步决定 provider 能否出现在
  // 「设置 → 模型」页（宿主只枚举有 volatile 字段的命名空间）。失败不影响聊天。
  try {
    bindSettingsNamespace(ctx, {
      log,
      onReady: () => log('debug', 'settings 命名空间已就绪（模型页可编辑本 provider）'),
    })
  } catch (error) {
    log('warn', `settings 命名空间注册失败（模型页可能不显示本 provider）：${error?.message ?? error}`)
  }

  // 每次现读：volatile 变更立刻生效（后端/模型勾选/CLI 路径等）
  const pick = key => {
    const live = readConfig()
    return live[key] === undefined ? normalized[key] : live[key]
  }
  const backendOf = () => {
    const value = String(pick('backend') ?? 'auto')
    return value === 'cli' || value === 'http' ? value : 'auto'
  }
  /** 当前实际生效的后端（auto 在 CLI 可用时走 cli），模型目录据此二选一。 */
  const effectiveBackend = () => {
    const wanted = backendOf()
    if (wanted === 'http') return 'http'
    if (wanted === 'cli') return 'cli'
    return cliState.available ? 'cli' : 'http'
  }
  const enabledIds = () => {
    const value = pick('enabledModelIds')
    return Array.isArray(value) ? value.map(String) : []
  }
  // CLI 动态清单：登录后拉一次并缓存；拉取失败/未登录时回落静态表（catalog.js）
  let cliModels = []
  // 二选一：走 CLI 只列 CLI 实报清单，走 HTTP 只列静态表，绝不并集
  const models = () => catalogForBackend(effectiveBackend(), cliModels, enabledIds())
  const defaultModel = () => defaultModelForBackend(effectiveBackend(), cliModels)
  // 账号池装配：插件配置主账号 → 凭据文件（数组或旧单账号）→ 自动发现
  const accounts = () => loadAccountList({
    account: pick('account'),
    credentialsFile: pick('credentialsFile'),
    autoDiscover: pick('autoDiscoverCredentials') !== false,
  })

  // CLI 状态快照：probeCli 是异步的，shim 侧需要同步判断，故用可变快照
  const cliPath = () => {
    const value = pick('cliPath')
    return typeof value === 'string' ? value.trim() : ''
  }
  // CLI 探测状态：安装态/登录态/版本，供设置卡片与启动日志展示
  // installed 与 available 分开：未登录时 installed 仍为 true，供卡片如实展示；
  // available 还要求（已登录 或 用户显式选了 backend='cli'）
  const cliState = { available: false, installed: false, version: '', loggedIn: false, message: '尚未探测' }
  const cliClient = createCliClient({
    // 全部传函数：volatile 改了路径/工作区/权限/并发立刻生效，不必重挂插件
    cliPath,
    workspace: () => {
      const value = pick('cliWorkspace')
      return typeof value === 'string' ? value.trim() : ''
    },
    permissionMode: () => String(pick('cliPermissionMode') ?? 'ask_risky'),
    timeoutSeconds: () => Number(pick('timeoutSeconds') ?? 300),
    concurrency: () => Number(pick('cliConcurrency') ?? 1),
    log,
  })
  const refreshCli = async () => {
    const found = await probeCli({ cliPath: cliPath() })
    // backend=cli 时不看登录态也让 shim 走 CLI：错误信息由 CLI 自己透传，
    // 好过静默回落 HTTP 让用户以为在用 CLI
    const forced = backendOf() === 'cli'
    cliState.installed = found.installed
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

  // 首次使用引导：检查本机有没有可用接入方式（CLI 或 Cookie），没有就给出安装/配置步骤
  const inspect = () => inspectSetup({
    credentialsFile: pick('credentialsFile'),
    autoDiscover: pick('autoDiscoverCredentials') !== false,
    cliPath: cliPath(),
    account: pick('account'),
  })
  // 引导快照：初始为「尚未检查」，refreshSetup() 后填真值；失败也留一条可读结果
  let setupState = { ready: false, backend: '', steps: [], summary: {}, pending: true }
  const refreshSetup = async () => {
    try {
      const result = await inspect()
      setupState = { ...result, pending: false }
      return setupState
    } catch (error) {
      setupState = {
        ready: false,
        backend: '',
        steps: [],
        summary: {},
        pending: false,
        error: String(error?.message ?? error),
      }
      return setupState
    }
  }

  // 扫码登录管理器：把 `doubao login --qr=png` 的二维码搬进设置卡片。
  // 子进程生命周期由卸载时统一回收（见下方 ctx.effect）。
  const login = createLoginManager({
    cliPath,
    log,
    // 探测用同一套 probeCli，保证卡片上的 CLI 状态与登录判定同源
    probe: options => probeCli(options),
  })

  const shim = createDoubaoShim({
    catalog: models,
    resolveModel,
    accounts,
    buildBody: buildRequestBody,
    pump: pumpSse,
    defaults: {
      ...DOUBAO_DEFAULTS,
      query: DOUBAO_QUERY,
      // 以下全部用 getter：shim 侧每次读 defaults.X 都拿活配置，
      // 用户在设置卡片/模型页改完立刻生效（volatile 不重挂插件）。
      get defaultModel() { return defaultModel() },
      get reasoningEffort() { return String(pick('reasoningEffort') ?? normalized.reasoningEffort) },
      get chatUrl() { return String(pick('chatUrl') ?? normalized.chatUrl) },
      get userAgent() { return String(pick('userAgent') ?? normalized.userAgent) },
      get timeoutSeconds() { return Number(pick('timeoutSeconds') ?? normalized.timeoutSeconds) },
      get heartbeatSeconds() { return Number(pick('heartbeatSeconds') ?? normalized.heartbeatSeconds) },
      get flattenHistory() { return pick('flattenHistory') !== false },
      get workMode() { return pick('workMode') !== false },
      get conversationMode() { return String(pick('conversationMode') ?? normalized.conversationMode) },
      get poolEnabled() { return pick('poolEnabled') === true },
      get backend() { return backendOf() },
      get cliEffort() { return String(pick('cliEffort') ?? '') },
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
    userAgent: String(pick('userAgent') ?? normalized.userAgent),
    enabled: false,
    enabledOf: () => pick('keepaliveEnabled') === true,
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
      poolEnabled: pick('poolEnabled') === true,
      keepaliveEnabled: pick('keepaliveEnabled') === true,
      lastRun: keepalive.readState().lastRun ?? null,
      backend: backendOf(),
      // 实际生效的接入方式与「当前后端的模型清单」——设置卡片据此说明现在列的是哪一套
      effectiveBackend: effectiveBackend(),
      // settings 命名空间：模型页靠它精确匹配 `namespaces.has(settingsNs)`，
      // 对不上整行不渲染，所以把它暴露出来便于排查
      settingsNs,
      models: models().map(model => model.id),
      defaultModel: defaultModel(),
      cli: { ...cliState, models: cliModels.map(model => model.id) },
      // 首次使用引导快照（不含任何凭据内容）
      setup: setupState,
      // 进行中的扫码登录（只报有无与剩余时间，二维码字节不进 status）
      login: login.snapshot(),
    }),
    runKeepalive: () => keepalive.runNow('manual'),
    refreshCli: () => refreshCli(),
    refreshSetup: () => refreshSetup(),
    login: {
      start: () => login.start(),
      poll: id => login.poll(id),
      cancel: () => login.cancel(),
    },
  })
  ctx.effect(() => () => {
    // 插件卸载/重载时先取消扫码登录，避免留下孤儿 doubao login 子进程
    // （CLI 有单实例锁，孤儿进程会让用户后续所有登录都报 conflict）
    try {
      login.cancel()
    } catch {}
    disposeRoutes?.()
  })

  let stopped = false
  ctx.effect(() => () => {
    stopped = true
    void shim.close()
  })

  // provider 注册成功后才有 adapter 可刷；CLI 探测与引导检查不依赖它，
  // 因此单独持有引用，注册失败时设置卡片仍能看到 CLI 状态。
  let adapterApi = null
  // 用户在设置里改了「后端」或「模型清单」后，pi-ai 的目录快照必须换身份，
  // 否则模型选择器一直显示旧后端的模型。volatile 改动不重挂插件，只能靠这个事件。
  ctx.on?.('loader/volatile-update', () => {
    if (stopped) return
    adapterApi?.invalidate()
  })
  // 探测 CLI（子进程 --version / auth status，约 0.6s）与首次引导检查。
  // 都在注册前后判一次 stopped，避免插件已卸载还去拉子进程。
  const scheduleProbes = () => {
    void refreshCli().then(state => {
      if (stopped) return
      if (state.models.length > 0) adapterApi?.invalidate()
    }).catch(error => {
      if (!stopped) log('warn', `豆包 CLI 探测失败（不影响 HTTP 后端）：${error?.message ?? error}`)
    })
    void refreshSetup().then(state => {
      if (stopped) return
      if (state.ready === true) {
        log('info', `豆包插件就绪（${state.summary?.cliReady ? 'CLI' : 'HTTP'} 接入可用）`)
        return
      }
      log('warn', `豆包插件尚未配置完成，模型调用会失败。修复步骤：\n${formatSetupGuide(state)}`)
    }).catch(error => {
      if (!stopped) log('warn', `豆包首次使用引导检查失败：${error?.message ?? error}`)
    })
  }

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
      adapterApi = adapter
      const backend = effectiveBackend()
      log('info', `豆包工作模式网关已就绪：${shim.baseUrl()}（后端：${backend}；模型：${models().map(m => m.id).join(', ')}）`)
      // CLI 探测放到注册之后：探测要拉两次子进程（--version/auth status），
      // 不该阻塞 provider 上线；探测完成后目录会自然热更新（getModels 是 live 的）
      scheduleProbes()
    })
    .catch(error => {
      if (stopped) return
      log('error', 'loopback endpoint failed to start; providers not registered', error)
      // provider 注册失败也要探测：设置卡片得能显示 CLI/凭据到底什么状态，
      // 否则用户看到的是一张全空白的卡片，无从判断该修哪一步。
      scheduleProbes()
    })
}

function settingsNamespaceOf(ctx) {
  const id = ctx?.fiber?.entry?.options?.id
  return typeof id === 'string' && id !== '' ? id : DOUBAO_SETTINGS_NS
}
