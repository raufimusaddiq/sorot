// Connection settings for the LLM, Jev and Tebar, editable from the studio
// UI and `sorot connect`. Saved in SQLite (`setting` table) over the env
// values: a saved field wins, clearing it (null) goes back to the env. Llm,
// Jev and Tebar read the shared config on every call, so a change applies at
// once — no restart. API keys are never sent back: only whether one is set
// and its last four characters.

import type { AppConfig } from "./config";
import { HttpError } from "./http";
import type { Jev } from "./jev";
import type { Llm } from "./llm";
import type { Store } from "./store";
import type { Tebar } from "./tebar";
import type { Json } from "./types";

type Kind = "url" | "text" | "secret" | "bool";
type Field = [configKey: keyof AppConfig, kind: Kind];

export const CONNECTIONS: Record<string, Record<string, Field>> = {
  llm: {
    enabled: ["llmEnabled", "bool"], baseUrl: ["llmBaseUrl", "url"], model: ["llmModel", "text"],
    apiKey: ["llmApiKey", "secret"], director: ["llmDirector", "bool"],
  },
  jev: { enabled: ["jevEnabled", "bool"], url: ["jevUrl", "url"], model: ["jevModel", "text"], apiKey: ["jevApiKey", "secret"] },
  tebar: { enabled: ["tebarEnabled", "bool"], baseUrl: ["tebarBaseUrl", "url"], apiKey: ["tebarApiKey", "secret"] },
};

export const mask = (key: string) => (key ? `••••${key.length >= 8 ? key.slice(-4) : ""}` : "");

export interface TestResult {
  ok: boolean;
  ms: number;
  model?: string;
  detail?: string;
  error?: string;
}

export class ConnectionSettings {
  /** The env layer, kept so clearing a saved field restores it. */
  private readonly env: Partial<Record<keyof AppConfig, unknown>> = {};

  constructor(
    private readonly config: AppConfig,
    private readonly store: Store,
    private readonly clients: { llm: Llm; jev: Jev; tebar: Tebar },
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
    const active = { llm: this.clients.llm.enabled, jev: this.clients.jev.enabled, tebar: this.clients.tebar.enabled };
    return Object.fromEntries(Object.entries(CONNECTIONS).map(([conn, fields]) => {
      const out: Json = { active: active[conn as keyof typeof active], saved: [] as string[] };
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
    if (!fields) throw new HttpError(404, `Unknown connection: ${conn} (llm, jev or tebar)`);
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
    if (!CONNECTIONS[conn]) throw new HttpError(404, `Unknown connection: ${conn} (llm, jev or tebar)`);
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
      if (!this.clients.tebar.enabled) return done({ ok: false, error: "Not configured: set an API key" });
      const me = await this.clients.tebar.me();
      const who = (me.data ?? me) as Json;
      return done({ ok: true, detail: String(who.email ?? who.name ?? who.id ?? "connected") });
    } catch (e) {
      return done({ ok: false, error: (e as Error).message });
    }
  }
}

function validate(kind: Kind, value: unknown, name: string): unknown {
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
