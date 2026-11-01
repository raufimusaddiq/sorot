import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { ask } from "../src/prompt";
import { Fail, harness } from "./helpers";

const ACCOUNTS = [
  { id: "tt", platform: "tiktok", name: "budi.tt", profileId: null, profileName: null, supported: true },
  { id: "yt", platform: "youtube", name: "Kanal Budi", profileId: null, profileName: null, supported: true },
  { id: "pin", platform: "pinterest", name: "Pins", profileId: null, profileName: null, supported: false },
];
const target = (accountId: string, platform: string, extra: object = {}) => ({
  accountId, platform, name: ACCOUNTS.find((x) => x.id === accountId)?.name ?? accountId, content: `copy ${platform}`, copyBy: "llm",
  needs: platform === "tiktok" ? { tiktokPrivacy: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"] } : platform === "youtube" ? { madeForKids: true } : {},
  warnings: [], blockers: [], ...(platform === "youtube" ? { title: "Judul" } : {}), ...extra,
});

/** Tebar connected; the draft answers for the accounts asked; publish echoes a post. */
function tebar(opts: { accounts?: object[]; gate?: string | null; blockers?: string[] } = {}) {
  return harness({
    "GET /api/social/accounts": { enabled: true, accounts: opts.accounts ?? ACCOUNTS },
    "POST /api/clips/c1/publish/draft": (b: any) => ({ clip: { id: "c1", gateVerdict: opts.gate ?? "PASS", gateReasons: ["may accuse a real person"] },
      copyCheckedBy: null, targets: b.accountIds.map((id: string) => target(id, ACCOUNTS.find((x) => x.id === id)!.platform, { blockers: opts.blockers ?? [] })) }),
    "POST /api/clips/c1/publish": (b: any) => ({ post: { id: "post-9", status: b.scheduledAt ? "SCHEDULED" : "PUBLISHING", body: b } }),
    "GET /api/clips/c1/posts": { posts: [{ id: "post-9", status: "PUBLISHED", createdAt: "2026-10-28T10:00:00.000Z",
      targets: JSON.stringify([{ platform: "tiktok", status: "published", permalink: "https://tiktok.com/v/1" }]) }] },
    "POST /api/social/posts/post-9/cancel": { post: { id: "post-9", status: "CANCELLED", createdAt: "2026-10-28T10:00:00.000Z", targets: "[{" } },
    "POST /api/social/sync": { posts: 2, clips: 1, errors: ["p2: Tebar 404"] },
  });
}
const sent = (h: ReturnType<typeof tebar>) => h.requests.findLast((r) => r.path === "/api/clips/c1/publish")?.body;

describe("accounts", () => {
  test("by workspace, unsupported ones noted; not connected says how to connect", async () => {
    const h = tebar({ accounts: [{ ...ACCOUNTS[0], profileName: "Budi" }, { ...ACCOUNTS[2], profileName: "Klien" }] });
    expect(await h.run("accounts")).toBe(0);
    expect(h.out[0]!.split("\n")[0]).toMatch(/^WORKSPACE\s+PLATFORM\s+NAME\s+ID\s+NOTE$/);
    expect(h.text()).toContain("can't take a video post");
    const off = harness({ "GET /api/social/accounts": { enabled: false, accounts: [] } });
    expect(await off.run("accounts")).toBe(1);
    expect(off.err.at(-1)).toContain("sorot connect setup");
  });
});

describe("publish a generated video", () => {
  test("--generated posts an export through its own routes; its posts are listed the same way", async () => {
    const h = harness({
      "GET /api/social/accounts": { enabled: true, accounts: ACCOUNTS },
      "POST /api/generate/exports/ex1/publish/draft": (b: any) => ({ clip: { id: "ex1", gateVerdict: "PASS", gateReasons: [] }, copyCheckedBy: null,
        targets: b.accountIds.map((id: string) => target(id, "tiktok")) }),
      "POST /api/generate/exports/ex1/publish": (b: any) => ({ post: { id: "post-7", status: "PUBLISHING", body: b } }),
      "GET /api/generate/exports/ex1/posts": { posts: [{ id: "post-7", status: "PUBLISHED", createdAt: "2026-10-28T10:00:00.000Z", targets: "[]" }] },
    });
    expect(await h.run("publish", "--generated", "ex1", "--to", "tt", "--draft", "--yes")).toBe(0);
    expect(h.requests.findLast((r) => r.path === "/api/generate/exports/ex1/publish")!.body).toMatchObject({ targets: [{ accountId: "tt", postMode: "draft" }] });
    expect(h.text()).toContain("Follow it: sorot posts --generated ex1");
    expect(await h.run("posts", "--generated", "ex1")).toBe(0);
    expect(h.out.at(-1)).toContain("post-7");
  });
});

describe("publish in a script (flags)", () => {
  test("every choice from flags: exact body, never a default for privacy or made-for-kids", async () => {
    const h = tebar();
    expect(await h.run("publish", "c1", "--to", "budi.tt,yt", "--privacy", "self_only", "--made-for-kids", "no", "--title", "Final",
      "--at", "2026-11-01T19:00:00+07:00", "--yes")).toBe(0);
    expect(sent(h)).toEqual({ scheduledAt: "2026-11-01T19:00:00+07:00", targets: [
      { accountId: "tt", content: "copy tiktok", privacyLevel: "SELF_ONLY" },
      { accountId: "yt", content: "copy youtube", title: "Final", madeForKids: false }] });
    expect(h.text()).toContain("SCHEDULED: post post-9");
    await h.run("publish", "c1", "--to", "tt", "--draft", "--text", "Halo", "--yes", "--json");
    expect(sent(h)).toMatchObject({ targets: [{ accountId: "tt", content: "Halo", postMode: "draft" }] });
  });

  test.each([
    [["--yes"], "Pick accounts with --to"],
    [["--to", "ghost"], "--to ghost: no such account"],
    [["--to", "tt"], "TikTok asks who can see it (budi.tt): add --privacy <PUBLIC_TO_EVERYONE|SELF_ONLY>, or --draft"],
    [["--to", "tt", "--privacy", "friends"], "--privacy for budi.tt: one of PUBLIC_TO_EVERYONE, SELF_ONLY"],
    [["--to", "yt"], "add --made-for-kids yes or no"],
    [["--to", "yt", "--made-for-kids", "maybe"], "--made-for-kids takes yes or no"],
    [["--to", "tt", "--draft"], "Add --yes to post without being asked"],
  ])("%o → %s", async (flags, message) => {
    const h = tebar();
    expect(await h.run("publish", "c1", ...flags)).toBe(2);
    expect(h.err.at(-1)).toContain(message);
    expect(sent(h)).toBeUndefined();
  });

  test("one workspace per post; the gate's REVIEW / FAIL need their flag; other blockers stop it", async () => {
    const ws = tebar({ accounts: [{ ...ACCOUNTS[0], profileName: "A" }, { ...ACCOUNTS[1], profileName: "B" }] });
    expect(await ws.run("publish", "c1", "--to", "tt,yt")).toBe(2);
    expect(ws.err.at(-1)).toContain("one Tebar workspace");
    for (const [gate, flag] of [["REVIEW", "--confirm-review"], ["FAIL", "--override"]] as const) {
      const h = tebar({ gate });
      expect(await h.run("publish", "c1", "--to", "tt", "--draft", "--yes")).toBe(2);
      expect(h.err.at(-1)).toContain(`add ${flag}`);
      expect(await h.run("publish", "c1", "--to", "tt", "--draft", "--yes", flag)).toBe(0);
      expect(sent(h)).toMatchObject(gate === "REVIEW" ? { confirmReview: true } : { override: true });
    }
    const blocked = tebar({ blockers: ["The clip has no rendered file yet: render it first"] });
    expect(await blocked.run("publish", "c1", "--to", "tt", "--draft", "--yes")).toBe(1);
    expect(blocked.err.at(-1)).toBe("✗ The clip has no rendered file yet: render it first");
  });
});

describe("publish on a terminal (asks)", () => {
  test("picks accounts by number, asks privacy and made-for-kids, confirms", async () => {
    const h = tebar();
    h.state.tty = true;
    h.state.answers = ["1, 2", "2", "maybe", "no", "y"];
    expect(await h.run("publish", "c1")).toBe(0);
    expect(h.text()).not.toContain("Pins");   // an account that can't take a video isn't offered
    expect(h.state.asked).toEqual(["Post to (numbers, e.g. 1,3): ", "Who can see it on TikTok (budi.tt)? ",
      "Made for kids? YouTube asks every upload [yes/no] ", "Made for kids? YouTube asks every upload [yes/no] ", "Post now to 2 accounts? [y/N] "]);
    expect(sent(h).targets).toEqual([{ accountId: "tt", content: "copy tiktok", privacyLevel: "SELF_ONLY" },
      { accountId: "yt", content: "copy youtube", title: "Judul", madeForKids: false }]);
  });

  test.each([
    [["9"], 2, "Pick numbers from 1 to 2"],
    [["1", "7"], 2, "Pick a number from 1 to 2"],
    [["2", "x", "maybe", "z"], 2, "Answer yes or no"],
    [["1", "1", "n"], 1, "Not posted."],
  ])("answers %o → exit %d (%s)", async (answers, code, message) => {
    const h = tebar();
    h.state.tty = true;
    h.state.answers = answers;
    expect(await h.run("publish", "c1")).toBe(code);
    expect(h.text() + h.err.join("\n")).toContain(message);
  });

  test("the gate asks instead of failing; nothing postable is said plainly", async () => {
    const h = tebar({ gate: "REVIEW" });
    h.state.tty = true;
    h.state.answers = ["y"];
    expect(await h.run("publish", "c1", "--to", "tt", "--draft", "--yes")).toBe(0);
    expect(h.state.asked[0]).toBe("The quality gate asks for a review (may accuse a real person). Checked it? [y/N] ");
    const none = tebar({ accounts: [ACCOUNTS[2]] });
    none.state.tty = true;
    expect(await none.run("publish", "c1")).toBe(1);
    expect(none.err.at(-1)).toContain("No account here can take a video post");
  });
});

test("posts, post actions and sync", async () => {
  const h = tebar();
  expect(await h.run("posts", "c1")).toBe(0);
  expect(h.text()).toContain("post-9  PUBLISHED  2026-10-28 10:00  tiktok published https://tiktok.com/v/1");
  expect(await h.run("posts", "cancel", "post-9")).toBe(0);
  expect(h.out.at(-1)).toContain("CANCELLED");
  expect(await h.run("posts", "c1", "--json")).toBe(0);
  expect(await h.run("posts", "cancel", "post-9", "--json")).toBe(0);
  expect(await h.run("sync")).toBe(1);
  expect([h.out.at(-1), h.err.at(-1)]).toEqual(["Checked 2 posts; new metrics for 1 clips (scoring learns from them).", "✗ p2: Tebar 404"]);
  expect(await h.run("sync", "--json")).toBe(1);
});

describe("connect setup", () => {
  const settings = { jev: { active: false, apiKeySet: false }, llm: { active: false, baseUrl: "", model: "" }, tebar: { active: true, apiKeySet: true } };
  test("asks for each service, hides keys, saves, tests and lists Tebar accounts", async () => {
    const h = harness({
      "GET /api/settings": settings, "PUT /api/settings/jev": {}, "PUT /api/settings/tebar": {}, "PUT /api/settings/llm": {},
      "POST /api/settings/jev/test": { ok: true, model: "jev-1.14.0", detail: "answered 0.97" },
      "POST /api/settings/tebar/test": { ok: false, error: "Tebar 403 insufficient_scope" },
      "POST /api/settings/llm/test": { ok: true }, "GET /api/social/accounts": { enabled: true, accounts: ACCOUNTS },
    });
    h.state.tty = true;
    h.state.answers = ["", "ts_key", "", "", "qwen", "", "y", "tb_live_k"];
    expect(await h.run("connect", "setup")).toBe(0);
    expect(h.state.asked).toEqual(["Set it up? [Y/n] ", "[secret] API key: ", "Set it up? [Y/n] ", "Base URL [http://localhost:11434/v1]: ",
      "Model: ", "[secret] API key (Enter for none): ", "Connected. Change it? [y/N] ", "[secret] API key (Enter keeps the saved one): "]);
    expect(h.requests.filter((r) => r.method === "PUT").map((r) => [r.path, r.body])).toEqual([
      ["/api/settings/jev", { apiKey: "ts_key" }], ["/api/settings/llm", { baseUrl: "http://localhost:11434/v1", model: "qwen" }],
      ["/api/settings/tebar", { apiKey: "tb_live_k" }]]);
    expect(h.text()).toContain("✓ Jev: OK (jev-1.14.0) — answered 0.97");
    expect(h.text()).toContain("✗ Tebar: Tebar 403 insufficient_scope");
  });

  test("skips, keeps, and needs a terminal", async () => {
    const h = harness({ "GET /api/settings": { ...settings, tebar: { active: false }, jev: { active: true, apiKeySet: true } },
      "PUT /api/settings/tebar": {}, "POST /api/settings/tebar/test": { ok: true }, "GET /api/social/accounts": { enabled: true, accounts: [] } });
    h.state.tty = true;
    h.state.answers = ["n", "n", "", "tb"];
    expect(await h.run("connect", "setup")).toBe(0);
    expect(h.requests.filter((r) => r.method === "PUT")).toHaveLength(1);
    expect(h.text()).toContain("0 accounts yet: connect them at tebar.app");
    const script = harness({ "GET /api/settings": new Fail(500, "x") });
    expect(await script.run("connect", "setup")).toBe(2);
    expect(script.err.at(-1)).toContain("run it in a terminal");
  });
});

test("terminal questions: the answer, a hidden secret, or nothing at end of input", async () => {
  const run = async (input: string, secret: boolean) => {
    const i = new PassThrough();
    const o = new PassThrough();
    let shown = "";
    o.on("data", (c) => { shown += String(c); });
    const answer = ask(i, o, "Key: ", secret);
    i.end(input);
    return { answer: await answer, shown };
  };
  expect(await run("halo\n", false)).toMatchObject({ answer: "halo" });
  const hidden = await run("tb_live_secret\n", true);
  expect([hidden.answer, hidden.shown.includes("tb_live_secret")]).toEqual(["tb_live_secret", false]);
  expect((await run("", false)).answer).toBe("");
});
