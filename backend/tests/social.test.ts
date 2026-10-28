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

const ACCOUNTS = [
  { id: "tt", platform: "tiktok", username: "budi.tt" }, { id: "yt", platform: "youtube", name: "Kanal Budi" },
  { id: "ig", platform: "instagram", username: "budi.ig" }, { id: "pin", platform: "pinterest", name: "Pins" },
  { id: "th", platform: "threads", username: "budi.th" },
];

interface TebarState {
  calls: Array<{ method: string; path: string; body: unknown; headers: Record<string, string> }>;
  postStatus: string;
  createError?: Response;
  insights: unknown;
}

/** A fake Tebar API behind env.fetchHandler (LLM / Jev calls go to `other`). */
function fakeTebar(other: (url: string, init?: RequestInit) => Response | Promise<Response> = (url) => { throw new Error(`no network: ${url}`); }) {
  const st: TebarState = { calls: [], postStatus: "pending", insights: { data: { views: 1000, likes: 50, comments: 5, shares: 2, saves: 3 } } };
  env.fetchHandler.fn = async (url, init) => {
    if (!url.startsWith("https://api.tebar.app/v1")) return other(url, init);
    const path = url.slice("https://api.tebar.app/v1".length);
    const method = String(init?.method);
    st.calls.push({ method, path, body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body, headers: init?.headers as Record<string, string> });
    if (path === "/me") return json({ data: { email: "budi@example.com" } });
    if (path === "/accounts") return json({ data: ACCOUNTS });
    if (path === "/accounts/tt/tiktok/creator-info") return json({ privacy_level_options: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"] });
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

async function connectTebar() {
  const r = await env.json("PUT", "/api/settings/tebar", { apiKey: "tb_live_secret1234" });
  expect(r.status).toBe(200);
}

/** A finished pipeline run; returns its best clip (rendered, gate PASS). */
async function renderedClip() {
  const videoId = (await env.json("POST", "/api/import", { url: "https://www.youtube.com/watch?v=abcdefghijk" })).body.data.videoId;
  await env.json("POST", "/api/process", { videoId, options: { direction: "yang lucu" } });
  await env.app.jobs.whenIdle();
  return env.app.store.clipsForVideo(videoId)[0]!;
}

describe("connection settings", () => {
  test("view masks keys; a saved field wins over the env; null goes back to it", async () => {
    const before = (await env.json("GET", "/api/settings")).body.data;
    expect(before.llm).toMatchObject({ active: false, baseUrl: "", model: "", apiKey: "", apiKeySet: false, enabled: true, director: true, saved: [] });
    expect(before.jev).toMatchObject({ url: "https://api.typesafe.ai/v1/systemone", model: "jev-1.14.0", active: false });
    expect(before.tebar).toMatchObject({ baseUrl: "https://api.tebar.app/v1", active: false });

    const r = await env.json("PUT", "/api/settings/llm", { baseUrl: " https://api.openai.com/v1 ", model: "gpt-x", apiKey: "sk-abcdefgh1234" });
    expect(r.body.data.llm).toMatchObject({ active: true, baseUrl: "https://api.openai.com/v1", model: "gpt-x", apiKey: "••••1234", apiKeySet: true });
    expect(r.body.data.llm.saved.sort()).toEqual(["apiKey", "baseUrl", "model"]);
    expect(JSON.stringify(r.body)).not.toContain("sk-abcdefgh1234");
    expect(env.app.llm.enabled).toBeTrue();
    expect((await env.json("PUT", "/api/settings/llm", { enabled: false })).body.data.llm.active).toBeFalse();
    expect(env.app.llm.enabled).toBeFalse();
    const cleared = (await env.json("PUT", "/api/settings/llm", { baseUrl: null, enabled: null })).body.data.llm;
    expect(cleared).toMatchObject({ baseUrl: "", enabled: true, saved: ["model", "apiKey"] });
  });

  test("bad input is a 400; unknown connections a 404", async () => {
    for (const [kind, body] of [["llm", { baseUrl: "ftp://x" }], ["llm", { enabled: "yes" }], ["jev", { apiKey: "a b" }],
      ["jev", { model: 5 }], ["tebar", { nope: 1 }], ["llm", { model: "m".repeat(301) }]] as const) {
      expect((await env.json("PUT", `/api/settings/${kind}`, body)).status).toBe(400);
    }
    expect((await env.json("PUT", "/api/settings/openai", {})).status).toBe(404);
    expect((await env.json("POST", "/api/settings/openai/test")).status).toBe(404);
  });

  test("saved settings survive a restart; an unreadable one is ignored", () => {
    const db = openDatabase(":memory:");
    const store = new Store(db);
    const config = { ...env.config, jevApiKey: "", jevModel: "jev-1.14.0" };
    const clients = { llm: new Llm(config), jev: new Jev(config), tebar: new Tebar(config) };
    new ConnectionSettings(config, store, clients).update("jev", { apiKey: "ts_key_99999999", model: "jev-1.13.0" });
    store.setSetting("jev.url", "{not json");
    const again = { ...env.config, jevApiKey: "", jevModel: "jev-1.14.0" };
    const s2 = new ConnectionSettings(again, store, { llm: new Llm(again), jev: new Jev(again), tebar: new Tebar(again) });
    expect(again).toMatchObject({ jevApiKey: "ts_key_99999999", jevModel: "jev-1.13.0", jevUrl: env.config.jevUrl });
    expect(s2.view().jev).toMatchObject({ apiKey: "••••9999", active: true });
    expect(mask("short")).toBe("••••");
    expect(mask("")).toBe("");
  });

  test("test connection: not configured, working, failing", async () => {
    expect((await env.json("POST", "/api/settings/llm/test")).body.data).toMatchObject({ ok: false, error: expect.stringContaining("Not configured") });
    expect((await env.json("POST", "/api/settings/jev/test")).body.data.ok).toBeFalse();
    expect((await env.json("POST", "/api/settings/tebar/test")).body.data.ok).toBeFalse();
    fakeTebar((url, init) => {
      if (url === "http://llm/v1/chat/completions") return json({ choices: [{ message: { role: "assistant", content: " OK " } }] });
      if (url === "https://api.typesafe.ai/v1/systemone") {
        expect(JSON.parse(String(init!.body)).questions.test.type).toBe("noul");
        return json({ model: "jev-1.14.0", answers: { test: { type: "noul", noul: 0.97 } }, usage: { input_tokens: 9, output_tokens: 1 } });
      }
      return json({}, 500);
    });
    await env.json("PUT", "/api/settings/llm", { baseUrl: "http://llm/v1", model: "qwen" });
    await env.json("PUT", "/api/settings/jev", { apiKey: "ts_k" });
    await connectTebar();
    expect((await env.json("POST", "/api/settings/llm/test")).body.data).toMatchObject({ ok: true, model: "qwen", detail: "OK" });
    expect((await env.json("POST", "/api/settings/jev/test")).body.data).toMatchObject({ ok: true, model: "jev-1.14.0", detail: "answered 0.97" });
    expect((await env.json("POST", "/api/settings/tebar/test")).body.data).toMatchObject({ ok: true, detail: "budi@example.com" });
    await env.json("PUT", "/api/settings/llm", { baseUrl: "http://down/v1" });
    expect((await env.json("POST", "/api/settings/llm/test")).body.data).toMatchObject({ ok: false, error: "LLM HTTP 500: {}" });
  });
});

describe("publishing through Tebar", () => {
  test("not connected: accounts say so, actions are a 409", async () => {
    expect((await env.json("GET", "/api/social/accounts")).body.data).toEqual({ enabled: false, accounts: [] });
    const clip = await renderedClip();
    expect((await env.json("POST", `/api/clips/${clip.id}/publish/draft`, { accountIds: ["tt"] })).status).toBe(409);
    expect((await env.json("POST", "/api/social/sync")).body.data).toEqual({ posts: 0, clips: 0, errors: [] });
  });

  test("draft without an LLM: template copy, the user's choices flagged, platform limits checked", async () => {
    fakeTebar();
    await connectTebar();
    expect((await env.json("GET", "/api/social/accounts")).body.data.accounts.map((a: any) => a.name)).toEqual(
      ["budi.tt", "Kanal Budi", "budi.ig", "Pins", "budi.th"]);
    const clip = await renderedClip();
    const d = (await env.json("POST", `/api/clips/${clip.id}/publish/draft`, { accountIds: ["tt", "yt", "pin"] })).body.data;
    expect(d.clip).toMatchObject({ id: clip.id, gateVerdict: "PASS" });
    expect(d.copyCheckedBy).toBeNull();
    const [tt, yt, pin] = d.targets;
    expect(tt).toMatchObject({ platform: "tiktok", copyBy: "template", needs: { tiktokPrivacy: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"] }, blockers: [] });
    expect(tt.content).toStartWith(clip.title!);
    expect(yt).toMatchObject({ platform: "youtube", needs: { madeForKids: true } });
    expect(yt.title).not.toContain("#");
    expect(yt.content).toEndWith("#shorts");
    expect(pin.blockers).toEqual(["pinterest doesn't take a single video post here"]);
    expect((await env.json("POST", `/api/clips/${clip.id}/publish/draft`, { accountIds: [] })).status).toBe(400);
    expect((await env.json("POST", `/api/clips/${clip.id}/publish/draft`, { accountIds: ["ghost"] })).status).toBe(400);
    expect((await env.json("POST", "/api/clips/nope/publish/draft", { accountIds: ["tt"] })).status).toBe(404);
  });

  test("draft with the LLM and Jev: per-platform copy, checked for over-claiming", async () => {
    let copyPrompt = "";
    fakeTebar((url, init) => {
      const body = JSON.parse(String(init!.body));
      if (url === "http://llm/v1/chat/completions") {
        const system = body.messages[0].content as string;
        if (!system.startsWith("You write the post text")) {
          return json({ choices: [{ message: { role: "assistant", content: "{}" } }] });   // pipeline calls: fall back to rules
        }
        copyPrompt = body.messages[1].content;
        return json({ choices: [{ message: { role: "assistant", content: JSON.stringify({ posts: {
          tiktok: { text: `Rahasia Pak Budi! ${"#x ".repeat(3)}` }, instagram: { text: `Caption IG ${Array.from({ length: 35 }, (_, i) => `#t${i}`).join(" ")}` },
          youtube: { text: "Deskripsi #shorts", title: "Judul <YouTube> #fyp" }, threads: { text: "a ".repeat(400) } } }) } }] });
      }
      const overclaim = Object.entries(body.state.posts).map(([p]) => p);
      return json({ model: "jev-1.14.0", usage: { input_tokens: 1, output_tokens: 1 },
        answers: Object.fromEntries(overclaim.map((p, i) => [`overclaims_${i}`, { type: "noul", noul: p === "tiktok" ? 0.85 : 0.1 }])) });
    });
    await connectTebar();
    const clip = await renderedClip();
    await env.json("PUT", "/api/settings/llm", { baseUrl: "http://llm/v1", model: "qwen" });
    await env.json("PUT", "/api/settings/jev", { apiKey: "ts_k" });
    const d = (await env.json("POST", `/api/clips/${clip.id}/publish/draft`, { accountIds: ["tt", "ig", "yt", "th"] })).body.data;
    expect(JSON.parse(copyPrompt)).toMatchObject({ platforms: ["tiktok", "instagram", "youtube", "threads"], direction: "yang lucu" });
    expect(d.copyCheckedBy).toBe("jev-1.14.0");
    const [tt, ig, yt, th] = d.targets;
    expect(tt).toMatchObject({ copyBy: "llm", overclaims: 0.85 });
    expect(tt.warnings).toContain("Jev: this copy may claim more than the clip says — check it");
    expect(ig.content.match(/#\S+/g)).toHaveLength(30);
    expect(ig.warnings).toContain("kept the first 30 hashtags (platform limit)");
    expect(yt.title).toBe("Judul YouTube");
    expect([...th.content].length).toBeLessThanOrEqual(500);
    expect(th.warnings).toContain("shortened to the 500-character limit");
  });

  test("publish: validation, the gate, then upload + one idempotent post", async () => {
    const st = fakeTebar();
    await connectTebar();
    const clip = await renderedClip();
    const url = `/api/clips/${clip.id}/publish`;
    const bad: Array<[unknown, string]> = [
      [{ targets: [] }, "at least one account"],
      [{ targets: [{ accountId: "ghost", content: "x" }] }, "unknown Tebar account"],
      [{ targets: [{ accountId: "pin", content: "x" }] }, "doesn't take a single video"],
      [{ targets: [{ accountId: "th", content: "a".repeat(501) }] }, "500 characters"],
      [{ targets: [{ accountId: "yt", content: "x", title: "T" }] }, "made for kids"],
      [{ targets: [{ accountId: "yt", content: "x", title: "<b>", madeForKids: false }] }, "title of 1-100"],
      [{ targets: [{ accountId: "tt", content: "x" }], scheduledAt: "2026-11-01 19:00" }, "time zone"],
      [{ targets: [{ accountId: "tt", content: "x" }], scheduledAt: "2020-01-01T00:00:00Z" }, "in the past"],
    ];
    for (const [body, msg] of bad) {
      const r = await env.json("POST", url, body);
      expect([r.status, r.body.error]).toEqual([400, expect.stringContaining(msg)]);
    }

    env.app.store.updateClip(clip.id, { gateVerdict: "REVIEW", gate: JSON.stringify({ reasons: ["may accuse a real person or company of wrongdoing"] }) });
    const review = await env.json("POST", url, { targets: [{ accountId: "tt", content: "x" }] });
    expect([review.status, review.body.error]).toEqual([409, expect.stringContaining("confirmReview")]);
    env.app.store.updateClip(clip.id, { gateVerdict: "FAIL", gate: "{corrupt" });
    expect((await env.json("POST", url, { targets: [{ accountId: "tt", content: "x" }] })).body.error).toContain("override");

    const at = new Date(Date.now() + 86_400_000).toISOString().replace("Z", "+00:00");
    const r = await env.json("POST", url, { override: true, scheduledAt: at, targets: [
      { accountId: "tt", content: " Rahasia! #fyp ", privacyLevel: "SELF_ONLY", postMode: "direct" },
      { accountId: "yt", content: "Desk #shorts", title: "Judul", madeForKids: false }] });
    expect(r.status).toBe(200);
    expect(r.body.data.post).toMatchObject({ clipId: clip.id, provider: "tebar", providerPostId: "post-1", status: "SCHEDULED" });
    const create = st.calls.find((c) => c.path === "/posts")!;
    expect(create.headers["Idempotency-Key"]).toBe(r.body.data.post.idempotencyKey);
    expect(create.body).toEqual({ content: "Rahasia! #fyp", media_ids: ["media-1"], scheduled_at: at, targets: [
      { account_id: "tt", content: "Rahasia! #fyp", options: { privacy_level: "SELF_ONLY", post_mode: "direct" } },
      { account_id: "yt", content: "Desk #shorts", options: { title: "Judul", made_for_kids: false } }] });
    expect(st.calls.find((c) => c.path === "/media/upload")!.headers["Content-Type"]).toBe("video/mp4");
    expect((await env.json("GET", `/api/clips/${clip.id}/posts`)).body.data.posts).toHaveLength(1);
  });

  test("a failed create is kept with its exact body; retry re-sends it with the same key", async () => {
    const st = fakeTebar();
    await connectTebar();
    const clip = await renderedClip();
    st.createError = json({ error: { code: "account_expired", message: "Reconnect TikTok" } }, 422);
    const r = await env.json("POST", `/api/clips/${clip.id}/publish`, { targets: [{ accountId: "tt", content: "Halo" }] });
    expect([r.status, r.body.error]).toEqual([400, "Tebar 422 account_expired: Reconnect TikTok"]);
    const failed = env.app.store.socialPostsForClip(clip.id)[0]!;
    expect(failed).toMatchObject({ status: "FAILED", providerPostId: null, errorMessage: "Tebar 422 account_expired: Reconnect TikTok" });
    st.createError = undefined;
    const retried = (await env.json("POST", `/api/social/posts/${failed.id}/retry`)).body.data.post;
    expect(retried).toMatchObject({ status: "PUBLISHING", providerPostId: "post-1" });
    const creates = st.calls.filter((c) => c.path === "/posts");
    expect(creates[1]!.headers["Idempotency-Key"]).toBe(creates[0]!.headers["Idempotency-Key"]);
    expect(creates[1]!.body).toEqual(creates[0]!.body);
    // Already on Tebar: retry just refreshes.
    st.postStatus = "published";
    expect((await env.json("POST", `/api/social/posts/${failed.id}/retry`)).body.data.post.status).toBe("PUBLISHED");
    expect((await env.json("POST", "/api/social/posts/nope/retry")).status).toBe(404);
    expect((await env.json("POST", "/api/social/posts/nope/refresh")).status).toBe(404);
    env.app.store.saveSocialPost({ ...failed, id: "early", providerPostId: null, request: null, status: "FAILED" });
    expect((await env.json("POST", "/api/social/posts/early/retry")).status).toBe(409);
    expect((await env.json("POST", "/api/social/posts/early/refresh")).body.data.post.status).toBe("FAILED");
  });

  test("an unrendered clip can't be published; a Tebar outage is a 502", async () => {
    const st = fakeTebar();
    await connectTebar();
    const clips = await renderedClip().then((c) => env.app.store.clipsForVideo(c.videoId));
    const pending = clips.find((c) => !c.renderPath)!;
    expect((await env.json("POST", `/api/clips/${pending.id}/publish`, { targets: [{ accountId: "tt", content: "x" }] })).status).toBe(409);
    expect((await env.json("POST", `/api/clips/${pending.id}/publish/draft`, { accountIds: ["tt"] })).body.data.targets[0].blockers)
      .toContain("The clip has no rendered file yet: render it first");
    st.createError = json({ error: { code: "platform_error" } }, 503);
    expect((await env.json("POST", `/api/clips/${clips[0]!.id}/publish`, { targets: [{ accountId: "tt", content: "x" }] })).status).toBe(502);
  });

  test("sync: published posts' metrics become feedback the scorer learns from", async () => {
    const st = fakeTebar();
    await connectTebar();
    const clip = await renderedClip();
    await env.json("POST", `/api/clips/${clip.id}/publish`, { targets: [{ accountId: "tt", content: "Halo" }] });
    expect((await env.json("POST", "/api/social/sync")).body.data).toEqual({ posts: 1, clips: 0, errors: [] });   // not live yet
    st.postStatus = "published";
    const s = (await env.json("POST", "/api/social/sync")).body.data;
    expect(s).toEqual({ posts: 1, clips: 1, errors: [] });
    const fb = env.app.store.feedbackForClip(clip.id)!;
    expect(fb).toMatchObject({ postViews: 1000, postLikes: 50, postComments: 5, postShares: 2, postSaves: 3, postedAt: "2026-10-27T10:00:00.000Z" });
    expect(fb.actualViralScore).toBeGreaterThan(0);
    expect(env.app.store.socialPostsForClip(clip.id)[0]).toMatchObject({ status: "PUBLISHED" });
    st.insights = { data: { reach: 1 } };
    expect((await env.json("POST", "/api/social/sync")).body.data.clips).toBe(0);
    st.postStatus = "failed";
    expect((await env.json("POST", "/api/social/sync")).body.data.posts).toBe(1);
    expect((await env.json("POST", "/api/social/sync")).body.data.posts).toBe(0);   // FAILED posts are left alone
  });

  test("sync collects errors; the background timer runs it", async () => {
    const st = fakeTebar();
    await connectTebar();
    const clip = await renderedClip();
    await env.json("POST", `/api/clips/${clip.id}/publish`, { targets: [{ accountId: "tt", content: "Halo" }] });
    st.postStatus = "published";
    st.insights = { data: { views: 5 } };
    env.app.store.updateSocialPost(env.app.store.socialPostsForClip(clip.id)[0]!.id, { createdAt: "2026-10-27T09:00:00Z" });
    env.app.store.saveSocialPost({ ...env.app.store.socialPostsForClip(clip.id)[0]!, id: "ghost", providerPostId: "ghost-post" });
    const r = (await env.json("POST", "/api/social/sync")).body.data;
    expect(r.posts).toBe(2);
    expect(r.errors).toEqual([expect.stringContaining("ghost: Tebar 404")]);

    env.config.tebarSyncHours = 0;
    env.app.publisher.start();     // 0 = only on request
    env.config.tebarSyncHours = 1e-6;
    env.app.publisher.start();
    await Bun.sleep(30);
    env.app.publisher.stop();
    expect(st.calls.filter((c) => c.path === "/posts/post-1/insights").length).toBeGreaterThanOrEqual(2);
  });

  test("fallbacks: unusable LLM copy, Jev down, TikTok info down → template copy and warnings, no crash", async () => {
    let llmReply = JSON.stringify({ posts: "nope" });
    fakeTebar((url) => {
      if (url === "http://llm/v1/chat/completions") return json({ choices: [{ message: { role: "assistant", content: llmReply } }] });
      return json({ detail: "down" }, 500);   // Jev
    });
    await connectTebar();
    const clip = await renderedClip();
    await env.json("PUT", "/api/settings/llm", { baseUrl: "http://llm/v1", model: "qwen" });
    await env.json("PUT", "/api/settings/jev", { apiKey: "ts_k" });
    const draft = async (ids: string[]) => (await env.json("POST", `/api/clips/${clip.id}/publish/draft`, { accountIds: ids })).body.data;
    expect((await draft(["ig"])).targets[0].copyBy).toBe("template");
    llmReply = JSON.stringify({ posts: { instagram: { text: "Copy LLM" }, youtube: { text: "" } } });
    const d = await draft(["ig", "yt"]);
    expect(d.targets.map((t: any) => t.copyBy)).toEqual(["llm", "template"]);
    expect(d.copyCheckedBy).toBeNull();                  // Jev failed: no check, no crash
    await env.json("PUT", "/api/settings/llm", { baseUrl: "http://unreachable/v1" });
    env.fetchHandler.fn = ((orig) => async (url: string, init?: RequestInit) => {
      if (url.startsWith("http://unreachable")) throw new Error("ECONNREFUSED");
      if (url.endsWith("/tiktok/creator-info")) return json({ error: { code: "permission_missing" } }, 422);
      return orig(url, init);
    })(env.fetchHandler.fn);
    const t = (await draft(["tt"])).targets[0];
    expect(t.copyBy).toBe("template");
    expect(t.warnings[0]).toStartWith("Couldn't read TikTok's privacy options");
    env.app.store.updateClip(clip.id, { gateVerdict: null, gate: null });
    expect((await draft(["ig"])).targets[0].warnings).toContain("Not checked by the quality gate");
  });

  test("Tebar errors surface as HTTP errors; sync sums a clip's posts and reports failures", async () => {
    const st = fakeTebar();
    await connectTebar();
    const clip = await renderedClip();
    await env.json("POST", `/api/clips/${clip.id}/publish`, { targets: [{ accountId: "tt", content: "Satu" }] });
    const first = env.app.store.socialPostsForClip(clip.id)[0]!;
    env.app.store.saveSocialPost({ ...first, id: "second", idempotencyKey: "k2" });   // posted twice (e.g. two accounts later)
    st.postStatus = "published";
    const r = (await env.json("POST", "/api/social/sync")).body.data;
    expect(r).toEqual({ posts: 2, clips: 1, errors: [] });
    expect(env.app.store.feedbackForClip(clip.id)!.postViews).toBe(2000);

    env.app.store.deleteClip(clip.id);   // feedback can't be saved for a clip that's gone
    env.app.store.deleteClip(clip.id);
    const gone = (await env.json("POST", "/api/social/sync")).body.data;
    expect(gone.clips).toBe(1);

    const orig = env.fetchHandler.fn;
    env.fetchHandler.fn = async (url, init) => {
      if (url.endsWith("/insights/sync")) return json({ error: { code: "x" } }, 500);
      if (url.endsWith("/posts/post-1")) return json({ error: { code: "not_found", message: "gone" } }, 404);
      if (url.endsWith("/accounts")) return json({ error: { code: "invalid_api_key", message: "revoked" } }, 401);
      return orig(url, init);
    };
    const failed = (await env.json("POST", "/api/social/sync")).body.data;
    expect(failed.errors[0]).toStartWith("Tebar 500");
    expect(failed.errors.some((e: string) => e.includes("Tebar 404"))).toBeTrue();
    expect((await env.json("POST", `/api/social/posts/${first.id}/refresh`)).status).toBe(400);
    expect((await env.json("GET", "/api/social/accounts")).status).toBe(400);
    expect((await env.json("GET", "/api/clips/nope/posts")).status).toBe(404);
  });

  test("helpers: copy fitting and post status", () => {
    expect(fitCopy("halo", "unknown")).toEqual({ text: "halo", warnings: [] });
    const post = (statuses: string[], status = "publishing") => ({ id: "p", status, scheduledAt: null,
      targets: statuses.map((s) => ({ id: null, accountId: "a", platform: "x", status: s, permalink: null, errorCode: null, errorMessage: null, publishedAt: null })) });
    expect(postStatus(post(["published", "published"]))).toBe("PUBLISHED");
    expect(postStatus(post(["published", "failed"]))).toBe("PARTIAL");
    expect(postStatus(post(["failed"]))).toBe("FAILED");
    expect(postStatus(post(["pending"], "scheduled"))).toBe("SCHEDULED");
    expect(postStatus(post([]))).toBe("PUBLISHING");
  });
});
