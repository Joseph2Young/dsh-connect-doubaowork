import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createConfigSchema, createConfigReader, normalizeConfig, unwrapVolatile, clampEffort, DOUBAO_DEFAULTS, DOUBAO_QUERY, VOLATILE_FIELDS } from '../config.js'

/** 最小假 z：只记录字段种类与链式 default/description/volatile。 */
function makeFakeZ() {
  const field = kind => {
    const f = { kind, defaultValue: undefined, descriptionText: '', volatileFlag: false }
    f.default = v => {
      f.defaultValue = v
      return f
    }
    f.description = d => {
      f.descriptionText = d
      return f
    }
    // 与真实 schemastery 一致：volatile 是链式副作用，返回自身
    f.volatile = () => {
      f.volatileFlag = true
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
    const obj = { ...defs }
    obj.description = () => obj
    return obj
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
    'conversationMode', 'account', 'poolEnabled', 'keepaliveEnabled',
    'backend', 'cliPath', 'cliWorkspace', 'cliPermissionMode', 'cliConcurrency', 'cliEffort',
    'conversationsFile',
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
  assert.equal(fields.poolEnabled.defaultValue, false)
  assert.equal(fields.keepaliveEnabled.defaultValue, false)
  assert.equal(typeof fields.account, 'object')
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

test('normalizeConfig 账号/池/保活字段收口', () => {
  // 默认：池与保活均关闭（opt-in），主账号空形状
  const defaults = normalizeConfig(undefined)
  assert.deepEqual(defaults.account, { id: '', label: '', cookie: '', deviceId: '', webId: '', enabled: true })
  assert.equal(defaults.poolEnabled, false)
  assert.equal(defaults.keepaliveEnabled, false)
  // 显式开启
  assert.equal(normalizeConfig({ poolEnabled: true }).poolEnabled, true)
  assert.equal(normalizeConfig({ keepaliveEnabled: true }).keepaliveEnabled, true)
  // 非真值一律收口为 false
  assert.equal(normalizeConfig({ poolEnabled: 'yes' }).poolEnabled, false)
  assert.equal(normalizeConfig({ keepaliveEnabled: 1 }).keepaliveEnabled, false)
  // 主账号字段收口：snake_case 兼容 + enabled 非 false 视为 true
  const account = normalizeConfig({ account: { cookie: 'sessionid=a', device_id: 'd1', enabled: false } }).account
  assert.equal(account.cookie, 'sessionid=a')
  assert.equal(account.deviceId, 'd1')
  assert.equal(account.enabled, false)
  // 非对象 account → 空形状
  assert.deepEqual(normalizeConfig({ account: 'x' }).account.cookie, '')
})

test('上游 query 常量完整', () => {
  assert.equal(DOUBAO_QUERY.aid, '582478')
  assert.equal(DOUBAO_QUERY.real_aid, '582478')
  assert.equal(DOUBAO_QUERY.version_code, '20800')
  assert.equal(DOUBAO_QUERY.device_platform, 'web')
  assert.equal(Object.keys(DOUBAO_QUERY).length, 19)
})

test('VOLATILE_FIELDS：用户可改的字段都是 volatile（模型页列 provider 的唯一开关）', () => {
  const z = makeFakeZ()
  createConfigSchema(z)
  const fields = z.fields
  // 清单里的每个字段都必须真的调用了 .volatile()
  for (const key of VOLATILE_FIELDS) {
    assert.equal(fields[key]?.volatileFlag, true, `${key} 应该是 volatile`)
  }
  // 敏感字段（含 cookie）不进可编辑表单，因此不是 volatile
  // （account 是嵌套 object schema，不是单字段，故用 notEqual 判）
  assert.notEqual(fields.account.volatileFlag, true)
  assert.equal(fields.chatUrl.volatileFlag, false)
  assert.equal(fields.userAgent.volatileFlag, false)
  // 清单与 schema 字段名严格对应，避免拼错后静默失效
  for (const key of VOLATILE_FIELDS) assert.ok(Object.hasOwn(fields, key), `未知字段 ${key}`)
  assert.equal(VOLATILE_FIELDS.length, new Set(VOLATILE_FIELDS).size)
})

test('unwrapVolatile：剥掉 get() 包装，数组与嵌套对象逐层还原', () => {
  const wrap = value => ({ get: () => value })
  assert.equal(unwrapVolatile('cli'), 'cli')
  assert.equal(unwrapVolatile(wrap('cli')), 'cli')
  assert.deepEqual(unwrapVolatile(wrap(['a', 'b'])), ['a', 'b'])
  assert.deepEqual(unwrapVolatile(wrap(['a', wrap('b')])), ['a', 'b'])
  // 嵌套对象里的 volatile 字段
  assert.deepEqual(unwrapVolatile({ backend: wrap('http'), n: 3 }), { backend: 'http', n: 3 })
  // 深层：整个 Config 被 volatile 包裹时的形态
  assert.deepEqual(unwrapVolatile(wrap({ backend: wrap('cli') })), { backend: 'cli' })
  // null / undefined 不炸
  assert.equal(unwrapVolatile(undefined), undefined)
  assert.equal(unwrapVolatile(null), null)
})

test('createConfigReader：活配置改动立即可见（volatile 就地更新语义）', () => {
  let current = { backend: 'auto', cliPath: '' }
  // 模拟 Cosmokit createVolatile：get() 返回当前值
  const hostConfig = { get: () => current }
  const read = createConfigReader(hostConfig)
  assert.equal(read().backend, 'auto')
  // 宿主就地更新引用后，读取器看到新值（不重挂插件也能生效）
  current = { backend: 'cli', cliPath: '/opt/doubao' }
  assert.equal(read().backend, 'cli')
  assert.equal(read().cliPath, '/opt/doubao')
  // 空配置返回空对象而不是 undefined，调用方可以安全取值
  assert.deepEqual(createConfigReader(undefined)(), {})
})

test('normalizeConfig 能吃 volatile 包装过的配置', () => {
  // 宿主可能把整个 Config 作为 volatile 引用传进来
  const wrapped = { get: () => ({ backend: 'cli', cliEffort: 'high', conversationMode: 'per-chat', poolEnabled: true }) }
  const config = normalizeConfig(wrapped)
  assert.equal(config.backend, 'cli')
  assert.equal(config.cliEffort, 'high')
  assert.equal(config.conversationMode, 'per-chat')
  assert.equal(config.poolEnabled, true)
})
