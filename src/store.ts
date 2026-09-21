/**
 * Adapter state persistence: the OC-session ↔ mcode-session mapping survives
 * adapter restarts (openchamber-pi kept this in memory only; mcode's on-disk
 * session store makes recovery cheap, so we do it).
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { OCModelRef } from "./types.js";

export interface StoredSession {
  ocId: string;
  /** mcode session id once the first prompt has run (lazy binding). */
  mcodeId?: string;
  directory: string;
  title: string;
  createdMs: number;
  updatedMs: number;
  /** Model used for / last used in this session. */
  model?: OCModelRef;
}

interface StateFile {
  schemaVersion: 1;
  sessions: StoredSession[];
}

function defaultStateFile(): string {
  return process.env.OCMC_STATE_FILE ?? join(homedir(), ".openchamber-mcode", "adapter-state.json");
}

export class Store {
  private sessions = new Map<string, StoredSession>();
  private saveTimer: NodeJS.Timeout | undefined;

  constructor(private file: string = defaultStateFile()) {}

  load(): void {
    try {
      if (!existsSync(this.file)) return;
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as StateFile;
      if (raw.schemaVersion !== 1 || !Array.isArray(raw.sessions)) return;
      for (const s of raw.sessions) {
        if (typeof s.ocId === "string" && typeof s.directory === "string") {
          this.sessions.set(s.ocId, s);
        }
      }
    } catch (err) {
      console.error(`[store] failed to load ${this.file}:`, err instanceof Error ? err.message : err);
    }
  }

  all(): StoredSession[] {
    return [...this.sessions.values()];
  }

  get(ocId: string): StoredSession | undefined {
    return this.sessions.get(ocId);
  }

  upsert(s: StoredSession): void {
    this.sessions.set(s.ocId, s);
    this.scheduleSave();
  }

  delete(ocId: string): void {
    this.sessions.delete(ocId);
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.saveTimer !== undefined) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 200);
    this.saveTimer.unref();
  }

  saveNow(): void {
    if (this.saveTimer !== undefined) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    const state: StateFile = { schemaVersion: 1, sessions: [...this.sessions.values()] };
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(state, null, 2));
    } catch (err) {
      console.error(`[store] failed to write ${this.file}:`, err instanceof Error ? err.message : err);
    }
  }
}
