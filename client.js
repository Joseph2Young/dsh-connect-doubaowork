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
    const CHECKIN_RUN_PATH = '/plugins/dsh-connect-doubaowork/checkin/run'
    const LOGIN_START_PATH = '/plugins/dsh-connect-doubaowork/login/start'
    const LOGIN_POLL_PATH = '/plugins/dsh-connect-doubaowork/login/poll'
    const LOGIN_CANCEL_PATH = '/plugins/dsh-connect-doubaowork/login/cancel'
    /** 登录轮询节奏：1.5s 一轮，扫码成功后最迟这么久就能反馈（对齐 workbuddy 的做法）。 */
    const LOGIN_POLL_INTERVAL_MS = 1500

    /**
     * 卡片样式表。
     *
     * 与 dsh-connect-workbuddy 同构：颜色走宿主 --dsw-alias-* 主题变量并带十六进制
     * 回退（深浅色主题自动适配），尺寸走统一竖向节奏。用 <style> + data-plugin-css
     * 注入到 <head> 并去重，因此本插件仍然零构建：不产出 CSS 文件，也不需要打包器
     * 认识 CSS。
     *
     * `typeof document` 守卫是必须的：客户端单测在无 DOM 的假宿主里加载本 bundle。
     */
    const CARD_CSS = `/* ---------------------------------------------------------------------------
 * 豆包工作模式设置卡片样式。
 *
 * 与 dsh-connect-workbuddy 的 dsm-* 系统同构：颜色全部走宿主 --dsw-alias-*
 * 主题变量并带十六进制回退，因此深浅色主题自动适配；尺寸只用 16px 竖向节奏，
 * 不靠各个区块自带 padding 去凑间距。
 *
 * 类名统一 dsm-doubaowork-* 前缀，避免与其它插件的卡片互相污染。
 * 样式由模块顶层注入到 <head>（<style data-plugin-css=...>），不走 CSS 文件，
 * 因此本插件保持零构建。
 * ------------------------------------------------------------------------- */
.dsm-doubaowork-card{
  --dsm-doubaowork-surface:var(--dsw-alias-bg-layer-1,#17181b);
  display:flex;flex-direction:column;gap:16px;margin:0;padding:16px 0 4px;
  color:var(--dsw-alias-label-primary,#e6e6e6);
  font-size:13px;line-height:1.5;
}

/* ---- 页头 ---- */
.dsm-doubaowork-head{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap;margin:0}
.dsm-doubaowork-head-copy{display:flex;flex-direction:column;gap:4px;flex:1;min-width:200px}
.dsm-doubaowork-title{margin:0;font-size:17px;font-weight:600;line-height:1.35;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-doubaowork-desc{margin:0;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#999)}
.dsm-doubaowork-badges{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-left:auto}

/* ---- 胶囊 ---- */
.dsm-doubaowork-badge{
  display:inline-flex;align-items:center;gap:5px;flex:none;
  padding:2px 9px;border-radius:999px;font-size:12px;font-weight:500;line-height:18px;
  color:var(--dsw-alias-brand-primary,#5686fe);
  background:rgba(86,134,254,.12);border:1px solid rgba(86,134,254,.32);
  white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis;
}
.dsm-doubaowork-badge-ok{
  color:var(--dsw-alias-state-success-primary,#22a06b);
  background:rgba(34,160,107,.12);border-color:rgba(34,160,107,.32);
}
.dsm-doubaowork-badge-warn{
  color:var(--dsw-alias-state-warn-primary,#f59e0b);
  background:rgba(245,158,11,.1);border-color:rgba(245,158,11,.32);
}
.dsm-doubaowork-badge-mute{
  color:var(--dsw-alias-label-secondary,#c6c9d0);
  background:transparent;border-color:var(--dsw-alias-border-l2,#3a3d45);
}

/* ---- 面板 tab 栏（吸附在卡片顶部，否则滚到池子就看不清当前所在面板）---- */
.dsm-doubaowork-panels{
  position:sticky;top:-1px;z-index:2;display:flex;align-items:stretch;gap:2px;margin:0;
  border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));
  background:var(--dsm-doubaowork-surface,var(--dsw-alias-bg-layer-1,#17181b));
}
.dsm-doubaowork-panel-tab{
  appearance:none;font:inherit;cursor:pointer;border:0;background:transparent;
  padding:7px 11px;margin-bottom:-1px;border-bottom:2px solid transparent;
  color:var(--dsw-alias-label-tertiary,#999);font-size:13px;font-weight:600;line-height:20px;
  white-space:nowrap;transition:color .15s,border-color .15s;
}
.dsm-doubaowork-panel-tab:hover:not(.dsm-doubaowork-panel-tab-active){color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-doubaowork-panel-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-doubaowork-panel-tab-active{color:var(--dsw-alias-label-primary,#e6e6e6);border-bottom-color:var(--dsw-alias-brand-primary,#5686fe)}
/* hidden 必须能压过上面的 display:flex：ID/类选择器一旦给了 display，UA 的
   [hidden]{display:none} 就失效，面板会永久绘制（workbuddy 5.20.1 踩过）。 */
.dsm-doubaowork-panel{display:flex;flex-direction:column;gap:18px;margin:0}
.dsm-doubaowork-panel[hidden]{display:none!important}

/* ---- 分组 ---- */
.dsm-doubaowork-section{display:flex;flex-direction:column;gap:10px;margin:0}
.dsm-doubaowork-section-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0}
.dsm-doubaowork-group-title{margin:0;font-size:15px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-doubaowork-group-desc{margin:0;font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary,#999)}
.dsm-doubaowork-note{margin:0;font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-doubaowork-hint{margin:0;font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary,#999)}
.dsm-doubaowork-error{margin:0;font-size:12px;line-height:17px;color:var(--dsw-alias-state-error-primary,#ef4444);white-space:pre-line}
.dsm-doubaowork-ok{color:var(--dsw-alias-state-success-primary,#22a06b)}
.dsm-doubaowork-warn{margin:0;padding:9px 11px;border-radius:9px;font-size:12px;line-height:17px;
  color:var(--dsw-alias-state-warn-primary,#f59e0b);
  background:rgba(245,158,11,.09);border:1px solid rgba(245,158,11,.3)}
.dsm-doubaowork-code{
  margin:0;padding:9px 11px;border-radius:9px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-all;
  color:var(--dsw-alias-label-secondary,#c6c9d0);
  background:var(--dsw-alias-bg-layer-1,#17181b);border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));
}

/* ---- 开关行：整行可点，说明文字在标签下方，开关用平台原生控件只上色 ---- */
.dsm-doubaowork-switchlist{
  display:flex;flex-direction:column;margin:0;padding:0;list-style:none;
  border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:12px;overflow:hidden;
  background:var(--dsw-alias-bg-layer-2,#232529);
}
.dsm-doubaowork-switchrow{
  display:flex;align-items:flex-start;gap:12px;padding:12px 14px;margin:0;
  border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));
}
.dsm-doubaowork-switchrow:first-child{border-top:0}
.dsm-doubaowork-switchrow-copy{display:flex;flex-direction:column;gap:3px;flex:1;min-width:0}
.dsm-doubaowork-switchrow-label{font-size:13px;font-weight:500;line-height:1.45;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-doubaowork-switchrow-desc{font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary,#999)}
.dsm-doubaowork-switch{
  display:inline-flex;align-items:center;justify-content:center;flex:none;margin-top:2px;cursor:pointer;
}
.dsm-doubaowork-switch input{margin:0;cursor:pointer;accent-color:var(--dsw-alias-brand-primary,#5686fe)}
.dsm-doubaowork-switch input:disabled{cursor:default}

/* ---- 字段行 ---- */
.dsm-doubaowork-fields{
  display:flex;flex-direction:column;margin:0;
  border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:12px;overflow:hidden;
  background:var(--dsw-alias-bg-layer-2,#232529);
}
.dsm-doubaowork-field{
  display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 14px;margin:0;
  border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));
}
.dsm-doubaowork-field:first-child{border-top:0}
.dsm-doubaowork-field-label{flex:1 1 140px;min-width:0;font-size:13px;line-height:1.45}
.dsm-doubaowork-field-control{flex:0 1 280px;min-width:160px;display:flex;justify-content:flex-end}
.dsm-doubaowork-select,.dsm-doubaowork-input{
  appearance:none;font:inherit;font-size:13px;line-height:20px;width:100%;
  padding:5px 10px;border-radius:8px;color:var(--dsw-alias-label-primary,#e6e6e6);
  background:var(--dsw-alias-bg-layer-1,#17181b);
  border:1px solid var(--dsw-alias-border-l2,#3a3d45);
}
.dsm-doubaowork-select{cursor:pointer;padding-right:26px;
  /* 纯 CSS 箭头：不依赖宿主的图标集（不同 DSH 线图标名不同） */
  background-image:linear-gradient(45deg,transparent 50%,currentColor 50%),linear-gradient(135deg,currentColor 50%,transparent 50%);
  background-position:calc(100% - 15px) 50%,calc(100% - 10px) 50%;
  background-size:5px 5px,5px 5px;background-repeat:no-repeat}
.dsm-doubaowork-select:focus-visible,.dsm-doubaowork-input:focus-visible{
  outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-doubaowork-input::placeholder{color:var(--dsw-alias-label-dimmed,#777)}

/* ---- 只读测量值行（label + value 两端对齐）---- */
.dsm-doubaowork-kv{display:flex;align-items:baseline;gap:12px;margin:0;padding:7px 0;min-width:0}
.dsm-doubaowork-kv-label{flex:0 0 auto;font-size:12px;color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-doubaowork-kv-value{flex:1 1 auto;min-width:0;font-size:12px;text-align:right;
  color:var(--dsw-alias-label-primary,#e8e9ed);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-doubaowork-kv-value-wrap{white-space:normal;word-break:break-all;text-align:right}

/* ---- 表格（逐账号）---- */
.dsm-doubaowork-table{
  display:flex;flex-direction:column;margin:0;padding:0;list-style:none;
  border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:12px;overflow:hidden;
  background:var(--dsw-alias-bg-layer-2,#232529);
}
.dsm-doubaowork-table-row{
  display:flex;align-items:center;gap:10px;padding:9px 14px;margin:0;
  border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));font-size:13px;
}
.dsm-doubaowork-table-row:first-child{border-top:0}
.dsm-doubaowork-table-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-doubaowork-table-meta{flex:none;font-size:12px;color:var(--dsw-alias-label-tertiary,#999)}
.dsm-doubaowork-dot{display:inline-block;flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-dimmed,#777)}
.dsm-doubaowork-dot-ok{background:var(--dsw-alias-state-success-primary,#22a06b)}
.dsm-doubaowork-dot-bad{background:var(--dsw-alias-state-error-primary,#ef4444)}
.dsm-doubaowork-dot-warn{background:var(--dsw-alias-state-warn-primary,#f59e0b)}

/* ---- 操作条 ---- */
.dsm-doubaowork-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0}
.dsm-doubaowork-bar-status{flex:1 1 auto;min-width:0;font-size:12px;line-height:18px;
  color:var(--dsw-alias-label-tertiary,#999);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-doubaowork-bar-actions{display:flex;gap:8px;flex:none;margin-left:auto}

/* ---- 按钮原语 ---- */
.dsm-doubaowork-btn{
  appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;
  padding:5px 14px;font-size:13px;line-height:1.5;white-space:nowrap;
}
.dsm-doubaowork-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-doubaowork-btn:disabled{opacity:.4;cursor:default}
.dsm-doubaowork-btn-outline{
  border-color:var(--dsw-alias-border-l2,#3a3d45);color:var(--dsw-alias-label-secondary,#c6c9d0);
  background:transparent;font-weight:500;
}
.dsm-doubaowork-btn-outline:hover:not(:disabled){
  color:var(--dsw-alias-label-primary,#e6e6e6);border-color:var(--dsw-alias-label-dimmed,#777);
  background:rgba(255,255,255,.04);
}
.dsm-doubaowork-btn-primary{background:var(--dsw-alias-label-primary,#e6e6e6);color:var(--dsw-alias-bg-layer-3,#2a2c33);font-weight:600}
.dsm-doubaowork-btn-primary:hover:not(:disabled){opacity:.9}
.dsm-doubaowork-btn-ghost{border-color:transparent;color:var(--dsw-alias-brand-primary,#5686fe);background:transparent;font-weight:500}
.dsm-doubaowork-btn-ghost:hover:not(:disabled){text-decoration:underline}

/* ---- 引导步骤 ---- */
.dsm-doubaowork-steps{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}
.dsm-doubaowork-step{display:flex;align-items:flex-start;gap:9px;margin:0;font-size:13px;line-height:1.5}
.dsm-doubaowork-step-mark{flex:none;width:16px;text-align:center;font-weight:700}
.dsm-doubaowork-step-mark-done{color:var(--dsw-alias-state-success-primary,#22a06b)}
.dsm-doubaowork-step-mark-warn{color:var(--dsw-alias-state-warn-primary,#f59e0b)}
.dsm-doubaowork-step-mark-blocked{color:var(--dsw-alias-state-error-primary,#ef4444)}
.dsm-doubaowork-step-mark-todo{color:var(--dsw-alias-label-dimmed,#777)}
.dsm-doubaowork-step-copy{display:flex;flex-direction:column;gap:4px;flex:1;min-width:0}
.dsm-doubaowork-step-detail{color:var(--dsw-alias-label-secondary,#c6c9d0)}

/* ---- 扫码登录 ---- */
.dsm-doubaowork-qr{display:flex;flex-direction:column;align-items:center;gap:8px;margin:0;padding:6px 0}
.dsm-doubaowork-qr-img{
  width:220px;height:220px;border-radius:10px;background:#fff;padding:8px;box-sizing:content-box;
  border:1px solid var(--dsw-alias-border-l2,#3a3d45);
}
.dsm-doubaowork-qr-wait{font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary,#c6c9d0);text-align:center}
`

    const CARD_CSS_ID = 'dsh-connect-doubaowork/client.css'
    if (typeof document !== 'undefined') {
      const existing = document.querySelector(`style[data-plugin-css="${CARD_CSS_ID}"]`)
      if (existing !== null) {
        existing.textContent = CARD_CSS
      } else {
        const styleTag = document.createElement('style')
        styleTag.dataset.plugin = 'dsh-connect-doubaowork'
        styleTag.dataset.pluginCss = CARD_CSS_ID
        styleTag.textContent = CARD_CSS
        document.head.appendChild(styleTag)
      }
    }

    const COPY = {
      zh: {
        'nav.panel': '豆包工作模式',
        'card.title': '豆包工作模式',
        'card.desc': '复用豆包桌面端登录态，把豆包聚合的模型接入 DSH。',
        'tab.overview': '概览',
        'tab.gateway': '网关',
        'tab.models': '模型',
        'tab.accounts': '账号',
        'tab.diagnostics': '诊断',
        'hint.workMode': '首轮把 agent_mode 打开，豆包会按工作模式（自带工具、可跑多步）应答。',
        'hint.flattenHistory': '把多轮历史压成一段文本一次发出；关掉则只发最后一条用户消息。',
        'hint.poolEnabled': '请求失败时自动换下一个账号重试（仅在上游返回错误、尚未开始流式输出时生效）。',
        'hint.keepaliveEnabled': '每天定时用登录态只读探测一次，确认 cookie 没失效；不产生任何豆包会话。',
        'hint.backend': 'auto 会在豆包 CLI 已安装且已登录时优先走 CLI，否则复用桌面端 cookie 走 HTTP。切到 cli 后模型清单会改成豆包 CLI 自己上报的那一套。',
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
        'group.effective': '当前生效（只读测量值）',
        'effective.backend': '实际使用的后端',
        'effective.backend.cli': 'CLI（豆包 CLI 自己的登录态）',
        'effective.backend.http': 'HTTP（复用桌面端 cookie）',
        'effective.models': '当前可路由模型',
        'effective.default': '默认模型',
        'effective.noModels': '（暂无；CLI 需先登录才会拉取清单）',
        'group.checkin': '每日自动签到',
        'checkin.enabled': '每日签到',
        'checkin.enabled.on': '已开启',
        'checkin.enabled.off': '已关闭',
        'checkin.time': '签到时刻',
        'checkin.next': '下一次',
        'checkin.next.none': '未启用',
        'checkin.last': '最近一次',
        'checkin.last.none': '还没跑过',
        'checkin.result': '今日结果',
        'checkin.result.value': '成功 %s 个账号',
        'checkin.result.skipped': '已跳过 %s 个（今日已签）',
        'checkin.account.ok': '登录态有效',
        'checkin.account.fail': '未签到',
        'checkin.account.pending': '未检查',
        'action.checkin': '立即签到',
        'action.checkingIn': '签到中…',
        'checkin.hint': '豆包没有签到按钮：免费积分按「当日首次登录」发放（80-150 积分，当日 24:00 清零）。这里的签到就是每天定时用登录态真实访问一次豆包，顺带确认登录态是否还有效。',
        'group.trace': '豆包侧的留痕',
        'trace.mode': '会话复用模式',
        'trace.mode.single': '固定复用同一条豆包会话（推荐，留痕最少）',
        'trace.mode.perChat': '每个对话各一条豆包会话（留痕随对话数增长）',
        'trace.bound': '已记住的会话绑定',
        'trace.bound.value': '%s 条（进程重启后仍复用，不会新开）',
        'trace.persisted': '绑定落盘',
        'trace.persisted.yes': '已落盘：%s',
        'trace.persisted.no': '仅内存（重载插件会丢，豆包侧会新开一条）',
        'trace.hint': '豆包 CLI 没有删除会话的命令，历史属于豆包服务端；插件能做的只有反复复用同一条会话，把新增条数压到最少。旧记录请在豆包客户端手动删除。',
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
        'group.login': '扫码登录豆包 CLI',
        'login.desc': '用豆包手机 App 扫码登录。登录态由豆包 CLI 自己保存，插件不读取、不存储任何凭据。',
        'action.login': '扫码登录',
        'action.loginAgain': '重新扫码登录',
        'login.starting': '正在获取二维码…',
        'login.waiting': '请用豆包 App 扫码（%ss）',
        'login.success': '登录成功，CLI 后端可用',
        'login.expired': '二维码已过期，请重新获取',
        'login.cancel': '取消',
        'login.close': '关闭',
        'login.failed': '获取二维码失败',
        'login.loggedIn': '已登录',
        'login.notLoggedIn': '未登录',
        'login.active': '扫码登录进行中',
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
        'tab.overview': 'Overview',
        'tab.gateway': 'Gateway',
        'tab.models': 'Models',
        'tab.accounts': 'Accounts',
        'tab.diagnostics': 'Diagnostics',
        'hint.workMode': 'Turns agent_mode on for the first turn, so Doubao answers in work mode (with its own tools and multi-step runs).',
        'hint.flattenHistory': 'Sends the whole history flattened as one text block; turn it off to send only the last user message.',
        'hint.poolEnabled': 'Retries with the next account when a request fails — only before any stream output has been written.',
        'hint.keepaliveEnabled': 'Probes each account cookie once a day with a read-only request; creates no Doubao conversations.',
        'hint.backend': 'auto prefers the CLI once it is installed and signed in, otherwise reuses the desktop cookie over HTTP. Switching to cli swaps the model list for the one the CLI reports.',
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
        'group.effective': 'In effect now (read-only)',
        'effective.backend': 'Backend in use',
        'effective.backend.cli': 'CLI (the Doubao CLI keeps its own sign-in)',
        'effective.backend.http': 'HTTP (reuses the desktop cookie)',
        'effective.models': 'Routable models',
        'effective.default': 'Default model',
        'effective.noModels': '(none yet; the CLI list appears after sign-in)',
        'group.checkin': 'Daily auto check-in',
        'checkin.enabled': 'Daily check-in',
        'checkin.enabled.on': 'On',
        'checkin.enabled.off': 'Off',
        'checkin.time': 'Check-in time',
        'checkin.next': 'Next run',
        'checkin.next.none': 'Not scheduled',
        'checkin.last': 'Last run',
        'checkin.last.none': 'Never',
        'checkin.result': "Today's result",
        'checkin.result.value': '%s account(s) signed',
        'checkin.result.skipped': '%s skipped (already today)',
        'checkin.account.ok': 'Signed in',
        'checkin.account.fail': 'Not signed',
        'checkin.account.pending': 'Not checked',
        'action.checkin': 'Check in now',
        'action.checkingIn': 'Checking in…',
        'checkin.hint': 'Doubao has no check-in button: the free credits are granted on the first login of the day (80-150 credits, expiring at 24:00 Beijing time). This check-in simply visits Doubao once a day with your login state, which also verifies that the cookie still works.',
        'group.trace': 'Traces on the Doubao side',
        'trace.mode': 'Conversation reuse',
        'trace.mode.single': 'Reuse one Doubao conversation (recommended, fewest traces)',
        'trace.mode.perChat': 'One Doubao conversation per chat (traces grow with chats)',
        'trace.bound': 'Bound conversations',
        'trace.bound.value': '%s kept (survives restarts, so no new ones)',
        'trace.persisted': 'Binding storage',
        'trace.persisted.yes': 'Saved to %s',
        'trace.persisted.no': 'Memory only (reloading the plugin starts a new Doubao conversation)',
        'trace.hint': 'The Doubao CLI has no command to delete conversations; the history lives on the Doubao server. The plugin can only reuse one conversation to keep new entries to a minimum. Delete old records in the Doubao client.',
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
        'group.login': 'Scan to sign in',
        'login.desc': 'Scan a QR code with the Doubao mobile app to sign in. The session is kept by the Doubao CLI itself — this plugin never reads or stores any credential.',
        'action.login': 'Scan to sign in',
        'action.loginAgain': 'Scan again',
        'login.starting': 'Requesting a QR code…',
        'login.waiting': 'Scan with the Doubao app and confirm on your phone (%s s left)',
        'login.success': 'Signed in',
        'login.expired': 'The QR code expired or the sign-in was rejected',
        'login.cancel': 'Cancel',
        'login.close': 'Close',
        'login.failed': 'Sign-in failed',
        'login.loggedIn': 'signed in',
        'login.notLoggedIn': 'not signed in',
        'login.active': 'sign-in in progress',
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

    /** Card body: tabbed panels over the same read-only measurements as before. */
    function Doubaocard(props) {
      const { t, settingsScope } = props
      const snapshot = typeof settingsScope?.getSnapshot === 'function' ? settingsScope.getSnapshot() : undefined
      const config = snapshot?.value ?? {}
      const [draft, setDraft] = react.useState(null)
      const [savedAt, setSavedAt] = react.useState(0)
      const [status, setStatus] = react.useState(null)
      const [statusError, setStatusError] = react.useState(false)
      const [probing, setProbing] = react.useState(false)
      const [checkingIn, setCheckingIn] = react.useState(false)
      const [refreshing, setRefreshing] = react.useState(false)
      const [checking, setChecking] = react.useState(false)
      // 当前面板：与 workbuddy 一致用「一个文档的多个面板」而不是二选一开关格。
      // 面板全部保持挂载（hidden 只隐藏不卸载），所以切回来不会重拉数据、
      // 半填的草稿也不会丢。
      const [tab, setTab] = react.useState('overview')
      // 扫码登录本地状态机：idle → starting → waiting → success | error
      // 只放浏览器侧的展示状态，二维码字节与 loginId 都来自 Host 的 start 响应
      const [login, setLogin] = react.useState({ phase: 'idle' })

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
          'checkinEnabled', 'checkinHour', 'checkinMinute',
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
          // CLI 探测结果会改变「当前生效」的后端与模型清单（auto 下登录后切到 cli），
          // 所以顺带重拉整份 status，别让那块只读测量值停在旧值。
          const snapshot2 = await fetch(STATUS_PATH, { headers: { accept: 'application/json' } })
          if (snapshot2.ok) {
            setStatus(await snapshot2.json())
            setStatusError(false)
          }
        } catch {} finally {
          setRefreshing(false)
        }
      }

      /**
       * 立即签到：POST /checkin/run。Host 侧是 force 模式（忽略「今日已签」去重），
       * 所以按钮点一次就真的访问一次豆包——这也是用户手动验证登录态的手段。
       * 返回的是新的 pending state，随后整份 status 重拉以刷新「今日结果」。
       */
      const checkinNow = async () => {
        setCheckingIn(true)
        try {
          const response = await fetch(CHECKIN_RUN_PATH, { method: 'POST', headers: { accept: 'application/json' } })
          if (response.ok) {
            const snapshot2 = await fetch(STATUS_PATH, { headers: { accept: 'application/json' } })
            if (snapshot2.ok) {
              setStatus(await snapshot2.json())
              setStatusError(false)
            }
          }
        } catch {} finally {
          setCheckingIn(false)
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

      /**
       * 开始一次扫码登录：Host 拉起 `doubao login --qr=png` 并回 data URL。
       * 失败（未装 CLI / 已有登录在进行 / 输出不支持）都在这里落地成可读文案。
       */
      const startLogin = async () => {
        setLogin({ phase: 'starting' })
        try {
          const response = await fetch(LOGIN_START_PATH, { method: 'POST', headers: { accept: 'application/json' } })
          const data = await response.json()
          if (data?.ok === true && typeof data.imageDataUrl === 'string' && data.imageDataUrl !== '') {
            setLogin({
              phase: 'waiting',
              loginId: data.loginId,
              imageDataUrl: data.imageDataUrl,
              expiresAt: Date.now() + Math.max(1, Number(data.expiresInSeconds ?? 300)) * 1000,
            })
            return
          }
          setLogin({ phase: 'error', error: String(data?.error ?? t('login.failed')) })
        } catch (error) {
          setLogin({ phase: 'error', error: String(error?.message ?? error) })
        }
      }

      /** 取消进行中的登录（同时杀掉 Host 侧子进程）。 */
      const cancelLogin = async () => {
        const active = login.loginId
        setLogin({ phase: 'idle' })
        if (typeof active !== 'string') return
        try {
          await fetch(LOGIN_CANCEL_PATH, {
            method: 'POST',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify({ loginId: active }),
          })
        } catch {}
      }

      /**
       * 轮询登录结果。
       *
       * 用 effect + 定时器而不是自己写循环：卸载时 clearInterval 就能停，
       * 不会留下悬空请求。成功后补一次 status 刷新，把 CLI 区块切成已登录。
       */
      react.useEffect(() => {
        if (login.phase !== 'waiting' || typeof login.loginId !== 'string') return undefined
        let alive = true
        let timer = undefined
        const tick = async () => {
          try {
            const response = await fetch(LOGIN_POLL_PATH, {
              method: 'POST',
              headers: { accept: 'application/json', 'content-type': 'application/json' },
              body: JSON.stringify({ loginId: login.loginId }),
            })
            if (!response.ok) return
            const data = await response.json()
            if (!alive) return
            if (data?.done === true) {
              if (data.loggedIn === true) {
                setLogin({ phase: 'success' })
                // 登录态变了：把 CLI 状态与引导一并刷新，卡片即时变成「已登录」
                void refreshCli()
                void refreshSetup()
                return
              }
              setLogin({ phase: 'error', error: String(data?.error ?? t('login.expired')) })
              return
            }
          } catch {
            // 网络抖动不算失败：下一轮继续问
          }
        }
        timer = setInterval(() => { void tick() }, LOGIN_POLL_INTERVAL_MS)
        void tick()
        return () => {
          alive = false
          if (timer !== undefined) clearInterval(timer)
        }
      }, [login.phase, login.loginId])

      /* ------------------------------------------------------------------
       * 渲染原语。
       *
       * 全部走 className（样式在模块顶层注入 <style>），不再用内联 style：
       * 内联样式既没法表达 :hover / :focus-visible，也没法跟随宿主深浅色主题，
       * 这就是旧卡片「一片灰字」的根源。
       * ---------------------------------------------------------------- */

      /** 分组：标题 + 可选描述 + 子元素。 */
      const group = (key, title, children, description) => h('section', { key, className: 'dsm-doubaowork-section' },
        h('div', { className: 'dsm-doubaowork-section-head' }, h('h4', { className: 'dsm-doubaowork-group-title' }, title)),
        description === undefined || description === '' ? null : h('p', { className: 'dsm-doubaowork-group-desc' }, description),
        ...(Array.isArray(children) ? children : [children]).filter(child => child !== null && child !== undefined && child !== false))

      /** 只读键值行（label 左侧、值右侧，过长省略）。 */
      const kv = (key, label, text, wrap = false) => h('div', { key, className: 'dsm-doubaowork-kv' },
        h('span', { className: 'dsm-doubaowork-kv-label' }, label),
        h('span', { className: `dsm-doubaowork-kv-value${wrap ? ' dsm-doubaowork-kv-value-wrap' : ''}` }, text))

      /** 可编辑字段行：label + 控件。 */
      const field = (key, label, control) => h('div', { key, className: 'dsm-doubaowork-field' },
        h('label', { className: 'dsm-doubaowork-field-label' }, label),
        h('div', { className: 'dsm-doubaowork-field-control' }, control))

      /** 开关行：整行说明 + 平台原生 checkbox（只给 accent-color，不自己画）。 */
      const switchRow = (key, label, description, checked, onChange, disabled = false) => h('div', { key, className: 'dsm-doubaowork-switchrow' },
        h('div', { className: 'dsm-doubaowork-switchrow-copy' },
          h('span', { className: 'dsm-doubaowork-switchrow-label' }, label),
          description === undefined || description === '' ? null : h('span', { className: 'dsm-doubaowork-switchrow-desc' }, description)),
        h('label', { className: 'dsm-doubaowork-switch' },
          h('input', { type: 'checkbox', checked: checked === true, disabled, onChange: event => onChange(event.target.checked) })))

      /** 按钮。variant: primary | outline | ghost。 */
      const button = (key, label, onClick, variant = 'outline', disabled = false) => h('button', {
        key,
        type: 'button',
        className: `dsm-doubaowork-btn dsm-doubaowork-btn-${variant}`,
        disabled,
        onClick,
      }, label)

      /** 下拉框（给 out-of-range 值一个稳定的空值 key）。 */
      const select = (options, current, onChange) => h('select', {
        className: 'dsm-doubaowork-select',
        value: current,
        onChange: event => onChange(event.target.value),
      }, options.map(([optionValue, optionLabel]) => h('option', { key: `o-${optionValue === '' ? 'default' : optionValue}`, value: optionValue }, optionLabel)))

      const input = (type, current, onChange, placeholder) => h('input', {
        className: 'dsm-doubaowork-input',
        type,
        placeholder,
        value: type === 'number' ? current : String(current ?? ''),
        onChange: event => onChange(type === 'number' ? Number(event.target.value) : event.target.value),
      })

      const note = (key, text) => h('p', { key, className: 'dsm-doubaowork-note' }, text)
      const hint = (key, text) => h('p', { key, className: 'dsm-doubaowork-hint' }, text)

      /** 面板容器：不活跃的面板保持挂载，只加 hidden。 */
      const panel = (id, children) => h('div', {
        key: `panel-${id}`,
        className: 'dsm-doubaowork-panel',
        hidden: tab !== id,
      }, ...children.filter(child => child !== null && child !== undefined && child !== false))

      /* ------------------------------------------------------------------
       * 页头：标题 + 描述 + 右侧状态徽章。
       *
       * 徽章只表达「当前实测状态」，不承担操作：后端徽章来自 status，
       * CLI 徽章来自 status.cli，两者都由 Host 侧探测产生。
       * ---------------------------------------------------------------- */
      const effectiveBackend = status?.effectiveBackend === 'cli' ? 'cli' : 'http'
      const cliInfo = status?.cli
      const badges = []
      if (status !== null && status !== undefined) {
        badges.push(h('span', {
          key: 'badge-backend',
          className: `dsm-doubaowork-badge${effectiveBackend === 'cli' ? ' dsm-doubaowork-badge-ok' : ''}`,
        }, t(`effective.backend.${effectiveBackend}`)))
        if (cliInfo !== null && cliInfo !== undefined) {
          badges.push(h('span', {
            key: 'badge-cli',
            className: `dsm-doubaowork-badge${cliInfo.loggedIn === true ? ' dsm-doubaowork-badge-ok' : ' dsm-doubaowork-badge-mute'}`,
          }, cliInfo.loggedIn === true
            ? `CLI v${cliInfo.version === '' || cliInfo.version === undefined ? '' : cliInfo.version}`
            : t('cli.notLoggedIn')))
        }
      } else {
        badges.push(h('span', { key: 'badge-unknown', className: 'dsm-doubaowork-badge dsm-doubaowork-badge-mute' },
          statusError ? t('error.fetch') : t('cli.unknown')))
      }

      const header = h('header', { key: 'head', className: 'dsm-doubaowork-head' },
        h('div', { className: 'dsm-doubaowork-head-copy' },
          h('h3', { className: 'dsm-doubaowork-title' }, t('card.title')),
          h('p', { className: 'dsm-doubaowork-desc' }, t('card.desc'))),
        h('div', { className: 'dsm-doubaowork-badges' }, ...badges))

      /* ---- 面板一：概览（引导 + 当前生效）---- */
      const overview = []
      overview.push(group('g-setup', t('group.setup'), (() => {
        const setup = status?.setup
        if (setup === undefined || setup === null || setup.pending === true) {
          return [h('p', { key: 'setup-pending', className: 'dsm-doubaowork-hint' }, t('setup.pending')),
            h('div', { key: 'setup-bar', className: 'dsm-doubaowork-bar' },
              button('setup-refresh', checking ? t('action.checking') : t('action.refreshSetup'), refreshSetup, 'outline', checking))]
        }
        const items = []
        items.push(h('div', { key: 'setup-head', className: 'dsm-doubaowork-bar' },
          h('span', {
            className: `dsm-doubaowork-badge${setup.ready === true ? ' dsm-doubaowork-badge-ok' : ' dsm-doubaowork-badge-warn'}`,
          }, setup.ready === true ? t('setup.ready') : t('setup.notReady')),
          h('div', { className: 'dsm-doubaowork-bar-actions' },
            button('setup-refresh', checking ? t('action.checking') : t('action.refreshSetup'), refreshSetup, 'outline', checking))))

        const steps = Array.isArray(setup.steps) ? setup.steps : []
        if (steps.length > 0) {
          const stepNodes = []
          for (const step of steps) {
            const mark = step.status === 'done' ? '✓' : step.status === 'warn' ? '!' : step.status === 'blocked' ? '✗' : '○'
            const markClass = step.status === 'done' ? 'done' : step.status === 'warn' ? 'warn' : step.status === 'blocked' ? 'blocked' : 'todo'
            const copy = [h('span', { key: 'd', className: 'dsm-doubaowork-step-detail' }, `${step.title}：${step.detail}`)]
            if (step.warn) copy.push(h('span', { key: 'w', className: 'dsm-doubaowork-warn' }, `${t('setup.warn')}${step.warn}`))
            if (Array.isArray(step.fix) && step.fix.length > 0) {
              copy.push(h('div', { key: 'f', className: 'dsm-doubaowork-step-copy' },
                h('span', { className: 'dsm-doubaowork-hint' }, t('setup.fix')),
                h('pre', { className: 'dsm-doubaowork-code' }, step.fix.join('\n'))))
            }
            stepNodes.push(h('li', { key: `step-${step.id}`, className: 'dsm-doubaowork-step' },
              h('span', { className: `dsm-doubaowork-step-mark dsm-doubaowork-step-mark-${markClass}` }, mark),
              h('div', { className: 'dsm-doubaowork-step-copy' }, ...copy)))
          }
          items.push(h('ul', { key: 'steps', className: 'dsm-doubaowork-steps' }, ...stepNodes))
        }
        return items
      })()))

      const effectiveNodes = []
      if (status === null || status === undefined) {
        effectiveNodes.push(h('p', { key: 'eff-unknown', className: 'dsm-doubaowork-hint' }, statusError ? t('error.fetch') : t('cli.unknown')))
      } else {
        const liveModels = Array.isArray(status.models) ? status.models : []
        effectiveNodes.push(kv('eff-1', t('effective.backend'), t(`effective.backend.${effectiveBackend}`)))
        effectiveNodes.push(kv('eff-2', t('effective.models'),
          liveModels.length === 0 ? t('effective.noModels') : `${liveModels.length}：${liveModels.join(', ')}`, true))
        effectiveNodes.push(kv('eff-3', t('effective.default'), String(status.defaultModel ?? '')))
      }
      overview.push(group('g-effective', t('group.effective'), effectiveNodes))

      /* ---- 面板二：网关（可编辑配置 + 保存）---- */
      const gateway = []
      if (settingsScope !== undefined) {
        const rows = []
        rows.push(field('f1', t('field.conversationMode'), select([
          ['single', t('field.conversationMode.single')],
          ['per-chat', t('field.conversationMode.per-chat')],
        ], value.conversationMode ?? 'single', next => setField('conversationMode', next))))
        rows.push(field('f2', t('field.reasoningEffort'), select(
          ['0', '1', '2', '3', '4'].map(level => [level, level]),
          String(value.reasoningEffort ?? '4'), next => setField('reasoningEffort', next))))
        rows.push(field('f3', t('field.timeoutSeconds'), input('number', value.timeoutSeconds ?? 300, next => setField('timeoutSeconds', next))))
        gateway.push(h('div', { key: 'gw-fields', className: 'dsm-doubaowork-fields' }, ...rows))

        const switches = []
        switches.push(switchRow('s1', t('field.workMode'), t('hint.workMode'),
          value.workMode !== false, next => setField('workMode', next)))
        switches.push(switchRow('s2', t('field.flattenHistory'), t('hint.flattenHistory'),
          value.flattenHistory !== false, next => setField('flattenHistory', next)))
        switches.push(switchRow('s3', t('field.poolEnabled'), t('hint.poolEnabled'),
          value.poolEnabled === true, next => setField('poolEnabled', next)))
        switches.push(switchRow('s4', t('field.keepaliveEnabled'), t('hint.keepaliveEnabled'),
          value.keepaliveEnabled === true, next => setField('keepaliveEnabled', next)))
        gateway.push(h('div', { key: 'gw-switches', className: 'dsm-doubaowork-switchlist' }, ...switches))
      } else {
        gateway.push(note('gw-ro', t('accounts.readonly')))
      }

      /* ---- 面板三：模型（后端选择 + CLI 探测）---- */
      const modelsPanel = []
      if (settingsScope !== undefined) {
        const rows = []
        rows.push(field('b1', t('field.backend'), select([
          ['auto', t('field.backend.auto')],
          ['cli', t('field.backend.cli')],
          ['http', t('field.backend.http')],
        ], value.backend ?? 'auto', next => setField('backend', next))))
        rows.push(field('b2', t('field.cliPath'), input('text', value.cliPath ?? '', next => setField('cliPath', next), 'doubao')))
        rows.push(field('b3', t('field.cliWorkspace'), input('text', value.cliWorkspace ?? '', next => setField('cliWorkspace', next), '~')))
        rows.push(field('b4', t('field.cliPermissionMode'), select([
          ['ask_risky', t('field.cliPermissionMode.ask_risky')],
          ['ask_always', t('field.cliPermissionMode.ask_always')],
          ['always_allow', t('field.cliPermissionMode.always_allow')],
        ], value.cliPermissionMode ?? 'ask_risky', next => setField('cliPermissionMode', next))))
        rows.push(field('b5', t('field.cliEffort'), select(
          [['', t('field.cliEffort.default')], ['none', 'none'], ['minimal', 'minimal'], ['low', 'low'],
            ['medium', 'medium'], ['high', 'high'], ['xhigh', 'xhigh'], ['max', 'max']],
          value.cliEffort ?? '', next => setField('cliEffort', next))))
        // 「上游后端」是一组互相影响的字段（选 cli 才用得到 cliPath/cliPermissionMode），
        // 所以整组包在同一个分组标题下，而不是散落在面板里。
        modelsPanel.push(group('md-backend', t('group.backend'), [
          h('div', { key: 'md-fields', className: 'dsm-doubaowork-fields' }, ...rows),
          hint('md-hint', t('hint.backend')),
        ]))
      } else {
        modelsPanel.push(note('md-ro', t('accounts.readonly')))
      }

      const cliNodes = []
      if (cliInfo === null || cliInfo === undefined) {
        cliNodes.push(h('p', { key: 'cli-unknown', className: 'dsm-doubaowork-hint' }, statusError ? t('error.fetch') : t('cli.unknown')))
      } else {
        cliNodes.push(kv('cli-1', t('cli.installed'),
          cliInfo.installed === true ? `✓ ${cliInfo.version === '' || cliInfo.version === undefined ? '' : `v${cliInfo.version}`}`.trim() : t('cli.notInstalled')))
        cliNodes.push(kv('cli-2', t('cli.loggedIn'),
          cliInfo.loggedIn === true ? `✓ ${t('cli.loggedIn')}` : t('cli.notLoggedIn')))
        const cliModels = Array.isArray(cliInfo.models) ? cliInfo.models : []
        cliNodes.push(kv('cli-3', t('cli.models'),
          cliModels.length === 0 ? t('cli.noModels') : `${cliModels.length}：${cliModels.join(', ')}`, true))
      }
      cliNodes.push(h('div', { key: 'cli-bar', className: 'dsm-doubaowork-bar' },
        h('div', { className: 'dsm-doubaowork-bar-actions' },
          button('cli-refresh', refreshing ? t('action.refreshing') : t('action.refreshCli'), refreshCli, 'outline', refreshing))))
      modelsPanel.push(group('md-cli', t('group.cli'), cliNodes))

      /* ---- 面板四：账号（池 + 扫码登录 + 签到）---- */
      const accountsPanel = []

      // 扫码登录：只在 Host 提供了 login 能力时渲染（缺席给会失败的按钮更糟）
      const loginState = status?.login
      if (loginState !== null && loginState !== undefined) {
        const loggedIn = cliInfo?.loggedIn === true
        const loginNodes = [h('p', { key: 'login-desc', className: 'dsm-doubaowork-group-desc' }, t('login.desc'))]
        if (login.phase === 'waiting') {
          const left = Math.max(0, Math.ceil(((login.expiresAt ?? 0) - Date.now()) / 1000))
          loginNodes.push(h('div', { key: 'qr', className: 'dsm-doubaowork-qr' },
            h('img', {
              className: 'dsm-doubaowork-qr-img',
              src: login.imageDataUrl,
              alt: t('login.waiting').replace('%s', ''),
              width: 220,
              height: 220,
            }),
            h('p', { className: 'dsm-doubaowork-qr-wait' }, t('login.waiting').replace('%s', String(left)))))
          loginNodes.push(h('div', { key: 'qr-bar', className: 'dsm-doubaowork-bar' },
            h('div', { className: 'dsm-doubaowork-bar-actions' },
              button('qr-cancel', t('login.cancel'), () => { void cancelLogin() }, 'outline'))))
        } else if (login.phase === 'starting') {
          loginNodes.push(h('p', { key: 'qr-starting', className: 'dsm-doubaowork-hint' }, t('login.starting')))
        } else if (login.phase === 'success') {
          loginNodes.push(h('div', { key: 'qr-ok', className: 'dsm-doubaowork-bar' },
            h('span', { className: 'dsm-doubaowork-badge dsm-doubaowork-badge-ok' }, `✓ ${t('login.success')}`),
            h('div', { className: 'dsm-doubaowork-bar-actions' },
              button('qr-again', t('action.loginAgain'), () => { void startLogin() }, 'outline'))))
        } else {
          if (login.phase === 'error') {
            loginNodes.push(h('p', { key: 'qr-err', className: 'dsm-doubaowork-error' }, `${t('login.failed')}：${login.error}`))
          }
          loginNodes.push(h('div', { key: 'qr-bar', className: 'dsm-doubaowork-bar' },
            h('span', { className: 'dsm-doubaowork-bar-status' },
              loggedIn ? `${t('login.loggedIn')}（${t('action.loginAgain')}）` : t('login.notLoggedIn')),
            h('div', { className: 'dsm-doubaowork-bar-actions' },
              button('qr-start', loggedIn ? t('action.loginAgain') : t('action.login'), () => { void startLogin() }, 'primary'))))
        }
        accountsPanel.push(group('g-login', t('group.login'), loginNodes))
      }

      // 账号池健康
      const poolNodes = []
      const list = Array.isArray(status?.accounts) ? status.accounts : []
      if (list.length === 0) {
        poolNodes.push(h('p', { key: 'pool-empty', className: 'dsm-doubaowork-hint' }, statusError ? t('error.fetch') : t('accounts.empty')))
      } else {
        const rows = []
        for (const account of list) {
          const health = account.health === null || account.health === undefined
            ? t('accounts.health.unknown')
            : account.health.ok === true ? t('accounts.health.ok') : `${t('accounts.health.bad')} (HTTP ${account.health.status})`
          const dotClass = account.health === null || account.health === undefined
            ? '' : account.health.ok === true ? ' dsm-doubaowork-dot-ok' : ' dsm-doubaowork-dot-bad'
          rows.push(h('li', { key: `acct-${account.id}`, className: 'dsm-doubaowork-table-row' },
            h('span', { className: `dsm-doubaowork-dot${dotClass}` }),
            h('span', { className: 'dsm-doubaowork-table-name' }, `${account.label} (${account.id})`),
            h('span', { className: 'dsm-doubaowork-table-meta' }, `${account.enabled ? '' : '· '}${health}`)))
        }
        poolNodes.push(h('ul', { key: 'pool-table', className: 'dsm-doubaowork-table' }, ...rows))
        const lastRun = status?.lastRun ? new Date(status.lastRun).toLocaleString() : t('accounts.never')
        poolNodes.push(kv('pool-last', t('accounts.lastRun'), lastRun))
      }
      poolNodes.push(h('div', { key: 'pool-bar', className: 'dsm-doubaowork-bar' },
        h('div', { className: 'dsm-doubaowork-bar-actions' },
          button('pool-probe', probing ? t('action.checking') : t('action.checkNow'), probeNow, 'outline', probing))))
      accountsPanel.push(group('g-accounts', t('group.accounts'), poolNodes))

      // 每日自动签到
      const checkinNodes = []
      if (settingsScope !== undefined) {
        checkinNodes.push(h('div', { key: 'ck-fields', className: 'dsm-doubaowork-fields' },
          field('ck1', t('checkin.enabled'), select([
            ['off', t('checkin.enabled.off')],
            ['on', t('checkin.enabled.on')],
          ], value.checkinEnabled === true ? 'on' : 'off', next => setField('checkinEnabled', next === 'on'))),
          field('ck2', t('checkin.time'), h('input', {
            className: 'dsm-doubaowork-input',
            type: 'time',
            value: `${String(value.checkinHour ?? 8).padStart(2, '0')}:${String(value.checkinMinute ?? 10).padStart(2, '0')}`,
            onChange: event => {
              const [hour, minute] = String(event.target.value ?? '').split(':')
              const h2 = Number(hour)
              const m2 = Number(minute)
              if (Number.isInteger(h2) && h2 >= 0 && h2 <= 23) setField('checkinHour', h2)
              if (Number.isInteger(m2) && m2 >= 0 && m2 <= 59) setField('checkinMinute', m2)
            },
          }))))
      }

      const checkin = status?.checkin
      if (status === null || status === undefined) {
        checkinNodes.push(h('p', { key: 'ck-unknown', className: 'dsm-doubaowork-hint' }, statusError ? t('error.fetch') : t('cli.unknown')))
      } else if (checkin === undefined || checkin === null) {
        checkinNodes.push(h('p', { key: 'ck-unknown', className: 'dsm-doubaowork-hint' }, t('cli.unknown')))
      } else {
        checkinNodes.push(kv('ck3', t('checkin.next'),
          typeof checkin.nextRunAt === 'string' && checkin.nextRunAt !== ''
            ? new Date(checkin.nextRunAt).toLocaleString()
            : t('checkin.next.none')))
        checkinNodes.push(kv('ck4', t('checkin.last'),
          typeof checkin.lastRun === 'string' && checkin.lastRun !== ''
            ? `${new Date(checkin.lastRun).toLocaleString()}${checkin.lastDay ? `（${checkin.lastDay}）` : ''}`
            : t('checkin.last.none')))
        checkinNodes.push(kv('ck5', t('checkin.result'),
          `${t('checkin.result.value').replace('%s', String(checkin.signedCount ?? 0))}${Number(checkin.skipped ?? 0) > 0 ? `，${t('checkin.result.skipped').replace('%s', String(checkin.skipped))}` : ''}`))
        const perAccount = Array.isArray(checkin.accounts) ? checkin.accounts : []
        if (perAccount.length > 0) {
          const rows = []
          for (const entry of perAccount) {
            const state = entry.ok === true
              ? t('checkin.account.ok')
              : entry.ok === false
                ? `${t('checkin.account.fail')}${entry.code !== null && entry.code !== undefined && entry.code !== 0 ? `（业务码 ${entry.code}）` : ''}`
                : t('checkin.account.pending')
            const dotClass = entry.ok === true ? ' dsm-doubaowork-dot-ok' : entry.ok === false ? ' dsm-doubaowork-dot-bad' : ''
            rows.push(h('li', { key: `ck-${entry.id}`, className: 'dsm-doubaowork-table-row' },
              h('span', { className: `dsm-doubaowork-dot${dotClass}` }),
              h('span', { className: 'dsm-doubaowork-table-name' }, `${entry.id}：${state}`),
              h('span', { className: 'dsm-doubaowork-table-meta' }, entry.day ? String(entry.day) : '')))
          }
          checkinNodes.push(h('ul', { key: 'ck-table', className: 'dsm-doubaowork-table' }, ...rows))
        }
        checkinNodes.push(h('div', { key: 'ck-bar', className: 'dsm-doubaowork-bar' },
          h('div', { className: 'dsm-doubaowork-bar-actions' },
            button('ck-run', checkingIn ? t('action.checkingIn') : t('action.checkin'), checkinNow, 'outline', checkingIn))))
        checkinNodes.push(h('p', { key: 'ck-hint', className: 'dsm-doubaowork-hint' }, t('checkin.hint')))
      }
      accountsPanel.push(group('g-checkin', t('group.checkin'), checkinNodes))

      /* ---- 面板五：诊断（留痕 + 说明）---- */
      const diagnostics = []
      const traceNodes = []
      if (status === null || status === undefined) {
        traceNodes.push(h('p', { key: 'trace-unknown', className: 'dsm-doubaowork-hint' }, statusError ? t('error.fetch') : t('cli.unknown')))
      } else {
        const mode = String(status.conversationMode ?? 'single') === 'per-chat' ? 'perChat' : 'single'
        const bound = Number(status.conversations?.count ?? 0)
        const persisted = status.conversations?.persisted === true
        traceNodes.push(kv('trace-1', t('trace.mode'), t(`trace.mode.${mode}`), true))
        traceNodes.push(kv('trace-2', t('trace.bound'), t('trace.bound.value').replace('%s', String(bound))))
        traceNodes.push(kv('trace-3', t('trace.persisted'),
          persisted ? t('trace.persisted.yes').replace('%s', String(status.conversations?.file ?? '')) : t('trace.persisted.no'), true))
        traceNodes.push(h('p', { key: 'trace-hint', className: 'dsm-doubaowork-hint' }, t('trace.hint')))
      }
      diagnostics.push(group('g-trace', t('group.trace'), traceNodes))

      diagnostics.push(group('g-hints', t('group.hint'), [
        h('p', { key: 'hint-cli', className: 'dsm-doubaowork-hint' }, t('hint.cli')),
        h('p', { key: 'hint-keepalive', className: 'dsm-doubaowork-hint' }, t('hint.keepalive')),
      ]))

      /* ---- tab 栏 + 面板 + 底部保存条 ---- */
      const tabs = [
        ['overview', t('tab.overview')],
        ['gateway', t('tab.gateway')],
        ['models', t('tab.models')],
        ['accounts', t('tab.accounts')],
        ['diagnostics', t('tab.diagnostics')],
      ]
      const tabBar = h('div', { key: 'tabs', className: 'dsm-doubaowork-panels', role: 'tablist' },
        ...tabs.map(([id, label]) => h('button', {
          key: `tab-${id}`,
          type: 'button',
          role: 'tab',
          'aria-selected': tab === id,
          className: `dsm-doubaowork-panel-tab${tab === id ? ' dsm-doubaowork-panel-tab-active' : ''}`,
          onClick: () => setTab(id),
        }, label)))

      const saveBar = settingsScope === undefined ? null : h('div', { key: 'savebar', className: 'dsm-doubaowork-bar' },
        h('span', { className: 'dsm-doubaowork-bar-status' }, dirty ? t('hint.saveUnsaved') : ''),
        h('div', { className: 'dsm-doubaowork-bar-actions' },
          button('save', savedAt > 0 && !dirty ? t('action.saved') : t('action.save'), save, 'primary', !dirty)))

      return h('div', { className: 'dsm-doubaowork-card' },
        header,
        tabBar,
        panel('overview', overview),
        panel('gateway', gateway),
        panel('models', modelsPanel),
        panel('accounts', accountsPanel),
        panel('diagnostics', diagnostics),
        saveBar)
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

        /**
         * 绑定 Host 的配置表单服务。
         *
         * 两个坑都在这里踩过：
         *  1. 只 `ctx.get('configForms')` 探一次。Host 的 configForms 是客户端
         *     插件注册的服务，卡片 apply 时它未必已就绪——拿到 undefined 就再也
         *     不重试，于是「网关选项」「上游后端」两块只剩标题、没有任何输入框
         *     （settingsScope 恒为 undefined，走的是只读降级分支）。
         *  2. 即便拿到服务，命名空间也要等 Host 真正开始 serve 才可读；渲染器按
         *     entry 对象身份缓存 inject 结果，所以晚绑定时必须**先卸载旧注册再
         *     重新注册**，否则页面停在首帧的只读形态。
         *
         * 因此：先用 `ctx.inject(['configForms'], …)` 等这个服务本身出现，再用
         * `whileServed` 跟随命名空间的 served 边沿；两者都就绪前保持只读降级，
         * 让卡片至少能显示状态与按钮。
         */
        const bindForms = (forms) => {
          if (forms === undefined || typeof forms.whileServed !== 'function') {
            // 老宿主（0.1.5 线）只有 settingsScope，没有 configForms
            const legacy = forms?.get?.(NS_CANDIDATES[0]) ?? ctx.get?.('settingsScope')
            if (legacy !== undefined) settingsScope = legacy
            rebind()
            return
          }
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
        }

        const inlineForms = ctx.get?.('configForms')
        if (inlineForms !== undefined) {
          bindForms(inlineForms)
        } else {
          // 服务尚未出现：先按只读形态渲染（卡片至少可用），等它就绪后重建插槽
          rebind()
          if (typeof ctx.inject === 'function') {
            ctx.inject(['configForms'], formsCtx => {
              bindForms(formsCtx?.configForms ?? formsCtx?.get?.('configForms'))
            })
          }
        }
      } catch (error) {
        console.error('[dsh-connect-doubaowork] client card failed to load (host provider unaffected):', error)
      }
    }

    const exports = { name: 'dsh-connect-doubaowork-client', inject: ['slots', 'locale'], apply }
    return exports
  },
})
