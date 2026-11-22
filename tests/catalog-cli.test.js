import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  catalogFromCli,
  catalogForBackend,
  defaultModelForBackend,
  deriveCatalog,
  resolveModel,
  upstreamId,
  DOUBAO_MODELS,
  DOUBAO_DEFAULT_MODEL,
} from '../catalog.js'

test('catalogForBackend：http 后端只列静态表，不掺 CLI 条目', () => {
  const cli = [{ id: 'brand-new-model', name: '新模型' }]
  const http = catalogForBackend('http', cli)
  assert.deepEqual(http.map(m => m.id), DOUBAO_MODELS.map(m => m.id))
  // 关键回归：CLI 独有模型不得出现在 HTTP 清单里（此前合并导致重复）
  assert.equal(http.some(m => m.id === 'brand-new-model'), false)
})

test('catalogForBackend：cli 后端只列 CLI 实报模型，不掺静态表独有条目', () => {
  const cli = [
    { id: 'person-deepseek-v4-1-flash-261017', name: 'DeepSeek V4.1 Flash', isDefault: true },
    { id: 'brand-new-model', name: '新模型' },
  ]
  const catalog = catalogForBackend('cli', cli)
  assert.deepEqual(catalog.map(m => m.id), ['deepseek-v4-flash', 'brand-new-model'])
  // 静态表里有、CLI 没报的（如 glm-5.3）不出现——这是「激活哪个就只出现哪个」的核心
  assert.equal(catalog.some(m => m.id === 'glm-5.3'), false)
})

test('catalogForBackend：cli 后端但清单为空时回落静态表（避免空目录）', () => {
  const catalog = catalogForBackend('cli', [])
  assert.deepEqual(catalog.map(m => m.id), DOUBAO_MODELS.map(m => m.id))
})

test('catalogForBackend：enabledIds 过滤在两套清单上都生效', () => {
  const cli = [
    { id: 'person-kimi-k3-261111', name: 'Kimi K3' },
    { id: 'brand-new-model', name: '新模型' },
  ]
  const catalog = catalogForBackend('cli', cli, ['kimi-k3'])
  assert.deepEqual(catalog.map(m => m.id), ['kimi-k3'])
  // 过滤为空时回落全量（避免空路由）
  assert.equal(catalogForBackend('http', [], ['不存在的模型']).length, DOUBAO_MODELS.length)
})

test('catalogFromCli：命中静态表时复用友好 id 与元信息，并补 cliId', () => {
  const catalog = catalogFromCli([{ id: 'person-kimi-k3-1-pro-261111', name: 'Kimi K3.1 Pro（CLI）', efforts: ['low', 'max'] }])
  const entry = catalog.find(m => m.id === 'kimi-k3.1-pro')
  assert.ok(entry)
  assert.equal(entry.name, 'Kimi K3.1 Pro（CLI）')
  assert.equal(entry.cliId, 'person-kimi-k3-1-pro-261111')
  assert.equal(entry.modelItemKey, 'person-kimi-k3-1-pro-261111')
  // 静态表元信息不丢
  assert.equal(entry.contextWindow, 300000)
  assert.equal(entry.ratio, '0.95x')
  assert.deepEqual(entry.efforts, ['low', 'max'])
})

test('catalogFromCli：未命中静态表的模型追加为 cliOnly', () => {
  const catalog = catalogFromCli([{ id: 'brand-new-model', name: '新模型', efforts: ['low', 'high'] }])
  const added = catalog.find(m => m.id === 'brand-new-model')
  assert.ok(added)
  assert.equal(added.cliOnly, true)
  assert.equal(added.modelItemKey, '')
  assert.equal(added.cliId, 'brand-new-model')
  assert.deepEqual(added.efforts, ['low', 'high'])
  assert.equal(added.contextWindow, 256000)
  // CLI 只报了这一个模型：命中静态表之外的条目单独成行
  assert.equal(catalog.length, 1)
  assert.equal(catalog[0].id, 'brand-new-model')
})

test('catalogFromCli：没报 efforts 的模型不塞空数组', () => {
  const catalog = catalogFromCli([{ id: 'person-glm-5-3-261111', name: 'GLM 5.3' }])
  assert.equal(catalog.find(m => m.id === 'glm-5.3').efforts, undefined)
})

test('upstreamId：优先 cliId，回落 modelItemKey', () => {
  assert.equal(upstreamId({ cliId: 'person-x', modelItemKey: '5' }, 'cli'), 'person-x')
  assert.equal(upstreamId({ modelItemKey: '5' }, 'cli'), '5')
  assert.equal(upstreamId({ modelItemKey: '5' }, 'http'), '5')
  assert.equal(upstreamId({}, 'http'), '')
})

test('defaultModelForBackend：http 用静态默认值，cli 跟随 CLI 的 is_default', () => {
  assert.equal(defaultModelForBackend('http', []), DOUBAO_DEFAULT_MODEL)
  // CLI 标 is_default 的模型能映射回友好 id
  const cli = [
    { id: 'person-qwen3-8-max', name: 'Qwen3.8 Max' },
    { id: 'person-deepseek-v4-1-flash-261017', name: 'DeepSeek V4.1 Flash', isDefault: true },
  ]
  assert.equal(defaultModelForBackend('cli', cli), 'deepseek-v4-flash')
  // 未知默认模型时回落静态默认值，避免死指
  assert.equal(defaultModelForBackend('cli', [{ id: 'brand-new', isDefault: true }]), DOUBAO_DEFAULT_MODEL)
})

test('deriveCatalog 支持传入自定义目录', () => {
  const base = [{ id: 'a', name: 'A', modelItemKey: 'a' }, { id: 'b', name: 'B', modelItemKey: 'b' }]
  assert.deepEqual(deriveCatalog([], base).map(m => m.id), ['a', 'b'])
  assert.deepEqual(deriveCatalog(['b'], base).map(m => m.id), ['b'])
  // 别名归一仍生效
  assert.deepEqual(deriveCatalog(['deepseek']).map(m => m.id), [DOUBAO_DEFAULT_MODEL])
})

test('resolveModel 同时匹配 id / modelItemKey / cliId', () => {
  const base = catalogFromCli([{ id: 'person-kimi-k3-261111', name: 'Kimi K3（CLI）' }])
  // 友好 id
  assert.equal(resolveModel('kimi-k3', base)?.id, 'kimi-k3')
  // 上游 id（CLI 会原样传 model 参数）
  assert.equal(resolveModel('person-kimi-k3-261111', base)?.id, 'kimi-k3')
  // 默认目录行为不变
  assert.equal(resolveModel('deepseek')?.id, DOUBAO_DEFAULT_MODEL)
  assert.equal(resolveModel(''), undefined)
})
