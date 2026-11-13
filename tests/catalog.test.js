import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DOUBAO_MODELS, DOUBAO_MODEL_ALIASES, DOUBAO_DEFAULT_MODEL, resolveModel, deriveCatalog } from '../catalog.js'

test('resolveModel 按 id 解析', () => {
  const entry = resolveModel('deepseek-v4-flash')
  assert.equal(entry.modelItemKey, 'person-deepseek-v4-1-flash-261017')
  assert.equal(entry.contextWindow, 300000)
})

test('resolveModel 按别名解析', () => {
  assert.equal(resolveModel('doubao')?.id, 'deepseek-v4-flash')
  assert.equal(resolveModel('deepseek')?.id, 'deepseek-v4-flash')
})

test('resolveModel 按上游 model_item_key 解析', () => {
  assert.equal(resolveModel('person-glm-5-3-261111')?.id, 'glm-5.3')
  assert.equal(resolveModel('9')?.id, 'auto')
})

test('resolveModel 未知/空输入返回 undefined', () => {
  assert.equal(resolveModel('nope'), undefined)
  assert.equal(resolveModel(''), undefined)
  assert.equal(resolveModel(undefined), undefined)
})

test('目录条目数与默认模型', () => {
  assert.equal(DOUBAO_MODELS.length, 10)
  assert.ok(DOUBAO_MODELS.some(m => m.id === DOUBAO_DEFAULT_MODEL))
  assert.equal(DOUBAO_DEFAULT_MODEL, 'deepseek-v4-flash')
  assert.ok(Object.isFrozen(DOUBAO_MODEL_ALIASES))
})

test('deriveCatalog 空集合 = 全部', () => {
  assert.equal(deriveCatalog([]).length, DOUBAO_MODELS.length)
  assert.equal(deriveCatalog(undefined).length, DOUBAO_MODELS.length)
})

test('deriveCatalog 按启用集合过滤（别名归一）', () => {
  const picked = deriveCatalog(['doubao', 'kimi-k3'])
  assert.deepEqual(picked.map(m => m.id), ['deepseek-v4-flash', 'kimi-k3'])
})

test('deriveCatalog 全未知输入回落全部，避免空路由', () => {
  assert.equal(deriveCatalog(['nope']).length, DOUBAO_MODELS.length)
})
