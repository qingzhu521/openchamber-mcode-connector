/**
 * Sidecar instance supervisor — lifecycle management for isolated
 * `openchamber serve` instances, riding the adapter's own lifecycle.
 *
 * OpenChamber spawns this adapter (as `$opencodeBinary`) when the app opens
 * and SIGTERMs the whole chain when it quits. That makes the adapter the one
 * process whose start/stop is already tied to the app — so the adapter can
 * own the isolated instances too:
 *
 *   app open  → managed server spawns adapter → adapter spawns each sidecar
 *               `openchamber serve --port P --foreground` (direct child)
 *   app quit  → adapter gets SIGTERM → adapter SIGTERMs sidecars
 *
 * This replaces the removed one-shot watcher/launcher scripts, whose
 * lifecycle only held when the app was opened through the launcher icon.
 *
 * Opt-in, fail-open: configured via OCMC_SIDECAR; any sidecar failure is
 * logged and skipped — the adapter itself must never fail to serve because
 * a sidecar could not start.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { get as httpGet } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SidecarSpec {
  /** Port the isolated `openchamber serve` instance listens on. */
  port: number;
  /** OPENCHAMBER_DATA_DIR for the instance (its profile directory). */
  profileDir: string;
}

/** openchamber CLI candidates beyond PATH (GUI-spawned adapters get a minimal PATH). */
const OPENCHAMBER_BIN_CANDIDATES = [
  join(homedir(), ".hermes/node/bin"),
  join(homedir(), ".local/bin"),
  join(homedir(), "bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
];

function log(line: string): void {
  console.error(`[sidecar] ${line}`);
}

function sidecarLogPath(port: number): string {
  return process.env.OCMC_SIDECAR_LOG_DIR
    ? join(process.env.OCMC_SIDECAR_LOG_DIR, `openchamber-mcode-sidecar-${port}.log`)
    : `/tmp/openchamber-mcode-sidecar-${port}.log`;
}

/**
 * Parse OCMC_SIDECAR: comma-separated `port=profileDir` entries.
 *   OCMC_SIDECAR="57125=~/.config/openchamber-mcode,57124=~/.config/openchamber-pi"
 * `~` expands to the home directory. Later entries override earlier ones on
 * port collisions; invalid entries are skipped with a warning.
 */
export function parseSidecarEnv(raw: string): SidecarSpec[] {
  const byPort = new Map<number, SidecarSpec>();
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) {
      log(`skipping malformed OCMC_SIDECAR entry (expected port=profileDir): '${trimmed}'`);
      continue;
    }
    const port = Number(trimmed.slice(0, eq));
    const profile = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^~(?=\/|$)/, homedir());
    if (!Number.isInteger(port) || port < 1 || port > 65535 || profile === "") {
      log(`skipping invalid OCMC_SIDECAR entry: '${trimmed}'`);
      continue;
    }
    byPort.set(port, { port, profileDir: profile });
  }
  return [...byPort.values()];
}

function resolveOpenchamberBinary(): string {
  const override = process.env.OCMC_OPENCHAMBER_BIN;
  if (override !== undefined && override !== "") return override;
  for (const dir of OPENCHAMBER_BIN_CANDIDATES) {
    const candidate = join(dir, "openchamber");
    if (existsSync(candidate)) return candidate;
  }
  return "openchamber"; // PATH at spawn time
}

/** True if something already answers on the port (health endpoint optional). */
function portResponds(port: number, timeoutMs = 2_000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpGet(`http://127.0.0.1:${port}/health`, (res) => {
      res.resume(); // drain
      log(`port ${port} already answering (/health -> ${res.statusCode ?? "no status"}), not starting a sidecar`);
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.setTimeout(timeoutMs);
  });
}

interface ManagedSidecar {
  spec: SidecarSpec;
  proc: ChildProcess;
  exited: boolean;
}

export class SidecarSupervisor {
  private children: ManagedSidecar[] = [];
  private stopping = false;

  private constructor(
    private specs: SidecarSpec[],
    private binary: string,
  ) {}

