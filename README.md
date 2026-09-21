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

## Sidecar instance management (optional)

The isolated instances above can ride the adapter's own lifecycle: OpenChamber
spawns this adapter when the app opens and SIGTERMs the chain when it quits,
so the adapter can start/stop the instances as direct children — no watchers,
no launchers, and opening the app directly (Dock/Spotlight) works exactly the
same as opening it via any launcher.

```bash
# set in ~/.config/openchamber/settings.json "opencodeBinary" env, or export
# before OpenChamber starts the managed server:
OCMC_SIDECAR="57125=$HOME/.config/openchamber-mcode,57124=$HOME/.config/openchamber-pi"
```

Each entry is `port=profileDir`; ports already answering on `/health` are
skipped, sidecar failures are logged and never break the adapter, and
instances log to `/tmp/openchamber-mcode-sidecar-<port>.log`. Requires the
`openchamber` CLI (resolved from PATH, common user bins, or
`OCMC_OPENCHAMBER_BIN`).

Because the desktop app spawns the adapter with a minimal GUI environment
(shell-profile env vars never reach it), the recommended configuration is a
file — `~/.openchamber-mcode/sidecar.json`:

```json
[
  { "port": 57125, "profileDir": "~/.config/openchamber-mcode" },
  { "port": 57124, "profileDir": "~/.config/openchamber-pi" }
]
```

(`~` expands to the home directory; path override via `OCMC_SIDECAR_FILE`.
The `OCMC_SIDECAR` env var still wins when set, e.g. in tests or terminal
runs.)

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
| `OCMC_SIDECAR` | – | comma list `port=profileDir`: isolated `openchamber serve` instances to start/stop with the adapter (or config file, see below) |
| `OCMC_SIDECAR_FILE` | `~/.openchamber-mcode/sidecar.json` | sidecar config file used when `OCMC_SIDECAR` is unset (recommended for the desktop app) |
| `OCMC_OPENCHAMBER_BIN` | `openchamber` (PATH + common dirs) | openchamber CLI used by the sidecar supervisor |
| `OCMC_SIDECAR_LOG_DIR` | `/tmp` | directory for `openchamber-mcode-sidecar-<port>.log` files |
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
