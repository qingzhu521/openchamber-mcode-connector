# OpenChamber Mcode — 计划

> 状态：计划已定稿，按此执行。本文先于代码写成（用户要求：先计划，再动手）。

## 1. 目标

模仿 `openchamber-pi`（相邻目录 `../openchamber-pi`），做一个 **openchamber-mcode**：
本地适配服务器，对外说 OpenChamber 实际消费的那部分 OpenCode HTTP/SSE API，
对下驱动 **mcode（MiniMax Code CLI）** 的无头模式。

```
OpenChamber (UI) ──OpenCode API──▶ openchamber-mcode ──每轮一个子进程──▶ mcode exec (stream-json)
```

不 fork OpenChamber、不 fork mcode：把 OpenChamber 指到本适配器（external
OpenCode server），会话实际跑在 mcode 上。

所有代码与文档都放在本目录 `openchamber-mcode/` 内。

## 2. mcode 能力调研结论（已实测，mcode 0.5.0，2026-09-20）

| 能力 | 入口 | 实测结论 |
|---|---|---|
| 一次性无头执行 | `mcode exec --cwd <dir> [--session <id>] --output-format stream-json` | stdout 输出严格 JSONL（LF 分行），事件带 `sequence`/`sessionId`/`turnId` |
| 提示词输入 | `--input -`（stdin） | ✅ 可用，绕开 argv 转义/长度问题 |
| 跨进程续接 | `--session mvs_xxx` | ✅ 新进程发 `session.resumed`，上下文完整（记忆测试通过） |
| 模型覆盖 | `--model provider/model` | ✅ providerId 含冒号（`custom_provider:tf-zhipu/glm-5.3-flash`）可用 |
| 中断 | SIGTERM 子进程 | ✅ 干净取消（stdout 末行 `mcode exec cancelled: ...`，非 JSON 行可跳过）；**中断后的会话仍可 `--session` 续接** |
| 模型目录 | `mcode provider list --json` | ✅ providers/models/selected/contextLimit/maxOutputTokens 齐全 |
| 会话落盘 | `~/.minimax/v2/sessions/YYYY/MM/DD/<ts>-session_<base64>/` | `manifest.json`（含 sessionId 与绝对路径）+ `messages.jsonl`（全量消息：user/assistant，content 块含 `text`/`thinking`） |

### stream-json 事件形状（实测摘录）

```
exec.started → session.started | session.resumed → turn.started
  → item.started/item.updated/item.completed   (item.type:
      "reasoning"      {contentDelta} / {content}
      "agent_message"  {contentDelta} / {content}
      "tool_call"      {toolCall:{id,name,status,input,output}}   ← M2 已映射，见下)
  → turn.completed   {model:{providerId,modelId,variant}, usage:{inputTokens,outputTokens,cacheReadTokens,totalTokens}, durationMs}
  → exec.completed   {result:{status:"succeeded"|"cancelled"…, output, model, usage}}
```

### tool_call 实测形状（mcode 0.5.0，2026-09-21，探针会话）

- `toolCall.status` 数字枚举：输入流阶段 4/5 → 参数定局 1（带 `input`）→
  输出定局 2（成功）/ 3（出错，如 read ENOENT）。
- `input` 是参数对象：bash `{command}`、write `{path, content}`、read `{path}`。
- `output` 统一为 `{content:[{type:"text",text}], details:{…}}`（write 另有
  `structuredPreview`，暂不透传）。
- 一个 turn 内可多个 tool_call 并发（write/read/bash 交错 start、批量 complete）。
- **`messages.jsonl` 不落盘工具调用**（探针会话只有 text/thinking 块）——重启
  恢复后工具部分消失，文本/推理保留；这是 mcode 数据源的限制，已注明。

## 3. 与 openchamber-pi 的架构差异（核心决策）

| | openchamber-pi | openchamber-mcode |
|---|---|---|
| 后端进程模型 | 每会话一个常驻 `pi --mode rpc`，stdin 推命令 | **每轮 prompt 一个 `mcode exec` 子进程**（进程无常驻、无 stdin 命令通道） |
| 会话状态归属 | pi 进程内存 + pi 自己的 session 文件 | mcode 落盘（`--session` 续接），适配器只存 OC↔mcode 映射 |
| 适配器重启恢复 | 会话丢失（内存态） | **可恢复**：适配器状态文件 + 解析 mcode `messages.jsonl` 重建历史 |
| 模型目录 | 临时 pi RPC `get_available_models` | `mcode provider list --json` |
| 中止 | RPC `abort` 命令 | SIGTERM 子进程（已验证干净且可续接） |

进程模型选型的理由：mcode 没有 pi 那种长驻 JSONL RPC；`exec` 是它的一等无头入口，
且状态由 mcode 自己持久化、按 sessionId 跨进程续接——"每轮一进程"反而更贴合
OpenCode 的 session 抽象，还免费拿到崩溃恢复。