  /** Undefined when no sidecar config exists (env var or config file). */
  static fromEnv(): SidecarSupervisor | undefined {
    const raw = process.env.OCMC_SIDECAR;
    if (raw !== undefined && raw.trim() !== "") {
      return new SidecarSupervisor(parseSidecarEnv(raw), resolveOpenchamberBinary());
    }
    // The desktop app spawns the adapter with a minimal GUI environment, so
    // an env var set in a shell profile never reaches it — fall back to a
    // config file next to the adapter state.
    const file = process.env.OCMC_SIDECAR_FILE ?? join(homedir(), ".openchamber-mcode", "sidecar.json");
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      const entries = Array.isArray(parsed)
        ? parsed
        : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { instances?: unknown }).instances)
          ? ((parsed as { instances: unknown[] }).instances)
          : undefined;
      if (entries === undefined) {
        log(`ignoring ${file}: expected a JSON array (or {"instances": [...]}) of {port, profileDir}`);
        return undefined;
      }
      const specs = entries
        .filter((e): e is { port: unknown; profileDir: unknown } =>
          typeof e === "object" && e !== null && "port" in e && "profileDir" in e)
        .filter((e) => Number.isInteger(e.port) && (e.port as number) > 0 && (e.port as number) <= 65535 && typeof e.profileDir === "string" && e.profileDir !== "")
        .map((e) => ({ port: e.port as number, profileDir: (e.profileDir as string).replace(/^~(?=\/|$)/, homedir()) }));
      if (specs.length === 0) {
        log(`no valid entries in ${file}; sidecar disabled`);
        return undefined;
      }
      return new SidecarSupervisor(specs, resolveOpenchamberBinary());
    } catch {
      return undefined; // no config file or unreadable — sidecar simply off
    }
  }

  /** Fire-and-forget; never throws — called after the serve handshake line. */
  start(): void {
    void this.startAll().catch((err) => {
      log(`startup failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  private async startAll(): Promise<void> {
    for (const spec of this.specs) {
      if (await portResponds(spec.port)) continue;
      this.spawnOne(spec);
    }
  }

  private spawnOne(spec: SidecarSpec): void {
    try {
      mkdirSync(spec.profileDir, { recursive: true });
      const logFd = openSync(sidecarLogPath(spec.port), "a");
      log(`starting instance on :${spec.port} (profile ${spec.profileDir}, log ${sidecarLogPath(spec.port)})`);
      const proc = spawn(this.binary, ["serve", "--port", String(spec.port), "--foreground"], {
        stdio: ["ignore", logFd, logFd],
        env: { ...process.env, OPENCHAMBER_DATA_DIR: spec.profileDir },
      });
      const managed: ManagedSidecar = { spec, proc, exited: false };
      this.children.push(managed);
      proc.on("error", (err) => {
        managed.exited = true;
        log(`instance :${spec.port} failed to spawn: ${err instanceof Error ? err.message : String(err)}`);
      });
      proc.on("exit", (code, signal) => {
        if (managed.exited) return;
        managed.exited = true;
        if (this.stopping) return;
        log(`instance :${spec.port} exited unexpectedly (code=${code ?? "?"} signal=${signal ?? "?"}) — see ${sidecarLogPath(spec.port)}`);
      });
    } catch (err) {
      log(`could not start instance :${spec.port}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * SIGTERM each sidecar, escalate to SIGKILL after a grace period, and wait
   * (bounded) for them to exit. `--foreground` instances run their own
   * graceful shutdown and registry (pid/instance file) cleanup on SIGTERM.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    const live = this.children.filter((c) => !c.exited && c.proc.pid !== undefined);
    if (live.length === 0) return;
    log(`stopping ${live.length} instance(s): ${live.map((c) => `:${c.spec.port}`).join(" ")}`);
    const exits = live.map(
      (c) =>
        new Promise<void>((resolve) => {
          c.proc.once("exit", () => resolve());
          setTimeout(() => resolve(), 3_500).unref();
        }),
    );
    for (const c of live) {
      try {
        c.proc.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
    await Promise.allSettled(exits);
    for (const c of live) {
      if (!c.exited) {
        try {
          c.proc.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        c.exited = true;
      }
    }
    this.children = [];
  }
}
