# dsh-connect-doubaowork

豆包「工作模式」版 DSH 连接插件——把豆包 Web 端工作模式（agent mode）聚合的模型接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，在 DSH 里直接使用豆包、DeepSeek、Kimi、GLM 系列模型。

插件在本机拉起一个 OpenAI 兼容的回环网关（127.0.0.1 随机端口 + 进程内随机 bearer token），DSH 宿主的模型请求走这个网关，再由插件转发到豆包。转发有两条后端路线，可在设置卡片切换：

| 后端 | 登录态来源 | 特点 |
| --- | --- | --- |
| `cli` | 官方豆包 CLI（`doubao login` 扫码一次） | 复用官方 CLI 的长期登录态，不依赖桌面端 cookie；自带工具执行与本地文件能力；支持 CLI 独有的新模型 |
| `http` | 桌面端 cookie（`sessionid`） | 零额外安装，但 cookie 约 30 天过期，且受风控影响 |

`backend` 默认 `auto`：CLI 已安装且已登录时优先走 CLI，否则自动回落 HTTP。两条路线共用同一份模型目录与同一套 DSH provider 注册，切换后端不影响调用方。

## 工作原理

```
                                    ┌── http 后端 ──▶ https://www.doubao.com/chat/completion
DSH 宿主 ──pi-ai──▶ 本地回环网关 ──┤   （构造工作模式请求体 + 解析 SSE 事件流）
                    /v1/chat/completions
                                    └── cli 后端 ───▶ doubao -p … --output-format stream-json
                                        （子进程 + 逐行 NDJSON 解析）
```

| 文件 | 职责 |
| --- | --- |
| `index.js` | 插件入口：先启动网关，再动态装配宿主包并注册 provider |
| `shim.js` | OpenAI 兼容网关（流式 SSE / 非流式 JSON），管理会话复用与超时，按 `backend` 分发到两条后端 |
| `cli-backend.js` | 豆包 CLI 子进程桥：NDJSON 事件解析、串行任务队列、探测与模型清单 |
| `doubao-protocol.js` | 工作模式请求体构造与 SSE 事件泵（正文增量 / 思考标题 / 会话 ack / 收尾） |
| `adapter.js` | `createProvider` + `openAICompletionsApi` + `PiAiAdapter` 装配 |
| `catalog.js` | 模型目录（静态 10 个 + CLI 动态清单合并，含别名） |
| `credentials.js` | 豆包登录态加载（手动导入 / 桌面端自动发现） |
| `login.js` | 扫码登录：拉起 `doubao login --qr=png`、读二维码 PNG 转 data URL、轮询登录态、取消与进程回收 |
| `onboarding.js` | 首次使用引导：探测接入方式、生成修复步骤（只读、无凭据输出） |
| `config.js` | 配置 schema 与默认常量 |
| `plugin.js` | 宿主注册编排（adapter → 目录 → discovery，含失败回收） |

## 支持的模型

| 模型 ID | 别名 | 说明 |
| --- | --- | --- |
| `auto` | — | 自动选择 |
| `doubao-2.1-lite` | — | 豆包 2.1 Lite |
| `doubao-2.1-pro` | — | 豆包 2.1 Pro |
| `deepseek-v4-flash` | `doubao`、`deepseek` | 默认模型 |
| `deepseek-v4-pro` | — | DeepSeek V4 Pro |
| `kimi-k3` | — | Kimi K3 |
| `kimi-k3.1-pro` | — | Kimi K3.1 Pro |
| `kimi-k3.1-pro-fast` | — | Kimi K3.1 Pro 快速版 |
| `glm-5.3` | — | GLM 5.3 |
| `glm-5.3-flash` | — | GLM 5.3 Flash |

`enabledModelIds` 留空表示全部启用；填入的 ID 全部无法识别时回落为全部，避免出现空路由。

上表是 HTTP 后端的静态兜底目录。CLI 后端登录后会执行 `doubao model list --json` 拉取真实清单，并**按当前生效后端二选一**呈现：

- **HTTP 后端生效**：模型清单就是上表 10 项（不发 `doubao model list`）。
- **CLI 后端生效**：模型清单是 CLI 实报的模型。能对上的条目复用上表的友好 ID 与元信息（例如 CLI 的 `person-deepseek-v4-1-flash-261017` 显示为 `deepseek-v4-flash`，`ratio`/上下文窗口沿用静态表），CLI 独有的新模型按 CLI 原样追加（`cliOnly`，只有 CLI 后端能路由）。未登录或拉取失败时回落上表，不会出现空路由。