## 4. 组件与文件布局

```
openchamber-mcode/
├── package.json / tsconfig.json / .gitignore / LICENSE(MIT)
├── bin/opencode-mcode            # $OPENCODE_BINARY 契约包装（serve 子命令）
├── src/
│   ├── cli.ts                    # serve 模式（stdout 打 "opencode server listening on <url>"）+ 独立模式
│   ├── server.ts                 # HTTP+SSE，OpenCode API 子集（路由对齐 pi 版）
│   ├── sessions.ts               # OC 会话注册表 + mcode 事件→OC 事件翻译（事件桥）
│   ├── mcode-exec.ts             # 每轮子进程驱动：spawn/stdin/JSONL 解析/SIGTERM 中止
│   ├── catalog.ts                # `mcode provider list --json` → OpenCode v2 Provider/Model
│   ├── store.ts                  # 适配器状态持久化（OC↔mcode 映射，去抖写盘）
│   ├── history.ts                # 定位 mcode 会话目录 + 解析 messages.jsonl 重建历史
│   └── types.ts                  # OpenCode 端类型（与 pi 版同形）
├── contrib/
│   └── smoke.ts                  # 端到端冒烟测试（watcher/launcher 脚本已于 2026-09-21 移除）
└── docs/{plan,architecture,api-surface}.md
```

## 5. 关键映射设计

### 会话生命周期

- `POST /session` → 生成 OC 会话 `ses_<uuid>`（此时尚未绑定 mcode，惰性创建）。
- 首次 prompt → spawn `mcode exec --cwd <dir> --input - --input-format text
  --output-format stream-json [flags]`（不带 `--session`），从 `session.started`
  事件捕获 mcode sessionId 并绑定、落盘；后续 prompt 一律加 `--session <id>`。
- 每会话内 prompt 串行化（promise 链）；busy 状态在 spawn 时置 busy，进程退出置 idle。
- `abort` → SIGTERM 当前 exec 子进程（5s 后 SIGKILL 兜底）→ 置 idle，finish="aborted"。
- `rename` → 适配器侧改标题（mcode exec 模式无改名命令）。
- `delete` → 杀进程 + 删适配器映射；**不动** `~/.minimax` 里的 mcode 会话数据（用户数据，越界不删，文档注明）。

### 事件翻译（mcode → OpenCode SSE）

| mcode 事件 | OpenCode SSE |
|---|---|
| `turn.started`（spawn 即置） | `session.status` busy |
| `item.*` type `reasoning`（`contentDelta`/`content`） | `message.part.updated`（reasoning part + delta） |
| `item.*` type `agent_message` | `message.part.updated`（text part + delta） |
| `item.*` type `tool_call` | `message.part.updated`（tool part，state 为 SDK v2 ToolState 判别联合：pending{raw}→running{input,title}→completed{output,title,metadata}/error{error}） |
| `turn.completed`（model+usage） | `message.updated`（tokens/model/finish）+ `session.idle` |
| `exec.completed` | 兑现同步 prompt 的 Promise；finish 按 result.status 映射 |
| `turn.failed` / `exec.failed` / 非零退出 | `session.error` + 置 idle |
| （订阅时） | `server.connected` |

消息簿记对齐 pi 版：prompt 时先落 OC user message；每 turn 一条或多条 OC assistant
message（parts = 该段全部 reasoning/text/tool item，按 item.id 稳定关联）。**工具
边界规则**：tool part 挂进当前流式 assistant message；工具之后的**新** text/
reasoning item 先收口当前 message 再开新的——与 mcode 每 API response 落一条
assistant 记录的粒度一致（实测：text → tools → 新 text）。

### 模型目录

`mcode provider list --json` → 过滤 enabled 且有 models 的 provider → OpenCode v2
形状；`selected: true` 的模型作为 default；**默认 provider/model 排到最前**
（OpenChamber 选择器会静默回落到第一个——pi 版踩过的坑）。
providerId 原样保留（含冒号，实测 OC 引用结构是 `{providerID, modelID}` 二段式）。

### 恢复（超出 pi 版的增强）

- 适配器状态：`~/.openchamber-mcode/adapter-state.json`（`OCMC_STATE_FILE` 可覆盖），
  记录 `ocId → {mcodeId, directory, title, created/updated, model}`，去抖写盘。
- 启动时加载状态 → 对已绑定会话：扫 `~/.minimax/v2/sessions/**/manifest.json`
  定位目录 → 解析 `messages.jsonl` 重建 OC 消息（user 文本剥离 `<system-reminder>` 包裹；
  assistant 的 `thinking`→reasoning、`text`→text）。解析失败则空历史降级，会话仍可用。
