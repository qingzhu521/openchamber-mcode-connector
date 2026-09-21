/**
 * Session registry: one OpenCode session maps to one mcode session id, and
 * each prompt runs as one `mcode exec` subprocess (process-per-turn — mcode
 * persists session state itself; we re-attach via `--session`).
 *
 * Also owns the mcode stream-json → OpenCode event translation (the
 * "event bridge": text/reasoning streaming since M1, tool parts since M2).
 * Mirrors openchamber-pi's sessions.ts where the contracts coincide.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { McodeExecRun, type McodeStreamEvent, type McodeRunOutcome, type McodeToolOutput } from "./mcode-exec.js";
import { Store, type StoredSession } from "./store.js";
import { McodeSessionIndex, parseHistory } from "./history.js";
import { defaultModelRef, type Catalog } from "./catalog.js";
import type {
  OCAssistantMessage,
  OCEvent,
  OCMessage,
  OCMessageWithParts,
  OCModelRef,
  OCPart,
  OCPromptBody,
  OCReasoningPart,
  OCSession,
  OCSessionStatus,
  OCTextPart,
  OCToolPart,
  OCUserMessage,
} from "./types.js";

export const ADAPTER_VERSION = "0.1.0";

function id(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

interface StreamingState {
  message: OCAssistantMessage;
  /** True once a tool part was attached — the next text/reasoning item starts a fresh message. */
  hasToolParts: boolean;
}

export interface ManagedSession {
  info: OCSession;
  mcodeId: string | undefined;
  /** Current turn's subprocess (undefined when idle). */
  run: McodeExecRun | undefined;
  /** Prompt serialization chain per session. */
  chain: Promise<void>;
  messages: OCMessageWithParts[];
  status: OCSessionStatus;
  model: OCModelRef;
  streaming: StreamingState | undefined;
  /**
   * mcode item.id → part for the current turn. Turn-scoped (not message-
   * scoped): tool parts can outlive the assistant message they live in when
   * a new text item closes it mid-tool, and their late updates must still
   * find the same part object.
   */
  turnParts: Map<string, OCPart>;
  hydrated: boolean;
}

type EventSink = (directory: string, event: OCEvent) => void;

type CatalogProvider = () => Promise<Catalog>;

const FALLBACK_MODEL: OCModelRef = { providerID: "mcode", modelID: "default" };

export class SessionManager {
  private sessions = new Map<string, ManagedSession>();
  private store = new Store();
  private mcodeIndex = new McodeSessionIndex();

  constructor(
    private emit: EventSink,
    private catalogProvider: CatalogProvider,
  ) {
    this.store.load();
  }

  /** Re-register sessions persisted by a previous adapter run, hydrating history. */
  async restore(): Promise<void> {
    for (const stored of this.store.all()) {
      const now = Date.now();
      const info: OCSession = {
        id: stored.ocId,
        projectID: stored.directory,
        directory: stored.directory,
        title: stored.title,
        version: ADAPTER_VERSION,
        time: { created: stored.createdMs, updated: stored.updatedMs || now },
      };
      const managed: ManagedSession = {
        info,
        mcodeId: stored.mcodeId,
        run: undefined,
        chain: Promise.resolve(),
        messages: [],
        status: { type: "idle" },
        model: stored.model ?? FALLBACK_MODEL,
        streaming: undefined,
        turnParts: new Map(),
        hydrated: false,
      };
      this.sessions.set(info.id, managed);
      this.emit(info.directory, { type: "session.created", properties: { info } });

      // Hydrate history from mcode's messages.jsonl (async, failure-tolerant).
      if (stored.mcodeId !== undefined) {
        void this.hydrate(managed);
      }
    }
  }

  private async hydrate(s: ManagedSession): Promise<void> {
    try {
      const dir = s.mcodeId !== undefined ? this.mcodeIndex.find(s.mcodeId) : undefined;
      if (dir === undefined) return;
      const messages = parseHistory(dir, s.info.id, s.info.directory, s.model);
      if (messages.length > 0) {
        s.messages = messages;
      }
    } catch (err) {
      console.error(`[hydrate] session ${s.info.id} failed:`, err instanceof Error ? err.message : err);
    } finally {
      s.hydrated = true;
    }
  }

  private async fallbackDefaultModel(): Promise<OCModelRef> {
    try {
      const cat = await this.catalogProvider();
      return defaultModelRef(cat) ?? FALLBACK_MODEL;
    } catch {
      return FALLBACK_MODEL;
    }
  }

