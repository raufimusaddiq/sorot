// Connection settings for the LLM, Jev and Tebar, editable from the studio
// UI and `sorot connect`. Saved in SQLite (`setting` table) over the env
// values: a saved field wins, clearing it (null) goes back to the env. Llm,
// Jev and Tebar read the shared config on every call, so a change applies at
// once — no restart. API keys are never sent back: only whether one is set
// and its last four characters.

import { Database } from "bun:sqlite";
import { join } from "node:path";
import type { AppConfig } from "./config";
import { HttpError } from "./http";
import type { Narrator } from "./generate/narration";
import { VOICE_ENGINES } from "./generate/narration";
import type { Jev } from "./jev";
import { Llm, LlmError } from "./llm";
import type { Store } from "./store";
import type { Tebar } from "./tebar";
import type { Json } from "./types";

type Kind = "url" | "text" | "secret" | "bool" | "tokens" | "engine" | "voices" | "commands" | "sources";
type Field = [configKey: keyof AppConfig, kind: Kind];

export const CONNECTIONS: Record<string, Record<string, Field>> = {
  llm: {
    enabled: ["llmEnabled", "bool"], baseUrl: ["llmBaseUrl", "url"], model: ["llmModel", "text"],
    apiKey: ["llmApiKey", "secret"], director: ["llmDirector", "bool"],
    vision: ["llmVision", "bool"], visionModel: ["llmVisionModel", "text"], genMaxTokens: ["genLlmMaxTokens", "tokens"],
  },
  jev: {
    enabled: ["jevEnabled", "bool"], url: ["jevUrl", "url"], model: ["jevModel", "text"], apiKey: ["jevApiKey", "secret"],
    director: ["jevDirector", "bool"],
  },
  tebar: { enabled: ["tebarEnabled", "bool"], baseUrl: ["tebarBaseUrl", "url"], apiKey: ["tebarApiKey", "secret"] },
  // Generate: scene images, the narration voice and the local check commands recipes may name.
  image: {
    enabled: ["imageEnabled", "bool"], baseUrl: ["imageBaseUrl", "url"], model: ["imageModel", "text"], apiKey: ["imageApiKey", "secret"],
    size: ["imageSize", "text"], style: ["imageStyle", "text"],
  },
  voice: {
    enabled: ["voiceEnabled", "bool"], engine: ["voiceEngine", "engine"], baseUrl: ["voiceBaseUrl", "url"], model: ["voiceModel", "text"],
    apiKey: ["voiceApiKey", "secret"], voices: ["voiceVoices", "voices"],
  },
  commands: { commands: ["commands", "commands"] },
  data: { sources: ["dataSources", "sources"] },
};

export const mask = (key: string) => (key ? `••••${key.length >= 8 ? key.slice(-4) : ""}` : "");

/** Kenari (kenari.id): an OpenAI-compatible AI gateway offered as this project's default LLM provider. */
export const KENARI_BASE_URL = "https://kenari.id/v1";
export const KENARI_DEFAULT_MODEL = "kenari/auto";

export interface TestResult {
  ok: boolean;
  ms: number;
  model?: string;
  detail?: string;
  error?: string;
}

export interface KenariModel {
  id: string;
  free: boolean;
}

export interface KenariVoiceModel {
  id: string;
  voices: string[];
}

export interface KenariQuotaWindow {
  budgetRp: number;
  remainingRp: number;
  usedFrac: number;
  resetsAt: string;
}

export interface KenariAccount {
  plan: string | null;
  windows: Record<string, KenariQuotaWindow>;
  balanceRp: number;
  usage: { requests: number; promptTokens: number; completionTokens: number };
}

export class ConnectionSettings {
  /** The env layer, kept so clearing a saved field restores it. */
  private readonly env: Partial<Record<keyof AppConfig, unknown>> = {};

  constructor(
    private readonly config: AppConfig,
    private readonly store: Store,
    private readonly clients: { llm: Llm; jev: Jev; tebar: Tebar; narrator?: Narrator },
    /** Same injected fetch (and retry wait) `app.ts` gives the shared `Llm` client, reused to probe a candidate connection without a real network call in tests. */
    private readonly fetchFn: typeof fetch = fetch,
    private readonly retryWaitMs = 2000,
  ) {
    for (const fields of Object.values(CONNECTIONS)) {
      for (const [key] of Object.values(fields)) this.env[key] = config[key];
    }
    this.apply();
  }

