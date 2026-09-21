/**
 * History recovery from mcode's on-disk session store (read-only).
 *
 * mcode persists sessions under (default) ~/.minimax/v2/sessions as
 * YYYY/MM/DD/<timestamp>-session_<base64>/ containing:
 *   manifest.json   {sessionId, paths:{...}} — absolute paths
 *   messages.jsonl  one JSON record per message:
 *     {message_id, turn_id, message:{role, content[], timestamp}}
 *     user content blocks:      {type:"text", text}
 *     assistant content blocks: {type:"thinking", thinking} | {type:"text", text}
 *
 * We hydrate OpenCode messages from messages.jsonl so an adapter restart does
 * not lose chat history. Any parse failure degrades to empty history — the
 * session itself stays usable via `mcode exec --session`.
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  OCMessageWithParts,
  OCModelRef,
  OCPart,
  OCAssistantMessage,
  OCUserMessage,
} from "./types.js";

interface McodeManifest {
  sessionId?: string;
}

interface McodeMessageRecord {
  message_id?: string;
  message?: {
    role?: string;
    content?: Array<{ type?: string; text?: string; thinking?: string }>;
    timestamp?: number;
  };
}

function sessionsRoot(): string {
  return process.env.OCMC_SESSIONS_ROOT ?? join(homedir(), ".minimax", "v2", "sessions");
}

function id(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

/** Strip mcode runtime injection wrappers from user-visible text. */
export function stripRuntimeWrappers(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<media-output-reminder>[\s\S]*?<\/media-output-reminder>/g, "")
    .trim();
}

/**
 * Build an index mcodeSessionId → session dir by walking the dated tree and
 * reading manifest.json. Cached per process; rebuilt once on a miss in case
 * the session was created after boot.
 */
export class McodeSessionIndex {
  private cache = new Map<string, string>();
  private built = false;

  private build(): void {
    this.cache.clear();
    const root = sessionsRoot();
    try {
      for (const year of readdirSync(root)) {
        const yearDir = join(root, year);
        if (!statSync(yearDir).isDirectory()) continue;
        for (const month of readdirSync(yearDir)) {
          const monthDir = join(yearDir, month);
          if (!statSync(monthDir).isDirectory()) continue;
          for (const day of readdirSync(monthDir)) {
            const dayDir = join(monthDir, day);
            if (!statSync(dayDir).isDirectory()) continue;
            for (const entry of readdirSync(dayDir)) {
              const sessionDir = join(dayDir, entry);
              const manifestPath = join(sessionDir, "manifest.json");
              try {
                if (!existsSync(manifestPath)) continue;
                const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as McodeManifest;
                if (typeof manifest.sessionId === "string") {
                  this.cache.set(manifest.sessionId, sessionDir);
                }
              } catch {
                /* unreadable manifest — skip */
              }
            }
          }
        }
      }
    } catch {
      /* root missing / unreadable — empty index */
    }
    this.built = true;
  }

  find(mcodeSessionId: string): string | undefined {
    if (!this.built) this.build();
    let hit = this.cache.get(mcodeSessionId);
    if (hit === undefined) {
      this.build(); // session may have been created after boot
      hit = this.cache.get(mcodeSessionId);
    }
    return hit;
  }
}

/**
 * Parse messages.jsonl into OpenCode messages. Failure-tolerant: a corrupt
 * tail line is skipped, an unreadable file yields [].
 */
export function parseHistory(sessionDir: string, ocSessionId: string, directory: string, fallbackModel: OCModelRef): OCMessageWithParts[] {
  const file = join(sessionDir, "messages.jsonl");
  if (!existsSync(file)) return [];
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }

  const out: OCMessageWithParts[] = [];
  let lastUserParent = "";
  let partSeq = 0;

  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let rec: McodeMessageRecord;
    try {
      rec = JSON.parse(line) as McodeMessageRecord;
    } catch {
      continue;
    }
    const msg = rec.message;
    if (!msg || typeof msg.role !== "string" || !Array.isArray(msg.content)) continue;
    const created = typeof msg.timestamp === "number" ? msg.timestamp : Date.now();

    if (msg.role === "user") {
      const texts = msg.content
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text!)
        .map(stripRuntimeWrappers)
        .filter((t) => t !== "");
      if (texts.length === 0) continue;
      const user: OCUserMessage = {
        id: rec.message_id ?? id("msg"),
        sessionID: ocSessionId,
        role: "user",
        time: { created },
        agent: "build",
        model: fallbackModel,
      };
      const parts: OCPart[] = texts.map((text) => ({
        id: id("prt"),
        sessionID: ocSessionId,
        messageID: user.id,
        type: "text" as const,
        text,
      }));
      lastUserParent = user.id;
      out.push({ info: user, parts });
      partSeq += parts.length;
      continue;
    }

    if (msg.role === "assistant") {
      const assistant: OCAssistantMessage = {
        id: rec.message_id ?? id("msg"),
        sessionID: ocSessionId,
        role: "assistant",
        time: { created, completed: created },
        parentID: lastUserParent,
        modelID: fallbackModel.modelID,
        providerID: fallbackModel.providerID,
        mode: "build",
        path: { cwd: directory, root: directory },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      };
      const parts: OCPart[] = [];
      for (const block of msg.content) {
        if (block.type === "thinking" && typeof block.thinking === "string") {
          parts.push({ id: id("prt"), sessionID: ocSessionId, messageID: assistant.id, type: "reasoning", text: block.thinking });
        } else if (block.type === "text" && typeof block.text === "string") {
          parts.push({ id: id("prt"), sessionID: ocSessionId, messageID: assistant.id, type: "text", text: block.text });
        }
      }
      if (parts.length === 0) continue;
      out.push({ info: assistant, parts });
      partSeq += parts.length;
    }
  }

  void partSeq; // (kept for debugging clarity)
  return out;
}
