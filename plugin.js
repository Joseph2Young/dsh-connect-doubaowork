/**
 * 纯编排：给定已构造好的 adapter 与宿主 ctx，完成注册与卸载。
 * 不 import 宿主包，便于用假 ctx 单测注册顺序与释放语义。
 */

/**
 * @param {object} ctx cordis 上下文（需有 ctx.llm、ctx.effect、可选 ctx.get）
 * @param {object} deps { providerId, displayName, settingsNs, adapter, models() }
 * @returns {() => void} dispose
 */
export function bootstrap(ctx, deps) {
  const { providerId, displayName, settingsNs, adapter, models } = deps
  let releaseAdapter
  let releaseDirectory
  let disposed = false

  const dispose = () => {
    if (disposed) return
    disposed = true
    try {
      releaseAdapter?.()
    } catch {}
    try {
      releaseDirectory?.()
    } catch {}
  }

  // 先注册路由：空目录的 INITIAL 注册非法（INVALID_ADAPTER），活路由 replace([]) 才合法
  releaseAdapter = ctx.llm.registerAdapter([providerId], adapter)
  try {
    releaseDirectory = ctx.llm.registerConfigurableProviders([
      { provider: providerId, displayName, settingsNs, settingsPath: [], declared: false },
    ])
  } catch (error) {
    dispose()
    throw error
  }
  ctx.effect(() => () => {
    dispose()
  })

  ctx.llm.registerModelDiscovery(settingsNs, async () => {
    return models().map(model => ({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      inputModalities: ['text'],
    }))
  })

  return dispose
}

/**
 * 把插件自己的 Config 挂进宿主 settings 服务。
 *
 * 为什么必须有这一步：宿主「设置 → 模型」页列 provider 的条件是
 * `state.namespaces.has(entry.settingsNs)`，而 namespaces 来自 settings 服务的
 * `describe()`，它只收录「Config 里至少有一个 `.volatile()` 字段」的条目
 * （`volatileForm(schema) === undefined → 跳过`）。没有 volatile 字段的插件，
 * provider 照样能聊天，但永远不会出现在模型页——这正是豆包之前的状态。
 *
 * `auto: false` 表示不额外生成一份由宿主渲染的配置页（我们自己有设置卡片），
 * 只借用命名空间，让模型页能列出 provider 行并打开编辑。
 *
 * @param {object} ctx cordis 上下文
 * @param {object} options
 * @param {(ctx: object) => void} [options.onReady] settings 服务就绪后的回调
 * @returns {() => void} dispose（settings 缺席时为空操作）
 */
export function bindSettingsNamespace(ctx, { onReady, log } = {}) {
  // 幂等守卫：settings 服务重启会让 inject 回调再跑一遍，而宿主对同一个 fiber
  // 只允许 configure 一次（重复调用抛 "Settings presentation is already
  // configured for this plugin instance"）。这里自己守住这个状态。
  let configured = false
  const configure = settings => {
    if (settings === undefined || typeof settings.configure !== 'function') return false
    if (configured) return true
    try {
      ctx.effect(() => {
        const dispose = settings.configure({ auto: false }, ctx.fiber)
        configured = true
        return () => {
          configured = false
          dispose?.()
        }
      }, 'dsh-connect-doubaowork: settings presentation')
    } catch (error) {
      // 已配置过（极少数宿主在 effect 之外预先登记）时不算失败：命名空间照样在
      log?.('debug', `settings.configure 跳过（${error?.message ?? error}）`)
      configured = true
    }
    onReady?.(settings)
    return true
  }

  // 与 workbuddy 一致：优先响应式等待服务上线，避免启动顺序把注册吃掉
  if (typeof ctx?.inject === 'function') {
    ctx.inject(['settings'], settingsCtx => {
      configure(settingsCtx?.settings ?? settingsCtx?.get?.('settings'))
    })
    return () => {}
  }
  configure(ctx?.get?.('settings'))
  return () => {}
}
