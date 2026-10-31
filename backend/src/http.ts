import { existsSync, statSync } from "node:fs";
import { normalize, resolve, sep } from "node:path";

export type Body = Record<string, unknown>;

export interface Ctx {
  req: Request;
  url: URL;
  params: Record<string, string>;
  /** Parsed JSON object body; empty body → {}. Throws HttpError(400) otherwise. */
  body(): Promise<Body>;
}

export type Handler = (ctx: Ctx) => Response | Promise<Response>;

export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export const ok = (data: unknown, status = 200) => Response.json({ status: "ok", data }, { status });
export const fail = (status: number, error: string) => Response.json({ status: "error", error }, { status });

async function parseBody(req: Request): Promise<Body> {
  const raw = await req.text();
  if (!raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "JSON body must be an object");
  }
  return parsed as Body;
}

interface Route { method: string; pattern: RegExp; keys: string[]; handler: Handler }

export class Router {
  private routes: Route[] = [];

  on(method: string, path: string, handler: Handler): this {
    const keys: string[] = [];
    const pattern = new RegExp(
      `^${path.replace(/:(\w+)/g, (_, k: string) => { keys.push(k); return "([^/]+)"; })}/?$`,
    );
    this.routes.push({ method, pattern, keys, handler });
    return this;
  }

  /** Returns null when no route path matches (caller decides the fallback). */
  async handle(req: Request, url: URL): Promise<Response | null> {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.pattern.exec(url.pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== req.method) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1] as string); });
      let cached: Promise<Body> | undefined;
      const ctx: Ctx = { req, url, params, body: () => (cached ??= parseBody(req)) };
      try {
        return await r.handler(ctx);
      } catch (e) {
        if (e instanceof HttpError) return fail(e.status, e.message);
        console.error(`Unhandled error on ${req.method} ${url.pathname}:`, e);
        return fail(500, (e as Error).message || "Internal error");
      }
    }
    return pathMatched ? fail(405, `Method ${req.method} not allowed`) : null;
  }
}

// ---- CORS (only needed for `next dev` on :3000; prod UI is same-origin) ----

export function corsHeaders(req: Request, allowed: Set<string>): Record<string, string> {
  const origin = req.headers.get("origin");
  if (!origin || !allowed.has(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": req.headers.get("access-control-request-headers") ?? "*",
    Vary: "Origin",
  };
}

export function withHeaders(res: Response, headers: Record<string, string>): Response {
  for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
  return res;
}

// ---- files ----

/**
 * Serve a file with HTTP Range support (the <video> element seeks with
 * Range requests). Returns a 404 envelope when missing or empty.
 */
export function serveFile(req: Request, path: string, opts: { contentType: string; attachment?: boolean }): Response {
  if (!existsSync(path) || statSync(path).size === 0) {
    const name = path.split(/[\\/]/).pop();
    return fail(404, `File not found or empty: ${name}`);
  }
  const file = Bun.file(path);
  const size = file.size;
  const headers: Record<string, string> = {
    "Content-Type": opts.contentType,
    "Accept-Ranges": "bytes",
  };
  if (opts.attachment) {
    headers["Content-Disposition"] = `attachment; filename="${path.split(/[\\/]/).pop()}"`;
  }

  const range = req.headers.get("range");
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (m && (m[1] || m[2])) {
    let start: number;
    let end: number;
    if (m[1]) {
      start = Number(m[1]);
      end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    } else {
      start = Math.max(size - Number(m[2]), 0); // suffix range: last N bytes
      end = size - 1;
    }
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
    }
    return new Response(file.slice(start, end + 1), {
      status: 206,
      headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) },
    });
  }
  return new Response(file, { headers: { ...headers, "Content-Length": String(size) } });
}

/**
 * Serve the statically-exported Next.js UI (`next build` with output:
 * 'export'). Tries the exact file, then `.html`, then `/index.html`, and
 * finally falls back to index.html (single-page app). Path traversal outside
 * `root` is rejected.
 */
export function serveStatic(root: string, pathname: string): Response | null {
  const base = resolve(root);
  if (!existsSync(base)) return null;
  let rel: string;
  try {
    rel = normalize(decodeURIComponent(pathname)).replace(/^[\\/]+/, "");
  } catch {
    return null;
  }
  const candidates = rel === "" ? ["index.html"] : [rel, `${rel}.html`, `${rel}/index.html`];
  for (const c of candidates) {
    const full = resolve(base, c);
    if (full !== base && !full.startsWith(base + sep)) return null;
    if (existsSync(full) && statSync(full).isFile()) {
      const immutable = pathname.startsWith("/_next/static/");
      return new Response(Bun.file(full), {
        headers: { "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache" },
      });
    }
  }
  // Missing assets (anything with an extension) are real 404s, not the SPA shell.
  if (/\.[A-Za-z0-9]+$/.test(rel)) return null;
  const index = resolve(base, "index.html");
  return existsSync(index) ? new Response(Bun.file(index), { headers: { "Cache-Control": "no-cache" } }) : null;
}
