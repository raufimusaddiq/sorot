import { describe, expect, test } from "bun:test";
import { Api, ApiError } from "../src/api";
import { has, num, parseArgs, str, UsageError } from "../src/args";
import { loadConfig, parseConf } from "../src/config";
import { clock, seconds, short, table, truncate, when } from "../src/format";

describe("args", () => {
  test("long, inline, boolean, short and passthrough", () => {
    const a = parseArgs(["import", "https://x", "--style", "hormozi", "--gap=0.8", "--trim", "-o", "out", "-f", "--", "--raw"]);
    expect(a.positionals).toEqual(["import", "https://x", "--raw"]);
    expect(a.flags).toEqual({ style: "hormozi", gap: "0.8", trim: true, out: "out", follow: true });
    expect(str(a, "style")).toBe("hormozi");
    expect(str(a, "trim")).toBeUndefined();
    expect(num(a, "gap")).toBe(0.8);
    expect(num(a, "missing")).toBeUndefined();
    expect(has(a, "trim") && !has(a, "hook")).toBeTrue();
  });

  test("errors", () => {
    expect(() => parseArgs(["--style"])).toThrow("--style needs a value");
    expect(() => parseArgs(["--style", "--trim"])).toThrow(UsageError);
    expect(() => parseArgs(["-z"])).toThrow("Unknown option -z");
    expect(() => num(parseArgs(["--max", "lots"]), "max")).toThrow("--max must be a number");
    expect(parseArgs(["-", "--"]).positionals).toEqual(["-"]);
  });
});

describe("config", () => {
  test("parseConf skips comments and strips quotes", () => {
    expect(parseConf("# hi\nVCLIP_URL='http://x'\r\nVCLIP_MODE = native\nbad line\n  # A=1")).toEqual({
      VCLIP_URL: "http://x", VCLIP_MODE: "native",
    });
  });

  test("lookup order, env override and defaults", () => {
    const files: Record<string, string> = {
      "/custom.conf": "SOROT_MODE=docker\nSOROT_APP_DIR=/srv/vc\nSOROT_URL=http://box:9000/",
      "/home/u/.config/sorot/cli.conf": "SOROT_MODE=native\nSOROT_SERVICE=vc2",
      "/etc/sorot/cli.conf": "SOROT_MODE=docker",
    };
    const read = (p: string) => files[p] ?? null;
    expect(loadConfig({ SOROT_CONFIG: "/custom.conf", HOME: "/home/u" }, read)).toEqual({
      url: "http://box:9000", mode: "docker", appDir: "/srv/vc", service: "sorot", source: "/custom.conf",
    });
    const home = loadConfig({ HOME: "/home/u", SOROT_URL: "http://other/" }, read);
    expect(home).toMatchObject({ url: "http://other", mode: "native", service: "vc2", appDir: "" });
    expect(loadConfig({}, read).source).toBe("/etc/sorot/cli.conf");
    expect(loadConfig({ USERPROFILE: "/home/u" }, read).mode).toBe("native");   // Windows home
    expect(loadConfig({}, () => null)).toEqual({ url: "http://localhost:8080", mode: "none", appDir: "", service: "sorot", source: null });
    expect(loadConfig({}, () => "SOROT_MODE=weird").mode).toBe("none");
  });

  test("installs from before the rename (Viral Clipper) keep working", () => {
    const files: Record<string, string> = {
      "/etc/viralclip/cli.conf": "VCLIP_MODE=native\nVCLIP_APP_DIR=/srv/old\nVCLIP_URL=http://old:8080\nVCLIP_SERVICE=viralclip",
      "/home/u/.config/viralclip/cli.conf": "VCLIP_MODE=docker",
      "/old.conf": "VCLIP_MODE=docker",
    };
    const read = (p: string) => files[p] ?? null;
    expect(loadConfig({}, read)).toEqual({
      url: "http://old:8080", mode: "native", appDir: "/srv/old", service: "viralclip", source: "/etc/viralclip/cli.conf",
    });
    expect(loadConfig({ HOME: "/home/u" }, read).source).toBe("/home/u/.config/viralclip/cli.conf");
    expect(loadConfig({ VCLIP_CONFIG: "/old.conf", VCLIP_URL: "http://x" }, read)).toMatchObject({ source: "/old.conf", url: "http://x" });
  });
});

describe("format", () => {
  test("helpers", () => {
    expect(table(["A", "B"], [])).toBe("(none)");
    expect(table(["ID", "NAME"], [["1", "long name"], [22, null]])).toBe("ID  NAME\n1   long name\n22  -");
    expect(clock(125.4)).toBe("2:05");
    expect(clock(3725)).toBe("1:02:05");
    expect(clock(null)).toBe("-");
    expect(clock(Number.NaN)).toBe("-");
    expect(short("abcdefghij")).toBe("abcdefgh");
    expect(short(null)).toBe("-");
    expect(truncate("  a   b  ", 10)).toBe("a b");
    expect(truncate("abcdefghij", 5)).toBe("abcd…");
    expect(truncate(null, 5)).toBe("-");
    expect(when("2026-10-27T08:54:19.609Z")).toBe("2026-10-27 08:54");
    expect(when(null)).toBe("-");
    expect(seconds("2026-10-27T08:00:00Z", "2026-10-27T08:01:01Z")).toBe("61s");
    expect(seconds("2026-10-27T08:01:00Z", "2026-10-27T08:00:00Z")).toBe("");
    expect(seconds(null, "x")).toBe("");
  });
});

describe("api client", () => {
  const api = (impl: (url: string, init?: RequestInit) => Response | Promise<Response>) =>
    new Api("http://a", (async (u: string, i?: RequestInit) => impl(u, i)) as unknown as typeof fetch);

  test("unwraps data and sends JSON", async () => {
    let seen: RequestInit | undefined;
    const a = api((_, init) => { seen = init; return Response.json({ status: "ok", data: { x: 1 } }); });
    expect(await a.post("/p", { y: 2 })).toEqual({ x: 1 });
    expect(seen).toMatchObject({ method: "POST", body: '{"y":2}', headers: { "Content-Type": "application/json" } });
    expect(await a.delete("/p")).toEqual({ x: 1 });
  });

  test("errors: unreachable, not JSON, envelope error, raw failures", async () => {
    const down = api(() => { throw new Error("ECONNREFUSED"); });
    await expect(down.get("/x")).rejects.toThrow("Cannot reach http://a (ECONNREFUSED). Is the app running? Try: sorot up");
    await expect(down.raw("/x")).rejects.toThrow("Cannot reach");
    await expect(api(() => new Response("<html>", { status: 502 })).get("/x")).rejects.toThrow("GET /x: HTTP 502 (not JSON)");
    await expect(api(() => Response.json({ status: "error", error: "nope" }, { status: 409 })).get("/x")).rejects.toMatchObject({ message: "nope", status: 409 });
    await expect(api(() => Response.json({}, { status: 500 })).get("/x")).rejects.toThrow("HTTP 500");
    await expect(api(() => Response.json({ status: "error", error: "No exported file" }, { status: 404 })).raw("/x")).rejects.toThrow("No exported file");
    await expect(api(() => new Response("x", { status: 500 })).raw("/x")).rejects.toBeInstanceOf(ApiError);
    const ok = await api(() => new Response("bytes")).raw("/x");
    expect(await ok.text()).toBe("bytes");
  });
});
