import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { openDatabase } from "../../src/db";
import { IdeaBank, historyKey } from "../../src/generate/ideas";
import { earlierConcepts } from "../../src/generate/novelty";
import { STEPS, settingsOf } from "../../src/generate/steps";
import { Store } from "../../src/store";
import type { GenProject } from "../../src/types";
import { EFFECTS_DONE, makeEnv, procOk, quickRecipe, samplePlan, sceneHtml, scriptLlm, type TestEnv } from "../helpers";

const T = "2026-01-01T00:00:00.000Z";
const json = JSON.stringify;
let env: TestEnv | undefined;
afterEach(() => { env?.cleanup(); env = undefined; });

const bank = () => {
  const store = new Store(openDatabase(":memory:"));
  store.saveGenRecipe({ id: "quick", name: "Quick", version: 1, builtIn: 1, description: null, recipe: json(quickRecipe()), ideaCursor: null, createdAt: T, updatedAt: T });
  return { store, bank: new IdeaBank(store) };
};
let n = 0;
const add = (b: IdeaBank, slug: string, extra: object = {}) => b.add({ slug, brief: `Brief ${slug}`, ...extra });
const later = (store: Store, id: string) => store.updateGenIdea(id, { status: "new" });   // keeps the order of creation visible

describe("the idea bank", () => {
  test("ideas are added with a slug and a brief; the id is yours or a generated one; slugs and ids are unique", () => {
    const { bank: b } = bank();
    const a = b.add({ id: "IDEA-042", slug: "bunga-majemuk", brief: " Jelaskan bunga majemuk ", flags: { language: "en", market_data: false } });
    expect(a).toMatchObject({ id: "IDEA-042", slug: "bunga-majemuk", brief: "Jelaskan bunga majemuk", status: "new", projectId: null, flags: json({ language: "en", market_data: false }) });
    expect(add(b, "lain").id).toMatch(/^[0-9a-f-]{36}$/);
    expect(() => add(b, "bunga-majemuk")).toThrow("slug bunga-majemuk exists already");
    expect(() => b.add({ id: "IDEA-042", slug: "x", brief: "y" })).toThrow("exists already");
    expect(b.get("IDEA-042").slug).toBe("bunga-majemuk");
    expect(() => b.get("nope")).toThrow("Idea not found");
  });

  test.each([
    [{ slug: "Bad Slug", brief: "x" }, "slug:"],
    [{ slug: "ok", brief: " " }, "brief required"],
    [{ slug: "ok", brief: "x".repeat(2001) }, "at most 2000"],
    [{ id: "bad id!", slug: "ok", brief: "x" }, "id:"],
    [{ slug: "ok", brief: "x", status: "done" }, "status is one of"],
    [{ slug: "ok", brief: "x", flags: [] }, "flags must be an object"],
    [{ slug: "ok", brief: "x", flags: { language: "fr" } }, "flags.language"],
    [{ slug: "ok", brief: "x", flags: { targetSec: 1.5 } }, "flags.targetSec"],
    [{ slug: "ok", brief: "x", flags: { market_data: "no" } }, "flags.market_data"],
    [{ slug: "ok", brief: "x", flags: { narration: 1 } }, "flags.narration"],
  ])("a bad idea %j is refused", (input, message) => expect(() => bank().bank.add(input)).toThrow(message));

  test("the next idea is the first new one after the recipe's cursor; moving the cursor skips what came before; no wrap-around", () => {
    const { store, bank: b } = bank();
    const one = add(b, "satu");
    const two = add(b, "dua");
    const three = add(b, "tiga");
    for (const [i, idea] of [one, two, three].entries()) store.updateGenIdea(idea.id, { createdAt: `2026-01-0${i + 1}T00:00:00.000Z` });
    expect(b.next("quick")!.id).toBe(one.id);
    b.link(one.id, "p1");
    b.moveCursor("quick", one.id);
    expect(b.next("quick")!.id).toBe(two.id);
    b.moveCursor("quick", three.id);
    expect(b.next("quick")).toBeNull();
    b.moveCursor("quick", "deleted-idea");       // a cursor on an idea that is gone starts over from the first new one
    expect(b.next("quick")!.id).toBe(two.id);
    expect(b.next("unknown-recipe")!.id).toBe(one.id === two.id ? two.id : two.id);
    later(store, one.id);
  });

  test("statuses follow the video: a built version makes it built, a posted export makes it posted; they never go back", () => {
    const { store, bank: b } = bank();
    const idea = add(b, "satu");
    store.saveGenProject({
      id: "p1", title: null, brief: "x", format: "9:16", targetSec: 30, language: "id", styleNotes: null, preset: null, recipeId: "quick", recipe: "{}", ideaId: idea.id,
      briefFlags: null, narrationScript: null, concept: null, stepIndex: 0, stepState: null, narration: 0, storylines: null, pickedStoryline: null, status: "RUNNING",
      currentPlanId: null, acceptedVersionId: null, errorMessage: null, createdAt: T, updatedAt: T,
    } as GenProject);
    b.link(idea.id, "p1");
    expect(b.get(idea.id).status).toBe("used");
    store.saveGenPlan({ id: "pl1", projectId: "p1", revision: 1, plan: "{}", changeRequest: null, changeSummary: null, approvedAt: T, createdAt: T });
    store.saveGenVersion({
      id: "v1", projectId: "p1", planId: "pl1", number: 1, parentVersionId: null, status: "BUILT", step: null, progress: 100, projectDir: null, renderKind: "draft",
      draftPath: null, stepState: null, hyperframesVersion: null, buildMs: 1, errorMessage: null, createdAt: T, updatedAt: T,
    });
    expect(b.list("built").map((i) => i.id)).toEqual([idea.id]);
    store.saveGenExport({ id: "e1", projectId: "p1", versionId: "v1", path: "/x.mp4", format: "9:16", durationSec: 30, title: "t", description: "d", createdAt: T });
    store.saveSocialPost({
      id: "sp1", clipId: "e1", provider: "tebar", providerPostId: "pp", status: "PUBLISHED", scheduledAt: null, idempotencyKey: "k", request: null, targets: null,
      errorMessage: null, createdAt: T, updatedAt: T, lastSyncedAt: null, subjectKind: "generated",
    });
    expect(b.get(idea.id).status).toBe("posted");
    store.updateSocialPost("sp1", { status: "FAILED" });
    expect(b.get(idea.id).status).toBe("posted");           // it was posted; a later failure does not un-post it
    expect(() => b.list("finished")).toThrow("status is one of");
    expect(b.list().map((i) => i.id)).toEqual([idea.id]);
  });

  test("an idea can be edited and removed, with the facts it came with", () => {
    const { store, bank: b } = bank();
    const idea = b.add({ slug: "satu", brief: "Satu" }, [{ claim: "Bunga 5,75 persen", value: "5,75%", sourceUrl: "https://bi.go.id/a" }]);
    expect(b.factsOf(idea.id)).toMatchObject([{ claim: "Bunga 5,75 persen", addedBy: "idea", projectId: null, ideaId: idea.id }]);
    add(b, "dua");
    expect(b.update(idea.id, { brief: "Satu, diubah", flags: { language: "en" } })).toMatchObject({ brief: "Satu, diubah", slug: "satu", flags: json({ language: "en" }) });
    expect(b.update(idea.id, { slug: "satu-baru" }).slug).toBe("satu-baru");
    expect(() => b.update(idea.id, { slug: "dua" })).toThrow("exists already");
    expect(b.update(idea.id, { slug: "satu-baru" }).slug).toBe("satu-baru");
    b.remove(idea.id);
    expect(store.genFactsForIdea(idea.id)).toEqual([]);
    expect(() => b.get(idea.id)).toThrow("Idea not found");
    n++;
  });
});

