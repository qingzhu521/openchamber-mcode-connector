/**
 * End-to-end smoke test for the adapter — no OpenChamber required.
 *
 * Drives the adapter's OpenCode HTTP surface exactly the way OpenChamber
 * would (bootstrap probes → session create → prompt_async + SSE → abort →
 * sync prompt → rename → restart recovery → delete), with real mcode runs
 * behind every prompt.
 *
 *   npm run smoke
 *   OCMC_MCODE_BINARY=/path/to/mcode npm run smoke
 */

import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterServer } from "../src/server.js";
import type { OCEvent, OCSession, OCMessageWithParts, OCPart } from "../src/types.js";

const WORKSPACE = mkdtempSync(join(tmpdir(), "ocmc-smoke-"));
const STATE_FILE = join(WORKSPACE, "adapter-state.json");
process.env.OCMC_STATE_FILE = STATE_FILE;
process.env.OCMC_TURN_TIMEOUT = process.env.OCMC_TURN_TIMEOUT ?? "240s";

let failures = 0;
let checks = 0;

function ok(name: string, cond: boolean, detail = ""): void {
  checks++;
  if (cond) {
    console.log(`  ✅ ${name}`);
  } else {
    failures++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Minimal SSE client over fetch, collecting parsed OCEvents. */
class SseCollector {
  private events: OCEvent[] = [];
  private waiters: Array<{ test: (e: OCEvent) => boolean; resolve: (e: OCEvent) => void; timer: NodeJS.Timeout }> = [];
  private closed = false;
  private controller = new AbortController();

  constructor(private url: string) {}

  async start(): Promise<void> {
    const res = await fetch(`${this.url}/event`, {
      signal: this.controller.signal,
      headers: { Accept: "text/event-stream" },
    });
    if (!res.ok || !res.body) throw new Error(`SSE connect failed: ${res.status}`);
    void this.pump(res.body);
  }

  private async pump(body: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    const reader = body.getReader(); // lock once — a second getReader() throws
    let buf = "";
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        for (;;) {
          const idx = buf.indexOf("\n\n");
          if (idx === -1) break;
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!dataLine) continue;
          try {
            const ev = JSON.parse(dataLine.slice(6)) as OCEvent;
            this.events.push(ev);
            for (const w of [...this.waiters]) {
              if (w.test(ev)) {
                this.waiters.splice(this.waiters.indexOf(w), 1);
                clearTimeout(w.timer);
                w.resolve(ev);
              }
            }
          } catch {
            /* malformed frame */
          }
        }
      }
    } catch (err) {
      if (!this.closed) console.error("  [sse] pump error:", err instanceof Error ? err.message : err);
    }
    this.closed = true;
  }

  waitFor(test: (e: OCEvent) => boolean, timeoutMs: number, label: string): Promise<OCEvent> {
    const existing = this.events.find(test);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = {
        test,
        resolve,
        timer: setTimeout(() => {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          reject(new Error(`timeout waiting for ${label} after ${timeoutMs}ms`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  stop(): void {
    this.controller.abort();
  }

  get all(): OCEvent[] {
    return this.events;
  }
}

async function api<T>(url: string, path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${url}${path}`, init);
  const text = await res.text();
  let body: T;
  try {
    body = text === "" ? (undefined as T) : (JSON.parse(text) as T);
  } catch {
    body = text as unknown as T;
  }
  return { status: res.status, body };
}

function promptBody(text: string): string {
  return JSON.stringify({ parts: [{ type: "text", text }] });
}

function lastAssistant(messages: OCMessageWithParts[] | undefined): OCMessageWithParts | undefined {
  if (!messages) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.info.role === "assistant") return messages[i];
  }
  return undefined;
}

function textOf(m: OCMessageWithParts | undefined): string {
  if (!m) return "";
  return m.parts
    .filter((p) => p.type === "text")
    .map((p) => (p as OCPart & { text: string }).text)
    .join("");
}

async function startServer(): Promise<AdapterServer> {
  const server = new AdapterServer({ port: 0, host: "127.0.0.1", defaultDirectory: WORKSPACE });
  await server.start();
  return server;
}

async function main(): Promise<void> {
  console.log(`workspace: ${WORKSPACE}`);
  console.log("— boot adapter #1 —");
  const server = await startServer();
  const url = server.url;
  const sse = new SseCollector(url);
  await sse.start();
  console.log(`adapter: ${url}`);

  // 1. bootstrap probes
  console.log("— bootstrap probes —");
  const health = await api<{ healthy: boolean; version: string }>(url, "/global/health");
  ok("GET /global/health", health.status === 200 && health.body.healthy === true);
  const providers = await api<{ all: Array<{ id: string; models: Record<string, unknown> }>; default: Record<string, string>; connected: string[] }>(url, "/provider");
  ok("GET /provider lists mcode models", providers.status === 200 && providers.body.all.length > 0, JSON.stringify(providers.body).slice(0, 200));
  const firstProvider = providers.body.all[0];
  const defaultProviderId = Object.keys(providers.body.default)[0];
  ok("default provider sorted first", firstProvider !== undefined && firstProvider.id === defaultProviderId, `${firstProvider?.id} vs ${defaultProviderId}`);
  for (const probe of ["/question", "/permission", "/lsp", "/formatter", "/experimental/session", "/path", "/vcs", "/agent", "/command", "/mcp", "/config", "/project", "/project/current"]) {
    const r = await api<unknown>(url, probe);
    ok(`GET ${probe}`, r.status === 200, `status ${r.status}`);
  }

  // 2. session create + async prompt + streaming
  console.log("— session create + async prompt (real mcode run) —");
  const created = await api<OCSession>(url, "/session", { method: "POST", body: JSON.stringify({}) });
  ok("POST /session", created.status === 200 && typeof created.body.id === "string");
  const sessionId = created.body.id;
  await sse.waitFor((e) => e.type === "session.created", 5_000, "session.created");

  // OpenChamber sends a client-generated messageID (optimistic insert) — the
  // adapter must reuse it and echo the user part, or the UI renders the
  // message twice (verified against OpenChamber's event-reducer).
  const CLIENT_MSG_ID = "msg_smokeclientecho0001";
  const asyncRes = await api<unknown>(url, `/session/${sessionId}/prompt_async`, {
    method: "POST",
    body: JSON.stringify({ messageID: CLIENT_MSG_ID, parts: [{ type: "text", text: "Reply with exactly: MCODE-SMOKE-OK" }] }),
  });
  ok("POST /prompt_async accepted", asyncRes.status === 204, `status ${asyncRes.status}`);

  const userPartEcho = await sse.waitFor(
    (e) =>
      e.type === "message.part.updated" &&
      (e.properties as { part?: { messageID?: string; type?: string } }).part?.messageID === CLIENT_MSG_ID &&
      (e.properties as { part?: { type?: string } }).part?.type === "text",
    10_000,
    "user part echo",
  );
  ok("client messageID reused + user part echoed", true, JSON.stringify((userPartEcho.properties as { part: unknown }).part).slice(0, 120));

  const deltaEv = await sse.waitFor(
    (e) => e.type === "message.part.updated" && typeof (e.properties as { delta?: string }).delta === "string" && (e.properties as { delta?: string }).delta !== "",
    120_000,
    "streaming text delta",
  );
  ok("SSE streams message.part.updated deltas", true, `first delta: ${JSON.stringify((deltaEv.properties as { delta: string }).delta).slice(0, 40)}`);
  await sse.waitFor((e) => e.type === "session.idle" && (e.properties as { sessionID: string }).sessionID === sessionId, 180_000, "session.idle");
  ok("SSE session.idle after turn", true);

  const messages1 = await api<OCMessageWithParts[]>(url, `/session/${sessionId}/message`);
  const answer = textOf(lastAssistant(messages1.body));
  ok("assistant text contains MCODE-SMOKE-OK", answer.includes("MCODE-SMOKE-OK"), answer.slice(0, 120));
  const userStored = (messages1.body ?? []).find((m) => m.info.role === "user");
  ok("user message stored clean (no system-reminder)", userStored !== undefined && !textOf(userStored).includes("system-reminder"), textOf(userStored).slice(0, 80));
  ok("user message keeps the client messageID", userStored?.info.id === CLIENT_MSG_ID, userStored?.info.id);

  // 3. abort mid-run, then prove the session is still usable
  console.log("— abort mid-run + reuse —");
  await api<unknown>(url, `/session/${sessionId}/prompt_async`, { method: "POST", body: promptBody("Write a very detailed 4000-word essay about the history of computing, starting from the abacus. Do not summarize.") });
  await sse.waitFor(
    (e) => e.type === "message.part.updated" && typeof (e.properties as { delta?: string }).delta === "string",
    120_000,
    "first delta of long run",
  );
  const abortRes = await api<unknown>(url, `/session/${sessionId}/abort`, { method: "POST" });
  ok("POST /abort", abortRes.status === 200);
  await sse.waitFor((e) => e.type === "session.idle" && (e.properties as { sessionID: string }).sessionID === sessionId, 30_000, "idle after abort");
  ok("idle after abort", true);

  const syncRes = await api<OCMessageWithParts>(url, `/session/${sessionId}/message`, { method: "POST", body: promptBody("Reply with exactly: SMOKE-SYNC-OK") });
  ok("POST /message (sync) after abort still works", syncRes.status === 200 && textOf(syncRes.body).includes("SMOKE-SYNC-OK"), textOf(syncRes.body).slice(0, 120));

  // 3.5 tool call round (M2): tool parts stream over SSE and land in messages
  console.log("— tool call round (real bash tool run) —");
  const toolRun = await api<OCMessageWithParts>(url, `/session/${sessionId}/message`, {
    method: "POST",
    body: promptBody('Use the bash tool to run exactly this command: echo tool-smoke-marker. Then reply with exactly: TOOLS-DONE'),
  });
  ok("tool round sync prompt returns", toolRun.status === 200, `status ${toolRun.status}`);
  const toolSse = sse.all.find(
    (e) => e.type === "message.part.updated" && (e.properties as { part?: { type?: string } }).part?.type === "tool",
  );
  ok("SSE streamed a tool part", toolSse !== undefined);

  const messagesTools = await api<OCMessageWithParts[]>(url, `/session/${sessionId}/message`);
  const allParts = (messagesTools.body ?? []).flatMap((m) => m.parts);
  const toolPart = allParts.find((p) => p.type === "tool") as
    | {
        type: "tool";
        tool: string;
        state: { status: string; input: Record<string, unknown>; output?: string };
      }
    | undefined;
  ok("message list contains a tool part", toolPart !== undefined);
  ok(
    "tool part is bash + completed (v2 ToolState)",
    toolPart !== undefined && toolPart.tool === "bash" && toolPart.state?.status === "completed",
    JSON.stringify(toolPart)?.slice(0, 240),
  );
  ok(
    "tool part state.input carries the command",
    toolPart !== undefined && String(toolPart.state?.input?.command ?? "").includes("tool-smoke-marker"),
    JSON.stringify(toolPart?.state?.input),
  );
  ok(
    "tool part state.output carries the stdout",
    toolPart !== undefined && (toolPart.state?.output ?? "").includes("tool-smoke-marker"),
    JSON.stringify(toolPart?.state?.output)?.slice(0, 160),
  );
  ok("final text answer after tools", textOf(lastAssistant(messagesTools.body)).includes("TOOLS-DONE"), textOf(lastAssistant(messagesTools.body)).slice(0, 120));

  // 4. rename
  const renamed = await api<OCSession>(url, `/session/${sessionId}`, { method: "PATCH", body: JSON.stringify({ title: "smoke-renamed" }) });
  ok("PATCH rename", renamed.status === 200 && renamed.body.title === "smoke-renamed");

  sse.stop();

  // 5. restart recovery
  console.log("— restart recovery —");
  await server.stop();
  ok("adapter state file written", existsSync(STATE_FILE));

  const server2 = await startServer();
  const url2 = server2.url;
  const sse2 = new SseCollector(url2);
  await sse2.start();

  const listed = await api<OCSession[]>(url2, "/session");
  ok("session survives adapter restart", listed.status === 200 && listed.body.some((s) => s.id === sessionId && s.title === "smoke-renamed"), JSON.stringify(listed.body).slice(0, 200));

  let hydrated: OCMessageWithParts[] | undefined;
  for (let i = 0; i < 30; i++) {
    const m = await api<OCMessageWithParts[]>(url2, `/session/${sessionId}/message`);
    if ((m.body ?? []).length >= 2) {
      hydrated = m.body;
      break;
    }
    await sleep(500);
  }
  ok("history hydrated from mcode messages.jsonl", (hydrated ?? []).length >= 2, `${(hydrated ?? []).length} messages`);
  // mcode's messages.jsonl persists only text/thinking blocks — tool parts do
  // not survive restarts (verified 2026-09-21: probe session store contains
  // no tool blocks). Hydration assertions therefore cover text only.
  const allAssistantText = (hydrated ?? [])
    .filter((m) => m.info.role === "assistant")
    .map((m) => textOf(m))
    .join("\n");
  ok("hydrated history contains both answers", allAssistantText.includes("SMOKE-SYNC-OK") && allAssistantText.includes("TOOLS-DONE"), allAssistantText.slice(0, 160));
  const hydratedUser = (hydrated ?? []).find((m) => m.info.role === "user");
  ok("hydrated user text stripped of runtime wrappers", hydratedUser !== undefined && !textOf(hydratedUser).includes("system-reminder"));

  // 6. post-restart prompt (proves --session resume through the adapter)
  const postRestart = await api<OCMessageWithParts>(url2, `/session/${sessionId}/message`, { method: "POST", body: promptBody("Earlier I asked you to reply with an exact marker word twice. What was the second one? Answer with just that marker.") });
  ok("prompt after restart (mcode session resume)", postRestart.status === 200 && /SMOKE-SYNC-OK/i.test(textOf(postRestart.body)), textOf(postRestart.body).slice(0, 160));

  // 7. delete
  const del = await api<unknown>(url2, `/session/${sessionId}`, { method: "DELETE" });
  ok("DELETE session", del.status === 200);
  const listedAfter = await api<OCSession[]>(url2, "/session");
  ok("session gone from list", !listedAfter.body.some((s) => s.id === sessionId));

  sse2.stop();
  await server2.stop();

  console.log(`\n${failures === 0 ? "ALL PASS" : "FAILURES"}: ${checks - failures}/${checks} checks passed`);
  rmSync(WORKSPACE, { recursive: true, force: true });
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("smoke crashed:", err);
  if (existsSync(STATE_FILE)) {
    console.error("state file tail:", readFileSync(STATE_FILE, "utf8").slice(-500));
  }
  process.exit(1);
});