**CLI 后端会把友好 ID 翻译成上游 ID 再传给 `--model`**：`doubao` 只认 `doubao model list` 报的 `person-*`/数字 ID，直传 `deepseek-v4-flash` 会报「`--model` 参数非法：不支持此模型」。翻译由 `catalog.js` 的 `upstreamId(entry, 'cli')` 完成（0.5.1 修）。`auto` 不传 `--model`，交给 CLI 自己的默认模型。

也就是说：**同一个模型不会在模型选择器里出现两次**——之前 0.4.x 把两套清单合并成一份（静态 10 项 + CLI 13 项 = 23 项，其中 10 项语义重复），0.5.0 起改成二选一。默认模型也跟着后端走：CLI 后端取 CLI 标 `is_default` 的那个（反查回友好 ID），HTTP 后端用 `deepseek-v4-flash`。


## 安装

需要 DSH 0.1.7 及以上（`engines` 要求 Node `^22.19.0 || >=24.0.0`）。

**从 GitHub 安装（推荐）**

```sh
dsh plugin --profile <你的 profile> add github:Joseph2Young/dsh-connect-doubaowork
```

DSH 桌面端请在 **设置 → 插件** 里填入同一来源安装。装完刷新页面或重启一次宿主即可在模型选择器里看到豆包系列模型。

**从本地目录安装（开发调试用）**

```sh
cd ~/.dsh/profiles/<你的 profile>
pnpm add file:/绝对路径/dsh-connect-doubaowork
```

改了源码要重新同步时，**必须 `remove` 再 `add`**：pnpm 对 `file:` 依赖是实体拷贝而非软链，直接 `add` 会报 “Already up to date” 而不更新文件。

```sh
pnpm remove dsh-connect-doubaowork && pnpm add file:/绝对路径/dsh-connect-doubaowork
```

> 注意：请用 `file:` 而不是 `link:`。本插件把 `@deepseek-ai/*`、`@earendil-works/pi-ai` 声明为 peerDependencies，`link:` 建立的软链不会从目标目录解析 peer 包，会导致宿主加载失败。

## 首次使用引导

插件装好后**第一次启动**会自检这台机器上有没有可用的豆包接入方式，结果同时出现在三处：

1. **宿主日志**——两者都不可用时打 warn，并把完整的修复步骤贴进去（含可直接复制的命令）；
2. **设置 → 插件 → 豆包工作模式** 卡片顶部「首次使用引导」区块——三步状态灯 + 每步的修复命令；
3. **`GET /plugins/dsh-connect-doubaowork/status`** 的 `setup` 字段（供脚本消费）。

检查的三步：

| 步骤 | 说明 |
| --- | --- |
| 豆包登录态（HTTP 后端） | 凭据文件是否存在、能否解析、是否含 `sessionid`、账号数；权限过宽（如 644）会提示 `chmod 600`；账号若来自**豆包桌面端自动发现**（无凭据文件）会明确标注来源，不会静默读取 |
| 豆包 CLI（推荐） | `doubao` 命令是否可用、版本号、是否已登录 |
| 可用接入方式 | 至少一条通才算就绪；都不通时明确告知「模型调用会返回 503」 |

**没装 CLI 时，引导会直接给出这两条命令：**

```sh
npm i -g @bytedance/doubao-cli
doubao login            # 扫码一次，登录态长期有效
```

装完点卡片上的「重新检查接入方式」，或重启 DSH，`backend: auto` 会自动从 HTTP 切到 CLI。

**不想开终端？** 装好 CLI 后，卡片上的「扫码登录豆包 CLI」区块可以直接出二维码——见下节。

引导只做只读探测（读凭据文件形状、拉两个 CLI 子进程），**不写任何文件、不改配置、不采集也不上报任何机器信息**。

## 豆包 CLI 后端（推荐）

官方 CLI 提供单次任务模式与逐行 JSON 输出，插件把它当作一条与 HTTP 抓包并列的上游后端：

