import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { createDoubaoAdapter, toPiModel, DOUBAO_STREAM_IDLE_TIMEOUT_MS } from '../adapter.js'
import { bootstrap, bindSettingsNamespace } from '../plugin.js'
import { deriveCatalog } from '../catalog.js'

const HOST = {
  createdProviderInput: null,
  createProvider: input => {
    HOST.createdProviderInput = input
    return { ...input, stream: () => {} }
  },
  openAICompletionsApi: () => ({ marker: 'openai-completions' }),
  resolveRetryPolicy: (policy, label) => ({ policy: policy ?? 'normal', label }),
  PiAiAdapter: class {
    constructor(config) {
      this.config = config
    }
  },
}

test('toPiModel 形状：provider 恒等 + 最小 compat', () => {
  const model = toPiModel(
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4.1 Flash', contextWindow: 300000, maxTokens: 65536 },
    'http://127.0.0.1:1234/v1',
    'doubao',
  )
  assert.equal(model.provider, 'doubao')
  assert.equal(model.api, 'openai-completions')
  assert.equal(model.baseUrl, 'http://127.0.0.1:1234/v1')
  assert.deepEqual(model.input, ['text'])
  assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  assert.equal(model.contextWindow, 300000)
  assert.equal(model.maxTokens, 65536)
  assert.equal(model.reasoning, false)
  assert.equal(model.compat.supportsStore, false)
  assert.equal(model.compat.supportsUsageInStreaming, false)
  assert.equal(model.compat.supportsDeveloperRole, false)
})

test('createDoubaoAdapter 装配 profiles 与凭据', async () => {
  const { adapter, invalidate } = createDoubaoAdapter(HOST, {
    providerId: 'doubao',
    displayName: '豆包工作模式',
    baseUrl: () => 'http://127.0.0.1:65535/v1',
    models: () => deriveCatalog(['doubao']),
    token: () => 'shim-token',
  })
  const profiles = adapter.config.profiles()
  const profile = profiles.get('doubao')
  assert.equal(profile.displayName, '豆包工作模式')
  assert.equal(profile.streamIdleTimeoutMs, DOUBAO_STREAM_IDLE_TIMEOUT_MS)
  assert.equal(profile.retryPolicy.label, 'dsh-connect-doubaowork retryPolicy')
  assert.equal(profile.reasoning, undefined)
  assert.equal(profile.piProvider.id, 'doubao')
  assert.equal(HOST.createdProviderInput.api.marker, 'openai-completions')
  assert.equal(HOST.createdProviderInput.id, 'doubao')
  assert.equal(await adapter.config.resolveApiKey(), 'shim-token')
  const models = profile.piProvider.getModels()
  assert.deepEqual(models.map(m => m.id), ['deepseek-v4-flash'])
  assert.ok(models.every(m => m.provider === 'doubao'))

  // INERT_AUTH：阻断 pi-ai 自身凭据生命周期
  assert.deepEqual(await adapter.config.auth.credentials.list(), [])
  assert.equal(await adapter.config.auth.credentials.read(), undefined)
  await assert.rejects(adapter.config.auth.credentials.modify(), /no pi-ai credential lifecycle/)
  assert.equal(await adapter.config.auth.authContext.env(), undefined)
  assert.equal(await adapter.config.auth.authContext.fileExists(), false)

  // invalidate 更换 profiles Map 身份
  const before = adapter.config.profiles()
  invalidate()
  assert.notEqual(adapter.config.profiles(), before)
})

test('bootstrap 注册顺序与释放语义', async () => {
  const calls = []
  let effectCleanup
  const fakeCtx = {
    llm: {
      registerAdapter: (providers, adapter) => {
        calls.push(['adapter', providers, adapter])
        return () => calls.push(['adapter-release'])
      },
      registerConfigurableProviders: entries => {
        calls.push(['directory', entries])
        return () => calls.push(['directory-release'])
      },
      registerModelDiscovery: (ns, fn) => {
        calls.push(['discovery', ns])
        fakeCtx.discover = fn
      },
    },
    effect: fn => {
      calls.push(['effect-register'])
      effectCleanup = fn()
    },
  }
  const adapter = { marker: 'adapter' }
  const dispose = bootstrap(fakeCtx, {
    providerId: 'doubao',
    displayName: '豆包工作模式',
    settingsNs: 'dsh-connect-doubaowork',
    adapter,
    models: () => deriveCatalog(['auto']),
  })
  assert.deepEqual(calls, [
    ['adapter', ['doubao'], adapter],
    ['directory', [{ provider: 'doubao', displayName: '豆包工作模式', settingsNs: 'dsh-connect-doubaowork', settingsPath: [], declared: false }]],
    ['effect-register'],
    ['discovery', 'dsh-connect-doubaowork'],
  ])
  const discovery = await fakeCtx.discover()
  assert.deepEqual(discovery, [
    { id: 'auto', name: '自动', contextWindow: 256000, maxTokens: 32768, inputModalities: ['text'] },
  ])
  effectCleanup()
  assert.deepEqual(calls.slice(4), [['adapter-release'], ['directory-release']])
  dispose() // 幂等：重复释放不再动作
  assert.equal(calls.length, 6)
})

