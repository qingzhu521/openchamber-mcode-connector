# Architecture

## Goal

OpenChamber talks to an OpenCode server over HTTP + SSE via
`@opencode-ai/sdk/v2`. mcode (MiniMax Code CLI) exposes headless operation via
`mcode exec` (one prompt per process, streaming JSONL on stdout, cross-process
session resume with `--session`).

`openchamber-mcode` bridges the two:

```
OpenChamber ──HTTP/SSE (OpenCode API subset)──▶ openchamber-mcode ──每轮一个子进程──▶ mcode exec (stream-json)
```

OpenChamber is configured to use an **external OpenCode server** pointing at
this adapter. No OpenChamber fork, no mcode fork.

## Backend strategy (vs openchamber-pi)

| | openchamber-pi | openchamber-mcode |
|---|---|---|
| Mechanism | one long-lived `pi --mode rpc` process per session, commands pushed over stdin | **one `mcode exec` subprocess per prompt (turn)** |
| Session state | pi process memory + pi session files | mcode's own on-disk store; adapter re-attaches via `--session <id>` |
| Abort | RPC `abort` command | SIGTERM the subprocess (verified: clean cancel, session stays resumable) |
| Model catalog | throwaway pi RPC `get_available_models` | `mcode provider list --json` |
| Adapter restart | sessions lost | sessions **recovered** (state file + messages.jsonl hydration) |

Why process-per-turn: mcode has no long-lived JSONL RPC mode. Its headless
contract is `exec`, and it persists all conversation state itself — every turn
is `mcode exec --cwd <dir> --session <id> --input - --output-format
stream-json` with the prompt on stdin. This maps cleanly onto OpenCode's
session model and makes crash recovery nearly free.

## Mapping concerns

### Session model

- OpenCode: one server, many sessions, sessions belong to a directory/project.
- mcode: sessions identified by `mvs_*` ids, stored under
  `~/.minimax/v2/sessions/YYYY/MM/DD/<ts>-session_<base64>/`
  (`manifest.json` + `messages.jsonl`), resumed cross-process.
- The adapter keeps an OC session registry (`ses_*`) with **lazy binding**: the
  mcode session id is captured from the first turn's stream events and
  persisted in `~/.openchamber-mcode/adapter-state.json`.

### Event translation

| OpenCode (SSE `event`) | mcode (stdout stream-json) |
|---|---|
| `message.updated` / `message.part.updated` | `item.started`/`item.updated`/`item.completed` with `item.type` `reasoning` / `agent_message` (`contentDelta`/`content`) |
| `session.status` busy / `session.idle` | subprocess spawn → `turn.started` / run settled (`exec.completed` or exit) |
| `session.error` | `*.failed` frames, non-zero exit without `exec.completed` |
| — (M2) | `item.type` `tool_call` (`toolCall.input/output`) — currently closes the current assistant message at tool boundaries |
| — (M3) | permissions: exec mode cannot ask; `OCMC_PERMISSION` passes `smart`/`full`/`off` |

### Capability gaps decided explicitly

- **Tool calls (M2)**: tool_call items are not yet mapped to OpenCode tool
  parts; a tool boundary finalizes the current assistant message so message
  splitting matches mcode's persisted records.
- **Permissions/questions (M3)**: OpenCode permission prompts are stubbed
  (`GET /question`, `GET /permission` → `[]`); exec mode has no ask UI.
- **Revert / todos / share**: stubbed or absent, same as the pi adapter's M1.
- **Rename**: adapter-side only (mcode exec has no rename command).
- **Delete**: removes the adapter mapping; the mcode transcript under
  `~/.minimax` is user data and is deliberately left untouched.

## Recovery (beyond openchamber-pi)

1. `adapter-state.json` maps `ses_* → {mcodeId, directory, title, model, …}`
   (debounced writes).
2. On boot the adapter re-registers those sessions and locates each mcode
   session dir by walking `~/.minimax/v2/sessions/**/manifest.json` (cached
   index, rebuilt once on miss).
3. `messages.jsonl` is parsed into OpenCode messages: user `text` blocks
   (runtime `<system-reminder>` wrappers stripped), assistant
   `thinking`→reasoning and `text`→text parts.
4. Parse failures degrade to empty history; the session still works because
   `--session` resume does not depend on the adapter's copy.

## Deployment modes

1. **Built-in lifecycle (recommended)**: the desktop app's main profile sets
   `opencodeBinary` to `bin/opencode-mcode`. The app starts its managed
   server, the server spawns this adapter as a child, and quitting the app
   tears down the whole chain — same lifecycle as the built-in opencode
   backend, zero extra processes (verified live).
2. **Isolated second instance**: a dedicated profile runs a separate
   `openchamber serve` on its own port (default 57125). Lifecycle is owned by
   the adapter's sidecar supervisor (`src/sidecar.ts`, opt-in via
   `OCMC_SIDECAR="port=profileDir,..."`): the adapter starts each instance as
   a direct `--foreground` child after the serve handshake line and SIGTERMs
   them on shutdown, so instances live exactly as long as the app-managed
   adapter — including direct Dock/Spotlight opens. The one-shot
   watcher/launcher scripts that used to live in `contrib/` were removed
   (2026-09-21): their lifecycle only held when OpenChamber was opened
   through the launcher icon, leaving the instance unreachable on direct
   app opens.

A resident supervisor / LaunchAgent variant was built and tested, then
dropped: it contradicts the parent-child elegance of the built-in flow.

## Verified mcode behaviors this relies on (0.5.0, 2026-09-20)

- `--input -` prompt on stdin; strict LF-delimited JSONL on stdout.
- `--session mvs_*` resumes with full context (`session.resumed`).
- SIGTERM mid-run cancels cleanly; the session remains resumable.
- `--model provider/model` override works with colon-bearing provider ids
  (`custom_provider:tf-zhipu/glm-5.3-flash`).
- `turn.completed` carries `{model, usage}`; `exec.completed` carries the
  final `result.output`.

## Milestones

1. **M0 — plan & probes**: `docs/plan.md` (all mcode capabilities verified
   live before any code).
2. **M1 — chat loop + recovery**: session CRUD, prompt sync/async,
   text/reasoning streaming, abort, model catalog, restart recovery. ✅
3. **M2 — tool calls & file changes**: `tool_call` → OpenCode tool parts.
4. **M3 — permissions bridge**.
5. **M4 — model switching UX, session stats, compaction**.
6. **M5 — packaging**: npm publish, CI.