  /** Saved values over the env ones. A saved value that no longer validates is ignored. */
  private apply() {
    const saved = this.store.settings();
    for (const [conn, fields] of Object.entries(CONNECTIONS)) {
      for (const [name, [key, kind]] of Object.entries(fields)) {
        const raw = saved[`${conn}.${name}`];
        let value = this.env[key];
        if (raw !== undefined) {
          try {
            value = validate(kind, JSON.parse(raw), name);
          } catch {
            /* keep the env value */
          }
        }
        (this.config as unknown as Record<string, unknown>)[key] = value;
      }
    }
  }

  view(): Json {
    const saved = this.store.settings();
    const c = this.config;
    const active: Record<string, boolean> = {
      llm: this.clients.llm.enabled, jev: this.clients.jev.enabled, tebar: this.clients.tebar.enabled,
      image: c.imageEnabled && !!c.imageBaseUrl && !!c.imageModel && !!c.imageApiKey,
      voice: (this.clients.narrator?.engines.length ?? 0) > 0,
      commands: c.commandsEnabled && c.commands.length > 0,
      data: c.dataSources.length > 0,
    };
    return Object.fromEntries(Object.entries(CONNECTIONS).map(([conn, fields]) => {
      const out: Json = { active: active[conn], saved: [] as string[] };
      if (conn === "voice") Object.assign(out, { engines: VOICE_ENGINES, localAvailable: c.whisperDevice !== "cpu" });
      if (conn === "commands") out.allowed = c.commandsEnabled;
      for (const [name, [key, kind]] of Object.entries(fields)) {
        const v = this.config[key];
        if (kind === "secret") {
          out[`${name}Set`] = !!v;
          out[name] = mask(String(v ?? ""));
        } else out[name] = v;
        if (`${conn}.${name}` in saved) (out.saved as string[]).push(name);
      }
      return [conn, out];
    }));
  }

  /** Patch one connection: a value saves it, null clears it (back to the env); unknown fields are a 400. */
  update(conn: string, patch: Json): Json {
    const fields = CONNECTIONS[conn];
    if (!fields) throw new HttpError(404, `Unknown connection: ${conn} (${Object.keys(CONNECTIONS).join(", ")})`);
    if (conn === "commands" && !this.config.commandsEnabled) throw new HttpError(409, "Custom commands are off on this install (set GEN_COMMANDS=1 to allow them)");
    if (conn === "voice" && patch.engine === "local" && this.config.whisperDevice === "cpu") throw new HttpError(409, "the local voice needs a GPU install");
    const writes: Array<[string, string | null]> = [];
    for (const [name, value] of Object.entries(patch)) {
      const field = fields[name];
      if (!field) throw new HttpError(400, `${conn} has no setting "${name}" (${Object.keys(fields).join(", ")})`);
      writes.push([`${conn}.${name}`, value === null ? null : JSON.stringify(validate(field[1], value, name))]);
    }
    this.store.transaction(() => { for (const [k, v] of writes) this.store.setSetting(k, v); });
    this.apply();
    return this.view();
  }

