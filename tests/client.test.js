import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * client.js 冒烟测试：在假宿主环境里加载 bundle（window.__ModuleLoader__ +
 * 假 react），断言设置区块/图标注册、locale 注册、configForms 晚绑定。
 */
const CLIENT_SOURCE = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/** 最小假 react：createElement 返回 {type, props} 树 + 常用 hooks stub。 */
function makeFakeReact() {
  return {
    createElement: (type, props, ...children) => ({
      type,
      props: props ?? {},
      children: children.flat().filter(Boolean),
    }),
    useState: init => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useRef: value => ({ current: value }),
    useCallback: fn => fn,
    useMemo: fn => fn(),
  }
}

function loadClientBundle() {
  const registrations = { loader: null, slots: [], locales: [] }
  const fakeWindow = {
    __ModuleLoader__: {
      load: bundle => { registrations.loader = bundle },
    },
  }
  const sandbox = new Function('window', 'require', `${CLIENT_SOURCE}\n;//# sourceURL=client.test.js`)
  sandbox(fakeWindow, name => {
    if (name === 'react') return makeFakeReact()
    throw new Error(`unexpected require: ${name}`)
  })
  assert.ok(registrations.loader, 'bundle must call __ModuleLoader__.load')
  const exports = registrations.loader.factory(() => makeFakeReact())
  assert.equal(exports.name, 'dsh-connect-doubaowork-client')
  assert.deepEqual(exports.inject, ['slots', 'locale'])
  return { exports, registrations }
}

function makeFakeCtx({ withForms = true } = {}) {
  const effects = []
  const slotRegistrations = []
  const disposers = []
  const registeredCopy = {}
  // 注册句柄：unregister 时从记录中移除（模拟宿主真实卸载语义，
  // 这样 rebind「先卸旧再注册」后记录里只剩最新一条）
  const track = handle => {
    slotRegistrations.push(handle)
    return () => {
      const index = slotRegistrations.indexOf(handle)
      if (index >= 0) slotRegistrations.splice(index, 1)
    }
  }
  const ctx = {
    effect: (fn, label) => { effects.push({ fn, label }); fn() },
    get: name => (name === 'configForms' && withForms ? {
      whileServed: (candidates, register) => {
        // 模拟宿主：立即进入 served 态
        const dispose = register(new Set(candidates))
        disposers.push(dispose)
        return dispose
      },
      get: ns => ({ namespace: ns, getSnapshot: () => ({ value: {} }), set: () => {} }),
    } : undefined),
    slots: {
      inject: (name, setup) => {
        const handle = { name }
        const innerDispose = setup()
        const unregister = track(handle)
        return () => { unregister(); if (typeof innerDispose === 'function') innerDispose() }
      },
      register: (entry, component) => track({ entry, component }),
    },
    locale: {
      // 存下注册的文案，bind 返回真翻译（断言中文渲染内容）
      register: (ns, copy) => { registeredCopy[ns] = copy },
      bind: ns => key => registeredCopy[ns]?.zh?.[key] ?? `${ns}:${key}`,
    },
  }
  return { ctx, effects, slotRegistrations, disposers }
}

test('client bundle：apply 注册设置区块与图标', () => {
  const { exports } = loadClientBundle()
  const { ctx, effects, slotRegistrations } = makeFakeCtx()
  exports.apply(ctx)
  assert.ok(effects.some(effect => effect.label === 'dsh-connect-doubaowork: settings copy'))
  assert.ok(effects.some(effect => effect.label === 'dsh-connect-doubaowork: settings namespace binding'))
  const sections = slotRegistrations.filter(entry => entry.entry?.name === 'settings.section')
  assert.equal(sections.length, 1)
  assert.equal(sections[0].entry.id, 'dsh-connect-doubaowork')
  assert.equal(typeof sections[0].component, 'function')
  const icons = slotRegistrations.filter(entry => entry.entry?.name === 'settings.section.icon')
  assert.equal(icons.length, 1)
  // inject 注入参数形状（卡片 props 契约）
  const injected = sections[0].entry.inject()
  assert.equal(injected.surface, 'settings')
  assert.equal(typeof injected.t, 'function')
  assert.ok(injected.settingsScope, 'settingsScope bound via configForms.whileServed')
})

test('client bundle：configForms 缺席时优雅降级（只注册槽，不抛错）', () => {
  const { exports } = loadClientBundle()
  const { ctx, slotRegistrations } = makeFakeCtx({ withForms: false })
  exports.apply(ctx)
  const sections = slotRegistrations.filter(entry => entry.entry?.name === 'settings.section')
  assert.equal(sections.length, 1)
  const injected = sections[0].entry.inject()
  assert.equal(injected.settingsScope, undefined)
})

test('client bundle：卡片渲染核心分组（无 JSX，纯 createElement 树）', () => {
  const { exports } = loadClientBundle()
  const { ctx, slotRegistrations } = makeFakeCtx()
  exports.apply(ctx)
  const section = slotRegistrations.find(entry => entry.entry?.name === 'settings.section')
  const props = section.entry.inject()
  const tree = section.component(props)
  const texts = []
  // fake createElement 把 children 平铺存进 node.children（字符串元素即文本）
  const walk = node => {
    if (node === null || node === undefined || typeof node !== 'object') return
    for (const child of Array.isArray(node.children) ? node.children : []) {
      if (typeof child === 'string') texts.push(child)
      else walk(child)
    }
  }
  walk(tree)
  const flat = texts.join('|')
  assert.match(flat, /豆包工作模式/)
  assert.match(flat, /账号池/)
  assert.match(flat, /每日保活巡检/)
  // CLI 后端区块（0.3.0 新增）：后端选择 + CLI 状态 + 重新探测按钮
  assert.match(flat, /上游后端/)
  assert.match(flat, /豆包 CLI/)
  assert.match(flat, /后端选择/)
  assert.match(flat, /重新探测 CLI/)
})

test('声明 dsh.client 的包必须在 exports 暴露 ./client 且目标文件存在（宿主冷启动硬校验）', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  if (pkg.dsh?.client) {
    const target = pkg.exports?.['./client']
    assert.ok(typeof target === 'string', 'exports["./client"] 缺失：宿主 client-modules 会拒绝组合并使整个 host-boot 失败')
    const resolved = new URL(`../${target.replace(/^\.\//, '')}`, import.meta.url)
    assert.ok(fs.existsSync(resolved), `exports["./client"] 指向的文件不存在: ${target}`)
    assert.ok(CLIENT_SOURCE.includes('__ModuleLoader__'), '客户端 bundle 应保持宿主 ModuleLoader 加载格式')
  }
})