test('bootstrap 目录注册失败时回收路由', () => {
  let released = false
  const fakeCtx = {
    llm: {
      registerAdapter: () => () => {
        released = true
      },
      registerConfigurableProviders: () => {
        throw new Error('DUPLICATE_DIRECTORY')
      },
      registerModelDiscovery: () => {},
    },
    effect: () => {},
  }
  assert.throws(
    () => bootstrap(fakeCtx, { providerId: 'doubao', displayName: 'x', settingsNs: 'ns', adapter: {}, models: () => [] }),
    /DUPLICATE_DIRECTORY/,
  )
  assert.equal(released, true)
})

// ── 0.5.0：settings 命名空间绑定（决定 provider 能否出现在「设置 → 模型」页） ──
// 宿主 dsh-settings 的 describe() 只收录「Config 至少有一个 .volatile() 字段」的
// 条目；模型页要 state.namespaces.has(settingsNs) 才渲染行。所以插件必须在
// apply 期把 Config 挂进 settings 服务（settings.configure）。

test('bindSettingsNamespace：优先响应式等待 settings 服务，configure 立即生效', () => {
  const injected = []
  const effectCalls = []
  const configured = []
  const fakeCtx = {
    fiber: { id: 'fiber-1' },
    inject: (names, callback) => {
      injected.push(names)
      callback({
        settings: {
          configure: (presentation, owner) => {
            configured.push([presentation, owner])
            return () => configured.push(['dispose'])
          },
        },
      })
    },
    effect: (fn, label) => {
      effectCalls.push(label)
      const cleanup = fn()
      return cleanup
    },
  }
  let ready = null
  const dispose = bindSettingsNamespace(fakeCtx, { onReady: settings => { ready = settings } })
  assert.deepEqual(injected, [['settings']])
  assert.equal(configured.length, 1)
  assert.deepEqual(configured[0][0], { auto: false }, 'auto:false 表示不额外生成宿主渲染的配置页')
  assert.equal(configured[0][1], fakeCtx.fiber, 'configure 必须绑定本插件的 fiber')
  assert.deepEqual(effectCalls, ['dsh-connect-doubaowork: settings presentation'])
  assert.ok(ready !== null, 'settings 就绪后应回调 onReady')
  assert.equal(typeof dispose, 'function')
})

test('bindSettingsNamespace：没有 inject 的老宿主退回同步探测', () => {
  const effectLabels = []
  const fakeCtx = {
    fiber: {},
    get: name => (name === 'settings' ? { configure: () => () => {} } : undefined),
    effect: (fn, label) => {
      effectLabels.push(label)
      return fn()
    },
  }
  bindSettingsNamespace(fakeCtx)
  assert.deepEqual(effectLabels, ['dsh-connect-doubaowork: settings presentation'])
})

test('bindSettingsNamespace：settings 缺席时静默降级（不抛错、不注册）', () => {
  const effectLabels = []
  const fakeCtx = {
    fiber: {},
    get: () => undefined,
    effect: (fn, label) => {
      effectLabels.push(label)
      return fn()
    },
  }
  assert.doesNotThrow(() => bindSettingsNamespace(fakeCtx))
  assert.deepEqual(effectLabels, [])
})

test('bindSettingsNamespace：settings 服务存在但缺 configure 时不注册', () => {
  const effectLabels = []
  const fakeCtx = {
    fiber: {},
    inject: (names, callback) => callback({ settings: {} }),
    effect: (fn, label) => {
      effectLabels.push(label)
      return fn()
    },
  }
  assert.doesNotThrow(() => bindSettingsNamespace(fakeCtx))
  assert.deepEqual(effectLabels, [])
})

test('bindSettingsNamespace：settings 服务重启导致 inject 回调重跑时不重复 configure', () => {
  // 宿主对同一个 fiber 只允许 configure 一次，重复调用会抛
  // "Settings presentation is already configured for this plugin instance"。
  let callback = null
  const configureCalls = []
  const disposers = []
  const fakeCtx = {
    fiber: {},
    inject: (names, cb) => { callback = cb },
    effect: fn => { disposers.push(fn()); return () => {} },
  }
  const settings = { configure: () => { configureCalls.push(1); return () => {} } }
  bindSettingsNamespace(fakeCtx)
  callback({ settings })
  assert.equal(configureCalls.length, 1)
  // settings 服务重启：cordis 会把同一个 inject 回调再投递一次
  callback({ settings })
  assert.equal(configureCalls.length, 1, '重复投递不应再次 configure')
  // 服务下线（effect 清理触发）后再上线，应能重新 configure
  for (const dispose of disposers) dispose()
  callback({ settings })
  assert.equal(configureCalls.length, 2, '服务重新上线后应重新 configure')
})

test('bindSettingsNamespace：宿主拒绝重复 configure 时降级为 debug 日志，不抛错', () => {
  const logLines = []
  const fakeCtx = {
    fiber: {},
    get: () => ({
      configure: () => {
        throw new Error('Settings presentation is already configured for this plugin instance')
      },
    }),
    effect: fn => fn(),
  }
  assert.doesNotThrow(() => bindSettingsNamespace(fakeCtx, { log: (level, message) => logLines.push([level, message]) }))
  assert.equal(logLines.length, 1)
  assert.equal(logLines[0][0], 'debug')
  assert.match(logLines[0][1], /already configured/)
})

test('index.js 监听 loader/volatile-update 以刷新 pi-ai 目录', async () => {
  // volatile 改动不重挂插件（值是就地更新），宿主只会 emit 这个事件。
  // 不监听的话用户把 backend 从 cli 改成 http，模型选择器仍列 CLI 那一套。
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8')
  assert.match(source, /loader\/volatile-update/)
  assert.match(source, /adapterApi\?\.invalidate\(\)/)
})