- 解析历史中的用户文本必须容忍多行——用逐行 JSON.parse 而不是正则切整个文件。

## 6. OpenCode API 面（M1 实现范围）

对齐 pi 版（同一 OpenChamber 消费方，见 `docs/api-surface.md`）：

- 会话：`POST/GET /session`、`GET /session/status`、`GET/PATCH/DELETE /session/{id}`、
  `GET /session/{id}/message`、`POST /session/{id}/prompt_async`、`POST /session/{id}/message`、
  `POST /session/{id}/abort`
- 引导探测：`/global/health`、`/provider`、`/config/providers`、`/experimental/session`、
  `/question` `/permission` `/lsp` `/formatter` `/mcp` `/command`（空）、`/path`、`/vcs`、`/agent`、
  `/config`、`/project(/current)`
- SSE：`/event` `/global/event`，连接即发 `server.connected`
- health 的 `version` 返回 `1.18.31`（OpenChamber 把它当 opencode 版本读）

## 7. 里程碑

- **M0 计划与调研** —— 本文 + 实测证据。✅
- **M1 聊天闭环**：会话 CRUD、prompt（同步/异步）、text/reasoning 流式、abort、
  模型目录、SSE 广播。**含 pi 版没有的重启恢复。** ✅
- **M2 工具调用**：`tool_call` item → OC tool part（input 逐字段 / output 文本
  +details / 状态机 pending→running→completed|error；abort 时悬空 tool 收敛为
  error）。✅（2026-09-21，payload 形状见 §2）
- **M3 权限/提问桥**：目前 exec 无法 ask（smart/full/off 由 `OCMC_PERMISSION` 透传）。
  **新线索**：`mcode acp` 可作为 stdio 上的 Agent Client Protocol server——若走
  ACP 可原生获得权限请求/工具事件，值得作为 M3+ 的后端升级方向评估。
- **M4 模型切换/统计/压缩**：`--model` 已通，其余看 mcode 后续能力。
- **M5 打包发布**：npm 包、CI。

本轮交付 M1 全量 + 启动器脚本 + 冒烟测试（不依赖 OpenChamber UI 即可验证的部分）。

## 8. 配置面（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `OCMC_MCODE_BINARY` | `mcode` | mcode 可执行文件路径 |
| `OCMC_STATE_FILE` | `~/.openchamber-mcode/adapter-state.json` | 适配器状态 |
| `OCMC_SESSIONS_ROOT` | `~/.minimax/v2/sessions` | mcode 会话树（只读） |
| `OCMC_PERMISSION` | `smart` | 透传 `--permission`（smart/full/off） |
| `OCMC_EFFORT` | – | 透传 `--effort` |
| `OCMC_MAX_STEPS` | – | 透传 `--max-steps` |
| `OCMC_TURN_TIMEOUT` | `30m` | 透传 `--timeout` |
| `OCMC_DEBUG` / `OCMC_DEBUG_LOG` | – / `/tmp/openchamber-mcode-debug.log` | 调试日志 |

## 9. 风险与开放问题

- providerId 含冒号在 OpenChamber 深处若有 `join/split` 用法可能出问题——OC SDK
  引用是二段式结构，判断为低风险；若实测出问题，加净化+反查表。
- mcode 会话目录按日期分层，靠 manifest 定位（启动时扫一次并缓存；找不到就降级空历史）。
- `turn.failed`/`exec.failed` 的确切事件名未观测到（ probes 全部成功），按通配
  `*.failed`/`error` 字段防御性处理。
- `toolCall.status` 枚举只有经验语义：完成态 2=成功、3=出错是实测（bash/write 成功
  =2、read ENOENT=3），中间态 4/5/1 的命名未知——映射只用"事件类型 + payload
  存在性 + 完成态 2/3"驱动，不依赖中间态语义。
- OpenChamber UI 端到端联调留待用户环境验证（本机若装有 openchamber 可直接跑 README 步骤）。

## 10. 验收标准（本轮）

1. `npm run typecheck`、`npm run build` 通过。
2. 适配器独立起服：引导探测端点全部 200；`/provider` 列出 mcode 模型且默认模型排最前。
3. 冒烟脚本全绿：建会话 → 异步 prompt → SSE 收到 text/reasoning delta 与
   `session.idle` → 中止 → 同步 prompt 返回最终消息 → 改名/删除。
4. 重启适配器后会话列表与消息历史恢复。
5. 所有新增/修改文件都在 `openchamber-mcode/` 内。

M2 追加验收（2026-09-21）：

6. 冒烟工具轮全绿：SSE 流出 tool part；最终消息列表含 bash tool part
   （state=completed、input.command、output.stdout 都带 marker）；工具后文本
   正常回流（TOOLS-DONE）。
7. 中止路径悬空 tool part 收敛为 error，不留永久 running。
