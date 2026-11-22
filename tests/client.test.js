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

/**
 * 假 react：createElement 返回 {type, props, children} 树；hooks 带「槽位持久化」，
 * 首次渲染时执行 useEffect，setState 会触发重渲染。这样能测到「fetch 拿到数据后
 * 卡片重绘成什么」，而不只是首帧的静态文案。
 */
function makeFakeReact() {
  const store = []
  let cursor = 0
  let rerender = null
  const react = {
    createElement: (type, props, ...children) => ({
      type,
      props: props ?? {},
      children: children.flat().filter(Boolean),
    }),
    useState: init => {
      const index = cursor
      cursor += 1
      if (!(index in store)) store[index] = typeof init === 'function' ? init() : init
      const set = next => {
        store[index] = typeof next === 'function' ? next(store[index]) : next
        if (rerender !== null) rerender()
      }
      return [store[index], set]
    },
    // 只在首次渲染执行一次（依赖不变的真实语义在此简化）
    useEffect: fn => {
      const index = cursor
      cursor += 1
      if (!store[index]) {
        store[index] = true
        fn()
      }
    },
    useRef: value => {
      const index = cursor
      cursor += 1
      if (!(index in store)) store[index] = { current: value }
      return store[index]
    },
    useCallback: fn => {
      const index = cursor
      cursor += 1
      if (!(index in store)) store[index] = fn
      return store[index]
    },
    useMemo: fn => {
      const index = cursor
      cursor += 1
      if (!(index in store)) store[index] = fn()
      return store[index]
    },
  }
  return {
    react,
    /** 渲染一次，返回 createElement 树。 */
    render(component, props) {
      cursor = 0
      return component(props)
    },
    /** 注册重渲染回调：setState 后由它把最新树写进 lastTree。 */
    onRerender(component, props) {
      const box = { tree: null }
      rerender = () => {
        box.tree = this.render(component, props)
      }
      return box
    },
  }
}

function loadClientBundle() {
  const registrations = { loader: null, slots: [], locales: [] }
  const fakeWindow = {
    __ModuleLoader__: {
      load: bundle => { registrations.loader = bundle },
    },
  }
  // 同一个 react 实例贯穿 bundle 与测试渲染器：store 与 rerender 必须共享，
  // 否则组件里的 setState 触发不到测试侧的重渲染
  const reactHarness = makeFakeReact()
  const sandbox = new Function('window', 'require', `${CLIENT_SOURCE}\n;//# sourceURL=client.test.js`)
  sandbox(fakeWindow, name => {
    if (name === 'react') return reactHarness.react
    throw new Error(`unexpected require: ${name}`)
  })
  assert.ok(registrations.loader, 'bundle must call __ModuleLoader__.load')
  const exports = registrations.loader.factory(() => reactHarness.react)
  assert.equal(exports.name, 'dsh-connect-doubaowork-client')
  assert.deepEqual(exports.inject, ['slots', 'locale'])
  return { exports, registrations, react: reactHarness }
}

/**
 * 用假 fetch 驱动卡片：先渲染一次（useEffect 拉 status），等 Promise 落定，
 * 再由 setState 触发的重渲染拿到最终树。返回扁平文本。
 */
async function renderCardWithStatus(statusPayload) {
  const { exports, react } = loadClientBundle()
  const { ctx, slotRegistrations } = makeFakeCtx()
  exports.apply(ctx)
  const section = slotRegistrations.find(entry => entry.entry?.name === 'settings.section')
  const props = section.entry.inject()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => statusPayload })
  try {
    const box = react.onRerender(section.component, props)
    box.tree = react.render(section.component, props)
    // 让 useEffect 里的 fetch.then 落定，setState 会同步触发 rerender
    await new Promise(resolve => setTimeout(resolve, 0))
    const texts = []
    const walk = node => {
      if (node === null || node === undefined || typeof node !== 'object') return
      for (const child of Array.isArray(node.children) ? node.children : []) {
        if (typeof child === 'string') texts.push(child)
        else walk(child)
      }
    }
    walk(box.tree)
    return texts.join('|')
  } finally {
    globalThis.fetch = originalFetch
  }
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
  // 首次使用引导区块（0.3.0 新增）：没配好要让用户看到「装什么、跑什么」
  assert.match(flat, /首次使用引导/)
  assert.match(flat, /重新检查接入方式/)
})

test('client bundle：引导区块把未配置的修复步骤渲染成可复制文本', async () => {
  const flat = await renderCardWithStatus({
    setup: {
      ready: false,
      pending: false,
      summary: { cliInstalled: false },
      steps: [
        { id: 'credentials', title: '豆包登录态', status: 'todo', detail: '未找到豆包登录态', fix: ['写入 ~/.dsh-doubao/credentials.json'] },
        { id: 'cli', title: '豆包 CLI', status: 'todo', detail: '未检测到 doubao 命令', fix: ['npm i -g @bytedance/doubao-cli', 'doubao login'] },
      ],
    },
  })
  assert.match(flat, /尚未配置完成/)
  assert.match(flat, /npm i -g @bytedance\/doubao-cli/)
  assert.match(flat, /doubao login/)
  assert.match(flat, /修复步骤/)
})

