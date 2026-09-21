/**
 * Session registry: one OpenCode session maps to one mcode session id, and
 * each prompt runs as one `mcode exec` subprocess (process-per-turn — mcode
 * persists session state itself; we re-attach via `--session`).
 *
 * Also owns the mcode stream-json → OpenCode event translation (the M1
 * "event bridge"). Mirrors openchamber-pi's sessions.ts where the contracts
 * coincide.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { McodeExecRun, type McodeStreamEvent, type McodeRunOutcome } from "./mcode-exec.js";
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
  OCSession,
  OCSessionStatus,
  OCTextPart,
  OCUserMessage,
} from "./types.js";

export const ADAPTER_VERSION = "0.1.0";

function id(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

interface StreamingState {
  message: OCAssistantMessage;
  /** mcode item.id → part; mcode addresses streaming content by stable item id. */
  partsByItem: Map<string, OCPart>;
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

  async prompt(sessionId: string, text: string, model?: OCModelRef, noReply = false): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`unknown session: ${sessionId}`);

    if (model) s.model = model;

    const userMsg: OCUserMessage = {
      id: id("msg"),
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
      // M2: map to an OpenCode tool part. For now, a tool boundary closes the
      // current assistant message so the next text starts a fresh one (this
      // matches how mcode persists one assistant record per API response, and
      // therefore how history hydration splits messages).
      if (s.streaming) {
        s.streaming.message.time.completed = Date.now();
        this.emit(s.info.directory, { type: "message.updated", properties: { info: s.streaming.message } });
        s.streaming = undefined;
      }
      return;
    }

    if (item.type !== "reasoning" && item.type !== "agent_message") return;
    const kind: "text" | "reasoning" = item.type === "reasoning" ? "reasoning" : "text";

    const streaming = this.ensureStreaming(s);
    let part = streaming.partsByItem.get(item.id);
    if (!part) {
      part = this.newPart(kind, s.info.id, streaming.message.id);
      streaming.partsByItem.set(item.id, part);
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

    this.emit(s.info.directory, { type: "message.updated", properties: { info: streaming.message } });
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
    s.streaming = { message: assistant, partsByItem: new Map() };
    s.messages.push({ info: assistant, parts: [] });
    this.emit(s.info.directory, { type: "message.updated", properties: { info: assistant } });
    return s.streaming;
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

  private newPart(kind: "text" | "reasoning", sessionID: string, messageID: string): OCPart {
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
