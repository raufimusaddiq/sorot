import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractMetrics, readPost, Tebar, TebarError } from "../src/tebar";

const ON = { tebarBaseUrl: "https://api.tebar.app/v1/", tebarApiKey: "tb_live_x" };
const dir = mkdtempSync(join(tmpdir(), "tebar-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const small = join(dir, "small.mp4");
writeFileSync(small, "x".repeat(100));

type Call = { method: string; url: string; headers: Record<string, string>; body: unknown };
/** A Tebar client whose requests go to `route`; `calls` records them. */
function tebar(route: (c: Call) => Response | Error, partSize?: number) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    const c = { method: String(init.method), url, headers: init.headers as Record<string, string>, body: init.body };
    calls.push(c);
    const r = route(c);
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as typeof fetch;
  return Object.assign(new Tebar(ON, fn, partSize), { calls });
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test("off without a key or when switched off", async () => {
  expect([new Tebar({ ...ON, tebarApiKey: "" }).enabled, new Tebar({ ...ON, tebarEnabled: false }).enabled]).toEqual([false, false]);
  await expect(new Tebar({ ...ON, tebarApiKey: "" }).accounts()).rejects.toMatchObject({ code: "not_configured" });
});

test("accounts: Bearer key, data list, display names", async () => {
  const t = tebar(() => json({ data: [{ id: "a1", platform: "tiktok", username: "budi" }, { id: "a2", platform: "youtube", name: "Kanal" }, { id: "a3" }, { platform: "x" }] }));
  const one = { profileId: null, profileName: null };
  expect(await t.accounts()).toEqual([{ id: "a1", platform: "tiktok", name: "budi", ...one }, { id: "a2", platform: "youtube", name: "Kanal", ...one },
    { id: "a3", platform: "", name: "a3", ...one }]);
  expect(t.calls[0]).toMatchObject({ method: "GET", url: "https://api.tebar.app/v1/accounts", headers: { Authorization: "Bearer tb_live_x" } });
  expect([(await tebar(() => json({ accounts: [{ id: "b" }] })).accounts()).length, await tebar(() => json({})).accounts()]).toEqual([1, []]);
});

test("workspaces: each profile's accounts are listed with its Tebar-Profile header, following next_cursor", async () => {
  const t = tebar((c) => c.url.endsWith("/profiles") ? json({ data: [{ id: "p1", name: "Budi" }, { id: "p2", external_id: "klien-42" }] })
    : c.url.endsWith("/accounts") && c.headers["Tebar-Profile"] === "p1" ? json({ data: [{ id: "a1", platform: "tiktok" }], next_cursor: "c2" })
      : c.url.endsWith("/accounts?cursor=c2") ? json({ data: [{ id: "a2", platform: "youtube" }], next_cursor: null })
        : json({ data: [{ id: "b1", platform: "instagram" }] }));
  expect((await t.accountsByProfile()).map((a) => [a.id, a.profileId, a.profileName])).toEqual([["a1", "p1", "Budi"], ["a2", "p1", "Budi"], ["b1", "p2", "klien-42"]]);
  for (const status of [403, 404]) {   // a key locked to one profile, or no profiles: one workspace, no header
    const single = tebar((c) => (c.url.endsWith("/profiles") ? json({ error: { code: "owner_key_required" } }, status) : json({ data: [{ id: "a1" }] })));
    expect((await single.accountsByProfile())[0]!.profileId).toBeNull();
    expect(single.calls.at(-1)!.headers["Tebar-Profile"]).toBeUndefined();
  }
  await expect(tebar(() => json({}, 500)).profiles()).rejects.toBeInstanceOf(TebarError);
});

test("retry and cancel; uploads and posts carry the workspace", async () => {
  const done = { id: "p1", status: "done", targets: [{ account_id: "a1", status: "published" }] };
  const t = tebar((c) => (c.method === "DELETE" ? new Response(null, { status: 204 }) : c.url.endsWith("/retry") ? json({ ok: true }) : json(done)));
  expect((await t.retryPost("p1")).targets[0]!.status).toBe("published");   // a reply without the post → read it
  await t.cancelPost("p1");
  await t.createPost({ content: "x" }, "k", "p9");
  await t.uploadVideo(small, "p9");
  expect(t.calls.map((c) => `${c.method} ${c.url.replace("https://api.tebar.app/v1", "")} ${c.headers["Tebar-Profile"] ?? "-"}`)).toEqual([
    "POST /posts/p1/retry -", "GET /posts/p1 -", "DELETE /posts/p1 -", "POST /posts p9", "POST /media/upload p9"]);
  expect((await tebar(() => json({ data: done })).retryPost("p1")).id).toBe("p1");
});

test.each([
  [json({ error: { code: "invalid_api_key", message: "Key revoked" } }, 401),
    { status: 401, code: "invalid_api_key", message: "Tebar 401 invalid_api_key: Key revoked — the API key is wrong or revoked: create a new one at tebar.app" }],
  [json({ error: { code: "insufficient_scope", message: "read only" } }, 403), { code: "insufficient_scope", message: expect.stringContaining("create a read + write key") }],
  [new Response("<html>bad gateway</html>", { status: 502 }), { status: 502, code: null, message: expect.stringContaining("bad gateway") }],
  [new Response("{oops", { status: 200 }), { message: expect.stringContaining("invalid JSON") }],
  [new Error("ECONNRESET"), { code: "unreachable" }],
])("errors carry Tebar's stable code (%#)", async (reply, error) => {
  const e = await tebar(() => (reply instanceof Response ? (reply.clone() as Response) : reply)).me().catch((x) => x);
  expect(e).toBeInstanceOf(TebarError);
  expect(e).toMatchObject(error);
});

test("empty bodies read as {}", async () => {
  expect([await tebar(() => new Response(null, { status: 204 })).me(), await tebar(() => new Response("", { status: 200 })).me()]).toEqual([{}, {}]);
});

test("small clips upload as a raw body; big ones in parts", async () => {
  const raw = tebar(() => json({ id: "m1", type: "video" }, 201));
  expect(await raw.uploadVideo(small)).toBe("m1");
  expect(raw.calls[0]).toMatchObject({ method: "POST", url: "https://api.tebar.app/v1/media/upload", headers: { "Content-Type": "video/mp4" } });
  expect(await tebar(() => json({ data: { id: "m2" } })).uploadVideo(small)).toBe("m2");
  await expect(tebar(() => json({})).uploadVideo(small)).rejects.toThrow("no media id");

  const parts = tebar((c) => c.url.endsWith("/media/uploads") ? json({ id: "m9", part_size: 40, part_count: 3 }, 201)
    : c.method === "PUT" ? new Response(null, { status: 204 }) : json({ type: "video" }), 10);
  expect(await parts.uploadVideo(small)).toBe("m9");
  expect(parts.calls.map((c) => `${c.method} ${c.url.replace("https://api.tebar.app/v1", "")}`)).toEqual([
    "POST /media/uploads", "PUT /media/m9/parts/1", "PUT /media/m9/parts/2", "PUT /media/m9/parts/3", "POST /media/m9/complete"]);
  expect([JSON.parse(String(parts.calls[0]!.body)), (parts.calls[3]!.body as Blob).size]).toEqual([{ mime_type: "video/mp4", size_bytes: 100 }, 20]);
  await expect(tebar(() => json({ id: "m" }), 10).uploadVideo(small)).rejects.toThrow("incomplete");
});

test("posts: idempotency key, targets, status", async () => {
  const created = { id: "p1", status: "scheduled", scheduled_at: "2026-11-01T12:00:00Z", targets: [
    { id: "t1", account_id: "a1", platform: "tiktok", status: "pending", permalink: null }] };
  const t = tebar(() => json(created, 201));
  expect(await t.createPost({ content: "Halo", targets: [{ account_id: "a1" }] }, "key-1")).toEqual({ id: "p1", status: "scheduled",
    scheduledAt: "2026-11-01T12:00:00Z", targets: [{ id: "t1", accountId: "a1", platform: "tiktok", status: "pending", permalink: null,
      errorCode: null, errorMessage: null, publishedAt: null }] });
  expect(t.calls[0]!.headers).toMatchObject({ "Idempotency-Key": "key-1", "Content-Type": "application/json" });
  expect((await tebar(() => json({ data: created })).getPost("p1")).id).toBe("p1");
  expect(() => readPost({ status: "x" })).toThrow("no id");
  expect(readPost({ id: "p", targets: [null] }).targets[0]).toMatchObject({ accountId: "", status: "pending" });
  const info = tebar(() => json({ ok: true }));
  await info.tiktokCreatorInfo("a/1");
  expect(info.calls[0]!.url).toEndWith("/accounts/a%2F1/tiktok/creator-info");
});

test("insights: the shallowest level with metrics (never counted twice), null = not reported", async () => {
  expect(extractMetrics({ data: { views: 1200, likes: 80, comments: null, shares: 4, saves: 9, reach: 999 } }))
    .toEqual({ views: 1200, likes: 80, comments: 0, shares: 4, saves: 9 });
  expect(extractMetrics({ data: [{ platform: "threads", metrics: { views: 10, replies: 2, reposts: 1 } },
    { platform: "instagram", metrics: { views: 5, comments: 1, saves: 2 } }] })).toEqual({ views: 15, likes: 0, comments: 3, shares: 1, saves: 2 });
  expect(extractMetrics({ views: 7, targets: [{ views: 3 }, { views: 4 }] })!.views).toBe(7);
  expect([extractMetrics({ data: { reach: 3, missing_permission: ["insights"] } }), extractMetrics(null)]).toEqual([null, null]);
  const t = tebar(() => json({ data: { views: 3 } }));
  expect(await t.postInsights("p1")).toMatchObject({ views: 3 });
  expect(t.calls[0]!.url).toEndWith("/posts/p1/insights");
});

test("refreshInsights: a 429 (asked too often) is fine, other errors are not", async () => {
  await tebar(() => json({ error: { code: "rate_limited" } }, 429)).refreshInsights();
  await tebar(() => json({ status: "running" }, 202)).refreshInsights();
  await expect(tebar(() => json({}, 500)).refreshInsights()).rejects.toBeInstanceOf(TebarError);
});