test('client bundle：引导快照 pending 时显示「尚未检查」而不是空白', async () => {
  const flat = await renderCardWithStatus({ setup: { ready: false, pending: true, steps: [], summary: {} } })
  assert.match(flat, /尚未检查/)
})

test('client bundle：接入可用时引导显示 ✓ 而不是报警', async () => {
  const flat = await renderCardWithStatus({
    setup: {
      ready: true,
      pending: false,
      summary: { cliReady: true, cliInstalled: true, cliVersion: '2.37.2' },
      steps: [{ id: 'ready', title: '可用接入方式', status: 'done', detail: '仅 CLI 可用', fix: [] }],
    },
  })
  assert.match(flat, /接入可用/)
  assert.doesNotMatch(flat, /尚未配置完成/)
})

test('client bundle：登录区块在 status.login 缺席时整块不渲染', async () => {
  // 宿主没装配登录能力时给一个会失败的按钮比不显示更糟
  const flat = await renderCardWithStatus({
    cli: { installed: true, version: '2.37.2', loggedIn: false, models: [] },
    setup: { ready: false, pending: true, steps: [], summary: {} },
  })
  assert.doesNotMatch(flat, /扫码登录豆包 CLI/)
})

test('client bundle：未登录时登录区块给出「扫码登录」入口', async () => {
  const flat = await renderCardWithStatus({
    cli: { installed: true, version: '2.37.2', loggedIn: false, models: [] },
    login: { active: false },
    setup: { ready: false, pending: true, steps: [], summary: {} },
  })
  assert.match(flat, /扫码登录豆包 CLI/)
  assert.match(flat, /未登录/)
  assert.match(flat, /扫码登录/)
  // 说明必须写明「插件不读取、不存储任何凭据」
  assert.match(flat, /不读取、不存储任何凭据/)
})

test('client bundle：已登录时入口变成「重新扫码登录」', async () => {
  const flat = await renderCardWithStatus({
    cli: { installed: true, version: '2.37.2', loggedIn: true, models: ['doubao-2.1-pro'] },
    login: { active: false },
    setup: { ready: true, pending: false, steps: [], summary: {} },
  })
  assert.match(flat, /扫码登录豆包 CLI/)
  assert.match(flat, /已登录/)
  assert.match(flat, /重新扫码登录/)
})

// ── 0.5.0 修的第二个真实缺陷：CLI 与桌面端模型清单被合并成一份 ─────────────
// 现场：模型选择器里同一个上游模型出现两次（静态表友好名 + CLI 的 person-* 名）。
// 修法：宿主侧 status.models 由 catalogForBackend(effectiveBackend, …) 算出，
// 二选一；卡片只展示这一份，不再自己拼接 CLI 清单。

test('client bundle：当前生效区块展示 status.models（CLI 后端只列 CLI 清单）', async () => {
  const flat = await renderCardWithStatus({
    backend: 'auto',
    effectiveBackend: 'cli',
    models: ['deepseek-v4-flash', 'kimi-k3'],
    defaultModel: 'deepseek-v4-flash',
    cli: { installed: true, version: '2.37.2', loggedIn: true, models: ['9', 'person-deepseek-v4-1-flash-261017'] },
    setup: { ready: true, pending: false, steps: [], summary: {} },
  })
  assert.match(flat, /当前生效（只读测量值）/)
  assert.match(flat, /CLI（豆包 CLI 自己的登录态）/)
  assert.match(flat, /2：deepseek-v4-flash, kimi-k3/)
  assert.match(flat, /deepseek-v4-flash/)
})

test('client bundle：当前生效区块在 HTTP 后端时标记 HTTP 且模型清单来自静态表', async () => {
  const flat = await renderCardWithStatus({
    effectiveBackend: 'http',
    models: ['auto', 'doubao-2.1-lite'],
    defaultModel: 'doubao-2.1-lite',
    cli: { installed: true, version: '2.37.2', loggedIn: true, models: [] },
    setup: { ready: true, pending: false, steps: [], summary: {} },
  })
  assert.match(flat, /HTTP（复用桌面端 cookie）/)
  assert.match(flat, /2：auto, doubao-2\.1-lite/)
})