```sh
npm i -g @bytedance/doubao-cli   # 安装（postinstall 会下载平台原生包）
doubao login                      # 扫码登录一次，登录态长期有效
doubao model list                 # 可选：确认能列出模型
```

装好并登录后，插件在 `backend: "auto"`（默认）下会自动切到 CLI 后端——不需要改任何配置。也可以在设置卡片里显式选 `cli` 或 `http`。

**它怎么工作**：每次 DSH 请求，插件拉起一次 `doubao -C <工作目录> -p <提示词> --output-format stream-json [--model <ID>] [--effort <档位>] [--resume <会话ID>]`，逐行解析 NDJSON 事件（`system.init` / `stream_event` 文本增量 / `assistant` 全量 / `result` 收尾）并转成 OpenAI SSE。多个请求通过内部队列串行化（CLI 是单账号共享后台，并发实例容易撞实例锁）。

**会话复用**：首轮把 DSH 的历史消息压平成一段文本，同时记下 CLI 返回的 `session_id`；后续轮次用 `--resume <session_id>` 续接，只发最后一条 user 文本——所以豆包侧的上下文由 CLI 自己维护，不会每轮重建。
`conversationMode: "single"` 下所有 DSH 会话共用一条 CLI 会话；`per-chat` 下每个 DSH 会话各自绑定一条。

**边界**：
- CLI 只支持 macOS ARM64 / Windows x64 / Linux x64；不支持的平台请用 `http` 后端或 `auto`（会自然回落）；
- CLI 走自己的 passport 登录体系，**不复用**桌面端 cookie，所以两条路线各需各自的登录；
- CLI 自带的工具执行/本地文件能力目前只记日志（不作为 OpenAI `tool_calls` 回给宿主），权限由 `cliPermissionMode` 控制；oneshot 模式下遇到需要审批的交互会被自动拒绝并继续，拒绝详情记录在日志里；
- 首次消息上限 262144 字符（CLI 侧限制），超长历史需靠 `flattenHistory` 压缩。

## 在设置界面里扫码登录（无需终端）

设置 → 插件 → 豆包工作模式 → **扫码登录豆包 CLI** 区块，点「扫码登录」即在卡片里显示二维码：

1. 点「扫码登录」——Host 在后台拉起 `doubao login --qr=png`，读回它生成的临时 PNG，转成 data URL 回给卡片；
2. 用豆包手机 App 扫描卡片里的二维码并在手机上确认；
3. 卡片每 1.5 秒轮询一次登录结果，成功后自动刷新「豆包 CLI」与「首次使用引导」两个区块，CLI 后端立刻可用；
4. 二维码约 5 分钟过期，过期或想换账号点「重新扫码登录」；点「取消」会立刻杀掉后台的登录进程。

**几个实现上的取舍**（都对使用者可见，所以写在这里）：

- 卡片里显示的是**图片字节**（`data:image/png;base64,...`），不是文件路径，也不发起任何外部图片请求；返回前会校验 PNG 魔数，非 PNG 文件一律不当作二维码回传，避免把任意文件读成图片。
- 判定「登录成功」用 `doubao auth status` 的返回值，而不是去解析登录进程的输出文案——后者的措辞在不同 CLI 版本里会变，而 `auth status` 是稳定契约。
- 豆包 CLI 有**单实例锁**：如果终端里已经有一次 `doubao login` 在等待，卡片这边会立刻收到「已有登录正在进行」，而不是静默卡住。同理，重复点「扫码登录」会复用同一个二维码，不会开第二个进程。
- 插件卸载或重载时会先取消进行中的扫码登录，避免留下孤儿 `doubao login` 进程——孤儿进程会让后续所有登录都撞锁失败。
- 三种路由（`/login/start`、`/login/poll`、`/login/cancel`）与其它插件路由一样**只接受 loopback 来源**，并且只做 POST。
- 插件**不读取、不存储**任何凭据：二维码是 CLI 自己生成的一次性图片，登录态由 CLI 保存在它自己的目录里。

## 凭据配置

HTTP 后端需要豆包登录态；如果只用 CLI 后端（`backend: "cli"`）可以跳过本节。插件不做扫码或抓包，两种方式提供登录态。

### 方式一（推荐）：手动导入 Cookie

1. 浏览器打开 `https://www.doubao.com` 并登录，F12 → Network 复制请求头里的完整 `Cookie`；
2. 写入 `~/.dsh-doubao/credentials.json`（建议目录 `chmod 700`、文件 `chmod 600`）：

