// Connection settings (UI / CLI) and publishing through Tebar, end to end
// over the HTTP API; Tebar, the LLM and Jev are faked at the fetch layer.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db";
import { Jev } from "../src/jev";
import { Llm } from "../src/llm";
import { fitCopy, postStatus } from "../src/publisher";
import { ConnectionSettings, mask } from "../src/settings";
import { Store } from "../src/store";
import { Tebar } from "../src/tebar";
import { makeEnv, type TestEnv } from "./helpers";

let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { await env.app.jobs.whenIdle(); env.app.publisher.stop(); env.cleanup(); });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const get = (path: string) => env.json("GET", path);
const post = (path: string, body?: unknown) => env.json("POST", path, body);
const put = (kind: string, body: unknown) => env.json("PUT", `/api/settings/${kind}`, body);
const llmReply = (content: string) => json({ choices: [{ message: { role: "assistant", content } }] });
const LLM = { baseUrl: "http://llm/v1", model: "qwen" };

const ACCOUNTS = [
  { id: "tt", platform: "tiktok", username: "budi.tt" }, { id: "yt", platform: "youtube", name: "Kanal Budi" },
  { id: "ig", platform: "instagram", username: "budi.ig" }, { id: "pin", platform: "pinterest", name: "Pins" },
  { id: "th", platform: "threads", username: "budi.th" },
];