describe("import-history", () => {
  const known = (id: string) => id === "quick" || id === "story";

  test("past concepts become novelty history for their recipe, past ideas join the bank as used, and anything already there is skipped", () => {
    const { store, bank: b } = bank();
    const file = {
      concepts: [{ recipeId: "quick", mechanism: "Benih jadi pohon", concept: "Pohon tumbuh", date: "2025-12-01T00:00:00.000Z" }, { mechanism: "Roda gigi", concept: "Uang berputar" }],
      ideas: [{ id: "IDEA-001", slug: "lama", brief: "Dulu", status: "posted" }, { slug: "tanpa-status", brief: "Juga dulu" }],
    };
    expect(b.importHistory(file, known)).toEqual({ concepts: 2, ideas: 2, skipped: 0 });
    expect(b.history("quick").map((c) => c.mechanism)).toEqual(["Benih jadi pohon", "Roda gigi"]);
    expect(b.get("IDEA-001").status).toBe("posted");
    expect(b.list().find((i) => i.slug === "tanpa-status")!.status).toBe("used");
    expect(b.next("quick")).toBeNull();                                  // imported ideas are not new
    expect(b.importHistory(file, known)).toEqual({ concepts: 0, ideas: 0, skipped: 4 });
    expect(JSON.parse(store.settings()[historyKey("quick")]!)).toHaveLength(2);
  });

  test("the novelty check of a new video compares with the imported concepts too", () => {
    const { store, bank: b } = bank();
    b.importHistory({ concepts: [{ mechanism: "Benih jadi pohon", concept: "Pohon tumbuh", date: "2025-12-01T00:00:00.000Z" }] }, known);
    const project = { id: "p1", recipeId: "quick" } as GenProject;
    expect(earlierConcepts(store, project, 30)).toEqual(["Benih jadi pohon\nPohon tumbuh"]);
    store.setSetting(historyKey("quick"), "{ broken");
    expect(earlierConcepts(store, project, 30)).toEqual([]);
  });

  test.each([
    [[], 'Send {"concepts"'],
    [{ concepts: "x" }, "concepts must be a list"],
    [{ ideas: "x" }, "ideas must be a list"],
    [{ concepts: [{ recipeId: "ghost", mechanism: "a", concept: "b" }] }, 'concepts[0]: there is no recipe "ghost"'],
    [{ concepts: [{ mechanism: "a" }] }, "concepts[0]: give both mechanism and concept"],
    [{ ideas: [{ slug: "Bad Slug", brief: "x" }] }, "ideas[0]:"],
  ])("a bad file %j is refused", (file, message) => expect(() => bank().bank.importHistory(file, known)).toThrow(message));
});

