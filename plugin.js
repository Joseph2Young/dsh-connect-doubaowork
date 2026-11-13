/**
 * 纯编排：给定已构造好的 adapter 与宿主 ctx，完成注册与卸载。
 * 不 import 宿主包，便于用假 ctx 单测注册顺序与释放语义。
 */

/**
 * @param {object} ctx cordis 上下文（需有 ctx.llm 与 ctx.effect）
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
