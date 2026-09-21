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
| `message.part.updated` (tool part) | `item.*` with `item.type` `tool_call` (`toolCall.input/output`, M2) |
| `session.status` busy / `session.idle` | subprocess spawn → `turn.started` / run settled (`exec.completed` or exit) |
| `session.error` | `*.failed` frames, non-zero exit without `exec.completed` |
| — (M3) | permissions: exec mode cannot ask; `OCMC_PERMISSION` passes `smart`/`full`/`off`. `mcode acp` (stdio Agent Client Protocol server) is a candidate backend for a native permission/question bridge |

### Tool parts (M2)

`tool_call` items map to OpenCode tool parts attached to the current streaming
assistant message. The part `state` mirrors `@opencode-ai/sdk` v2 (1.18.31)
`ToolState` exactly — a discriminated union on `.status` (verified against the
SDK's `dist/v2/gen/types.gen.d.ts`): pending `{input, raw}` → running
`{input, title?, metadata?}` → completed `{input, output: string, title,
metadata}` or error `{input, error, metadata?}`, each with `time`. The state
machine is driven by event type + payload presence: `item.started` → pending,
input/output frames → running, `item.completed` → completed (final
`toolCall.status` 2) or error (3, e.g. an ENOENT read — error text from
`output.content`). A turn aborted mid-tool finalizes dangling tool parts as
`error: "run aborted"` so the UI never shows an eternal spinner.

Boundary rule: a **new** text/reasoning item after tool parts closes the
current assistant message and opens a fresh one — matching mcode's
one-assistant-record-per-API-response persistence (observed live:
text → tools → new text within a single turn; multiple tool calls interleave).

### Capability gaps decided explicitly

- **Tool calls (M2)**: mapped to OpenCode tool parts (input fields, output
  text + details, completed/error states) with abort-safe finalization. One
  caveat: mcode's `messages.jsonl` does not persist tool calls, so tool parts
  exist only in the live session view — after an adapter restart the hydrated
  history keeps text/reasoning but drops tool parts.
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
   `thinking`→reasoning and `text`→text parts. Tool calls are **not**
   persisted by mcode (verified 2026-09-21: probe session store contains only
   text/thinking blocks), so hydrated history has no tool parts.
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
   the standalone [openchamber-sidecars](../openchamber-sidecars) launcher:
   when the app's `Local` backend points at it, it spawns the real opencode
   plus each isolated instance as a direct `--foreground` child, and SIGTERMs
   them all on app quit — including direct Dock/Spotlight opens. That keeps
   this adapter single-purpose (mcode only), symmetric with
   [openchamber-pi](../openchamber-pi). The earlier in-adapter supervisor
   (`src/sidecar.ts`, `bin/opencode-with-sidecars`) and the one-shot
   watcher/launcher scripts that used to live in `contrib/` were removed
   (2026-09-21).

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
3. **M2 — tool calls & file changes**: `tool_call` → OpenCode tool parts. ✅
   (2026-09-21; payload shapes live-observed, smoke-tested end-to-end)
4. **M3 — permissions bridge** (candidate: switch backend to `mcode acp`).
5. **M4 — model switching UX, session stats, compaction**.
6. **M5 — packaging**: npm publish, CI.