```json
{
  "cookie": "sessionid=xxxx; sessionid_ss=xxxx; ttwid=...; odin_tt=...; ...",
  "device_id": "可选，缺省时由 cookie 哈希派生",
  "web_id": "可选",
  "tea_uuid": "可选",
  "local_app_id": "582478"
}
```

`cookie` 必须包含 `sessionid=`。Cookie 约 30 天过期，过期后重新复制即可。

可用环境变量 `DSH_DOUBAO_CREDENTIALS_FILE` 指定其它路径。

### 方式二（实验性，仅 macOS）：自动发现桌面端登录态

`autoDiscoverCredentials`（默认开启）在没有凭据文件时读取豆包桌面端的
`~/Library/Application Support/Doubao/Local State`，从 `x-tt-multi-sids` 提取 `sessionid`，并从 `aha.device` 读取设备标识。

该方式拿不到 `ttwid` 等设备 Cookie，豆包风控可能拒绝；失败时请回到方式一。Windows / Linux 请使用方式一。

## 配置项

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabledModelIds` | `[]` | 启用的模型 ID，空 = 全部 |
| `workMode` | `true` | 使用豆包工作模式（`agent_mode=1` / `mode_id=3`） |
| `reasoningEffort` | `"4"` | 工作模式思考强度，0–4 |
| `autoDiscoverCredentials` | `true` | 无凭据文件时自动发现桌面端登录态（实验性） |
| `credentialsFile` | `""` | 凭据 JSON 路径，空 = 默认路径 |
| `chatUrl` | 豆包工作模式端点 | 上游地址 |
| `userAgent` | 桌面端 UA | 上游 User-Agent |
| `timeoutSeconds` | `300` | 上游请求超时 |
| `heartbeatSeconds` | `15` | SSE 心跳间隔，`0` = 关闭 |
| `flattenHistory` | `true` | 首轮把历史消息压平为一段 |
| `conversationMode` | `"single"` | 豆包侧会话归属：`single` = 全部复用同一条豆包会话（默认）；`per-chat` = 每个 DSH 会话一条豆包记录 |
| `account` | 空 | 主账号快捷配置（`cookie` / `deviceId` / `webId`），优先级低于凭据文件 |
| `poolEnabled` | `false` | 账号池故障转移：当前账号上游失败时自动换下一个账号重试（多账号时生效） |
| `keepaliveEnabled` | `false` | 每日保活巡检：定时检查各账号 Cookie 是否仍被豆包接受（见下文） |
| `backend` | `"auto"` | 上游后端：`auto`（CLI 可用且已登录就优先 CLI）/ `cli`（只用 CLI）/ `http`（只用 HTTP 抓包） |
| `cliPath` | `""` | `doubao` 可执行文件路径，空 = 自动探测 npm 全局 bin、`~/.local/bin`、Homebrew、`PATH` |
| `cliWorkspace` | `""` | CLI 任务工作目录（`-C`），空 = 用户主目录 |
| `cliPermissionMode` | `"ask_risky"` | CLI 权限模式：`ask_always` / `ask_risky` / `always_allow` |
| `cliConcurrency` | `1` | CLI 并发任务上限（CLI 是单账号共享后台，建议保持 1） |
| `cliEffort` | `""` | CLI 推理强度：`none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`，空 = 模型默认 |

## 设置界面

插件自带 DSH Web GUI 设置卡片（`dsh.client` 注入，无需构建）：在 **DSH 设置 → 插件 → 豆包工作模式** 中可读写网关选项（会话归属、工作模式、思考强度、超时等）、查看账号池健康状态、手动触发保活巡检。卡片另有一块「上游后端 / 豆包 CLI」区域：可切换 `backend`、填写 `cliPath` 与工作目录、选择 CLI 权限模式与推理强度，并显示 CLI 的安装/登录状态与拉到的模型清单，提供「重新探测 CLI」按钮（`POST /plugins/dsh-connect-doubaowork/cli/refresh`）。

卡片顶部还有「首次使用引导」区块（见上文），显示三步状态灯与修复命令，并提供「重新检查接入方式」按钮（`POST /plugins/dsh-connect-doubaowork/setup`）。

卡片对配置采用「草稿-保存」模式：改动先落在草稿，点「保存设置」才写回；健康状态为只读测量值（由巡检写入 `~/.dsh-doubao/pool-state.json`）。老版本宿主不提供设置插槽时，卡片自动降级或隐藏，不影响网关本体。

卡片上的区块顺序：首次使用引导 → 网关选项 → **当前生效（只读）** → 豆包 CLI（安装态/登录态/模型清单）→ **扫码登录** → 账号池 → 说明。

「当前生效」区块直接显示 `status.effectiveBackend` 与 `status.models`：宿主侧按生效后端选好一份清单，卡片只展示这一份，所以你在 CLI 后端看到的模型列表与 HTTP 后端看到的不会混。改 `backend` 下拉框并保存后，该区块无需重启就跟着变（volatile 字段就地更新）。

## 设置 → 模型页里的豆包行

0.5.0 起，`doubao` provider 会作为一行出现在 **DSH 设置 → 模型** 页（和 WorkBuddy 一样），前提是插件的 Config schema 至少有一个 `.volatile()` 字段——宿主 `dsh-settings` 的 `describe()` 会跳过没有 volatile 字段的插件条目，而模型页又要靠 `namespaces.has(settingsNs)` 才渲染行。`config.js` 里的 `VOLATILE_FIELDS` 就是这个开关，改动它请配套改 `tests/config.test.js`。

模型页那一行的编辑卡片对我们只显示一行提示（`ProviderEditor` 只对 `llm-deepseek` / `llm-pi-ai` 两个命名空间渲染完整表单），**这不是缺陷**：豆包的配置入口是本插件的设置卡片。


## 账号池与保活巡检

**多账号**：在 `~/.dsh-doubao/credentials.json` 里用 `accounts` 数组放置多个账号（也兼容旧的单账号形状）：

```json
{
  "accounts": [
    { "id": "a1", "label": "主号", "cookie": "sessionid=…; sid_tt=…;", "device_id": "…", "web_id": "…" },
    { "id": "a2", "label": "备号", "cookie": "sessionid=…; sid_tt=…;" }
  ]
}
```

- **粘性轮换**：新会话默认从上一次成功的账号开始（`lastGoodId` 粘性锚点），避免每次都撞失效账号；
- **故障转移**：`poolEnabled: true` 且多账号时，当前账号在「上游请求失败 / HTTP 非 2xx」阶段自动换下一个账号重试（流式响应已开始后不再换号——响应头已发出无法回退）；成功账号被记住，后续请求优先；
- **会话与账号绑定**：豆包 `conversation_id` 是账号作用域的，会话换账号时会自动重新建会话，不会把 A 账号的会话 id 发给 B 账号。

**每日保活巡检**（对应 workbuddy 的自动签到）：豆包没有「签到」概念，落地为等价的**保活巡检**——每日固定时刻（默认 08:30）用每个账号的 Cookie 向豆包首页发起一次只读探测（`redirect: manual`，不产生会话记录），结果写入 `~/.dsh-doubao/pool-state.json` 并可在设置卡片查看。注意这是弱验证：它只能发现「Cookie 被服务端拒绝」，不能确认账号额度仍然可用；默认关闭（`keepaliveEnabled: true` 开启），设置卡片可手动「立即巡检」。

## 关于豆包侧的会话记录

工作模式端点就是豆包客户端聊天走的同一个服务端接口，因此在 DSH 里的对话会落在豆包账号的会话列表里——这是免费额度路线的固有行为，插件无法关闭服务端留痕（运行时并不启动或驱动豆包客户端）。

插件默认 `conversationMode: "single"`：所有 DSH 请求复用同一条豆包会话，客户端里只出现一条记录。会话锚定用的是「首条 user 消息」而非首条消息本身——pi-ai 对不支持会话中 system 的模型会在第二轮起移除首条 system，若按首条消息哈希会键漂移、每个 agent 轮次新建一条豆包窗口。

可以进一步调整：

- 设 `conversationMode: "per-chat"`：每个 DSH 会话对应一条豆包记录（按会话隔离历史）；
- 在豆包桌面端登录一个次要账号（或在 `credentials.json` 里填次要账号的 Cookie），主账号的客户端保持干净。

## 豆包反问如何回到 DSH

豆包工作模式是带交互的 agent 服务：信息不足时它不会硬答，而是发出反问（`interaction_ask_block`），并保持连接等待回答。插件对此做了双向闭环：

1. **反问转回 DSH**：插件识别反问块，把问题正文（`❓` 前缀）作为本轮回复流回 DSH，并立即结束本轮（服务端此时不发结束帧、可等待数十分钟，插件主动断开避免调用方挂到超时）；
2. **回答送回豆包**：你在 DSH 里的下一条回复会被送进**同一条豆包会话**（复用 `conversation_id`），豆包 agent 拿到补充信息后继续执行原任务。

因此：**所有回答都请在 DSH 里进行**。豆包客户端里那条会话只是服务端账本；在豆包 App 里输入的回答对 DSH 不可见（插件是 DSH→豆包的单向拉取桥，不轮询豆包侧输入）。

## 常见问题

- **401 / 模型列表为空**：先检查 `~/.dsh-doubao/credentials.json` 是否存在且含 `sessionid=`。
- **模型选择器里看不到豆包模型**：宿主需要重新组合 bundle，刷新页面或重启一次 DSH。
- **回复被风控中断**：多为 Cookie 缺设备字段，改用手动导入的完整 Cookie。
- **豆包回复以 `❓` 提问结尾**：这是工作模式的正常反问，在 DSH 里直接回答即可，回答会送回同一豆包会话继续执行（见上文「豆包反问如何回到 DSH」）。
- **账号池没有切换**：确认 `poolEnabled: true` 且凭据文件里有多个有效账号（含 `sessionid=`）；流式响应已经开始后不会换号。
- **`auto` 模式下怎么知道现在走的是哪条后端？** 宿主日志里启动那一行会写「后端：cli」或「后端：http」；设置卡片的「豆包 CLI」区域也会显示安装/登录状态。`backend: "cli"` 时即使 CLI 未登录也会尝试 CLI（错误信息原样透传，便于定位），不会静默回落。
- **CLI 报 `login_required`？** 执行 `doubao login` 扫码一次。登录态保存在 `~/Library/Application Support/doubao_cli/doubao-cli-pc-login/`（macOS），与桌面端 cookie 无关。
- **插件找不到 `doubao`？** 自动探测顺序是 npm 全局 bin → `~/.local/bin` → `/opt/homebrew/bin` → `/usr/local/bin` → `PATH`。都不命中时在配置里填 `cliPath` 绝对路径。
- **卡片上所有区块都显示「状态读取失败（主进程路由不可用）」？**

插件自己的 HTTP 路由没挂上。0.4.0 及更早版本用 `ctx.get('webServer')` 做一次性同步探测：宿主启动时 `webServer` 服务若还没就绪，插件会拿到 `undefined` 并静默跳过注册——日志里那条「网关已就绪」照常打，所以从日志看不出问题。0.4.1 起改用 `ctx.inject(['webServer'], …)` 响应式挂载，启动顺序不再影响注册。升级后重启 DSH 即可。

**卡片里「网关选项」「上游后端」只有标题、没有下拉框和输入框？**

同一类问题的客户端版本：卡片用 `ctx.get('configForms')` 同步探一次宿主表单服务，服务没就绪就一直走只读降级分支。0.4.3 起改为 `ctx.inject(['configForms'], …)` 等待服务出现，晚到后重建插槽（渲染器按 entry 身份缓存 `inject()` 结果，不重建就永远停在首帧）。

- **设置 → 模型页里没有「豆包工作模式」这一行？** 0.5.0 起已修复。根因是插件 Config schema 里没有 `.volatile()` 字段，宿主 `dsh-settings` 的 `describe()` 会直接跳过这类插件条目，模型页据此判定「没有 settings 命名空间」而不渲染行。现在 `config.js` 的 `VOLATILE_FIELDS` 里 17 个字段都带 `.volatile()`。升级后重启 DSH 生效。

- **模型选择器里同一个模型出现两次（CLI 的 `person-*` 和友好名各一条）？** 0.4.x 把静态表与 CLI 清单合并成一份（23 项，其中 10 项语义重复）。0.5.0 起改为按当前生效后端**二选一**：CLI 后端只列 CLI 实报的模型（能对上静态表的复用友好 ID），HTTP 后端只列静态表。切换 `backend` 保存后立即生效，无需重启。

- **模型页里豆包那一行的编辑卡片只有一行灰色提示、Apply 按钮禁用？** 宿主 `ProviderEditor` 只对 `llm-deepseek` / `llm-pi-ai` 这两个命名空间渲染完整表单，其它命名空间一律显示 `advancedHint` 并禁用提交。这是宿主的设计边界，不是插件缺陷；豆包的配置入口是本插件的设置卡片。

## 隐私与数据流向

本插件**不含任何个人身份信息、硬编码凭据、遥测或自动上报**。所有出站流量只有两个目标：

| 目标 | 何时 | 内容 |
| --- | --- | --- |
| `https://www.doubao.com/chat/completion` | 使用 HTTP 后端时 | 你的对话内容 + Cookie（本地读取，不写日志） |
| 本机 `doubao` 子进程 | 使用 CLI 后端时 | 你的对话内容（经 stdin/argv 传给 CLI，由 CLI 自己联网） |