  async create(directory: string, title?: string, parentID?: string): Promise<OCSession> {
    const now = Date.now();
    const model = await this.fallbackDefaultModel();
    const info: OCSession = {
      id: id("ses"),
      projectID: directory,
      directory,
      title: title ?? "New session",
      version: ADAPTER_VERSION,
      time: { created: now, updated: now },
      ...(parentID !== undefined ? { parentID } : {}),
    };
    const managed: ManagedSession = {
      info,
      mcodeId: undefined, // lazily bound on first prompt
      run: undefined,
      chain: Promise.resolve(),
      messages: [],
      status: { type: "idle" },
      model,
      streaming: undefined,
      turnParts: new Map(),
      hydrated: true,
    };
    this.sessions.set(info.id, managed);
    this.persist(managed);
    this.emit(directory, { type: "session.created", properties: { info } });
    return info;
  }

  list(directory?: string): OCSession[] {
    const all = [...this.sessions.values()].map((s) => s.info);
    return directory === undefined ? all : all.filter((s) => s.directory === directory);
  }

  get(sessionId: string): ManagedSession | undefined {
    return this.sessions.get(sessionId);
  }

  async remove(sessionId: string): Promise<boolean> {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    this.sessions.delete(sessionId);
    this.store.delete(sessionId);
    this.emit(s.info.directory, { type: "session.deleted", properties: { info: s.info } });
    s.run?.abort(); // settled run resolves as cancelled; mcode session data on disk is left alone
    return true;
  }

  rename(sessionId: string, title: string): OCSession | undefined {
    const s = this.sessions.get(sessionId);
    if (!s) return undefined;
    s.info.title = title;
    s.info.time.updated = Date.now();
    this.persist(s);
    this.emit(s.info.directory, { type: "session.updated", properties: { info: s.info } });
    return s.info;
  }

  messages(sessionId: string): OCMessageWithParts[] | undefined {
    return this.sessions.get(sessionId)?.messages;
  }

  statuses(): Record<string, OCSessionStatus> {
    const out: Record<string, OCSessionStatus> = {};
    for (const s of this.sessions.values()) out[s.info.id] = s.status;
    return out;
  }

  async abort(sessionId: string): Promise<boolean> {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    s.run?.abort();
    return true;
  }

  async prompt(sessionId: string, text: string, model?: OCModelRef, noReply = false, messageID?: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`unknown session: ${sessionId}`);

    if (model) s.model = model;

    // OpenChamber sends a client-generated messageID with its optimistic
    // insert; the server MUST reuse it so the echoed message.part.updated /
    // message.updated events reconcile the optimistic entry in place instead
    // of rendering the user's message twice (event-reducer matches by id).
    const userMsg: OCUserMessage = {
      id: typeof messageID === "string" && messageID !== "" ? messageID : id("msg"),
      sessionID: s.info.id,
      role: "user",
      time: { created: Date.now() },
      agent: "build",
      model: s.model,
    };
    const parts: OCPart[] = [
      { id: id("prt"), sessionID: s.info.id, messageID: userMsg.id, type: "text", text },
    ];
    s.messages.push({ info: userMsg, parts });
    s.info.time.updated = Date.now();
    if (s.info.title === "New session") {
      s.info.title = text.slice(0, 60);
      this.emit(s.info.directory, { type: "session.updated", properties: { info: s.info } });
    }
    this.emit(s.info.directory, { type: "message.updated", properties: { info: userMsg } });
    // Echo the user text part: the reducer replaces the client's sessionID-less
    // optimistic part (same type, new id) in place — without this echo a page
    // fetch merges the optimistic part back in and the text shows twice.
    for (const p of parts) this.emitPart(s, p);
    this.persist(s);

    if (noReply) return; // register-only: record the message, do not run the agent