/** A fake Tebar API behind env.fetchHandler (LLM / Jev calls go to `other`). Set `workspaces` for several profiles. */
function fakeTebar(other: (url: string, init?: RequestInit) => Response | Promise<Response> = (url) => { throw new Error(`no network: ${url}`); }) {
  const st = { calls: [] as Array<{ method: string; path: string; body: unknown; headers: Record<string, string> }>,
    postStatus: "pending", createError: undefined as Response | undefined, insights: { data: { views: 1000, likes: 50, comments: 5, shares: 2, saves: 3 } } as unknown,
    workspaces: null as Record<string, string[]> | null, tiktokBusiness: false, fail: null as string | null };
  env.fetchHandler.fn = async (url, init) => {
    if (!url.startsWith("https://api.tebar.app/v1")) return other(url, init);
    const path = url.slice("https://api.tebar.app/v1".length);
    const method = String(init?.method);
    const headers = init?.headers as Record<string, string>;
    st.calls.push({ method, path, body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body, headers });
    if (st.fail === `${method} ${path}`) return json({ error: { code: "post_not_removable", message: "too late" } }, 409);
    if (path === "/me") return json({ data: { email: "budi@example.com" } });
    if (path === "/profiles") {
      return st.workspaces ? json({ data: Object.keys(st.workspaces).map((id) => ({ id, name: `WS ${id}` })) })
        : json({ error: { code: "owner_key_required" } }, 403);
    }
    if (path === "/accounts") {
      const ws = headers["Tebar-Profile"];
      return json({ data: ws ? ACCOUNTS.filter((a) => st.workspaces![ws]!.includes(a.id)) : ACCOUNTS, next_cursor: null });
    }
    if (path === "/accounts/tt/tiktok/creator-info") {
      return json(st.tiktokBusiness ? { video_public_only: true, privacy_level_options: ["PUBLIC_TO_EVERYONE"] }
        : { privacy_level_options: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"] });
    }
    if (path === "/posts/post-1/retry") return json({ id: "post-1", status: "done", targets: [{ account_id: "tt", platform: "tiktok", status: "published" }] });
    if (path === "/posts/post-1" && method === "DELETE") return new Response(null, { status: 204 });
    if (path === "/media/upload") return json({ id: "media-1" }, 201);
    if (path === "/posts" && method === "POST") {
      if (st.createError) return st.createError;
      const body = JSON.parse(String(init!.body));
      return json({ id: "post-1", status: body.scheduled_at ? "scheduled" : "publishing", scheduled_at: body.scheduled_at ?? null,
        targets: body.targets.map((t: { account_id: string }, i: number) => ({ id: `t${i}`, account_id: t.account_id,
          platform: ACCOUNTS.find((a) => a.id === t.account_id)!.platform, status: "pending", permalink: null })) }, 201);
    }
    if (path === "/posts/post-1") {
      return json({ id: "post-1", status: "done", targets: [{ id: "t0", account_id: "tt", platform: "tiktok", status: st.postStatus,
        permalink: st.postStatus === "published" ? "https://tiktok.com/@budi/video/1" : null, published_at: "2026-10-27T10:00:00.000Z" }] });
    }
    if (path === "/posts/post-1/insights") return json(st.insights);
    if (path === "/insights/sync") return json({ error: { code: "rate_limited", message: "wait" } }, 429);
    return json({ error: { code: "not_found", message: path } }, 404);
  };
  return st;
}

/** A finished pipeline run; returns its best clip (rendered, gate PASS). */
async function renderedClip() {
  const videoId = (await post("/api/import", { url: "https://www.youtube.com/watch?v=abcdefghijk" })).body.data.videoId;
  await post("/api/process", { videoId, options: { direction: "yang lucu" } });
  await env.app.jobs.whenIdle();
  return env.app.store.clipsForVideo(videoId)[0]!;
}

/** Tebar faked and connected, and a rendered clip with publish / draft shorthands. */
async function ready(other?: Parameters<typeof fakeTebar>[0]) {
  const st = fakeTebar(other);
  expect((await put("tebar", { apiKey: "tb_live_secret1234" })).status).toBe(200);
  const clip = await renderedClip();
  return { st, clip, publish: (body: unknown) => post(`/api/clips/${clip.id}/publish`, body),
    draft: async (accountIds: string[]) => (await post(`/api/clips/${clip.id}/publish/draft`, { accountIds })).body.data };
}
const tt = (content = "x", extra: object = { privacyLevel: "SELF_ONLY" }) => ({ targets: [{ accountId: "tt", content, ...extra }] });

describe("connection settings", () => {
  test("view masks keys; a saved field wins over the env; null goes back to it", async () => {
    const before = (await get("/api/settings")).body.data;
    expect(before).toMatchObject({ llm: { active: false, baseUrl: "", apiKey: "", apiKeySet: false, enabled: true, director: true, saved: [] },
      jev: { url: "https://api.typesafe.ai/v1/systemone", model: "jev-1.14.0", active: false, director: true },
      tebar: { baseUrl: "https://api.tebar.app/v1", active: false } });
    const r = await put("llm", { baseUrl: " https://api.openai.com/v1 ", model: "gpt-x", apiKey: "sk-abcdefgh1234" });
    expect(r.body.data.llm).toMatchObject({ active: true, baseUrl: "https://api.openai.com/v1", apiKey: "••••1234", apiKeySet: true });
    expect(r.body.data.llm.saved.sort()).toEqual(["apiKey", "baseUrl", "model"]);
    expect(JSON.stringify(r.body)).not.toContain("sk-abcdefgh1234");
    expect((await put("llm", { enabled: false })).body.data.llm.active).toBeFalse();
    expect(env.app.llm.enabled).toBeFalse();
    expect((await put("llm", { baseUrl: null, enabled: null })).body.data.llm).toMatchObject({ baseUrl: "", enabled: true, saved: ["model", "apiKey"] });
  });

  test("bad input is a 400; unknown connections a 404", async () => {
    for (const [kind, body] of [["llm", { baseUrl: "ftp://x" }], ["llm", { enabled: "yes" }], ["jev", { apiKey: "a b" }],
      ["jev", { model: 5 }], ["tebar", { nope: 1 }], ["llm", { model: "m".repeat(301) }]] as const) {
      expect((await put(kind, body)).status).toBe(400);
    }
    expect([(await put("openai", {})).status, (await post("/api/settings/openai/test")).status]).toEqual([404, 404]);
  });

  test("saved settings survive a restart; an unreadable one is ignored", () => {
    const store = new Store(openDatabase(":memory:"));
    const boot = () => {
      const config = { ...env.config, jevApiKey: "", jevModel: "jev-1.14.0" };
      return { config, settings: new ConnectionSettings(config, store, { llm: new Llm(config), jev: new Jev(config), tebar: new Tebar(config) }) };
    };
    boot().settings.update("jev", { apiKey: "ts_key_99999999", model: "jev-1.13.0" });
    store.setSetting("jev.url", "{not json");
    const again = boot();
    expect(again.config).toMatchObject({ jevApiKey: "ts_key_99999999", jevModel: "jev-1.13.0", jevUrl: env.config.jevUrl });
    expect(again.settings.view().jev).toMatchObject({ apiKey: "••••9999", active: true });
    expect([mask("short"), mask("")]).toEqual(["••••", ""]);
  });

  test("test connection: not configured, working, failing", async () => {
    const test = async (kind: string) => (await post(`/api/settings/${kind}/test`)).body.data;
    for (const kind of ["llm", "jev", "tebar"]) expect((await test(kind)).ok).toBeFalse();
    fakeTebar((url, init) => {
      if (url === "http://llm/v1/chat/completions") return llmReply(" OK ");
      if (url !== "https://api.typesafe.ai/v1/systemone") return json({}, 500);
      expect(JSON.parse(String(init!.body)).questions.test.type).toBe("noul");
      return json({ model: "jev-1.14.0", answers: { test: { type: "noul", noul: 0.97 } }, usage: { input_tokens: 9, output_tokens: 1 } });
    });
    await put("llm", LLM);
    await put("jev", { apiKey: "ts_k" });
    await put("tebar", { apiKey: "tb_live_secret1234" });
    expect(await test("llm")).toMatchObject({ ok: true, model: "qwen", detail: "OK" });
    expect(await test("jev")).toMatchObject({ ok: true, model: "jev-1.14.0", detail: "answered 0.97" });
    expect(await test("tebar")).toMatchObject({ ok: true, detail: "budi@example.com" });
    await put("llm", { baseUrl: "http://down/v1" });
    expect(await test("llm")).toMatchObject({ ok: false, error: "LLM HTTP 500: {}" });
  });
});

describe("publishing through Tebar", () => {
  test("not connected: accounts say so, actions are a 409", async () => {
    expect((await get("/api/social/accounts")).body.data).toEqual({ enabled: false, accounts: [] });
    const clip = await renderedClip();
    expect((await post(`/api/clips/${clip.id}/publish/draft`, { accountIds: ["tt"] })).status).toBe(409);
    expect((await post("/api/social/sync")).body.data).toEqual({ posts: 0, clips: 0, errors: [] });
  });

  test("draft without an LLM: template copy, the user's choices flagged, platform limits checked", async () => {
    const { clip, draft } = await ready();
    expect((await get("/api/social/accounts")).body.data.accounts.map((a: any) => a.name)).toEqual(["budi.tt", "Kanal Budi", "budi.ig", "Pins", "budi.th"]);
    const d = await draft(["tt", "yt", "pin"]);
    expect(d).toMatchObject({ clip: { id: clip.id, gateVerdict: "PASS" }, copyCheckedBy: null });
    const [t, yt, pin] = d.targets;
    expect(t).toMatchObject({ platform: "tiktok", copyBy: "template", needs: { tiktokPrivacy: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"] }, blockers: [] });
    expect(t.content).toStartWith(clip.title!);
    expect(yt).toMatchObject({ platform: "youtube", needs: { madeForKids: true }, title: expect.not.stringContaining("#"), content: expect.stringMatching(/#shorts$/) });
    expect(pin.blockers).toEqual(["pinterest doesn't take a single video post here"]);
    for (const [path, ids, status] of [[clip.id, [], 400], [clip.id, ["ghost"], 400], ["nope", ["tt"], 404]] as const) {
      expect((await post(`/api/clips/${path}/publish/draft`, { accountIds: ids })).status).toBe(status);
    }
  });

  test("draft with the LLM and Jev: per-platform copy, checked for over-claiming", async () => {
    let copyPrompt = "";
    const { draft } = await ready((url, init) => {
      const body = JSON.parse(String(init!.body));
      if (url !== "http://llm/v1/chat/completions") {   // Jev: is each platform's copy over-claiming?
        return json({ model: "jev-1.14.0", usage: { input_tokens: 1, output_tokens: 1 }, answers: Object.fromEntries(
          Object.keys(body.state.posts).map((p, i) => [`overclaims_${i}`, { type: "noul", noul: p === "tiktok" ? 0.85 : 0.1 }])) });
      }
      if (!(body.messages[0].content as string).startsWith("You write the post text")) return llmReply("{}");   // pipeline calls
      copyPrompt = body.messages[1].content;
      return llmReply(JSON.stringify({ posts: {
        tiktok: { text: `Rahasia Pak Budi! ${"#x ".repeat(3)}` }, instagram: { text: `Caption IG ${Array.from({ length: 35 }, (_, i) => `#t${i}`).join(" ")}` },
        youtube: { text: "Deskripsi #shorts", title: "Judul <YouTube> #fyp" }, threads: { text: "a ".repeat(400) } } }));
    });
    await put("llm", LLM);
    await put("jev", { apiKey: "ts_k" });
    const d = await draft(["tt", "ig", "yt", "th"]);
    expect(JSON.parse(copyPrompt)).toMatchObject({ platforms: ["tiktok", "instagram", "youtube", "threads"], direction: "yang lucu" });
    expect(d.copyCheckedBy).toBe("jev-1.14.0");
    const [t, ig, yt, th] = d.targets;
    expect(t).toMatchObject({ copyBy: "llm", overclaims: 0.85, warnings: expect.arrayContaining(["Jev: this copy may claim more than the clip says — check it"]) });
    expect(ig.content.match(/#\S+/g)).toHaveLength(30);
    expect(ig.warnings).toContain("kept the first 30 hashtags (platform limit)");
    expect(yt.title).toBe("Judul YouTube");
    expect([[...th.content].length <= 500, th.warnings]).toEqual([true, expect.arrayContaining(["shortened to the 500-character limit"])]);
  });

  test("publish: validation, the gate, then upload + one idempotent post", async () => {
    const { st, clip, publish } = await ready();
    for (const [body, msg] of [
      [{ targets: [] }, "at least one account"],
      [{ targets: [{ accountId: "ghost", content: "x" }] }, "unknown Tebar account"],
      [{ targets: [{ accountId: "pin", content: "x" }] }, "doesn't take a single video"],
      [{ targets: [{ accountId: "th", content: "a".repeat(501) }] }, "500 characters"],
      [{ targets: [{ accountId: "yt", content: "x", title: "T" }] }, "made for kids"],
      [{ targets: [{ accountId: "yt", content: "x", title: "<b>", madeForKids: false }] }, "title of 1-100"],
      [{ ...tt(), scheduledAt: "2026-11-01 19:00" }, "time zone"],
      [{ ...tt(), scheduledAt: "2020-01-01T00:00:00Z" }, "in the past"],
    ] as const) {
      const r = await publish(body);
      expect([r.status, r.body.error]).toEqual([400, expect.stringContaining(msg)]);
    }
    env.app.store.updateClip(clip.id, { gateVerdict: "REVIEW", gate: JSON.stringify({ reasons: ["may accuse a real person or company of wrongdoing"] }) });
    expect((await publish(tt())).body.error).toContain("confirmReview");
    env.app.store.updateClip(clip.id, { gateVerdict: "FAIL", gate: "{corrupt" });
    expect((await publish(tt())).body.error).toContain("override");

    const at = new Date(Date.now() + 86_400_000).toISOString().replace("Z", "+00:00");
    const r = await publish({ override: true, scheduledAt: at, targets: [
      { accountId: "tt", content: " Rahasia! #fyp ", privacyLevel: "SELF_ONLY", postMode: "direct" },
      { accountId: "yt", content: "Desk #shorts", title: "Judul", madeForKids: false }] });
    expect(r.body.data.post).toMatchObject({ clipId: clip.id, provider: "tebar", providerPostId: "post-1", status: "SCHEDULED" });
    const create = st.calls.find((c) => c.path === "/posts")!;
    expect(create.headers["Idempotency-Key"]).toBe(r.body.data.post.idempotencyKey);
    expect(create.body).toEqual({ content: "Rahasia! #fyp", media_ids: ["media-1"], scheduled_at: at, targets: [
      { account_id: "tt", content: "Rahasia! #fyp", options: { privacy_level: "SELF_ONLY", post_mode: "direct" } },
      { account_id: "yt", content: "Desk #shorts", options: { title: "Judul", made_for_kids: false } }] });
    expect(st.calls.find((c) => c.path === "/media/upload")!.headers["Content-Type"]).toBe("video/mp4");
    expect((await get(`/api/clips/${clip.id}/posts`)).body.data.posts).toHaveLength(1);
  });

  test("a failed create is kept with its exact body; retry re-sends it with the same key", async () => {
    const { st, clip, publish } = await ready();
    st.createError = json({ error: { code: "account_expired", message: "Reconnect TikTok" } }, 422);
    const expired = "Tebar 422 account_expired: Reconnect TikTok — reconnect this account at tebar.app";   // the code's hint is added
    expect((await publish(tt("Halo"))).body.error).toBe(expired);
    const failed = env.app.store.socialPostsForClip(clip.id)[0]!;
    expect(failed).toMatchObject({ status: "FAILED", providerPostId: null, errorMessage: expired });
    st.createError = undefined;
    expect((await post(`/api/social/posts/${failed.id}/retry`)).body.data.post).toMatchObject({ status: "PUBLISHING", providerPostId: "post-1" });
    const [first, second] = st.calls.filter((c) => c.path === "/posts");
    expect([second!.headers["Idempotency-Key"], second!.body]).toEqual([first!.headers["Idempotency-Key"], first!.body]);
    st.postStatus = "published";   // already on Tebar: retry just refreshes
    expect((await post(`/api/social/posts/${failed.id}/retry`)).body.data.post.status).toBe("PUBLISHED");
    expect([(await post("/api/social/posts/nope/retry")).status, (await post("/api/social/posts/nope/refresh")).status]).toEqual([404, 404]);
    env.app.store.saveSocialPost({ ...failed, id: "early", providerPostId: null, request: null, status: "FAILED" });
    expect((await post("/api/social/posts/early/retry")).status).toBe(409);
    expect((await post("/api/social/posts/early/refresh")).body.data.post.status).toBe("FAILED");
  });

  test("an unrendered clip can't be published; a Tebar outage is a 502", async () => {
    const { st, clip, publish } = await ready();
    const pending = env.app.store.clipsForVideo(clip.videoId).find((c) => !c.renderPath)!;
    expect((await post(`/api/clips/${pending.id}/publish`, tt())).status).toBe(409);
    expect((await post(`/api/clips/${pending.id}/publish/draft`, { accountIds: ["tt"] })).body.data.targets[0].blockers)
      .toContain("The clip has no rendered file yet: render it first");
    st.createError = json({ error: { code: "platform_error" } }, 503);
    expect((await publish(tt())).status).toBe(502);
  });

  test("sync: published posts' metrics become feedback; several posts are summed; FAILED posts are left alone", async () => {
    const { st, clip, publish } = await ready();
    await publish(tt("Halo"));
    const sync = async () => (await post("/api/social/sync")).body.data;
    expect(await sync()).toEqual({ posts: 1, clips: 0, errors: [] });   // not live yet
    st.postStatus = "published";
    expect(await sync()).toEqual({ posts: 1, clips: 1, errors: [] });
    expect(env.app.store.feedbackForClip(clip.id)).toMatchObject({ postViews: 1000, postLikes: 50, postComments: 5, postShares: 2, postSaves: 3,
      postedAt: "2026-10-27T10:00:00.000Z", actualViralScore: expect.any(Number) });
    expect(env.app.store.socialPostsForClip(clip.id)[0]!.status).toBe("PUBLISHED");
    env.app.store.saveSocialPost({ ...env.app.store.socialPostsForClip(clip.id)[0]!, id: "second", idempotencyKey: "k2" });
    expect(await sync()).toEqual({ posts: 2, clips: 1, errors: [] });
    expect(env.app.store.feedbackForClip(clip.id)!.postViews).toBe(2000);
    st.insights = { data: { reach: 1 } };
    expect((await sync()).clips).toBe(0);
    st.postStatus = "failed";
    expect([(await sync()).posts, (await sync()).posts]).toEqual([2, 0]);
  });

  test("sync errors are collected (not thrown); Tebar errors surface as HTTP errors; the timer runs sync", async () => {
    const { st, clip, publish } = await ready();
    await publish(tt("Halo"));
    st.postStatus = "published";
    const first = env.app.store.socialPostsForClip(clip.id)[0]!;
    env.app.store.saveSocialPost({ ...first, id: "ghost", providerPostId: "ghost-post" });
    expect((await post("/api/social/sync")).body.data).toMatchObject({ posts: 2, errors: [expect.stringContaining("ghost: Tebar 404")] });
    env.app.store.deleteClip(clip.id);   // feedback can't be saved for a clip that's gone
    expect((await post("/api/social/sync")).body.data.clips).toBe(1);

    const orig = env.fetchHandler.fn;
    env.fetchHandler.fn = async (url, init) => {
      if (url.endsWith("/insights/sync")) return json({ error: { code: "x" } }, 500);
      if (url.endsWith("/posts/post-1")) return json({ error: { code: "not_found", message: "gone" } }, 404);
      if (url.endsWith("/accounts")) return json({ error: { code: "invalid_api_key", message: "revoked" } }, 401);
      return orig(url, init);
    };
    expect((await post("/api/social/sync")).body.data.errors[0]).toStartWith("Tebar 500");
    expect([(await post(`/api/social/posts/${first.id}/refresh`)).status, (await get("/api/social/accounts")).status,
      (await get("/api/clips/nope/posts")).status]).toEqual([400, 400, 404]);

    env.fetchHandler.fn = orig;
    env.config.tebarSyncHours = 0;
    env.app.publisher.start();     // 0 = only on request
    env.config.tebarSyncHours = 1e-6;
    env.app.publisher.start();
    await Bun.sleep(30);
    env.app.publisher.stop();
    expect(st.calls.filter((c) => c.path === "/insights/sync").length).toBeGreaterThanOrEqual(2);
  });

  test("fallbacks: unusable LLM copy, Jev down, TikTok info down → template copy and warnings, no crash", async () => {
    let reply = JSON.stringify({ posts: "nope" });
    const { clip, draft } = await ready((url) => (url === "http://llm/v1/chat/completions" ? llmReply(reply) : json({ detail: "down" }, 500)));
    await put("llm", LLM);
    await put("jev", { apiKey: "ts_k" });
    expect((await draft(["ig"])).targets[0].copyBy).toBe("template");
    reply = JSON.stringify({ posts: { instagram: { text: "Copy LLM" }, youtube: { text: "" } } });
    const d = await draft(["ig", "yt"]);
    expect([d.targets.map((t: any) => t.copyBy), d.copyCheckedBy]).toEqual([["llm", "template"], null]);   // Jev failed: no check, no crash
    await put("llm", { baseUrl: "http://unreachable/v1" });
    const orig = env.fetchHandler.fn;
    env.fetchHandler.fn = async (url, init) => {
      if (url.startsWith("http://unreachable")) throw new Error("ECONNREFUSED");
      return url.endsWith("/tiktok/creator-info") ? json({ error: { code: "permission_missing" } }, 422) : orig(url, init);
    };
    const t = (await draft(["tt"])).targets[0];
    expect([t.copyBy, t.warnings[0]]).toEqual(["template", expect.stringMatching(/^Couldn't read TikTok's privacy options/)]);
    env.app.store.updateClip(clip.id, { gateVerdict: null, gate: null });
    expect((await draft(["ig"])).targets[0].warnings).toContain("Not checked by the quality gate");
  });

  test("workspaces: accounts grouped by profile; a post stays in one and carries its header on upload, create and re-send", async () => {
    const { st, clip, publish } = await ready();
    st.workspaces = { p1: ["tt", "yt"], p2: ["ig", "th"] };
    const accounts = (await get("/api/social/accounts")).body.data.accounts;
    expect(accounts.map((a: any) => [a.id, a.profileName, a.supported])).toEqual([["tt", "WS p1", true], ["yt", "WS p1", true], ["ig", "WS p2", true], ["th", "WS p2", true]]);
    const mixed = await post(`/api/clips/${clip.id}/publish/draft`, { accountIds: ["tt", "ig"] });
    expect([mixed.status, mixed.body.error]).toEqual([400, expect.stringContaining("one Tebar workspace")]);
    st.createError = json({ error: { code: "rate_limited" } }, 429);
    expect((await publish({ targets: [{ accountId: "ig", content: "Halo" }] })).status).toBe(400);
    st.createError = undefined;
    const row = env.app.store.socialPostsForClip(clip.id)[0]!;
    expect(row.profileId).toBe("p2");
    await post(`/api/social/posts/${row.id}/retry`);
    expect(st.calls.filter((c) => c.path === "/media/upload" || c.path === "/posts").map((c) => c.headers["Tebar-Profile"])).toEqual(["p2", "p2", "p2"]);
  });

  test("TikTok privacy: asked before any upload for a direct post; drafts and business accounts don't need it", async () => {
    const { st, publish } = await ready();
    const r = await publish(tt("x", {}));
    expect([r.status, r.body.error]).toEqual([400, "targets[0]: TikTok asks you to choose who can see it (PUBLIC_TO_EVERYONE, SELF_ONLY), or send it as a draft"]);
    expect(st.calls.some((c) => c.path === "/media/upload")).toBeFalse();
    expect((await publish(tt("x", { postMode: "draft" }))).status).toBe(200);
    st.tiktokBusiness = true;
    expect((await publish(tt("x", {}))).status).toBe(200);
    st.fail = "GET /accounts/tt/tiktok/creator-info";   // can't tell here: Tebar decides
    expect((await publish(tt("x", {}))).status).toBe(200);
    expect(st.calls.filter((c) => c.path === "/posts").map((c) => (c.body as any).targets[0].options)).toEqual([{ post_mode: "draft" }, undefined, undefined]);
  });

  test("retry asks Tebar to redo the failed accounts; only a scheduled post can be cancelled", async () => {
    const { st, clip, publish } = await ready();
    await publish(tt());
    const row = env.app.store.socialPostsForClip(clip.id)[0]!;
    env.app.store.updateSocialPost(row.id, { status: "FAILED" });
    expect((await post(`/api/social/posts/${row.id}/retry`)).body.data.post.status).toBe("PUBLISHED");
    expect(st.calls.at(-1)).toMatchObject({ method: "POST", path: "/posts/post-1/retry" });
    expect((await post(`/api/social/posts/${row.id}/cancel`)).status).toBe(409);
    env.app.store.updateSocialPost(row.id, { status: "SCHEDULED" });
    st.fail = "DELETE /posts/post-1";
    expect((await post(`/api/social/posts/${row.id}/cancel`)).body.error).toContain("post_not_removable");
    st.fail = null;
    expect((await post(`/api/social/posts/${row.id}/cancel`)).body.data.post.status).toBe("CANCELLED");
    expect(st.calls.at(-1)).toMatchObject({ method: "DELETE", path: "/posts/post-1" });
    env.app.store.updateSocialPost(row.id, { status: "PARTIAL" });
    st.fail = "POST /posts/post-1/retry";
    expect((await post(`/api/social/posts/${row.id}/retry`)).status).toBe(400);
    expect((await post("/api/social/posts/nope/cancel")).status).toBe(404);
  });

  test("helpers: copy fitting and post status", () => {
    expect(fitCopy("halo", "unknown")).toEqual({ text: "halo", warnings: [] });
    const status = (statuses: string[], s = "publishing") => postStatus({ id: "p", status: s, scheduledAt: null,
      targets: statuses.map((x) => ({ id: null, accountId: "a", platform: "x", status: x, permalink: null, errorCode: null, errorMessage: null, publishedAt: null })) });
    expect([status(["published", "published"]), status(["published", "failed"]), status(["failed"]), status(["pending"], "scheduled"), status([])])
      .toEqual(["PUBLISHED", "PARTIAL", "FAILED", "SCHEDULED", "PUBLISHING"]);
  });
});