本地读取（只读，限于取得登录态）：

- `~/.dsh-doubao/credentials.json`——你自己写的 Cookie 文件（建议 `chmod 600`）
- `~/Library/Application Support/Doubao/Local State`——**可选**，仅当凭据文件不存在且开启 `autoDiscoverCredentials` 时，用于从豆包桌面端发现登录态
- `~/Library/Application Support/doubao_cli/`——`doubao` CLI 自己的登录态（由 CLI 管理，插件不解析）

本插件会写的文件（都在用户目录，不进仓库）：

- `~/.dsh-doubao/pool-state.json`——账号探测结果（只有 HTTP 状态码、时间戳、账号 id，**不含 Cookie**）

日志脱敏约定：插件在任何日志、错误信息、引导输出里**都不打印 Cookie、token、device_id 的实际取值**；引导只报告「有无 / 能否解析 / 账号数」这类形状信息，并有专门的回归用例（`tests/onboarding.test.js` 的「summary 不含任何凭据内容」）守护。

## 隐私与扫码登录

扫码登录这条链路涉及的数据只有两样，都在本机：

| 数据 | 位置 | 生命周期 |
| --- | --- | --- |
| 二维码 PNG | CLI 自己生成的临时文件（`$TMPDIR/org.chromium.Chromium.scoped_dir.*/qrcode.png`） | 登录进程退出后由系统清理 |
| 二维码图片字节 | Host 内存 → 设置卡片 `<img src="data:...">` | 登录成功后卡片清空，不落盘、不写日志 |

