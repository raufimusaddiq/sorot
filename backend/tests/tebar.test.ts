import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractMetrics, readPost, Tebar, TebarError } from "../src/tebar";

const ON = { tebarBaseUrl: "https://api.tebar.app/v1/", tebarApiKey: "tb_live_x" };
const dir = mkdtempSync(join(tmpdir(), "tebar-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Call = { method: string; url: string; headers: Record<string, string>; body: unknown };

function fake(route: (c: Call) => Response | Error) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    const c = { method: String(init.method), url, headers: init.headers as Record<string, string>, body: init.body };
    calls.push(c);
    const r = route(c);
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("Tebar client", () => {
  test("off without a key or when switched off", async () => {
    expect(new Tebar({ ...ON, tebarApiKey: "" }).enabled).toBeFalse();
    expect(new Tebar({ ...ON, tebarEnabled: false }).enabled).toBeFalse();
    await expect(new Tebar({ ...ON, tebarApiKey: "" }).accounts()).rejects.toMatchObject({ code: "not_configured" });
  });

  test("accounts: Bearer key, data list, display names", async () => {
    const f = fake(() => json({ data: [{ id: "a1", platform: "tiktok", username: "budi" }, { id: "a2", platform: "youtube", name: "Kanal" },
      { id: "a3" }, { platform: "x" }] }));
    expect(await new Tebar(ON, f.fn).accounts()).toEqual([
      { id: "a1", platform: "tiktok", name: "budi" }, { id: "a2", platform: "youtube", name: "Kanal" }, { id: "a3", platform: "", name: "a3" }]);
    expect(f.calls[0]).toMatchObject({ method: "GET", url: "https://api.tebar.app/v1/accounts" });
    expect(f.calls[0]!.headers.Authorization).toBe("Bearer tb_live_x");
    expect(await new Tebar(ON, fake(() => json({ accounts: [{ id: "b" }] })).fn).accounts()).toHaveLength(1);
    expect(await new Tebar(ON, fake(() => json({})).fn).accounts()).toEqual([]);
  });

  test("errors carry Tebar's stable code", async () => {
    const t = new Tebar(ON, fake(() => json({ error: { code: "invalid_api_key", message: "Key revoked" } }, 401)).fn);
    const e = await t.me().catch((x) => x);
    expect(e).toBeInstanceOf(TebarError);
    expect(e).toMatchObject({ status: 401, code: "invalid_api_key", message: "Tebar 401 invalid_api_key: Key revoked" });
    const html = await new Tebar(ON, fake(() => new Response("<html>bad gateway</html>", { status: 502 })).fn).me().catch((x) => x);
    expect(html).toMatchObject({ status: 502, code: null });
    expect(html.message).toContain("bad gateway");
    await expect(new Tebar(ON, fake(() => new Response("{oops", { status: 200 })).fn).me()).rejects.toThrow("invalid JSON");
    await expect(new Tebar(ON, fake(() => new Error("ECONNRESET")).fn).me()).rejects.toMatchObject({ code: "unreachable" });
    expect(await new Tebar(ON, fake(() => new Response(null, { status: 204 })).fn).me()).toEqual({});
    expect(await new Tebar(ON, fake(() => new Response("", { status: 200 })).fn).me()).toEqual({});
  });

  test("small clips upload as a raw body; big ones in parts", async () => {
    const small = join(dir, "small.mp4");
    writeFileSync(small, "x".repeat(100));
    const raw = fake(() => json({ id: "m1", type: "video" }, 201));
    expect(await new Tebar(ON, raw.fn).uploadVideo(small)).toBe("m1");
    expect(raw.calls[0]).toMatchObject({ method: "POST", url: "https://api.tebar.app/v1/media/upload" });
    expect(raw.calls[0]!.headers["Content-Type"]).toBe("video/mp4");
    expect(await new Tebar(ON, fake(() => json({ data: { id: "m2" } })).fn).uploadVideo(small)).toBe("m2");
    await expect(new Tebar(ON, fake(() => json({})).fn).uploadVideo(small)).rejects.toThrow("no media id");

    const parts = fake((c) => c.url.endsWith("/media/uploads") ? json({ id: "m9", part_size: 40, part_count: 3 }, 201)
      : c.method === "PUT" ? new Response(null, { status: 204 }) : json({ type: "video" }));
    expect(await new Tebar(ON, parts.fn, 10).uploadVideo(small)).toBe("m9");
    expect(parts.calls.map((c) => `${c.method} ${c.url.replace("https://api.tebar.app/v1", "")}`)).toEqual([
      "POST /media/uploads", "PUT /media/m9/parts/1", "PUT /media/m9/parts/2", "PUT /media/m9/parts/3", "POST /media/m9/complete"]);
    expect(JSON.parse(String(parts.calls[0]!.body))).toEqual({ mime_type: "video/mp4", size_bytes: 100 });
    expect((parts.calls[3]!.body as Blob).size).toBe(20);
    await expect(new Tebar(ON, fake(() => json({ id: "m" })).fn, 10).uploadVideo(small)).rejects.toThrow("incomplete");
  });

  test("posts: idempotency key, targets, status", async () => {
    const created = { id: "p1", status: "scheduled", scheduled_at: "2026-11-01T12:00:00Z", targets: [
      { id: "t1", account_id: "a1", platform: "tiktok", status: "pending", permalink: null }] };
    const f = fake(() => json(created, 201));
    const t = new Tebar(ON, f.fn);
    const post = await t.createPost({ content: "Halo", targets: [{ account_id: "a1" }] }, "key-1");
    expect(f.calls[0]!.headers["Idempotency-Key"]).toBe("key-1");
    expect(f.calls[0]!.headers["Content-Type"]).toBe("application/json");
    expect(post).toEqual({ id: "p1", status: "scheduled", scheduledAt: "2026-11-01T12:00:00Z", targets: [{
      id: "t1", accountId: "a1", platform: "tiktok", status: "pending", permalink: null, errorCode: null, errorMessage: null, publishedAt: null }] });
    expect((await new Tebar(ON, fake(() => json({ data: created })).fn).getPost("p1")).id).toBe("p1");
    expect(() => readPost({ status: "x" })).toThrow("no id");
    expect(readPost({ id: "p", targets: [null] }).targets[0]).toMatchObject({ accountId: "", status: "pending" });
    const c = fake(() => json({ ok: true }));
    await new Tebar(ON, c.fn).tiktokCreatorInfo("a/1");
    expect(c.calls[0]!.url).toEndWith("/accounts/a%2F1/tiktok/creator-info");
  });

  test("insights: shallowest level with metrics, null = not reported", async () => {
    expect(extractMetrics({ data: { views: 1200, likes: 80, comments: null, shares: 4, saves: 9, reach: 999 } }))
      .toEqual({ views: 1200, likes: 80, comments: 0, shares: 4, saves: 9 });
    expect(extractMetrics({ data: [{ platform: "threads", metrics: { views: 10, replies: 2, reposts: 1 } },
      { platform: "instagram", metrics: { views: 5, comments: 1, saves: 2 } }] }))
      .toEqual({ views: 15, likes: 0, comments: 3, shares: 1, saves: 2 });
    // Totals win over per-account entries (never counted twice).
    expect(extractMetrics({ views: 7, targets: [{ views: 3 }, { views: 4 }] })!.views).toBe(7);
    expect(extractMetrics({ data: { reach: 3, missing_permission: ["insights"] } })).toBeNull();
    expect(extractMetrics(null)).toBeNull();
    const f = fake(() => json({ data: { views: 3 } }));
    expect(await new Tebar(ON, f.fn).postInsights("p1")).toMatchObject({ views: 3 });
    expect(f.calls[0]!.url).toEndWith("/posts/p1/insights");
  });

  test("refreshInsights: a 429 (asked too often) is fine, other errors are not", async () => {
    await new Tebar(ON, fake(() => json({ error: { code: "rate_limited" } }, 429)).fn).refreshInsights();
    await new Tebar(ON, fake(() => json({ status: "running" }, 202)).fn).refreshInsights();
    await expect(new Tebar(ON, fake(() => json({}, 500)).fn).refreshInsights()).rejects.toBeInstanceOf(TebarError);
  });
});