describe("the idea step", () => {
  const rig = (ideaId: string | null = null) => {
    const { store, bank: b } = bank();
    store.saveGenProject({
      id: "p1", title: null, brief: "placeholder", format: "9:16", targetSec: 30, language: "id", styleNotes: null, preset: null, recipeId: "quick", recipe: "{}", ideaId,
      briefFlags: null, narrationScript: null, concept: null, stepIndex: 0, stepState: null, narration: 0, storylines: null, pickedStoryline: null, status: "RUNNING",
      currentPlanId: null, acceptedVersionId: null, errorMessage: null, createdAt: T, updatedAt: T,
    } as GenProject);
    const ctx = (withSettings: Record<string, unknown> = {}) => ({ project: store.getGenProject("p1")!, store, settings: settingsOf("idea", withSettings) }) as never;
    return { store, bank: b, ctx };
  };

  test("a project made from an idea only confirms the link; a project without one takes the recipe's next idea and moves the cursor", async () => {
    const linked = rig("IDEA-1");
    add(linked.bank, "x", { id: "IDEA-1" });
    expect(await STEPS.idea.run(linked.ctx())).toEqual({ status: "done", outputRef: "IDEA-1" });

    const lone = rig("gone");
    await expect(STEPS.idea.run(lone.ctx())).rejects.toThrow("no longer in the bank");

    const r = rig();
    const first = add(r.bank, "satu");
    add(r.bank, "dua");
    expect(await STEPS.idea.run(r.ctx())).toEqual({ status: "done", outputRef: first.id });
    expect(r.store.getGenProject("p1")).toMatchObject({ brief: "Brief satu", ideaId: first.id });
    expect(r.store.getGenIdea(first.id)).toMatchObject({ status: "used", projectId: "p1" });
    expect(r.store.getGenRecipe("quick")!.ideaCursor).toBe(first.id);
  });

  test("`cursor: false` leaves the cursor alone; an empty bank is an error that says how to fill it", async () => {
    const r = rig();
    add(r.bank, "satu");
    await STEPS.idea.run(r.ctx({ cursor: false }));
    expect(r.store.getGenRecipe("quick")!.ideaCursor).toBeNull();
    await expect(STEPS.idea.run(rig().ctx())).rejects.toThrow("sorot gen idea add");
  });
});

