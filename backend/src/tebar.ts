// Tebar (tebar.app) REST client: one API key publishes to the accounts the
// user connected there (TikTok, Instagram, YouTube, Threads, X…) and reads
// their post metrics back. https://docs.tebar.app/api — JSON, snake_case,
// Bearer key, errors as {"error": {"code", "message"}}.
//
// Sorot is local, so it polls (Tebar's webhooks need a public https URL).
// Off unless TEBAR_API_KEY is set (env, or the UI / CLI connection settings).
//
// Workspaces: a Tebar account can hold several profiles ("workspaces"), each
// with its own social accounts. A post (and its media) belongs to one profile,
// chosen with the `Tebar-Profile` header (docs.tebar.app/api/profile).

import { statSync } from "node:fs";
import type { AppConfig } from "./config";
import type { Json } from "./types";

export class TebarError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null) {
    super(message);
  }
}

export interface TebarAccount {
  id: string;
  platform: string;
  name: string;
  /** The workspace (Tebar profile) it belongs to; null with a single workspace. */
  profileId: string | null;
  profileName: string | null;
}

export interface TebarProfile {
  id: string;
  name: string;
}

/** What the user can do about the error codes they can fix (docs.tebar.app/api/error). */
const HINTS: Record<string, string> = {
  insufficient_scope: "this API key can only read: create a read + write key at tebar.app",
  invalid_api_key: "the API key is wrong or revoked: create a new one at tebar.app",
  plan_required: "Tebar's API needs a paid plan (Starter, Basic or Pro)",
  account_expired: "reconnect this account at tebar.app",
  publishing_limit_reached: "this account reached its posting limit for now: try again later",
  mixed_profiles: "pick accounts from one workspace",
  tiktok_privacy_required: "choose who can see it on TikTok, or post it as a draft",
};

export interface TebarTarget {
  id: string | null;
  accountId: string;
  platform: string;
  /** pending | published | failed (Tebar's per-account status). */
  status: string;
  permalink: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  publishedAt: string | null;
}

export interface TebarPost {
  id: string;
  status: string;
  scheduledAt: string | null;
  targets: TebarTarget[];
}

export interface PostMetrics {
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
}

/** Raw uploads are for files under 100 MB; bigger ones go up in parts. */
export const RAW_UPLOAD_MAX = 95 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 600_000;

const s = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

function target(t: Json): TebarTarget {
  return {
    id: s(t.id), accountId: s(t.account_id) ?? "", platform: s(t.platform) ?? "", status: s(t.status) ?? "pending",
    permalink: s(t.permalink), errorCode: s(t.error_code), errorMessage: s(t.error_message), publishedAt: s(t.published_at),
  };
}

export function readPost(body: Json): TebarPost {
  const p = (body.data && typeof body.data === "object" && !Array.isArray(body.data) ? body.data : body) as Json;
  const id = s(p.id);
  if (!id) throw new TebarError("Tebar post response has no id", 200, null);
  return {
    id, status: s(p.status) ?? "", scheduledAt: s(p.scheduled_at),
    targets: (Array.isArray(p.targets) ? p.targets : []).map((t) => target((t ?? {}) as Json)),
  };
}

const METRIC_KEYS: Record<keyof PostMetrics, string[]> = {
  views: ["views", "plays", "video_views"],
  likes: ["likes"],
  comments: ["comments", "replies"],
  shares: ["shares", "reposts"],
  saves: ["saves"],
};

const metricsIn = (o: Json): Partial<PostMetrics> | null => {
  const out: Partial<PostMetrics> = {};
  for (const [k, keys] of Object.entries(METRIC_KEYS) as Array<[keyof PostMetrics, string[]]>) {
    for (const key of keys) {
      const v = o[key];
      if (typeof v === "number" && Number.isFinite(v)) out[k] = (out[k] ?? 0) + v;
    }
  }
  return Object.keys(out).length ? out : null;
};

/**
 * Totals from a post-insights body. Its exact shape isn't shown in Tebar's
 * docs (only the metric names, with null = "not reported"), so this reads the
 * shallowest level that has metric fields — the post's totals, else the sum
 * of its per-account entries — and never adds a level to the one below it.
 */
