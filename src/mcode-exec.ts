/**
 * mcode subprocess driver — one `mcode exec` process per prompt (per turn).
 *
 * mcode (MiniMax Code CLI) has no long-lived RPC mode like pi's `--mode rpc`.
 * Its first-class headless entry is `mcode exec`:
 *
 *   mcode exec --cwd <dir> [--session <id>] --input - --input-format text \
 *              --output-format stream-json [--model provider/model] \
 *              [--permission smart|full|off] [--timeout 30m] [--max-steps N]
 *
 * The prompt arrives on stdin (`--input -`), the run streams strict JSONL on
 * stdout (LF-separated; a cancelled run prints one trailing plain-text line
 * which we skip). Session state is persisted by mcode itself and re-attached
 * cross-process via `--session <id>` (verified: session.resumed + intact
 * context, and a SIGTERM-aborted session stays resumable).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";

export interface McodeExecOptions {
  cwd: string;
  prompt: string;
  /** mcode session id; omitted on the first turn of a session. */
  sessionId?: string | undefined;
  /** provider/model override, e.g. custom_provider:tf-zhipu/glm-5.3-flash */
  model?: string | undefined;
  /** CLI flags sourced from env config (see mcodeFlags()). */
  extraArgs?: string[] | undefined;
  /** mcode binary; defaults to OCMC_MCODE_BINARY or "mcode" from PATH. */
  binary?: string | undefined;
}

export interface McodeStreamEvent {
  schemaVersion: number;
  sequence: number;
  timestampMs: number;
  runId: string;
  sessionId: string;
  turnId: string;
  type: string;
  item?: McodeItem;
  model?: McodeTurnModel;
  usage?: McodeTurnUsage;
  result?: McodeExecResult;
  error?: unknown;
  [key: string]: unknown;
}

export interface McodeItem {
  id: string;
  type: "reasoning" | "agent_message" | "tool_call" | string;
  /** streaming delta (item.started/item.updated) */
  contentDelta?: string;
  /** full content (item.completed) */
  content?: string;
  toolCall?: {
    id: string;
    name: string;
    status: number;
    input?: unknown;
    output?: unknown;
  };
  [key: string]: unknown;
}

export interface McodeTurnModel {
  providerId: string;
  modelId: string;
  variant?: string;
  [key: string]: unknown;
}

export interface McodeTurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  totalTokens?: number;
  [key: string]: unknown;
}

export interface McodeExecResult {
  type: "exec.result";
  runId: string;
  sessionId: string;
  turnId: string;
  status: string; // "succeeded" | "cancelled" | ... (open set)
  output?: string;
  model?: McodeTurnModel;
  usage?: McodeTurnUsage;
  [key: string]: unknown;
}

export interface McodeRunOutcome {
  status: string;
  output?: string | undefined;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  aborted: boolean;
  model?: McodeTurnModel | undefined;
  usage?: McodeTurnUsage | undefined;
  /** Filled if the process died without an exec.completed frame. */
  failure?: string | undefined;
}

const DEBUG_LOG = process.env.OCMC_DEBUG_LOG ?? "/tmp/openchamber-mcode-debug.log";

function debug(line: string): void {
  if (process.env.OCMC_DEBUG) appendFileSync(DEBUG_LOG, line + "\n");
}

/** Extra exec flags from OCMC_* env config. */
export function mcodeFlags(): string[] {
  const args: string[] = [];
  const permission = process.env.OCMC_PERMISSION;
  if (permission) args.push("--permission", permission);
  const effort = process.env.OCMC_EFFORT;
  if (effort) args.push("--effort", effort);
  const maxSteps = process.env.OCMC_MAX_STEPS;
  if (maxSteps) args.push("--max-steps", maxSteps);
  const timeout = process.env.OCMC_TURN_TIMEOUT;
  if (timeout) args.push("--timeout", timeout);
  return args;
}

export class McodeExecRun extends EventEmitter {
  private proc: ChildProcess;
  private buffer = "";
  private decoder = new StringDecoder("utf8");
  private settled = false;
  private abortInitiated = false;
  private stderrTail = "";
  /** mcode session id, captured from the first stream frame that carries it. */
  private boundSession: string | undefined;

  readonly done: Promise<McodeRunOutcome>;
  private resolveDone!: (o: McodeRunOutcome) => void;

