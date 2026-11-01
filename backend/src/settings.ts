// Connection settings for the LLM, Jev and Tebar, editable from the studio
// UI and `sorot connect`. Saved in SQLite (`setting` table) over the env
// values: a saved field wins, clearing it (null) goes back to the env. Llm,
// Jev and Tebar read the shared config on every call, so a change applies at
// once — no restart. API keys are never sent back: only whether one is set
// and its last four characters.

import { join } from "node:path";
import type { AppConfig } from "./config";
import { HttpError } from "./http";
import type { Narrator } from "./generate/narration";
import { VOICE_ENGINES } from "./generate/narration";
import type { Jev } from "./jev";
import type { Llm } from "./llm";
import type { Store } from "./store";
import type { Tebar } from "./tebar";
import type { Json } from "./types";

type Kind = "url" | "text" | "secret" | "bool" | "engine" | "voices" | "commands";
type Field = [configKey: keyof AppConfig, kind: Kind];

export const CONNECTIONS: Record<string, Record<string, Field>> = {
  llm: {
    enabled: ["llmEnabled", "bool"], baseUrl: ["llmBaseUrl", "url"], model: ["llmModel", "text"],
    apiKey: ["llmApiKey", "secret"], director: ["llmDirector", "bool"],
    vision: ["llmVision", "bool"], visionModel: ["llmVisionModel", "text"],
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
    private readonly clients: { llm: Llm; jev: Jev; tebar: Tebar; narrator?: Narrator },
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
}

const SLUG = /^[a-z0-9][a-z0-9_-]{0,39}$/;

function validate(kind: Kind, value: unknown, name: string): unknown {
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