    // Serialize turns per session: one mcode exec process at a time.
    s.chain = s.chain.then(
      () => this.runTurn(s, text),
      () => this.runTurn(s, text),
    );
    await s.chain;
  }

  private async runTurn(s: ManagedSession, text: string): Promise<void> {
    if (s.run !== undefined) {
      await s.run.done; // defensive: chain should already serialize
    }

    this.setStatus(s, { type: "busy" });
    s.turnParts = new Map(); // fresh item→part index for this turn
    const modelArg =
      s.model.providerID !== FALLBACK_MODEL.providerID
        ? `${s.model.providerID}/${s.model.modelID}`
        : undefined;

    const run = new McodeExecRun({
      cwd: s.info.directory,
      prompt: text,
      sessionId: s.mcodeId,
      model: modelArg,
    });
    s.run = run;

    run.on("event", (ev: McodeStreamEvent) => this.onMcodeEvent(s, ev));

    let outcome: McodeRunOutcome;
    try {
      outcome = await run.done;
    } finally {
      if (s.run === run) s.run = undefined;
    }

    // Lazy-bind the mcode session id from the run we just executed.
    if (s.mcodeId === undefined && run.sessionId !== undefined) {
      s.mcodeId = run.sessionId;
      this.persist(s);
    }

    // Track the model actually used (mcode reports it per turn).
    if (outcome.model) {
      s.model = { providerID: outcome.model.providerId, modelID: outcome.model.modelId };
      this.persist(s);
    }

    this.finalizeDanglingTools(s, outcome);
    this.finishStreaming(s, outcome);
    this.setStatus(s, { type: "idle" });
    this.emit(s.info.directory, { type: "session.idle", properties: { sessionID: s.info.id } });

    if (!outcome.aborted && outcome.status !== "succeeded") {
      const message = outcome.failure ?? `mcode exec ${outcome.status}`;
      this.emit(s.info.directory, {
        type: "session.error",
        properties: {
          sessionID: s.info.id,
          error: { name: "UnknownError", data: { message } },
        },
      });
    }
  }

  async disposeAll(): Promise<void> {
    for (const s of this.sessions.values()) s.run?.abort();
    this.store.saveNow();
    this.sessions.clear();
  }

  // ------------------------------------------------------------------
  // persistence
  // ------------------------------------------------------------------

  private persist(s: ManagedSession): void {
    const stored: StoredSession = {
      ocId: s.info.id,
      ...(s.mcodeId !== undefined ? { mcodeId: s.mcodeId } : {}),
      directory: s.info.directory,
      title: s.info.title,
      createdMs: s.info.time.created,
      updatedMs: s.info.time.updated,
      model: s.model,
    };
    this.store.upsert(stored);
  }

  // ------------------------------------------------------------------
  // mcode stream-json → OpenCode event translation
  // ------------------------------------------------------------------

  private setStatus(s: ManagedSession, status: OCSessionStatus): void {
    s.status = status;
    this.emit(s.info.directory, {
      type: "session.status",
      properties: { sessionID: s.info.id, status },
    });
  }

  private emitPart(s: ManagedSession, part: OCPart, delta?: string): void {
    this.emit(s.info.directory, {
      type: "message.part.updated",
      properties: delta === undefined ? { part } : { part, delta },
    });
  }

  private onMcodeEvent(s: ManagedSession, ev: McodeStreamEvent): void {
    if (process.env.OCMC_DEBUG) {
      const target = process.env.OCMC_DEBUG_LOG ?? "/tmp/openchamber-mcode-debug.log";
      appendFileSync(target, `[mcode-event] ${ev.type} seq=${ev.sequence}\n`);
    }

    // Lazy-bind mcode session id as soon as any frame carries it.
    if (s.mcodeId === undefined && ev.sessionId) {
      s.mcodeId = ev.sessionId;
      this.persist(s);
    }

    switch (ev.type) {
      case "session.started":
      case "session.resumed":
      case "turn.started":
      case "exec.started":
        break; // binding/busy handled in runTurn

      case "turn.completed": {
        if (s.streaming && ev.model) {
          s.streaming.message.providerID = ev.model.providerId;
          s.streaming.message.modelID = ev.model.modelId;
        }
        if (s.streaming && ev.usage) {
          this.applyUsage(s.streaming.message, ev.usage);
        }
        if (s.streaming) {
          this.emit(s.info.directory, { type: "message.updated", properties: { info: s.streaming.message } });
        }
        break;
      }

      case "item.started":
      case "item.updated":
      case "item.completed":
        this.onItem(s, ev);
        break;

      case "exec.completed":
        break; // outcome resolved in runTurn; idle emitted there

      default: {
        // Defensive: any *.failed / frame carrying `error` surfaces as session.error.
        if (ev.type.endsWith("failed") || ev.error !== undefined) {
          const message =
            ev.error !== undefined
              ? typeof ev.error === "string"
                ? ev.error
                : JSON.stringify(ev.error).slice(0, 300)
              : `mcode ${ev.type}`;
          this.emit(s.info.directory, {
            type: "session.error",
            properties: {
              sessionID: s.info.id,
              error: { name: "UnknownError", data: { message } },
            },
          });
        }
        break;
      }
    }
  }

  private onItem(s: ManagedSession, ev: McodeStreamEvent): void {
    const item = ev.item;
    if (!item) return;

    if (item.type === "tool_call") {
      this.onToolItem(s, ev);
      return;
    }

    if (item.type !== "reasoning" && item.type !== "agent_message") return;
    const kind: "text" | "reasoning" = item.type === "reasoning" ? "reasoning" : "text";

    const existing = s.turnParts.get(item.id);
    let part: OCTextPart | OCReasoningPart;
    if (existing !== undefined && isTextPart(existing)) {
      part = existing;
    } else if (existing !== undefined) {
      return; // defensive: item id already mapped to a non-text part
    } else {
      // Tool boundary: text/reasoning arriving after tool parts starts a fresh
      // assistant message — this matches mcode's one-record-per-API-response
      // persistence granularity (probe 2026-09-21: text → tools → new text).
      if (s.streaming?.hasToolParts) this.closeStreaming(s);
      const streaming = this.ensureStreaming(s);
      part = this.newPart(kind, s.info.id, streaming.message.id);
      s.turnParts.set(item.id, part);
      const record = s.messages.find((m) => m.info.id === streaming.message.id);
      record?.parts.push(part);
      this.emitPart(s, part);
    }

    if (ev.type === "item.completed") {
      if (typeof item.content === "string") part.text = item.content;
      if (part.time) part.time.end = Date.now();
      this.emitPart(s, part);
    } else if (typeof item.contentDelta === "string" && item.contentDelta !== "") {
      part.text += item.contentDelta;
      this.emitPart(s, part, item.contentDelta);
    }

    if (s.streaming) {
      this.emit(s.info.directory, { type: "message.updated", properties: { info: s.streaming.message } });
    }
  }

  /**
   * tool_call items → OpenCode tool parts (M2). The part attaches to the
   * current streaming assistant message (created when absent, e.g. a
   * tool-first turn); a *new* text item after tool parts closes that
   * message. `state` follows @opencode-ai/sdk v2 ToolState (discriminated on
   * .status; input is a plain record, output is a string, completed carries
   * title+metadata). Live-observed payload (mcode 0.5.0):
   *   started/updated  toolCall {id, name, status 4|5}        (input streaming)
   *   updated          toolCall {..., status 1, input}        (arguments settled)
   *   updated          toolCall {..., status 2|3, output}     (output settled)
   *   completed        toolCall {..., status 2|3, input+output}
   * final status: 2 = success, 3 = error (e.g. ENOENT read).
   */
  private onToolItem(s: ManagedSession, ev: McodeStreamEvent): void {
    const item = ev.item!;
    const tc = item.toolCall;
    if (!tc || typeof tc.name !== "string") return;

    let part = s.turnParts.get(item.id) as OCToolPart | undefined;
    if (!part) {
      const streaming = this.ensureStreaming(s);
      part = {
        id: id("prt"),
        sessionID: s.info.id,
        messageID: streaming.message.id,
        type: "tool",
        callID: typeof tc.id === "string" && tc.id !== "" ? tc.id : item.id,
        tool: tc.name,
        state: { status: "pending", input: {}, raw: "" },
      };
      streaming.hasToolParts = true;
      s.turnParts.set(item.id, part);
      const record = s.messages.find((m) => m.info.id === streaming.message.id);
      record?.parts.push(part);
    }

    const args = (tc.input !== undefined && typeof tc.input === "object" ? tc.input : {}) as Record<string, unknown>;
    const output = tc.output;
    const title = toolTitle(tc.name, args);
    const metadata =
      output?.details !== undefined && Object.keys(output.details).length > 0
        ? { details: output.details }
        : undefined;
    const startedAt = toolStartedAt(part);
    const endedAt = Date.now();

    if (ev.type === "item.completed") {
      if (tc.status === 3) {
        part.state = {
          status: "error",
          input: args,
          error: toolOutputText(output) ?? `tool ${tc.name} failed (status ${tc.status})`,
          ...(metadata !== undefined ? { metadata } : {}),
          time: { start: startedAt, end: endedAt },
        };
      } else {
        part.state = {
          status: "completed",
          input: args,
          output: toolOutputText(output) ?? "",
          title,
          metadata: metadata ?? {},
          time: { start: startedAt, end: endedAt },
        };
      }
    } else if (tc.input !== undefined || tc.output !== undefined) {
      part.state = {
        status: "running",
        input: args,
        title,
        ...(metadata !== undefined ? { metadata } : {}),
        time: { start: startedAt },
      };
    } else if (part.state.status === "pending" && ev.type !== "item.started") {
      part.state = { status: "running", input: args, title, time: { start: startedAt } };
    }

    this.emitPart(s, part);
    const owner = s.messages.find((m) => m.info.id === part!.messageID);
    if (owner) {
      this.emit(s.info.directory, { type: "message.updated", properties: { info: owner.info } });
    }
  }

  /** Tool parts still pending/running when the turn settles never got item.completed. */
  private finalizeDanglingTools(s: ManagedSession, outcome: McodeRunOutcome): void {
    for (const part of s.turnParts.values()) {
      if (part.type !== "tool") continue;
      if (part.state.status === "completed" || part.state.status === "error") continue;
      const start = toolStartedAt(part);
      part.state = outcome.aborted
        ? { status: "error", input: toolInputOf(part), error: "run aborted", time: { start, end: Date.now() } }
        : {
            status: "completed",
            input: toolInputOf(part),
            output: "",
            title: part.tool,
            metadata: {},
            time: { start, end: Date.now() },
          };
      this.emitPart(s, part);
    }
  }

  private ensureStreaming(s: ManagedSession): StreamingState {
    if (s.streaming) return s.streaming;
    const parent = [...s.messages].reverse().find((m) => m.info.role === "user");
    const assistant: OCAssistantMessage = {
      id: id("msg"),
      sessionID: s.info.id,
      role: "assistant",
      time: { created: Date.now() },
      parentID: parent?.info.id ?? "",
      modelID: s.model.modelID,
      providerID: s.model.providerID,
      mode: "build",
      path: { cwd: s.info.directory, root: s.info.directory },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    s.streaming = { message: assistant, hasToolParts: false };
    s.messages.push({ info: assistant, parts: [] });
    this.emit(s.info.directory, { type: "message.updated", properties: { info: assistant } });
    return s.streaming;
  }

  /** Finalize the current streaming assistant message (tool boundary / turn end). */
  private closeStreaming(s: ManagedSession): void {
    if (!s.streaming) return;
    s.streaming.message.time.completed = Date.now();
    this.emit(s.info.directory, { type: "message.updated", properties: { info: s.streaming.message } });
    s.streaming = undefined;
  }

  private finishStreaming(s: ManagedSession, outcome: McodeRunOutcome): void {
    if (!s.streaming) return;
    const msg = s.streaming.message;
    msg.time.completed = Date.now();
    if (outcome.usage) this.applyUsage(msg, outcome.usage);
    if (outcome.model) {
      msg.providerID = outcome.model.providerId;
      msg.modelID = outcome.model.modelId;
    }
    msg.finish = outcome.status; // "succeeded" | "cancelled" | ...
    this.emit(s.info.directory, { type: "message.updated", properties: { info: msg } });
    s.streaming = undefined;
  }

  private newPart(kind: "text" | "reasoning", sessionID: string, messageID: string): OCTextPart | OCReasoningPart {
    const base = {
      id: id("prt"),
      sessionID,
      messageID,
      text: "",
      time: { start: Date.now() },
    };
    return kind === "text"
      ? ({ ...base, type: "text" } satisfies OCTextPart)
      : { ...base, type: "reasoning" };
  }

  private applyUsage(
    msg: OCAssistantMessage,
    usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; totalTokens?: number },
  ): void {
    msg.tokens = {
      input: usage.inputTokens ?? 0,
      output: usage.outputTokens ?? 0,
      reasoning: 0,
      cache: { read: usage.cacheReadTokens ?? 0, write: 0 },
    };
  }
}

