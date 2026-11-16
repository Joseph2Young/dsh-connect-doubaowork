import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createConfigSchema, normalizeConfig, clampEffort, DOUBAO_DEFAULTS, DOUBAO_QUERY } from '../config.js'

/** 最小假 z：只记录字段种类与链式 default/description。 */
function makeFakeZ() {
  const field = kind => {
    const f = { kind, defaultValue: undefined, descriptionText: '' }
    f.default = v => {
      f.defaultValue = v
      return f
    }
    f.description = d => {
      f.descriptionText = d
      return f
    }
    return f
  }
  const z = {
    array: () => field('array'),
    string: () => field('string'),
    boolean: () => field('boolean'),
    number: () => field('number'),
  }
  z.object = defs => {
    z.fields = defs
    return { ...defs }
  }
  return z
}

test('createConfigSchema 字段种类与默认值', () => {
  const z = makeFakeZ()
  createConfigSchema(z)
  const fields = z.fields
  assert.deepEqual(Object.keys(fields), [
    'enabledModelIds', 'workMode', 'reasoningEffort', 'autoDiscoverCredentials',
    'credentialsFile', 'chatUrl', 'userAgent', 'timeoutSeconds', 'heartbeatSeconds', 'flattenHistory',
    'conversationMode',
  ])
  assert.equal(fields.enabledModelIds.kind, 'array')
  assert.deepEqual(fields.enabledModelIds.defaultValue, [])
  assert.equal(fields.workMode.kind, 'boolean')
  assert.equal(fields.workMode.defaultValue, true)
  assert.equal(fields.reasoningEffort.defaultValue, DOUBAO_DEFAULTS.reasoningEffort)
  assert.equal(fields.chatUrl.defaultValue, DOUBAO_DEFAULTS.chatUrl)
  assert.equal(fields.userAgent.defaultValue, DOUBAO_DEFAULTS.userAgent)
  assert.equal(fields.timeoutSeconds.defaultValue, 300)
  assert.equal(fields.heartbeatSeconds.defaultValue, 15)
  assert.equal(fields.flattenHistory.defaultValue, true)
  assert.equal(fields.credentialsFile.defaultValue, '')
  assert.equal(fields.autoDiscoverCredentials.defaultValue, true)
  assert.equal(fields.conversationMode.kind, 'string')
  assert.equal(fields.conversationMode.defaultValue, DOUBAO_DEFAULTS.conversationMode)
})

test('normalizeConfig 空配置 → 全默认', () => {
  const config = normalizeConfig(undefined)
  assert.deepEqual(config.enabledModelIds, [])
  assert.equal(config.workMode, true)
  assert.equal(config.reasoningEffort, '4')
  assert.equal(config.chatUrl, DOUBAO_DEFAULTS.chatUrl)
  assert.equal(config.timeoutSeconds, 300)
  assert.equal(config.heartbeatSeconds, 15)
  assert.equal(config.flattenHistory, true)
  assert.equal(config.autoDiscoverCredentials, true)
  assert.equal(config.conversationMode, 'single')
})

test('normalizeConfig 归一与收口', () => {
  const config = normalizeConfig({
    enabledModelIds: [1, 'kimi-k3'],
    workMode: false,
    reasoningEffort: '2',
    timeoutSeconds: '30',
    heartbeatSeconds: 0,
    conversationMode: 'single',
  })
  assert.deepEqual(config.enabledModelIds, ['1', 'kimi-k3'])
  assert.equal(config.workMode, false)
  assert.equal(config.reasoningEffort, '2')
  assert.equal(config.timeoutSeconds, 30)
  assert.equal(config.heartbeatSeconds, 0)
  assert.equal(config.conversationMode, 'single')
  // 非法值回落 single（默认）
  assert.equal(normalizeConfig({ conversationMode: 'bogus' }).conversationMode, 'single')
  // 显式 per-chat 仍然生效
  assert.equal(normalizeConfig({ conversationMode: 'per-chat' }).conversationMode, 'per-chat')
})

test('clampEffort 只放行 0-4', () => {
  assert.equal(clampEffort('0'), '0')
  assert.equal(clampEffort('4'), '4')
  assert.equal(clampEffort('9'), '4')
  assert.equal(clampEffort('abc'), '4')
  assert.equal(clampEffort(undefined), '4')
})

test('上游 query 常量完整', () => {
  assert.equal(DOUBAO_QUERY.aid, '582478')
  assert.equal(DOUBAO_QUERY.real_aid, '582478')
  assert.equal(DOUBAO_QUERY.version_code, '20800')
  assert.equal(DOUBAO_QUERY.device_platform, 'web')
  assert.equal(Object.keys(DOUBAO_QUERY).length, 19)
})
