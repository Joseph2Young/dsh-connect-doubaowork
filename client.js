/**
 * dsh-connect-doubaowork Web 设置卡片。
 *
 * 与 workbuddy 的 client.js 同构：打包为 `window.__ModuleLoader__.load` bundle，
 * 由 DSH Web GUI 加载；`apply(ctx)` 在设置页注册「豆包工作模式」区块，渲染
 * 网关选项（读写 settingsScope 即插件 Config）+ 账号池健康状态 + 保活巡检。
 *
 * 设计约定（对照 dsh-connect-workbuddy/lib/client.js）：
 * - 无能力探针：ctx.slots.inject('settings.section', …) 本身就是探针，宿主
 *   不声明该 slot 时静默无事，绝不因能力缺失抛错。
 * - configForms softGet：0.1.7 线提供 configForms，0.1.5 线提供 settingsScope；
 *   ctx.get() 对缺席服务返回 undefined，二者皆无时配置组降级为只读说明。
 * - 测量值不进 Config：账号健康/巡检结果来自插件路由 /plugins/<id>/status
 *   （只读 fetch），与 Config 草稿写互不覆盖。
 */
window.__ModuleLoader__.load({
  id: 'dsh-connect-doubaowork',
  factory: (require) => {
    const react = require('react')
    const h = react.createElement

    const SECTION_ID = 'dsh-connect-doubaowork'
    const LOCALE_NAMESPACE = 'settings.doubaowork'
    const NS_CANDIDATES = ['dsh-connect-doubaowork']
    const STATUS_PATH = '/plugins/dsh-connect-doubaowork/status'
    const KEEPALIVE_RUN_PATH = '/plugins/dsh-connect-doubaowork/keepalive/run'

    const COPY = {
      zh: {
        'nav.panel': '豆包工作模式',
        'card.title': '豆包工作模式',
        'card.desc': '复用豆包桌面端登录态，把豆包聚合的模型接入 DSH。',
        'group.gateway': '网关选项',
        'field.conversationMode': '豆包侧会话归属',
        'field.conversationMode.single': 'single：全部共用一条豆包会话（推荐）',
        'field.conversationMode.per-chat': 'per-chat：每个 DSH 会话一条豆包记录',
        'field.workMode': '启用工作模式（agent_mode=1）',
        'field.flattenHistory': '首轮压平历史消息',
        'field.reasoningEffort': '思考强度（0-4）',
        'field.timeoutSeconds': '上游超时（秒）',
        'field.poolEnabled': '账号池故障转移（失败自动换号重试）',
        'field.keepaliveEnabled': '每日保活巡检（定时检查账号 cookie，默认关）',
        'action.save': '保存设置',
        'action.saved': '已保存',
        'action.checkNow': '立即巡检',
        'action.checking': '巡检中…',
        'group.accounts': '账号池',
        'accounts.empty': '未配置账号。请在 ~/.dsh-doubao/credentials.json 放置 cookie（或在配置文件 account 字段填写），多账号支持 accounts 数组。',
        'accounts.health.ok': '正常',
        'accounts.health.bad': '异常',
        'accounts.health.unknown': '未巡检',
        'accounts.lastRun': '上次巡检',
        'accounts.never': '从未巡检',
        'accounts.readonly': '（健康状态为只读测量值，由巡检写入 ~/.dsh-doubao/pool-state.json）',
        'group.hint': '说明',
        'hint.keepalive': '豆包没有「签到」概念，保活巡检为等价功能：每日定时验证各账号 cookie 是否仍被豆包接受。纯读操作，不产生会话记录。',
        'hint.saveUnsaved': '有未保存的修改',
        'error.fetch': '状态读取失败（主进程路由不可用）',
      },
      en: {
        'nav.panel': 'Doubao Work Mode',
        'card.title': 'Doubao Work Mode',
        'card.desc': 'Reuses the Doubao desktop login to expose its bundled models to DSH.',
        'group.gateway': 'Gateway options',
        'field.conversationMode': 'Doubao-side conversation',
        'field.conversationMode.single': 'single: share one Doubao conversation (recommended)',
        'field.conversationMode.per-chat': 'per-chat: one Doubao conversation per DSH session',
        'field.workMode': 'Enable work mode (agent_mode=1)',
        'field.flattenHistory': 'Flatten history on first turn',
        'field.reasoningEffort': 'Thinking effort (0-4)',
        'field.timeoutSeconds': 'Upstream timeout (s)',
        'field.poolEnabled': 'Pool failover (retry on next account)',
        'field.keepaliveEnabled': 'Daily keepalive probe (off by default)',
        'action.save': 'Save settings',
        'action.saved': 'Saved',
        'action.checkNow': 'Probe now',
        'action.checking': 'Probing…',
        'group.accounts': 'Account pool',
        'accounts.empty': 'No account configured. Put a cookie into ~/.dsh-doubao/credentials.json (or the account config field); multiple accounts use an accounts array.',
        'accounts.health.ok': 'healthy',
        'accounts.health.bad': 'failing',
        'accounts.health.unknown': 'not probed',
        'accounts.lastRun': 'Last probe',
        'accounts.never': 'never',
        'accounts.readonly': ' (health is a read-only measurement written to ~/.dsh-doubao/pool-state.json)',
        'group.hint': 'Notes',
        'hint.keepalive': 'Doubao has no check-in concept; the keepalive probe is the equivalent: a daily read-only check that each account cookie is still accepted. It creates no Doubao conversations.',
        'hint.saveUnsaved': 'Unsaved changes',
        'error.fetch': 'Status unavailable (plugin route unreachable)',
      },
    }

    /** Card body: gateway options + pool health + keepalive. */
    function Doubaocard(props) {
      const { t, settingsScope } = props
      const snapshot = typeof settingsScope?.getSnapshot === 'function' ? settingsScope.getSnapshot() : undefined
      const config = snapshot?.value ?? {}
      const [draft, setDraft] = react.useState(null)
      const [savedAt, setSavedAt] = react.useState(0)
      const [status, setStatus] = react.useState(null)
      const [statusError, setStatusError] = react.useState(false)
      const [probing, setProbing] = react.useState(false)

      const value = draft ?? config
      const dirty = draft !== null

      react.useEffect(() => {
        let alive = true
        fetch(STATUS_PATH, { headers: { accept: 'application/json' } })
          .then(response => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
          .then(data => { if (alive) { setStatus(data); setStatusError(false) } })
          .catch(() => { if (alive) setStatusError(true) })
        return () => { alive = false }
      }, [savedAt])

      const setField = (key, next) => setDraft(current => ({ ...(current ?? config), [key]: next }))

      const save = () => {
        if (draft === null || typeof settingsScope?.set !== 'function') return
        for (const key of ['conversationMode', 'workMode', 'flattenHistory', 'reasoningEffort', 'timeoutSeconds', 'poolEnabled', 'keepaliveEnabled']) {
          if (draft[key] !== undefined && draft[key] !== config[key]) {
            try {
              settingsScope.set(key, draft[key])
            } catch (error) {
              console.error('[dsh-connect-doubaowork] failed to save', key, error)
            }
          }
        }
        setDraft(null)
        setSavedAt(Date.now())
      }

      const probeNow = async () => {
        setProbing(true)
        try {
          const response = await fetch(KEEPALIVE_RUN_PATH, { method: 'POST', headers: { accept: 'application/json' } })
          if (response.ok) {
            setStatus(await response.json())
            setStatusError(false)
          }
        } catch {} finally {
          setProbing(false)
        }
      }

      const rowStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', padding: '6px 0' }
      const labelStyle = { flex: '0 0 auto', maxWidth: '60%' }
      const sectionTitle = { margin: '14px 0 4px', fontSize: '0.92em', opacity: 0.8 }
      const inputStyle = { minWidth: '160px' }

      const rows = []
      rows.push(h('div', { key: 'title', style: { fontWeight: 600, marginBottom: 2 } }, t('card.title')))
      rows.push(h('div', { key: 'desc', style: { opacity: 0.7, fontSize: '0.9em' } }, t('card.desc')))

      // —— 网关选项（settingsScope 缺席时降级为只读说明）——
      rows.push(h('div', { key: 'g1', style: sectionTitle }, t('group.gateway')))
      if (settingsScope !== undefined) {
        rows.push(h('div', { key: 'f1', style: rowStyle },
          h('label', { style: labelStyle }, t('field.conversationMode')),
          h('select', {
            style: inputStyle,
            value: value.conversationMode ?? 'single',
            onChange: event => setField('conversationMode', event.target.value),
          },
          h('option', { value: 'single' }, t('field.conversationMode.single')),
          h('option', { value: 'per-chat' }, t('field.conversationMode.per-chat')))),
        )
        rows.push(h('div', { key: 'f2', style: rowStyle },
          h('label', { style: labelStyle }, t('field.workMode')),
          h('input', { type: 'checkbox', checked: value.workMode !== false, onChange: event => setField('workMode', event.target.checked) })),
        )
        rows.push(h('div', { key: 'f3', style: rowStyle },
          h('label', { style: labelStyle }, t('field.flattenHistory')),
          h('input', { type: 'checkbox', checked: value.flattenHistory !== false, onChange: event => setField('flattenHistory', event.target.checked) })),
        )
        rows.push(h('div', { key: 'f4', style: rowStyle },
          h('label', { style: labelStyle }, t('field.reasoningEffort')),
          h('select', {
            style: inputStyle,
            value: String(value.reasoningEffort ?? '4'),
            onChange: event => setField('reasoningEffort', event.target.value),
          },
          ['0', '1', '2', '3', '4'].map(level => h('option', { key: level, value: level }, level)))),
        )
        rows.push(h('div', { key: 'f5', style: rowStyle },
          h('label', { style: labelStyle }, t('field.timeoutSeconds')),
          h('input', {
            style: inputStyle, type: 'number', min: 1,
            value: value.timeoutSeconds ?? 300,
            onChange: event => setField('timeoutSeconds', Number(event.target.value)),
          })),
        )
        rows.push(h('div', { key: 'f6', style: rowStyle },
          h('label', { style: labelStyle }, t('field.poolEnabled')),
          h('input', { type: 'checkbox', checked: value.poolEnabled === true, onChange: event => setField('poolEnabled', event.target.checked) })),
        )
        rows.push(h('div', { key: 'f7', style: rowStyle },
          h('label', { style: labelStyle }, t('field.keepaliveEnabled')),
          h('input', { type: 'checkbox', checked: value.keepaliveEnabled === true, onChange: event => setField('keepaliveEnabled', event.target.checked) })),
        )
        rows.push(h('div', { key: 'save', style: rowStyle },
          dirty ? h('span', { style: { color: '#d97706', fontSize: '0.85em' } }, t('hint.saveUnsaved')) : h('span'),
          h('button', {
            type: 'button',
            disabled: !dirty,
            onClick: save,
            style: { opacity: dirty ? 1 : 0.5 },
          }, savedAt > 0 && !dirty ? t('action.saved') : t('action.save'))),
        )
      } else {
        rows.push(h('div', { key: 'ro', style: { opacity: 0.7, fontSize: '0.88em' } }, t('accounts.readonly')))
      }

      // —— 账号池健康（只读测量值 + 手动巡检）——
      rows.push(h('div', { key: 'g2', style: sectionTitle }, t('group.accounts')))
      const list = Array.isArray(status?.accounts) ? status.accounts : []
      if (list.length === 0) {
        rows.push(h('div', { key: 'empty', style: { opacity: 0.7, fontSize: '0.88em' } }, statusError ? t('error.fetch') : t('accounts.empty')))
      } else {
        for (const account of list) {
          const health = account.health === null || account.health === undefined
            ? t('accounts.health.unknown')
            : account.health.ok === true ? t('accounts.health.ok') : `${t('accounts.health.bad')} (HTTP ${account.health.status})`
          rows.push(h('div', { key: `acct-${account.id}`, style: rowStyle },
            h('span', null, `${account.label} (${account.id})`),
            h('span', { style: { fontSize: '0.85em', opacity: 0.8 } }, `${account.enabled ? '' : '· '}${health}`)),
          )
        }
        const lastRun = status?.lastRun ? new Date(status.lastRun).toLocaleString() : t('accounts.never')
        rows.push(h('div', { key: 'lastrun', style: rowStyle },
          h('span', { style: { fontSize: '0.85em', opacity: 0.7 } }, `${t('accounts.lastRun')}: ${lastRun}`)),
        )
      }
      rows.push(h('div', { key: 'probe', style: rowStyle },
        h('button', { type: 'button', disabled: probing, onClick: probeNow }, probing ? t('action.checking') : t('action.checkNow'))),
      )

      // —— 说明 ——
      rows.push(h('div', { key: 'g3', style: sectionTitle }, t('group.hint')))
      rows.push(h('div', { key: 'hint', style: { opacity: 0.7, fontSize: '0.85em', lineHeight: 1.5 } }, t('hint.keepalive')))

      return h('div', { className: 'dsm-doubaowork-card' }, rows)
    }

    /** 设置页导航图标（宿主 settings.section.icon 槽渲染）。 */
    function PluginIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 16
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        style: { borderRadius: '4px', display: 'block', opacity: props?.active === false ? 0.75 : 1 },
      }, h('path', {
        d: 'M12 2.5c-2.2 3.4-5.3 5-9 5 1.9 4.6 4.6 8.1 9 14 4.4-5.9 7.1-9.4 9-14-3.7 0-6.8-1.6-9-5z',
        fill: 'currentColor', opacity: 0.9,
      }))
    }

    function apply(ctx) {
      try {
        ctx.effect(() => ctx.locale.register(LOCALE_NAMESPACE, COPY), 'dsh-connect-doubaowork: settings copy')
        const t = ctx.locale.bind(LOCALE_NAMESPACE)
        let settingsScope
        let liveDisposers = []

        const registerSlots = () => {
          const disposers = []
          disposers.push(ctx.slots.inject('settings.section', () => {
            const inner = []
            inner.push(ctx.slots.register({
              name: 'settings.section',
              id: SECTION_ID,
              order: 36,
              label: () => t('nav.panel'),
              locale: LOCALE_NAMESPACE,
              inject: () => ({ t, settingsScope, surface: 'settings' }),
            }, Doubaocard))
            try {
              const iconInject = ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
                name: 'settings.section.icon',
                id: SECTION_ID,
                locale: LOCALE_NAMESPACE,
              }, iconProps => PluginIcon(iconProps)))
              if (typeof iconInject === 'function') inner.push(iconInject)
            } catch (error) {
              console.error('[dsh-connect-doubaowork] settings nav icon failed (page unaffected):', error)
            }
            return () => {
              for (const dispose of inner) try { dispose() } catch {}
            }
          }))
          return disposers
        }

        const rebind = () => {
          for (const dispose of liveDisposers) try { dispose() } catch {}
          liveDisposers = []
          liveDisposers = registerSlots()
        }

        const forms = ctx.get('configForms')
        if (forms !== undefined && typeof forms.whileServed === 'function') {
          // unserved→served 边沿绑定：settingsScope 就绪后重建插槽（渲染器按
          // entry 身份缓存 inject 结果，晚绑定必须先卸载旧注册）
          ctx.effect(() => forms.whileServed(NS_CANDIDATES, served => {
            const ns = NS_CANDIDATES.find(candidate => served.has(candidate)) ?? [...served].find(entry => /doubaowork/i.test(entry))
            settingsScope = ns === undefined ? undefined : forms.get(ns)
            rebind()
            return () => {
              for (const dispose of liveDisposers) try { dispose() } catch {}
              liveDisposers = []
            }
          }), 'dsh-connect-doubaowork: settings namespace binding')
          rebind()
        } else {
          rebind()
        }
      } catch (error) {
        console.error('[dsh-connect-doubaowork] client card failed to load (host provider unaffected):', error)
      }
    }

    const exports = { name: 'dsh-connect-doubaowork-client', inject: ['slots', 'locale'], apply }
    return exports
  },
})