test('client bundle：没有可路由模型时给出可读提示而不是空白', async () => {
  const flat = await renderCardWithStatus({
    effectiveBackend: 'cli',
    models: [],
    defaultModel: 'deepseek-v4-flash',
    cli: { installed: true, version: '2.37.2', loggedIn: false, models: [] },
    setup: { ready: false, pending: false, steps: [], summary: {} },
  })
  assert.match(flat, /暂无；CLI 需先登录才会拉取清单/)
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

// ── 0.4.3 修的真实缺陷：configForms 晚就绪时卡片停在只读形态 ───────────────
// 现场：截图里「网关选项」「上游后端」两块只有标题、没有任何下拉框与输入框。
// 原因是 `ctx.get('configForms')` 在 apply 时同步探一次，Host 的客户端插件
// 服务尚未注册就永远拿不到 → settingsScope 恒为 undefined → 走只读降级分支。

test('client bundle：configForms 晚于卡片就绪时，晚到后仍渲染出可编辑输入框', async () => {
  const { exports, react } = loadClientBundle()
  const lateCallbacks = []
  const slotRegistrations = []
  const track = handle => {
    slotRegistrations.push(handle)
    return () => {
      const index = slotRegistrations.indexOf(handle)
      if (index >= 0) slotRegistrations.splice(index, 1)
    }
  }
  const forms = {
    whileServed: (candidates, register) => {
      const dispose = register(new Set(candidates))
      return dispose
    },
    get: ns => ({ namespace: ns }),
  }
  const registeredCopy = {}
  const ctx = {
    effect: (fn) => { fn() },
    // apply 时 configForms 还没注册
    get: () => undefined,
    inject: (names, callback) => { lateCallbacks.push({ names, callback }) },
    slots: {
      inject: (name, setup) => {
        const handle = { name }
        const inner = setup()
        const unregister = track(handle)
        return () => { unregister(); if (typeof inner === 'function') inner() }
      },
      register: (entry, component) => track({ entry, component }),
    },
    locale: {
      register: (ns, copy) => { registeredCopy[ns] = copy },
      bind: ns => key => registeredCopy[ns]?.zh?.[key] ?? `${ns}:${key}`,
    },
  }
  exports.apply(ctx)
  // 宿主稍后注册 configForms，cordis 触发 inject 回调
  assert.equal(lateCallbacks.length, 1, '应通过 ctx.inject 等待 configForms')
  assert.deepEqual(lateCallbacks[0].names, ['configForms'])
  lateCallbacks[0].callback({ configForms: forms })

  const section = slotRegistrations.find(entry => entry.entry?.name === 'settings.section')
  assert.ok(section, '晚绑定后必须重新注册插槽（渲染器按 entry 身份缓存 inject 结果）')
  const props = section.entry.inject()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ setup: { ready: true, steps: [] }, cli: null, login: null }) })
  try {
    // onRerender 注册回调后，fetch 落定的 setState 会重写 box.tree
    const box = react.onRerender(section.component, props)
    box.tree = react.render(section.component, props)
    await new Promise(resolve => setTimeout(resolve, 0))
    const inputs = []
    const walk = node => {
      if (node === null || node === undefined || typeof node !== 'object') return
      // 假 react 的元素形状是 { type, props, children }（type 是标签名或组件）
      const tag = node.type ?? ''
      if (tag === 'select' || tag === 'input') inputs.push(node)
      for (const child of Array.isArray(node.children) ? node.children : []) walk(child)
    }
    walk(box.tree)
    const selects = inputs.filter(node => node.type === 'select')
    assert.ok(selects.length >= 4, `应渲染出后端与网关下拉框，实际 ${selects.length} 个 select`)
    assert.ok(inputs.some(node => node.type === 'input' && node.props?.type === 'text'), '应渲染出 cliPath/cliWorkspace 文本框')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('client bundle：留痕区块展示会话复用模式与落盘状态', async () => {
  const flat = await renderCardWithStatus({
    conversationMode: 'single',
    conversations: { count: 1, persisted: true, file: '/Users/x/.dsh-doubao/conversations.json' },
    effectiveBackend: 'cli',
    models: ['deepseek-v4-flash'],
    defaultModel: 'deepseek-v4-flash',
    cli: { installed: true, version: '2.37.2', loggedIn: true, models: ['deepseek-v4-flash'] },
  })
  assert.match(flat, /豆包侧的留痕/)
  assert.match(flat, /固定复用同一条豆包会话/)
  assert.match(flat, /1 条（进程重启后仍复用，不会新开）/)
  assert.match(flat, /已落盘/)
  // 关键告知：豆包侧历史删不掉，只能力求少留
  assert.match(flat, /没有删除会话的命令/)
})

test('client bundle：未落盘时提示重载会新开一条豆包会话', async () => {
  const flat = await renderCardWithStatus({
    conversationMode: 'per-chat',
    conversations: { count: 3, persisted: false, file: '' },
    effectiveBackend: 'http',
    models: ['auto'],
    defaultModel: 'auto',
    cli: { installed: false, version: '', loggedIn: false, models: [] },
  })
  assert.match(flat, /每个对话各一条豆包会话/)
  assert.match(flat, /仅内存（重载插件会丢，豆包侧会新开一条）/)
})