  constructor(private options: McodeExecOptions) {
    super();

    const args = [
      "exec",
      "--cwd",
      options.cwd,
      "--input",
      "-",
      "--input-format",
      "text",
      "--output-format",
      "stream-json",
      ...(options.sessionId !== undefined ? ["--session", options.sessionId] : []),
      ...(options.model !== undefined ? ["--model", options.model] : []),
      ...(options.extraArgs ?? mcodeFlags()),
    ];

    this.done = new Promise<McodeRunOutcome>((resolve) => {
      this.resolveDone = resolve;
    });

    debug(`[mcode-exec] spawn ${options.binary ?? process.env.OCMC_MCODE_BINARY ?? "mcode"} ${args.join(" ")}`);
    this.proc = spawn(options.binary ?? process.env.OCMC_MCODE_BINARY ?? "mcode", args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    this.proc.stderr!.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-8192);
    });

    this.proc.stdout!.on("data", (chunk: Buffer | string) => {
      this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
      this.drain();
    });
    this.proc.stdout!.on("end", () => {
      this.buffer += this.decoder.end();
      this.drain();
    });
    this.proc.on("error", (err) => this.settle({ status: "failed", exitCode: null, signal: null, aborted: false, failure: String(err) }));
    this.proc.on("exit", (code, signal) => this.onExit(code, signal));

    // Prompt goes via stdin: no argv quoting/length limits.
    this.proc.stdin!.on("error", () => undefined); // EPIPE if mcode dies early
    this.proc.stdin!.write(options.prompt, "utf8");
    this.proc.stdin!.end();
  }

  /** mcode session id once observed (session.started / session.resumed / any frame). */
  get sessionId(): string | undefined {
    return this.boundSession;
  }

  abort(): void {
    if (this.settled) return;
    this.abortInitiated = true;
    try {
      this.proc.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    // Escalate if SIGTERM is not honored (verified honored in probes; belt+braces).
    setTimeout(() => {
      if (!this.settled) {
        try {
          this.proc.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }, 5_000).unref();
  }

  private drain(): void {
    // Strict LF-only framing (mirrors the pi adapter's lesson: never split on
    // U+2028/U+2029; mcode JSONL is LF-delimited).
    for (;;) {
      const idx = this.buffer.indexOf("\n");
      if (idx === -1) return;
      let line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length === 0) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let ev: McodeStreamEvent;
    try {
      ev = JSON.parse(line) as McodeStreamEvent;
    } catch {
      // Non-JSON noise (e.g. the trailing "mcode exec cancelled: ..." line).
      debug(`[mcode-exec] non-json stdout: ${line.slice(0, 200)}`);
      return;
    }
    debug(`[mcode-event] ${ev.type} seq=${ev.sequence} ${line.slice(0, 300)}`);

    if (this.boundSession === undefined && typeof ev.sessionId === "string" && ev.sessionId !== "") {
      this.boundSession = ev.sessionId;
    }

    if (ev.type === "exec.completed" && ev.result) {
      const r = ev.result;
      this.settle({
        status: r.status,
        output: r.output,
        exitCode: null,
        signal: null,
        aborted: false,
        model: r.model ?? ev.model,
        usage: r.usage ?? ev.usage,
      });
    }

    this.emit("event", ev);
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    const failure =
      this.abortInitiated ? undefined : this.stderrTail.trim().slice(-2000) || undefined;
    this.settle({
      status: this.abortInitiated ? "cancelled" : "failed",
      exitCode: code,
      signal,
      aborted: this.abortInitiated,
      failure: this.settled ? undefined : (failure ?? `mcode exec exited (code=${code} signal=${signal}) without exec.completed`),
    });
  }

  private settle(outcome: McodeRunOutcome): void {
    if (this.settled) return;
    this.settled = true;
    debug(`[mcode-exec] settle status=${outcome.status} aborted=${outcome.aborted} exit=${outcome.exitCode} ${outcome.failure ?? ""}`);
    this.resolveDone(outcome);
    this.emit("settled", outcome);
  }
}

/**
 * Run a buffered one-shot mcode command (no stream parsing) — used by the
 * model catalog (`mcode provider list --json`).
 */
export function mcodeOnce(args: string[], timeoutMs = 30_000): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.env.OCMC_MCODE_BINARY ?? "mcode", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`mcode ${args[0]} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.stdout!.on("data", (c: Buffer) => (stdout += c.toString()));
    proc.stderr!.on("data", (c: Buffer) => (stderr += c.toString()));
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}