// ---- over HTTP, and a whole unattended run -------------------------------------------------

const base = "/api/generate";
const story = (i: number) => ({ title: `Film ${i}`, pitch: "satu", opening: "benih", beats: ["hook", "isi", "akhir"], look: "flat", sound: "tenang", bold: false, recommended: i === 1, reason: "k" });
const STORIES = json({ storylines: [story(1), story(2), story(3)] });
const PICK = json({ decision: "pick", index: 0, reason: "paling jelas" });
const APPROVE = json({ decision: "approve", reason: "siap" });
const SCENES = [0, 1, 2].map((i) => json({ html: sceneHtml(i) }));
const JUDGE = json({ criteria: ["hook", "main_message"].map((id) => ({ id, answer: "yes", reason: "ok" })), risks: ["misleading_claim", "flat_film"].map((id) => ({ id, flagged: false, reason: "" })) });
const COPY = json({ title: "Bunga berbunga", description: "Uang tumbuh sendiri." });
const probe = json({ streams: [{ codec_type: "video", width: 1080, height: 1920, avg_frame_rate: "30/1", duration: "30.0" }], format: { duration: "30.0" } });

/** An app whose recipe lets the director make every decision, so a run never waits for anyone. */
async function unattended(replies: Parameters<typeof scriptLlm>[1]) {
  env = makeEnv({ llmBaseUrl: "http://llm/v1", llmModel: "m" });
  env.app.start();
  const llm = scriptLlm(env, replies);
  const fallback = env.execHandler.fn;
  env.hfHandlers.check = () => procOk(json({ ok: true, lint: { findings: [] }, runtime: { findings: [] }, layout: { findings: [] } }));
  env.execHandler.fn = (cmd, args, signal) => {
    if (cmd.includes("ffprobe")) return procOk(probe);
    if (cmd === "ffmpeg" && args.includes("volumedetect")) return { ...procOk(), stderr: "mean_volume: -20.0 dB\nmax_volume: -3.0 dB" };
    return fallback(cmd, args, signal);
  };
  const recipe = quickRecipe();
  const steps = recipe.steps.map((s) => (s.use === "storylines" ? { ...s, gate: "director" as const } : s.use === "plan" ? { ...s, gate: "director" as const } : s));
  const imported = await env.json("POST", `${base}/recipes/import`, { recipe: { ...recipe, id: "auto", name: "Auto", steps: [{ use: "idea" }, ...steps, ...[]].filter((s, i, all) => !(s.use === "export" && i < all.length - 1)) } });
  expect(imported.status).toBe(201);
  return llm;
}

