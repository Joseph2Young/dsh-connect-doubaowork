# dsh-connect-doubaowork

豆包「工作模式」版 DSH 连接插件——把豆包 Web 端工作模式（agent mode）聚合的模型接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，在 DSH 里直接使用豆包、DeepSeek、Kimi、GLM 系列模型。

插件在本机拉起一个 OpenAI 兼容的回环网关（127.0.0.1 随机端口 + 进程内随机 bearer token），DSH 宿主的模型请求走这个网关，由插件复刻豆包工作模式的请求体与 SSE 事件流，转发到豆包的聊天补全端点。

## 工作原理

```
DSH 宿主 ──pi-ai(openai-completions)──▶ 本地回环网关 (/v1/chat/completions)
                                            │ 构造工作模式请求体 + 解析 SSE 事件流
                                            ▼
                              https://www.doubao.com/chat/completion
```

| 文件 | 职责 |
| --- | --- |
| `index.js` | 插件入口：先启动网关，再动态装配宿主包并注册 provider |
| `shim.js` | OpenAI 兼容网关（流式 SSE / 非流式 JSON），管理会话复用与超时 |
| `doubao-protocol.js` | 工作模式请求体构造与 SSE 事件泵（正文增量 / 思考标题 / 会话 ack / 收尾） |
| `adapter.js` | `createProvider` + `openAICompletionsApi` + `PiAiAdapter` 装配 |
| `catalog.js` | 模型目录（10 个，含别名） |
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

## 凭据配置

插件不做扫码或抓包，两种方式提供豆包登录态。

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

## 设置界面

插件自带 DSH Web GUI 设置卡片（`dsh.client` 注入，无需构建）：在 **DSH 设置 → 插件 → 豆包工作模式** 中可读写网关选项（会话归属、工作模式、思考强度、超时等）、查看账号池健康状态、手动触发保活巡检。卡片对配置采用「草稿-保存」模式：改动先落在草稿，点「保存设置」才写回；健康状态为只读测量值（由巡检写入 `~/.dsh-doubao/pool-state.json`）。老版本宿主不提供设置插槽时，卡片自动降级或隐藏，不影响网关本体。

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

## 测试

```sh
node --test "tests/*.test.js"
```

纯 ESM JavaScript，零构建、零运行时依赖（仅 Node 内置模块 + 宿主 peer 包）。

## License

MIT
