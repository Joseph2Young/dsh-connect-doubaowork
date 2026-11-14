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
| `conversationMode` | `"per-chat"` | 豆包侧会话归属：`per-chat` = 每个 DSH 会话一条豆包记录；`single` = 全部复用同一条豆包会话 |

## 关于豆包侧的会话记录

工作模式端点就是豆包客户端聊天走的同一个服务端接口，因此在 DSH 里的每段对话都会落在豆包账号的会话列表里——这是免费额度路线的固有行为，插件无法关闭服务端留痕（运行时并不启动或驱动豆包客户端）。

可以缓解：

- 设 `conversationMode: "single"`：所有 DSH 请求复用同一条豆包会话，客户端里只出现一条记录，不再每会话新增一条；
- 在豆包桌面端登录一个次要账号（或在 `credentials.json` 里填次要账号的 Cookie），主账号的客户端保持干净。

## 常见问题

- **401 / 模型列表为空**：先检查 `~/.dsh-doubao/credentials.json` 是否存在且含 `sessionid=`。
- **模型选择器里看不到豆包模型**：宿主需要重新组合 bundle，刷新页面或重启一次 DSH。
- **回复被风控中断**：多为 Cookie 缺设备字段，改用手动导入的完整 Cookie。

## 测试

```sh
node --test "tests/*.test.js"
```

纯 ESM JavaScript，零构建、零运行时依赖（仅 Node 内置模块 + 宿主 peer 包）。

## License

MIT
