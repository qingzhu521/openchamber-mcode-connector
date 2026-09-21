/**
 * Model/provider catalog from `mcode provider list --json`, translated into
 * OpenCode v2 Provider/Model shapes, cached for the adapter lifetime.
 *
 * OpenChamber's picker silently falls back to the FIRST listed
 * provider/model when it cannot match the default — the default provider and
 * model are sorted to the front for that reason (same lesson as openchamber-pi).
 */

import { mcodeOnce } from "./mcode-exec.js";

interface McodeProviderEntry {
  providerId?: string;
  name?: string;
  kind?: string;
  active?: boolean;
  enabled?: boolean;
  readOnly?: boolean;
  apiFormat?: string;
  baseUrl?: string;
  models?: Array<{
    modelId?: string;
    displayName?: string;
    selected?: boolean;
    contextLimit?: number;
    maxOutputTokens?: number;
  }>;
}

interface McodeProviderList {
  minimaxModelSource?: string;
  providers?: McodeProviderEntry[];
}

interface OCv2Model {
  id: string;
  providerID: string;
  api: { id: string; url: string; npm: string };
  name: string;
  capabilities: {
    temperature: boolean;
    reasoning: boolean;
    attachment: boolean;
    toolcall: boolean;
    input: { text: boolean; audio: boolean; image: boolean; video: boolean; pdf: boolean };
    output: { text: boolean; audio: boolean; image: boolean; video: boolean; pdf: boolean };
    interleaved: boolean;
  };
  cost: { input: number; output: number; cache: { read: number; write: number } };
  limit: { context: number; output: number };
  options: Record<string, unknown>;
}

export interface OCv2Provider {
  id: string;
  name: string;
  source: "config";
  env: string[];
  options: Record<string, unknown>;
  models: Record<string, OCv2Model>;
}

export interface Catalog {
  providers: OCv2Provider[];
  /** providerID → default modelID */
  defaults: Record<string, string>;
}

export interface ModelRef {
  providerID: string;
  modelID: string;
}

function toOCModel(providerId: string, baseUrl: string | undefined, m: NonNullable<McodeProviderEntry["models"]>[number]): OCv2Model {
  const modelId = m.modelId ?? "unknown";
  return {
    id: modelId,
    providerID: providerId,
    api: { id: modelId, url: baseUrl ?? "", npm: "mcode" },
    name: m.displayName ?? modelId,
    capabilities: {
      temperature: true,
      reasoning: true, // mcode models stream thinking blocks in practice
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: true,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: m.contextLimit ?? 0, output: m.maxOutputTokens ?? 0 },
    options: {},
  };
}

export async function loadCatalog(): Promise<Catalog> {
  const { stdout, code, stderr } = await mcodeOnce(["provider", "list", "--json"]);
  if (code !== 0) {
    throw new Error(`mcode provider list exited ${code}: ${stderr.slice(0, 400)}`);
  }
  let doc: McodeProviderList;
  try {
    doc = JSON.parse(stdout) as McodeProviderList;
  } catch (err) {
    throw new Error(`mcode provider list: unparseable JSON (${err instanceof Error ? err.message : err})`);
  }

  const providers = new Map<string, OCv2Provider>();
  const defaults: Record<string, string> = {};

  for (const p of doc.providers ?? []) {
    if (!p.enabled || !p.providerId) continue;
    const models = (p.models ?? []).filter((m) => typeof m.modelId === "string");
    if (models.length === 0) continue;
    const oc: OCv2Provider = {
      id: p.providerId,
      name: p.name ?? p.providerId,
      source: "config",
      env: [],
      options: {},
      models: {},
    };
    for (const m of models) {
      oc.models[m.modelId!] = toOCModel(p.providerId, p.baseUrl, m);
      if (m.selected === true) defaults[p.providerId] = m.modelId!;
    }
    providers.set(p.providerId, oc);
  }

  // Default provider/model first (picker fallback quirk).
  const sorted = [...providers.values()].sort((a, b) => {
    const aDef = defaults[a.id] !== undefined ? 0 : 1;
    const bDef = defaults[b.id] !== undefined ? 0 : 1;
    return aDef - bDef;
  });
  for (const p of sorted) {
    const def = defaults[p.id];
    if (!def) continue;
    const entries = Object.entries(p.models).sort(([a], [b]) => (a === def ? -1 : b === def ? 1 : 0));
    p.models = Object.fromEntries(entries);
  }

  return { providers: sorted, defaults };
}

/** The model ref OpenCode sessions should default to. */
export function defaultModelRef(cat: Catalog): ModelRef | undefined {
  for (const [providerID, modelID] of Object.entries(cat.defaults)) {
    return { providerID, modelID };
  }
  const first = cat.providers[0];
  const firstModel = first && Object.keys(first.models)[0];
  if (first && firstModel) return { providerID: first.id, modelID: firstModel };
  return undefined;
}