插件不读 CLI 的登录态文件（`~/Library/Application Support/doubao_cli/doubao-cli-pc-login/`），只调用 `doubao auth status` 拿一个布尔值。

## 测试

```sh
node --test "tests/*.test.js"
```

170 个用例，覆盖协议解析、网关、账号池、保活巡检、CLI 后端（NDJSON 事件、串行队列、探测、超时/取消）、扫码登录、插件路由、模型目录二选一与设置卡片渲染。

- CLI 与登录相关用例全部用假子进程（`EventEmitter` + `Readable`）驱动，不依赖本机是否装了豆包 CLI；
- `tests/onboarding.test.js`（14 例）覆盖首次引导的三态与隐私回归；
- `tests/login.test.js`（18 例）覆盖二维码解析、conflict/不可用/未安装三种失败、文件晚落盘重试、单实例复用、过期与取消、**伪造 PNG 不被当图片回传**；
- `tests/routes.test.js`（17 例）覆盖方法闸、loopback 闸、能力缺席不注册、poll 读 body、卸载回收，以及**启动顺序回归**（webServer 晚于插件就绪、插件先卸载而挂载晚到）；
- `tests/client.test.js` 用带 hooks 槽位的假 react 真正驱动卡片重渲染（含引导区块、登录区块与「当前生效」区块）；
- `tests/plugin-adapter.test.js`（8 例）含 `bindSettingsNamespace()` 的四条路径（响应式 inject / 老宿主同步探测 / settings 缺席 / 缺 configure）；
- `tests/config.test.js`（10 例）守护 `VOLATILE_FIELDS`：17 个字段必须真的调用 `.volatile()`，`account`/`chatUrl`/`userAgent` 必须不是 volatile。

纯 ESM JavaScript，零构建、零运行时依赖（仅 Node 内置模块 + 宿主 peer 包）。

## License

MIT