  /** A tiny real call through the configured connection. */
  async test(conn: string): Promise<TestResult> {
    if (!CONNECTIONS[conn]) throw new HttpError(404, `Unknown connection: ${conn} (${Object.keys(CONNECTIONS).join(", ")})`);
    const t0 = performance.now();
    const done = (r: Omit<TestResult, "ms">): TestResult => ({ ...r, ms: Math.round(performance.now() - t0) });
    try {
      if (conn === "llm") {
        if (!this.clients.llm.enabled) return done({ ok: false, error: "Not configured: set a base URL and a model" });
        const msg = await this.clients.llm.chat([{ role: "user", content: "Reply with the single word OK." }], { temperature: 0 });
        return done({ ok: true, model: this.clients.llm.model, detail: msg.content.trim().slice(0, 60) });
      }
      if (conn === "jev") {
        if (!this.clients.jev.enabled) return done({ ok: false, error: "Not configured: set an API key" });
        const d = await this.clients.jev.decide({ message: "Sorot connection test" },
          { test: { type: "noul", instructions: "Is `message` a connection test?" } });
        return done({ ok: true, model: d.model, detail: `answered ${(d.answers.test as { noul: number }).noul.toFixed(2)}` });
      }
      if (conn === "image") {
        const c = this.config;
        const missing = [["a base URL", c.imageBaseUrl], ["a model", c.imageModel], ["an API key", c.imageApiKey]].filter(([, v]) => !v).map(([n]) => n);
        return missing.length || !c.imageEnabled ? done({ ok: false, error: `Not configured: set ${missing.join(", ") || "it on"}` }) : done({ ok: true, model: c.imageModel, detail: `images ${c.imageSize}` });
      }
      if (conn === "voice") {
        if (!this.clients.narrator?.engines.length) return done({ ok: false, error: "Not configured: pick an engine and add its key or URL" });
        return done({ ok: true, detail: await this.clients.narrator.ping(join(this.config.dataDir, "voice-test")) });
      }
      if (conn === "data") return done(testSources(this.config.dataSources));
      if (conn === "commands") {
        const n = this.config.commands.length;
        return !this.config.commandsEnabled ? done({ ok: false, error: "Custom commands are off on this install" }) : n ? done({ ok: true, detail: `${n} command${n > 1 ? "s" : ""}` }) : done({ ok: false, error: "No commands registered" });
      }
      if (!this.clients.tebar.enabled) return done({ ok: false, error: "Not configured: set an API key" });
      const me = await this.clients.tebar.me();
      const who = (me.data ?? me) as Json;
      return done({ ok: true, detail: String(who.email ?? who.name ?? who.id ?? "connected") });
    } catch (e) {
      return done({ ok: false, error: (e as Error).message });
    }
  }

  /**
   * Validate a candidate LLM connection (not yet saved) with one small real chat call — lets
   * onboarding confirm a key works before `update("llm", …)` commits it. `baseUrl` defaults to
   * Kenari's; never persists anything, never echoes `apiKey` back.
   */
  async probe(candidate: Record<string, unknown>): Promise<TestResult> {
    const model = validate("text", candidate.model, "model") as string;
    const apiKey = validate("secret", candidate.apiKey, "apiKey") as string;
    const baseUrl = candidate.baseUrl === undefined || candidate.baseUrl === "" ? KENARI_BASE_URL : (validate("url", candidate.baseUrl, "baseUrl") as string);
    const t0 = performance.now();
    const done = (r: Omit<TestResult, "ms">): TestResult => ({ ...r, ms: Math.round(performance.now() - t0) });
    const candidateLlm = new Llm({ llmBaseUrl: baseUrl, llmModel: model, llmApiKey: apiKey, llmTimeoutSec: this.config.llmTimeoutSec }, this.fetchFn, this.retryWaitMs);
    try {
      const msg = await candidateLlm.chat([{ role: "user", content: "Reply with the single word OK." }], { temperature: 0 });
      return done({ ok: true, model, detail: msg.content.trim().slice(0, 60) });
    } catch (e) {
      return done({ ok: false, error: e instanceof LlmError ? e.message : (e as Error).message });
    }
  }

  /**
   * Kenari's own model catalog (`GET /v1/models`) — public, no key needed. `undefined` returns
   * every chat-capable model (the default list); an endpoint name (`"images"`, `"audio_speech"`,
   * …) filters to models offering it. Never throws: a fetch failure comes back as `{ warning }`.
   */
  private async kenariCatalog(endpoint?: string): Promise<{ rows: Array<Record<string, unknown>> } | { warning: string }> {
    try {
      const res = await this.fetchFn(`${KENARI_BASE_URL}/models`);
      if (!res.ok) throw new Error(`Kenari HTTP ${res.status}`);
      const data = (await res.json()) as { data?: Array<Record<string, unknown>> };
      const all = (data.data ?? []).filter((m) => typeof m.id === "string");
      return { rows: endpoint ? all.filter((m) => Array.isArray(m.endpoints) && (m.endpoints as unknown[]).includes(endpoint)) : all };
    } catch (e) {
      return { warning: (e as Error).message };
    }
  }