describe("idea routes", () => {
  test("ideas are listed (filtered by status), added with facts, shown, edited and deleted", async () => {
    env = makeEnv();
    const made = await env.json("POST", `${base}/ideas`, {
      id: "IDEA-042", slug: "bunga", brief: "Jelaskan bunga majemuk", flags: { language: "id" }, facts: [{ claim: "Bunga 5,75 persen", value: "5,75%", sourceUrl: "https://bi.go.id/a" }],
    });
    expect(made.status).toBe(201);
    expect(made.body.data.idea).toMatchObject({ id: "IDEA-042", status: "new", flags: { language: "id" } });
    expect((await env.json("GET", `${base}/ideas`)).body.data.ideas).toHaveLength(1);
    expect((await env.json("GET", `${base}/ideas?status=used`)).body.data.ideas).toEqual([]);
    expect((await env.json("GET", `${base}/ideas?status=nope`)).status).toBe(400);
    const shown = (await env.json("GET", `${base}/ideas/IDEA-042`)).body.data;
    expect(shown.facts).toMatchObject([{ claim: "Bunga 5,75 persen", addedBy: "idea" }]);
    expect((await env.json("PATCH", `${base}/ideas/IDEA-042`, { brief: "Lebih baik" })).body.data.idea.brief).toBe("Lebih baik");
    expect((await env.json("POST", `${base}/ideas`, { slug: "bunga", brief: "x" })).status).toBe(409);
    expect((await env.json("POST", `${base}/ideas`, { slug: "baru", brief: "x", facts: [{ claim: "tanpa sumber" }] })).body.error).toContain("facts[0]");
    expect((await env.json("DELETE", `${base}/ideas/IDEA-042`)).body.data).toEqual({ deleted: true });
    expect((await env.json("GET", `${base}/ideas/IDEA-042`)).status).toBe(404);
  });

  test("import-history takes the documented shape and says what it did", async () => {
    env = makeEnv();
    env.app.start();
    const r = await env.json("POST", `${base}/import-history`, { concepts: [{ mechanism: "a", concept: "b" }], ideas: [{ slug: "lama", brief: "Dulu" }] });
    expect(r.body.data).toEqual({ concepts: 1, ideas: 1, skipped: 0 });
    expect((await env.json("POST", `${base}/import-history`, { concepts: "x" })).status).toBe(400);
  });

  test("a run with no new idea, or with an unknown recipe or idea, is refused", async () => {
    env = makeEnv({ llmBaseUrl: "http://llm/v1", llmModel: "m" });
    env.app.start();
    expect((await env.json("POST", `${base}/run`, { recipeId: "quick" })).body.error).toContain("no new idea for the recipe quick");
    expect((await env.json("POST", `${base}/run`, { recipeId: "ghost" })).status).toBe(404);
    expect((await env.json("POST", `${base}/run`, { ideaId: "ghost" })).status).toBe(404);
  });
});

describe("the files of a project", () => {
  test("the names of what has been written, so an outside agent knows what to read", async () => {
    env = makeEnv({ llmBaseUrl: "http://llm/v1", llmModel: "m" });
    env.app.start();
    scriptLlm(env, []);
    const created = await env.json("POST", `${base}/projects`, { brief: "Jelaskan bunga", targetSec: 30, facts: [{ claim: "Bunga 5,75 persen", sourceUrl: "https://bi.go.id/a" }] });
    const id = created.body.data.project.id as string;
    await env.app.generate.whenIdle();
    expect((await env.json("GET", `${base}/projects/${id}/files`)).body.data.files).toEqual(["BRIEF.md", "facts.md"]);
    expect((await env.json("GET", `${base}/projects/nope/files`)).status).toBe(404);
  });
});

