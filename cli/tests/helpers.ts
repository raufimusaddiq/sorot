import type { CliConfig } from "../src/config";
import { main } from "../src/main";

export type Handler = (body: any, url: URL) => unknown;

export class Fail {
  constructor(readonly status: number, readonly error: string) {}
}

/** In-memory harness: a fake API (routes keyed "METHOD /path"), captured output, processes and files. */
export function harness(routes: Record<string, Handler | unknown> = {}, config: Partial<CliConfig> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const runs: { cmd: string[]; cwd?: string }[] = [];
  const requests: { method: string; path: string; body: any }[] = [];
  const files = new Map<string, number>();
  const copies: [string, string][] = [];
  const existing = new Set<string>();
  const state = {
    runCode: 0,
    captures: {} as Record<string, { code: number; stdout: string }>,
    isRoot: false,
  };

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, path: url.pathname + url.search, body });
    const route = routes[`${method} ${url.pathname}`];
    if (route === undefined) return Response.json({ status: "error", error: `no route ${method} ${url.pathname}` }, { status: 404 });
    const result = typeof route === "function" ? (route as Handler)(body, url) : route;
    if (result instanceof Response) return result;
    if (result instanceof Fail) return Response.json({ status: "error", error: result.error }, { status: result.status });
    return Response.json({ status: "ok", data: result });
  }) as unknown as typeof fetch;

  const cfg: CliConfig = { url: "http://app:8080", mode: "docker", appDir: "/opt/vc", service: "sorot", source: "/etc/sorot/cli.conf", ...config };

  const deps = {
    config: cfg,
    out: (s: string) => out.push(s),
    err: (s: string) => err.push(s),
    sleep: async () => {},
    run: async (cmd: string[], opts?: { cwd?: string }) => {
      runs.push({ cmd, cwd: opts?.cwd });
      return state.runCode;
    },
    capture: async (cmd: string[]) => state.captures[cmd[0] as string] ?? { code: 127, stdout: "" },
    fs: {
      exists: (p: string) => existing.has(p.replaceAll("\\", "/")),
      mkdir: () => {},
      copy: (a: string, b: string) => { copies.push([a.replaceAll("\\", "/"), b.replaceAll("\\", "/")]); },
      write: async (p: string, res: Response) => {
        const n = (await res.arrayBuffer()).byteLength;
        files.set(p.replaceAll("\\", "/"), n);
        return n;
      },
    },
    get isRoot() { return state.isRoot; },
    cwd: "/home/u",
    pollMs: 1,
    fetchFn,
  };

  return {
    out, err, runs, requests, files, copies, existing, state,
    run: (...argv: string[]) => main(argv, deps),
    text: () => out.join("\n"),
  };
}

export const stage = (name: string, status: string, extra: Record<string, unknown> = {}) => ({
  stage: name, status, startedAt: "2026-10-27T08:00:00.000Z", completedAt: "2026-10-27T08:00:30.000Z", errorMessage: null, ...extra,
});

export const clip = (rank: number, tier: string, extra: Record<string, unknown> = {}) => ({
  id: `clip-${rank}`, videoId: "video-1234-abcd", rankPos: rank, tier, score: 0.9 - rank / 100, startTime: 60 * rank,
  endTime: 60 * rank + 45, durationSec: 45, renderStatus: "COMPLETED", exportStatus: "COMPLETED",
  exportPath: `/app/data/exports/v/clip_${rank}_subtitled.mp4`, title: `Clip ${rank} title`, ...extra,
});