  private async catalog<T>(endpoint: string | undefined, map: (m: Record<string, unknown>) => T): Promise<{ models: T[]; warning?: string }> {
    const result = await this.kenariCatalog(endpoint);
    return "warning" in result ? { models: [], warning: result.warning } : { models: result.rows.map(map) };
  }

  /** Every chat-capable Kenari model, for the LLM onboarding picker. */
  async kenariModels(): Promise<{ models: KenariModel[]; warning?: string }> {
    return this.catalog(undefined, (m) => ({ id: m.id as string, free: !!(m.pricing as { free?: unknown } | undefined)?.free }));
  }

  /** Kenari's image-generation models (`endpoints` includes `"images"`), for the image onboarding picker. */
  async kenariImageModels(): Promise<{ models: KenariModel[]; warning?: string }> {
    return this.catalog("images", (m) => ({ id: m.id as string, free: !!(m.pricing as { free?: unknown } | undefined)?.free }));
  }

  /** Kenari's text-to-speech models (`endpoints` includes `"audio_speech"`) and each one's voice ids, for the voice onboarding picker. */
  async kenariVoiceModels(): Promise<{ models: KenariVoiceModel[]; warning?: string }> {
    return this.catalog("audio_speech", (m) => ({ id: m.id as string, voices: Array.isArray(m.voices) ? (m.voices as string[]) : [] }));
  }

  /**
   * The saved connection's Kenari balance, plan quota and usage totals — so a user never has to
   * leave Sorot to check "how much do I have left." `null` when the saved connection isn't
   * Kenari, or on a restricted/shared key that can't read account data (Kenari answers those
   * with 403), or on a fetch failure; never throws.
   */
  async kenariAccount(): Promise<{ account: KenariAccount | null; warning?: string }> {
    if (this.config.llmBaseUrl !== KENARI_BASE_URL || !this.config.llmApiKey) return { account: null };
    const headers = { Authorization: `Bearer ${this.config.llmApiKey}` };
    try {
      const [balanceRes, quotaRes, usageRes] = await Promise.all([
        this.fetchFn(`${KENARI_BASE_URL}/account/balance`, { headers }),
        this.fetchFn(`${KENARI_BASE_URL}/account/quota`, { headers }),
        this.fetchFn(`${KENARI_BASE_URL}/usage`, { headers }),
      ]);
      const failed = [balanceRes, quotaRes, usageRes].find((r) => !r.ok);
      if (failed) return { account: null, warning: `Kenari HTTP ${failed.status}` };
      const balance = (await balanceRes.json()) as { balance_micro_idr?: number };
      const quota = (await quotaRes.json()) as { plan?: { name?: string; windows?: Record<string, { budget_rp?: number; remaining_rp?: number; used_frac?: number; resets_at?: string }> } };
      const usage = (await usageRes.json()) as { total?: { requests?: number; prompt_tokens?: number; completion_tokens?: number } };
      const windows: Record<string, KenariQuotaWindow> = {};
      for (const [name, w] of Object.entries(quota.plan?.windows ?? {})) {
        windows[name] = { budgetRp: w.budget_rp ?? 0, remainingRp: w.remaining_rp ?? 0, usedFrac: w.used_frac ?? 0, resetsAt: w.resets_at ?? "" };
      }
      return {
        account: {
          plan: quota.plan?.name ?? null,
          windows,
          balanceRp: Math.round((balance.balance_micro_idr ?? 0) / 1_000_000),
          usage: { requests: usage.total?.requests ?? 0, promptTokens: usage.total?.prompt_tokens ?? 0, completionTokens: usage.total?.completion_tokens ?? 0 },
        },
      };
    } catch (e) {
      return { account: null, warning: (e as Error).message };
    }
  }
}