export function extractMetrics(body: unknown): PostMetrics | null {
  let level: unknown[] = [body];
  for (let depth = 0; depth < 5 && level.length; depth++) {
    const found = level.filter((x): x is Json => !!x && typeof x === "object" && !Array.isArray(x)).map(metricsIn).filter((m) => m !== null);
    if (found.length) {
      const total: PostMetrics = { views: 0, likes: 0, comments: 0, shares: 0, saves: 0 };
      for (const m of found) for (const k of Object.keys(total) as Array<keyof PostMetrics>) total[k] += Math.max(0, Math.round(m[k] ?? 0));
      return total;
    }
    level = level.flatMap((x) => (Array.isArray(x) ? x : x && typeof x === "object" ? Object.values(x as Json) : []));
  }
  return null;
}

export class Tebar {
  constructor(
    private readonly config: Pick<AppConfig, "tebarBaseUrl" | "tebarApiKey"> & { tebarEnabled?: boolean },
    private readonly fetchFn: typeof fetch = fetch,
    private readonly rawUploadMax = RAW_UPLOAD_MAX,
  ) {}

  get enabled(): boolean {
    return this.config.tebarEnabled !== false && !!this.config.tebarApiKey && !!this.config.tebarBaseUrl;
  }

  private async request(method: string, path: string, opts: {
    json?: unknown; body?: RequestInit["body"]; headers?: Record<string, string>; timeoutMs?: number; profile?: string | null;
  } = {}): Promise<Json> {
    if (!this.enabled) throw new TebarError("Tebar is not connected (set TEBAR_API_KEY)", 0, "not_configured");
    const base = this.config.tebarBaseUrl.replace(/\/+$/, "");
    const headers: Record<string, string> = { Authorization: `Bearer ${this.config.tebarApiKey}`, ...opts.headers };
    if (opts.profile) headers["Tebar-Profile"] = opts.profile;
    let body = opts.body;
    if (opts.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.json);
    }
    let res: Response;
    try {
      res = await this.fetchFn(`${base}${path}`, { method, headers, body, signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS) });
    } catch (e) {
      throw new TebarError(`Tebar unreachable: ${(e as Error).message}`, 0, "unreachable");
    }
    if (res.status === 204) return {};
    const text = await res.text();
    let data: Json = {};
    try {
      data = text ? (JSON.parse(text) as Json) : {};
    } catch {
      if (res.ok) throw new TebarError(`Tebar answered with invalid JSON: ${text.slice(0, 120)}`, res.status, null);
    }
    if (!res.ok) {
      const err = (data.error ?? {}) as Json;
      const code = s(err.code);
      const hint = code && HINTS[code] ? ` — ${HINTS[code]}` : "";
      throw new TebarError(`Tebar ${res.status} ${code ?? ""}: ${s(err.message) ?? text.slice(0, 200)}${hint}`.replace("  ", " "), res.status, code);
    }
    return data;
  }

  /** Who the key belongs to (connection test). */
  me(): Promise<Json> {
    return this.request("GET", "/me");
  }

  /** One profile's accounts (or all of them without one), following `next_cursor`. */
  async accounts(profile?: TebarProfile): Promise<TebarAccount[]> {
    const out: TebarAccount[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const d = await this.request("GET", `/accounts${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, { profile: profile?.id });
      const rows = (Array.isArray(d.data) ? d.data : Array.isArray(d.accounts) ? d.accounts : []) as Json[];
      for (const a of rows.filter((r) => s(r.id))) {
        out.push({
          id: s(a.id) as string, platform: s(a.platform) ?? "",
          name: s(a.username) ?? s(a.name) ?? s(a.display_name) ?? (s(a.id) as string),
          profileId: profile?.id ?? null, profileName: profile?.name ?? null,
        });
      }
      cursor = s(d.next_cursor);
      if (!cursor) break;
    }
    return out;
  }

  /** The key's workspaces, oldest (the default) first; [] for a key locked to one profile. */
  async profiles(): Promise<TebarProfile[]> {
    try {
      const d = await this.request("GET", "/profiles");
      const rows = (Array.isArray(d.data) ? d.data : []) as Json[];
      return rows.filter((p) => s(p.id)).map((p) => ({ id: s(p.id) as string, name: s(p.name) ?? s(p.external_id) ?? (s(p.id) as string) }));
    } catch (e) {
      // owner_key_required (a key locked to one profile) or no profiles: one workspace
      if (e instanceof TebarError && (e.status === 403 || e.status === 404)) return [];
      throw e;
    }
  }

  /**
   * Every account, tagged with its workspace when there is more than one: each
   * profile is listed with the Tebar-Profile header (accounts carry no profile
   * field in Tebar's docs), so a post can be kept inside one workspace.
   */
  async accountsByProfile(): Promise<TebarAccount[]> {
    const profiles = await this.profiles();
    if (profiles.length <= 1) return this.accounts();
    return (await Promise.all(profiles.map((p) => this.accounts(p)))).flat();
  }

  /** TikTok's privacy choices for an account (TikTok requires the user to pick one for direct posts). */
  tiktokCreatorInfo(accountId: string): Promise<Json> {
    return this.request("GET", `/accounts/${encodeURIComponent(accountId)}/tiktok/creator-info`);
  }

  /** Upload a rendered clip into a workspace (null = the default); returns its media id. */
  async uploadVideo(path: string, profile: string | null = null): Promise<string> {
    const size = statSync(path).size;
    if (size <= this.rawUploadMax) {
      const d = await this.request("POST", "/media/upload", {
        body: Bun.file(path), headers: { "Content-Type": "video/mp4" }, timeoutMs: UPLOAD_TIMEOUT_MS, profile,
      });
      const id = s(d.id) ?? s((d.data as Json | undefined)?.id);
      if (!id) throw new TebarError("Tebar upload response has no media id", 200, null);
      return id;
    }
    const init = await this.request("POST", "/media/uploads", { json: { mime_type: "video/mp4", size_bytes: size }, profile });
    const id = s(init.id);
    const partSize = Number(init.part_size);
    const parts = Number(init.part_count);
    if (!id || !(partSize > 0) || !(parts > 0)) throw new TebarError("Tebar multipart upload response is incomplete", 201, null);
    const file = Bun.file(path);
    for (let n = 1; n <= parts; n++) {
      await this.request("PUT", `/media/${encodeURIComponent(id)}/parts/${n}`, {
        body: file.slice((n - 1) * partSize, Math.min(n * partSize, size)),
        headers: { "Content-Type": "application/octet-stream" }, timeoutMs: UPLOAD_TIMEOUT_MS, profile,
      });
    }
    await this.request("POST", `/media/${encodeURIComponent(id)}/complete`, { timeoutMs: UPLOAD_TIMEOUT_MS, profile });
    return id;
  }

  /** Create (publish now, or schedule) a post in a workspace. The same key + same body returns the same post. */
  async createPost(body: Json, idempotencyKey: string, profile: string | null = null): Promise<TebarPost> {
    return readPost(await this.request("POST", "/posts", { json: body, headers: { "Idempotency-Key": idempotencyKey }, profile }));
  }

  /** Retry the accounts that failed (Tebar never re-posts the ones already published). */
  async retryPost(id: string): Promise<TebarPost> {
    const d = await this.request("POST", `/posts/${encodeURIComponent(id)}/retry`);
    return s(d.id) || s((d.data as Json | undefined)?.id) ? readPost(d) : this.getPost(id);
  }

  /** Cancel a scheduled post. */
  async cancelPost(id: string): Promise<void> {
    await this.request("DELETE", `/posts/${encodeURIComponent(id)}`);
  }

  async getPost(id: string): Promise<TebarPost> {
    return readPost(await this.request("GET", `/posts/${encodeURIComponent(id)}`));
  }

  async postInsights(id: string): Promise<PostMetrics | null> {
    return extractMetrics(await this.request("GET", `/posts/${encodeURIComponent(id)}/insights`));
  }

  /** Ask Tebar to fetch fresh numbers from the platforms (at most once per 5 min; a 429 is fine). */
  async refreshInsights(): Promise<void> {
    try {
      await this.request("POST", "/insights/sync");
    } catch (e) {
      if (!(e instanceof TebarError) || e.status !== 429) throw e;
    }
  }
}
