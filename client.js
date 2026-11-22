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
    const CLI_REFRESH_PATH = '/plugins/dsh-connect-doubaowork/cli/refresh'
    const SETUP_PATH = '/plugins/dsh-connect-doubaowork/setup'

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
        'group.backend': '上游后端',
        'field.backend': '后端选择',
        'field.backend.auto': 'auto：装好 CLI 且已登录就优先 CLI，否则用 HTTP',
        'field.backend.cli': 'cli：只用豆包 CLI（需先执行 doubao login）',
        'field.backend.http': 'http：只用 HTTP 抓包（复用桌面端 cookie）',
        'field.cliPath': 'doubao 路径（留空自动探测）',
        'field.cliWorkspace': 'CLI 工作目录（留空用主目录）',
        'field.cliPermissionMode': 'CLI 权限模式',
        'field.cliPermissionMode.ask_risky': 'ask_risky（风险操作时确认，推荐）',
        'field.cliPermissionMode.ask_always': 'ask_always（始终确认）',
        'field.cliPermissionMode.always_allow': 'always_allow（全部允许）',
        'field.cliEffort': 'CLI 推理强度（留空用模型默认）',
        'field.cliEffort.default': '模型默认',
        'group.cli': '豆包 CLI',
        'cli.installed': '已安装',
        'cli.notInstalled': '未检测到',
        'cli.loggedIn': '已登录',
        'cli.notLoggedIn': '未登录（请执行 doubao login 扫码）',
        'cli.models': 'CLI 模型清单',
        'cli.noModels': '未拉取（登录后自动拉取）',
        'cli.unknown': '尚未探测',
        'action.refreshCli': '重新探测 CLI',
        'action.refreshing': '探测中…',
        'group.setup': '首次使用引导',
        'action.refreshSetup': '重新检查接入方式',
        'action.checking': '检查中…',
        'setup.ready': '接入可用',
        'setup.notReady': '尚未配置完成，模型调用会失败',
        'setup.pending': '尚未检查',
        'setup.fix': '修复步骤：',
        'setup.warn': '注意：',
        'hint.cli': 'CLI 后端走豆包官方 CLI 的登录态（doubao login 扫码一次），不依赖桌面端 cookie；它还自带工具执行与本地文件能力。HTTP 后端复用桌面端 cookie，约 30 天过期。',
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
        'group.backend': 'Upstream backend',
        'field.backend': 'Backend',
        'field.backend.auto': 'auto: prefer CLI when installed and signed in, else HTTP',
        'field.backend.cli': 'cli: Doubao CLI only (run doubao login first)',
        'field.backend.http': 'http: HTTP capture only (desktop cookie)',
        'field.cliPath': 'doubao path (empty = autodetect)',
        'field.cliWorkspace': 'CLI workspace (empty = home)',
        'field.cliPermissionMode': 'CLI permission mode',
        'field.cliPermissionMode.ask_risky': 'ask_risky (confirm risky ops, recommended)',
        'field.cliPermissionMode.ask_always': 'ask_always (always confirm)',
        'field.cliPermissionMode.always_allow': 'always_allow (allow everything)',
        'field.cliEffort': 'CLI reasoning effort (empty = model default)',
        'field.cliEffort.default': 'model default',
        'group.cli': 'Doubao CLI',
        'cli.installed': 'installed',
        'cli.notInstalled': 'not found',
        'cli.loggedIn': 'signed in',
        'cli.notLoggedIn': 'not signed in (run doubao login)',
        'cli.models': 'CLI model list',
        'cli.noModels': 'not fetched (fetched automatically after sign-in)',
        'cli.unknown': 'not probed yet',
        'action.refreshCli': 'Probe CLI again',
        'action.refreshing': 'Probing…',
        'group.setup': 'Getting started',
        'action.refreshSetup': 'Check again',
        'action.checking': 'Checking…',
        'setup.ready': 'Ready to use',
        'setup.notReady': 'Not configured yet — model calls will fail',
        'setup.pending': 'Not checked yet',
        'setup.fix': 'How to fix:',
        'setup.warn': 'Note:',
        'hint.cli': 'The CLI backend uses the official Doubao CLI login (scan a QR code once with doubao login) and does not depend on the desktop cookie; it also brings tool execution and local file access. The HTTP backend reuses the desktop cookie, which expires in about 30 days.',
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
      const [refreshing, setRefreshing] = react.useState(false)
      const [checking, setChecking] = react.useState(false)

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
        for (const key of [
          'backend', 'conversationMode', 'workMode', 'flattenHistory', 'reasoningEffort', 'timeoutSeconds',
          'poolEnabled', 'keepaliveEnabled', 'cliPath', 'cliWorkspace', 'cliPermissionMode', 'cliEffort',
        ]) {
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

      const refreshCli = async () => {
        setRefreshing(true)
        try {
          const response = await fetch(CLI_REFRESH_PATH, { method: 'POST', headers: { accept: 'application/json' } })
          if (response.ok) {
            const data = await response.json()
            setStatus(current => ({ ...(current ?? {}), cli: data }))
            setStatusError(false)
          }
        } catch {} finally {
          setRefreshing(false)
        }
      }

      const refreshSetup = async () => {
        setChecking(true)
        try {
          const response = await fetch(SETUP_PATH, { method: 'POST', headers: { accept: 'application/json' } })
          if (response.ok) {
            const data = await response.json()
            setStatus(current => ({ ...(current ?? {}), setup: data }))
            setStatusError(false)
          }
        } catch {} finally {
          setChecking(false)
        }
      }

      const rowStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', padding: '6px 0' }
      const labelStyle = { flex: '0 0 auto', maxWidth: '60%' }
      const sectionTitle = { margin: '14px 0 4px', fontSize: '0.92em', opacity: 0.8 }
      const inputStyle = { minWidth: '160px' }

      const rows = []
      rows.push(h('div', { key: 'title', style: { fontWeight: 600, marginBottom: 2 } }, t('card.title')))
      rows.push(h('div', { key: 'desc', style: { opacity: 0.7, fontSize: '0.9em' } }, t('card.desc')))

      // —— 首次使用引导：没配好就把安装/配置步骤直接摊在卡片顶部 ——
      rows.push(h('div', { key: 'g0', style: sectionTitle }, t('group.setup')))
      const setup = status?.setup
      if (setup === undefined || setup === null || setup.pending === true) {
        rows.push(h('div', { key: 'setup-pending', style: { opacity: 0.7, fontSize: '0.88em' } }, t('setup.pending')))
      } else {
        rows.push(h('div', { key: 'setup-head', style: rowStyle },
          h('span', null, setup.ready === true ? t('setup.ready') : t('setup.notReady')),
          h('span', { style: { fontSize: '0.85em', opacity: 0.8 } },
            setup.ready === true ? '✓' : (setup.summary?.cliInstalled === true ? `CLI v${setup.summary?.cliVersion ?? ''}` : '')),
        ))
        const steps = Array.isArray(setup.steps) ? setup.steps : []
        for (const step of steps) {
          const mark = step.status === 'done' ? '✓' : step.status === 'warn' ? '!' : step.status === 'blocked' ? '✗' : '○'
          rows.push(h('div', { key: `setup-${step.id}`, style: { padding: '4px 0 4px 10px', fontSize: '0.88em' } },
            h('div', null, `${mark} ${step.title}：${step.detail}`),
            step.warn ? h('div', { style: { opacity: 0.75, paddingLeft: 12 } }, `${t('setup.warn')}${step.warn}`) : null,
            (Array.isArray(step.fix) && step.fix.length > 0)
              ? h('div', { style: { opacity: 0.8, paddingLeft: 12, fontFamily: 'monospace' } },
                h('div', null, t('setup.fix')),
                ...step.fix.map((line, index) => h('div', { key: `fix-${index}` }, line)))
              : null,
          ))
        }
      }
      rows.push(h('div', { key: 'setup-refresh', style: rowStyle },
        h('button', { type: 'button', disabled: checking, onClick: refreshSetup }, checking ? t('action.checking') : t('action.refreshSetup')))
      )

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

      // —— 上游后端选择 + CLI 状态 ——
      rows.push(h('div', { key: 'gb', style: sectionTitle }, t('group.backend')))
      if (settingsScope !== undefined) {
        rows.push(h('div', { key: 'b1', style: rowStyle },
          h('label', { style: labelStyle }, t('field.backend')),
          h('select', {
            style: inputStyle,
            value: value.backend ?? 'auto',
            onChange: event => setField('backend', event.target.value),
          },
          h('option', { value: 'auto' }, t('field.backend.auto')),
          h('option', { value: 'cli' }, t('field.backend.cli')),
          h('option', { value: 'http' }, t('field.backend.http')))),
        )
        rows.push(h('div', { key: 'b2', style: rowStyle },
          h('label', { style: labelStyle }, t('field.cliPath')),
          h('input', {
            style: inputStyle, type: 'text', placeholder: 'doubao',
            value: value.cliPath ?? '',
            onChange: event => setField('cliPath', event.target.value),
          })),
        )
        rows.push(h('div', { key: 'b3', style: rowStyle },
          h('label', { style: labelStyle }, t('field.cliWorkspace')),
          h('input', {
            style: inputStyle, type: 'text', placeholder: '~',
            value: value.cliWorkspace ?? '',
            onChange: event => setField('cliWorkspace', event.target.value),
          })),
        )
        rows.push(h('div', { key: 'b4', style: rowStyle },
          h('label', { style: labelStyle }, t('field.cliPermissionMode')),
          h('select', {
            style: inputStyle,
            value: value.cliPermissionMode ?? 'ask_risky',
            onChange: event => setField('cliPermissionMode', event.target.value),
          },
          h('option', { value: 'ask_risky' }, t('field.cliPermissionMode.ask_risky')),
          h('option', { value: 'ask_always' }, t('field.cliPermissionMode.ask_always')),
          h('option', { value: 'always_allow' }, t('field.cliPermissionMode.always_allow')))),
        )
        rows.push(h('div', { key: 'b5', style: rowStyle },
          h('label', { style: labelStyle }, t('field.cliEffort')),
          h('select', {
            style: inputStyle,
            value: value.cliEffort ?? '',
            onChange: event => setField('cliEffort', event.target.value),
          },
          [['', t('field.cliEffort.default')], ['none', 'none'], ['minimal', 'minimal'], ['low', 'low'],
            ['medium', 'medium'], ['high', 'high'], ['xhigh', 'xhigh'], ['max', 'max']]
            .map(([level, label]) => h('option', { key: level === '' ? 'default' : level, value: level }, label)))),
        )
      }

      // —— CLI 探测状态（只读测量值 + 手动重新探测）——
      rows.push(h('div', { key: 'gc', style: sectionTitle }, t('group.cli')))
      const cli = status?.cli
      if (cli === null || cli === undefined) {
        rows.push(h('div', { key: 'cliu', style: { opacity: 0.7, fontSize: '0.88em' } }, statusError ? t('error.fetch') : t('cli.unknown')))
      } else {
        rows.push(h('div', { key: 'clii', style: rowStyle },
          h('span', null, t('cli.installed')),
          h('span', { style: { fontSize: '0.85em', opacity: 0.85 } },
            cli.installed === true ? `✓ ${cli.version === '' ? '' : `v${cli.version}`}`.trim() : t('cli.notInstalled')),
        ))
        rows.push(h('div', { key: 'clil', style: rowStyle },
          h('span', null, t('cli.loggedIn')),
          h('span', { style: { fontSize: '0.85em', opacity: 0.85 } },
            cli.loggedIn === true ? `✓ ${t('cli.loggedIn')}` : t('cli.notLoggedIn')),
        ))
        const cliModels = Array.isArray(cli.models) ? cli.models : []
        rows.push(h('div', { key: 'clim', style: rowStyle },
          h('span', null, t('cli.models')),
          h('span', { style: { fontSize: '0.85em', opacity: 0.85 } },
            cliModels.length === 0 ? t('cli.noModels') : `${cliModels.length}：${cliModels.join(', ')}`),
        ))
      }
      rows.push(h('div', { key: 'clirefresh', style: rowStyle },
        h('button', { type: 'button', disabled: refreshing, onClick: refreshCli }, refreshing ? t('action.refreshing') : t('action.refreshCli')))
      )

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
      rows.push(h('div', { key: 'hintcli', style: { opacity: 0.7, fontSize: '0.85em', lineHeight: 1.5, marginBottom: 6 } }, t('hint.cli')))
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