const SLUG = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** Opens every source read-only and counts its tables, so a wrong path shows up here and not in the middle of a research run. */
function testSources(sources: AppConfig["dataSources"]): Omit<TestResult, "ms"> {
  if (!sources.length) return { ok: false, error: "No data sources registered" };
  const lines: string[] = [];
  for (const s of sources) {
    try {
      const db = new Database(s.path, { readonly: true });
      const n = (db.query("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number }).n;
      db.close();
      lines.push(`${s.name}: ${n} table${n === 1 ? "" : "s"}`);
    } catch (e) {
      return { ok: false, error: `${s.name} can't be opened: ${(e as Error).message}` };
    }
  }
  return { ok: true, detail: lines.join(", ") };
}

function validate(kind: Kind, value: unknown, name: string): unknown {
  if (kind === "sources") {
    if (!Array.isArray(value) || value.length > 20) throw new HttpError(400, `${name} must be a list of at most 20 data sources`);
    const names = new Set<string>();
    return value.map((s, i) => {
      const o = (typeof s === "object" && s !== null ? s : {}) as Record<string, unknown>;
      if (typeof o.name !== "string" || !SLUG.test(o.name)) throw new HttpError(400, `sources[${i}].name: lowercase letters, digits, dashes and underscores`);
      if (names.has(o.name)) throw new HttpError(400, `sources[${i}].name: ${o.name} is listed twice`);
      names.add(o.name);
      if (o.kind !== "sqlite") throw new HttpError(400, `sources[${i}].kind: only "sqlite" is supported`);
      if (typeof o.path !== "string" || !o.path.trim() || o.path.length > 500) throw new HttpError(400, `sources[${i}].path: give the path of the SQLite file`);
      return { name: o.name, kind: "sqlite", path: o.path.trim() };
    });
  }
  if (kind === "voices") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new HttpError(400, `${name} must map a language to a voice id`);
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.some(([lang, id]) => !/^[a-z]{2,7}$|^default$/.test(lang) || typeof id !== "string" || id.length > 120)) throw new HttpError(400, `${name}: use {"id": "<voice id>", "en": "<voice id>"}`);
    return Object.fromEntries(entries.map(([lang, id]) => [lang, (id as string).trim()]));
  }
  if (kind === "commands") {
    if (!Array.isArray(value) || value.length > 20) throw new HttpError(400, `${name} must be a list of at most 20 commands`);
    const names = new Set<string>();
    return value.map((c, i) => {
      const o = (typeof c === "object" && c !== null ? c : {}) as Record<string, unknown>;
      const cmd = typeof o.cmd === "string" ? o.cmd.trim() : "";
      const args = o.args === undefined ? [] : o.args;
      const timeoutSec = o.timeoutSec === undefined ? 60 : o.timeoutSec;
      if (typeof o.name !== "string" || !SLUG.test(o.name)) throw new HttpError(400, `commands[${i}].name: lowercase letters, digits, dashes and underscores`);
      if (names.has(o.name)) throw new HttpError(400, `commands[${i}].name: ${o.name} is listed twice`);
      names.add(o.name);
      if (!cmd || cmd.length > 300) throw new HttpError(400, `commands[${i}].cmd: give the program to run`);
      if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) throw new HttpError(400, `commands[${i}].args: a list of text`);
      if (typeof timeoutSec !== "number" || !Number.isInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > 600) throw new HttpError(400, `commands[${i}].timeoutSec: 1 to 600`);
      return { name: o.name, cmd, args, timeoutSec };
    });
  }
  if (kind === "engine") {
    if (typeof value !== "string" || (value && !(VOICE_ENGINES as readonly string[]).includes(value))) throw new HttpError(400, `${name} must be one of ${VOICE_ENGINES.join(", ")}`);
    return value;
  }
  if (kind === "tokens") {
    const n = typeof value === "string" && value.trim() ? Number(value) : value;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 256 || n > 200_000) throw new HttpError(400, `${name} must be a whole number of tokens from 256 to 200000`);
    return n;
  }
  if (kind === "bool") {
    if (typeof value !== "boolean") throw new HttpError(400, `${name} must be true or false`);
    return value;
  }
  if (typeof value !== "string") throw new HttpError(400, `${name} must be text`);
  const v = value.trim();
  if (kind === "url" && v && !/^https?:\/\/\S+$/i.test(v)) throw new HttpError(400, `${name} must be an http(s) URL`);
  if (kind === "secret" && /\s/.test(v)) throw new HttpError(400, `${name} must not contain spaces`);
  if (v.length > (kind === "secret" ? 500 : 300)) throw new HttpError(400, `${name} is too long`);
  return v;
}
