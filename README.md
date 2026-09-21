# OpenChamber Mcode Connector

Use [OpenChamber](https://github.com/openchamber/openchamber) with the
[mcode](https://www.minimax.io) coding agent (MiniMax Code CLI) instead of
OpenCode.

`openchamber-mcode` is a local adapter server that speaks the subset of the
OpenCode HTTP/SSE API that OpenChamber actually consumes, and drives mcode
agent sessions underneath via mcode's headless mode
(`mcode exec --output-format stream-json`, one subprocess per prompt,
cross-process session resume via `--session`).

```
OpenChamber (UI) ──OpenCode API──▶ openchamber-mcode ──每轮一个子进程──▶ mcode exec (stream-json)
```

No OpenChamber fork required: point OpenChamber at this adapter as an
**external OpenCode server** and sessions run on mcode.

Sibling project: [openchamber-pi](../openchamber-pi) (same adapter pattern
for the pi coding agent). This repo follows its architecture and API surface;
the key differences are documented in
[docs/architecture.md](docs/architecture.md) — notably process-per-turn
instead of a long-lived RPC subprocess, and adapter-restart recovery from
mcode's own session store.

## Status

**M1 works**: session create/list/rename/delete, prompt (sync + async), live
text/reasoning streaming over SSE, abort (session stays usable), model catalog
from mcode, and full restart recovery (sessions and history survive adapter
restarts via `adapter-state.json` + mcode `messages.jsonl`). See
[docs/plan.md](docs/plan.md) for the roadmap (tool-call parts are M2).

## Recommended: built-in lifecycle (zero extra processes)

The most elegant setup mirrors how OpenChamber runs its **built-in opencode
backend**: the desktop app starts its own managed server, that server spawns
`$opencodeBinary` as a child process, and quitting the app tears the whole
chain down. Point the app's **main profile** at this adapter and you get
exactly that lifecycle — mcode starts with OpenChamber and stops with it, no
watchers, no LaunchAgent, no resident supervisor:

```bash
# one-time (backs up first):
cp ~/.config/openchamber/settings.json ~/.config/openchamber/settings.json.bak
# set "opencodeBinary" in ~/.config/openchamber/settings.json to
#   /absolute/path/to/openchamber-mcode/bin/opencode-mcode
```

Then just open OpenChamber normally (Dock/Spotlight/login) — the backend is
mcode. Verified: app start → managed server + adapter up; app quit → all
processes gone. To revert, restore the backup or clear the
`opencodeBinary` field.

## Isolated second instance (optional)

The profile below defines a **separate** OpenChamber instance (own port,
own data dir) — useful to keep the main app on a different backend:

OpenChamber spawns whatever `$OPENCODE_BINARY` / `settings.opencodeBinary`
points to as `serve --hostname H --port P`, waits for the stdout line
`opencode server listening on <url>`, then health-checks `/global/health`.
This repo's `bin/opencode-mcode` wrapper implements that contract on top of
mcode.

Recommended: run a second, isolated OpenChamber profile so your main setup is
untouched:

```bash
# isolated profile dir
mkdir -p ~/.config/openchamber-mcode
cat > ~/.config/openchamber-mcode/settings.json <<'EOF'
{
  "opencodeBinary": "/absolute/path/to/openchamber-mcode/bin/opencode-mcode"
}
EOF

# start OpenChamber with mcode as the agent backend
OPENCHAMBER_DATA_DIR=~/.config/openchamber-mcode openchamber serve --port 57125
# open http://127.0.0.1:57125
```

Requires: Node.js 22+, the `mcode` CLI on PATH (or `OCMC_MCODE_BINARY`).

Debug logging: set `OCMC_DEBUG=1` (writes HTTP requests and mcode events to
`/tmp/openchamber-mcode-debug.log`, override with `OCMC_DEBUG_LOG`).

## Standalone / smoke test

```bash
npm install
npm run build
npm run smoke   # end-to-end: bootstrap probes, prompt+stream, abort, restart recovery
```

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `OCMC_MCODE_BINARY` | `mcode` | mcode executable |
| `OCMC_STATE_FILE` | `~/.openchamber-mcode/adapter-state.json` | OC↔mcode session mapping |
| `OCMC_SESSIONS_ROOT` | `~/.minimax/v2/sessions` | mcode session tree (read-only, for history hydration) |
| `OCMC_PERMISSION` | – | pass `--permission smart\|full\|off` to exec |
| `OCMC_EFFORT` | – | pass `--effort` |
| `OCMC_MAX_STEPS` | – | pass `--max-steps` |
| `OCMC_TURN_TIMEOUT` | – | pass `--timeout` (e.g. `30m`) |
| `OCMC_DEBUG` / `OCMC_DEBUG_LOG` | – / `/tmp/openchamber-mcode-debug.log` | debug logging |

Deleting a session through OpenChamber removes the adapter mapping but never
touches mcode's own transcript under `~/.minimax` — that is your data.

## Why

- OpenChamber is a great workspace UI but is hard-wired to the OpenCode SDK.
- mcode is a full terminal coding agent with a first-class headless exec mode
  and its own persistent session store — but no rich web UI.
- This project connects the two without forking either.

## Non-goals

- Reimplementing OpenChamber's platform features (scheduler, relay, goals).
- Wrapping mcode as an LLM provider inside OpenCode. mcode is a full agent
  with its own loop; we adapt at the session-protocol level.

## License

MIT
