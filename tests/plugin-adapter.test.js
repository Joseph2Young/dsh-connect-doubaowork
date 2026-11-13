import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDoubaoAdapter, toPiModel, DOUBAO_STREAM_IDLE_TIMEOUT_MS } from '../adapter.js'
import { bootstrap } from '../plugin.js'
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
