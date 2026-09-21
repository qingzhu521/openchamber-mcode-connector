# OpenCode API surface consumed by OpenChamber

Same consumer as openchamber-pi (inventory originally extracted from
`reference/openchamber`, see the pi repo's `docs/api-surface.md`); this
document tracks the mcode counterpart for each item.

## REST/SDK methods implemented (M1)

| SDK method | Purpose in OpenChamber | mcode counterpart |
|---|---|---|
| `session.list` | session list per directory | adapter registry (restored from `adapter-state.json`) |
| `session.create` | new session | OC session, lazily bound to an mcode session on first prompt |
| `session.get` | session detail | adapter registry |
| `session.update` | rename/metadata | adapter-side title |
| `session.delete` | delete session | kill current run + drop mapping (mcode transcript untouched) |
| `session.messages` | load message history | live registry; after restart hydrated from `messages.jsonl` |
| `session.promptAsync` | send prompt (async) | spawn `mcode exec --input - --output-format stream-json` (prompt on stdin) |
| `session.abort` | stop generation | SIGTERM the exec subprocess |
| `session.fork` / `revert` / `unrevert` / `summarize` / `todo` / `shell` / `command` / `share` | — | **not implemented (M1)** — 501/404 |

## Bootstrap probes (must exist, observed live on OpenChamber 1.21.0)

| Endpoint | This adapter's response |
|---|---|
| `GET /provider` | `{all: Provider[], default: {providerID: modelID}, connected: string[]}` from `mcode provider list --json` |
| `GET /config/providers` | `{providers, default}` (same source) |
| `GET /question` / `GET /permission` | `[]` |
| `GET /lsp` / `GET /formatter` / `GET /command` | `[]` |
| `GET /mcp` | `{}` |
| `GET /experimental/session` | all sessions (all directories) |
| `GET /path` | `{home, state, config, worktree, directory}` |
| `GET /vcs` | `{}` or `{branch}` (git of the request directory) |
| `GET /agent` | one primary `build` agent (mcode) |
| `GET /global/health` | `{healthy: true, version: "1.18.31"}` |

Gotcha (inherited from the pi adapter): OpenChamber's model picker ignores
`default` when it cannot match it and silently falls back to the **first
listed provider/model** — the adapter sorts mcode's selected provider/model to
the front.

Note: mcode provider ids contain colons (`custom_provider:tf-zhipu`). The
OpenCode SDK passes provider/model as a two-field ref (`{providerID,
modelID}`), so they are kept verbatim.

## SSE event contract (event-reducer.ts)

The reducer handles exactly these `type` values; the adapter emits compatible
payloads for the M1 subset:

```
server.connected            session.created           session.updated
session.deleted             session.status            session.idle
session.error               session.diff              message.updated
message.removed             message.part.updated      message.part.delta
message.part.removed        permission.asked          permission.replied
question.asked              question.replied          question.rejected
todo.updated                project.updated           vcs.branch.updated
lsp.updated                 server.instance.disposed  global.disposed
```

Emitted by this adapter (M1): `server.connected`, `session.created`,
`session.updated`, `session.deleted`, `session.status`, `session.idle`,
`session.error`, `message.updated`, `message.part.updated` (with `delta`
during streaming — `message.part.delta` frames are not required; OpenChamber
consumes `message.part.updated` deltas, as verified on the pi adapter).

## mcode stream-json → OpenCode event mapping

| mcode event | OpenCode SSE |
|---|---|
| (subprocess spawn) | `session.status` busy |
| `item.*` type `reasoning` (`contentDelta`/`content`) | `message.part.updated` (reasoning part, delta) |
| `item.*` type `agent_message` | `message.part.updated` (text part, delta) |
| `item.*` type `tool_call` | (M2) closes current assistant message |
| `turn.completed` (`model`+`usage`) | `message.updated` (tokens/model) |
| run settled (`exec.completed` / exit) | `message.updated` (finish) + `session.status` idle + `session.idle` |
| `*.failed` / error exit without `exec.completed` | `session.error` + idle |
| (SSE subscribe) | `server.connected` |