// ---------------------------------------------------------------------
// tool payload → OpenCode v2 ToolState helpers
// ---------------------------------------------------------------------

function isTextPart(part: OCPart): part is OCTextPart | OCReasoningPart {
  return part.type === "text" || part.type === "reasoning";
}

/** Start timestamp carried by running/completed/error states; pending has none. */
function toolStartedAt(part: OCToolPart): number {
  const st = part.state;
  if (st.status === "running" || st.status === "completed" || st.status === "error") return st.time.start;
  return Date.now();
}

function toolInputOf(part: OCToolPart): Record<string, unknown> {
  return part.state.input ?? {};
}

/** Human title: `bash: <command>`, `write: <path>`, else the tool name. */
function toolTitle(tool: string, args: Record<string, unknown>): string {
  const cmd = typeof args.command === "string" ? args.command : undefined;
  const path = typeof args.path === "string" ? args.path : undefined;
  const hint = cmd ?? path;
  if (hint === undefined) return tool;
  const short = hint.length > 60 ? `${hint.slice(0, 57)}…` : hint;
  return `${tool}: ${short}`;
}

function toolOutputText(output: McodeToolOutput | undefined): string | undefined {
  if (!output || !Array.isArray(output.content)) return undefined;
  const text = output.content
    .filter((b) => typeof b?.text === "string")
    .map((b) => b.text)
    .join("");
  return text === "" ? undefined : text;
}