describe("unattended runs", () => {
  test("a run takes the next idea and carries it to an exported video; the next run takes the next idea; resuming by name does not move the cursor", async () => {
    // idea 1: storylines pick, plan, gate approve, three scenes, judge, export copy
    const llm = await unattended([STORIES, PICK, json(samplePlan({ shots: samplePlan().shots.map((s: any, i: number) => ({ ...s, transition: ["cut", "fade", "flash"][i], ...(i === 0 ? { effects: { glowPx: 20, reason: "the hook shines" } } : {}) })) })), EFFECTS_DONE, APPROVE, ...SCENES, JUDGE, COPY]);
    await env!.json("POST", `${base}/ideas`, { id: "IDEA-1", slug: "satu", brief: "Jelaskan bunga majemuk", flags: { language: "id", targetSec: 30, market_data: false }, facts: [{ claim: "Bunga 5,75 persen", value: "5,75%", sourceUrl: "https://bi.go.id/a" }] });
    await env!.json("POST", `${base}/ideas`, { id: "IDEA-2", slug: "dua", brief: "Jelaskan inflasi" });
    const run = await env!.json("POST", `${base}/run`, { recipeId: "auto" });
    expect(run.status).toBe(201);
    const id = run.body.data.project.id as string;
    expect(run.body.data.project).toMatchObject({ ideaId: "IDEA-1", briefFlags: { buildWithoutStopping: true, forbiddenNumbers: true } });
    await env!.app.generate.whenIdle();

    const project = env!.app.store.getGenProject(id)!;
    expect([project.status, project.errorMessage]).toEqual(["EXPORTED", null]);
    expect(env!.app.generate.facts(id)).toMatchObject([{ claim: "Bunga 5,75 persen", addedBy: "idea" }]);
    const exports = env!.app.store.genExportsForProject(id);
    expect(exports).toHaveLength(1);
    expect(exports[0]).toMatchObject({ title: "Bunga berbunga", description: "Uang tumbuh sendiri." });
    expect(existsSync(exports[0]!.path)).toBeTrue();
    expect(env!.app.store.getGenProject(id)!.acceptedVersionId).toBeTruthy();
    expect(llm.requests).toHaveLength(10);
    expect(env!.app.generate.ideas.get("IDEA-1")).toMatchObject({ status: "built", projectId: id });
    expect(env!.app.store.getGenRecipe("auto")!.ideaCursor).toBe("IDEA-1");

    // naming the finished idea resumes it (nothing left to do) and leaves the cursor where it was
    const again = await env!.json("POST", `${base}/run`, { recipeId: "auto", ideaId: "IDEA-1" });
    expect(again.body.data.project.id).toBe(id);
    await env!.app.generate.whenIdle();
    expect(env!.app.store.getGenRecipe("auto")!.ideaCursor).toBe("IDEA-1");
    expect(env!.app.store.genExportsForProject(id)).toHaveLength(1);
    expect(env!.app.generate.ideas.next("auto")!.id).toBe("IDEA-2");
  });

  test("an owner gate stops the run where it is; naming the idea starts a new one without moving the cursor", async () => {
    await unattended([STORIES]);
    await env!.json("POST", `${base}/ideas`, { id: "IDEA-1", slug: "satu", brief: "Satu" });
    await env!.json("POST", `${base}/ideas`, { id: "IDEA-2", slug: "dua", brief: "Dua" });
    // the quick recipe asks the owner to pick a storyline: an unattended run cannot pass that gate
    const waiting = await env!.json("POST", `${base}/run`, { recipeId: "quick", ideaId: "IDEA-2" });
    await env!.app.generate.whenIdle();
    const id = waiting.body.data.project.id as string;
    expect(env!.app.store.getGenProject(id)).toMatchObject({ status: "WAITING", ideaId: "IDEA-2" });
    expect(env!.app.store.genVersionsForProject(id)).toEqual([]);
    expect(env!.app.store.getGenRecipe("quick")!.ideaCursor).toBeNull();
    expect(env!.app.generate.ideas.get("IDEA-2")).toMatchObject({ status: "used", projectId: id });
    expect(env!.app.generate.ideas.next("quick")!.id).toBe("IDEA-1");
  });

  test("a failed run is retried by naming its idea; a failed build is queued again", async () => {
    await unattended([json({ nope: true }), json({ nope: true })]);
    await env!.json("POST", `${base}/ideas`, { id: "IDEA-1", slug: "satu", brief: "Satu" });
    const run = await env!.json("POST", `${base}/run`, { recipeId: "auto" });
    await env!.app.generate.whenIdle();
    const id = run.body.data.project.id as string;
    expect(env!.app.store.getGenProject(id)!.status).toBe("FAILED");
    scriptLlm(env!, [STORIES, PICK, json(samplePlan({ shots: samplePlan().shots.map((s: any, i: number) => ({ ...s, transition: ["cut", "fade", "flash"][i], ...(i === 0 ? { effects: { glowPx: 20, reason: "the hook shines" } } : {}) })) })), EFFECTS_DONE, APPROVE, ...SCENES, JUDGE, COPY]);
    const retried = await env!.json("POST", `${base}/run`, { recipeId: "auto", ideaId: "IDEA-1" });
    expect(retried.body.data.project.id).toBe(id);
    await env!.app.generate.whenIdle();
    expect(env!.app.store.getGenProject(id)!.status).toBe("EXPORTED");

    // a build that failed or was cancelled is built again; a project that never got going starts its steps again
    const v = env!.app.store.genVersionsForProject(id)[0]!;
    env!.app.store.updateGenProject(id, { status: "FAILED", errorMessage: "x" });
    env!.app.store.updateGenVersion(v.id, { status: "FAILED" });
    env!.app.store.updateGenProject(id, { status: "WAITING" });
    scriptLlm(env!, [...SCENES, JUDGE]);
    await env!.json("POST", `${base}/run`, { ideaId: "IDEA-1" });
    await env!.app.generate.whenIdle();
    expect(env!.app.store.genVersionsForProject(id)).toHaveLength(2);
  });
});
