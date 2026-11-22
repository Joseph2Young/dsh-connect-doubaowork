import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeCliModels, deriveCatalog, resolveModel, DOUBAO_MODELS, DOUBAO_DEFAULT_MODEL } from '../catalog.js'

test('mergeCliModels 空清单回落静态表', () => {
  assert.deepEqual(mergeCliModels([]), [...DOUBAO_MODELS])
  assert.deepEqual(mergeCliModels(undefined), [...DOUBAO_MODELS])
})

test('mergeCliModels 用 CLI 名称覆盖静态表，并保留 contextWindow', () => {
  const merged = mergeCliModels([
    { id: 'doubao-2.1-pro', name: '豆包 2.1 Pro（CLI）' },
    { id: 'kimi-k3', name: 'Kimi K3' },
  ])
  const pro = merged.find(m => m.id === 'doubao-2.1-pro')
  assert.equal(pro.name, '豆包 2.1 Pro（CLI）')
  // 静态表独有的元信息不能被 CLI 冲掉
  assert.equal(pro.modelItemKey, '5')
  assert.equal(pro.contextWindow, 256000)
  assert.equal(pro.ratio, '0.65x')
  // 静态表里有但 CLI 没报的模型仍然保留
  assert.ok(merged.some(m => m.id === 'glm-5.3'))
})

test('mergeCliModels CLI 独有模型追加为 cliOnly（无 model_item_key）', () => {
  const merged = mergeCliModels([{ id: 'brand-new-model', name: '新模型', efforts: ['low', 'high'] }])
  const added = merged.find(m => m.id === 'brand-new-model')
  assert.ok(added)
  assert.equal(added.cliOnly, true)
  assert.equal(added.modelItemKey, '')
  assert.deepEqual(added.efforts, ['low', 'high'])
  assert.equal(added.contextWindow, 256000)
  // 顺序：静态表原序在前，新增项在末尾
  assert.equal(merged[merged.length - 1].id, 'brand-new-model')
  assert.equal(merged[0].id, DOUBAO_MODELS[0].id)
})

test('mergeCliModels 携带 efforts 供 CLI 侧推理强度使用', () => {
  const merged = mergeCliModels([{ id: 'doubao-2.1-pro', name: 'X', efforts: ['none', 'max'] }])
  assert.deepEqual(merged.find(m => m.id === 'doubao-2.1-pro').efforts, ['none', 'max'])
  // 没报 efforts 的模型不塞空数组
  assert.equal(merged.find(m => m.id === 'glm-5.3').efforts, undefined)
})

test('deriveCatalog 支持传入合并后目录', () => {
  const base = mergeCliModels([{ id: 'brand-new-model', name: '新模型' }])
  const all = deriveCatalog([], base)
  assert.ok(all.some(m => m.id === 'brand-new-model'))
  const picked = deriveCatalog(['brand-new-model'], base)
  assert.deepEqual(picked.map(m => m.id), ['brand-new-model'])
  // 别名归一仍生效
  assert.deepEqual(deriveCatalog(['deepseek']).map(m => m.id), [DOUBAO_DEFAULT_MODEL])
  // 过滤为空时回落全量（避免空路由）
  assert.equal(deriveCatalog(['不存在的模型']).length, DOUBAO_MODELS.length)
})

test('resolveModel 支持传入合并后目录', () => {
  const base = mergeCliModels([{ id: 'brand-new-model', name: '新模型' }])
  assert.equal(resolveModel('brand-new-model', base)?.id, 'brand-new-model')
  // 静态表模型在合并目录里仍可解析
  assert.equal(resolveModel('doubao-2.1-pro', base)?.modelItemKey, '5')
  // 默认目录行为不变
  assert.equal(resolveModel('deepseek')?.id, DOUBAO_DEFAULT_MODEL)
  assert.equal(resolveModel(''), undefined)
})
