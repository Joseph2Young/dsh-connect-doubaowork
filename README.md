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

上表是静态兜底目录。CLI 后端登录后会自动执行 `doubao model list --json` 拉取真实清单并与静态表合并：同名条目用 CLI 的显示名覆盖（保留静态表的上下文窗口等元信息），CLI 独有的新模型追加为 `cliOnly` 条目（只有 CLI 后端能路由，HTTP 后端没有对应的 `model_item_key`）。未登录或拉取失败时静默回落静态表，不会掉模型。

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

> 注意：请用 `file:` 而不是 `link:`。本插件把 `@deepseek-ai/*`、`@earendil-works/pi-ai` 声明为 peerDependencies，`link:` 建立的软链不会从目标目录解析 peer 包，会导致宿主加载失败。

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

卡片对配置采用「草稿-保存」模式：改动先落在草稿，点「保存设置」才写回；健康状态为只读测量值（由巡检写入 `~/.dsh-doubao/pool-state.json`）。老版本宿主不提供设置插槽时，卡片自动降级或隐藏，不影响网关本体。

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

## 测试

```sh
node --test "tests/*.test.js"
```

97 个用例，覆盖协议解析、网关、账号池、保活巡检、CLI 后端（NDJSON 事件、串行队列、探测、超时/取消）、目录合并与设置卡片渲染。CLI 相关用例全部用假子进程（`EventEmitter` + `Readable`）驱动，不依赖本机是否装了豆包 CLI。

纯 ESM JavaScript，零构建、零运行时依赖（仅 Node 内置模块 + 宿主 peer 包）。

## License

MIT
