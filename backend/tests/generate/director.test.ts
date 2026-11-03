import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/db";
import { TOOL_DEFS } from "../../src/generate/directorTools";
import { Director, DirectorError, approvalChanges, changedShots, shotsNamed } from "../../src/generate/director";
import { DirectorLog } from "../../src/generate/events";
import { validatePlan, type Plan, type PlanContext } from "../../src/generate/planSchema";
import type { RecipeStep } from "../../src/generate/recipe";
import { LlmError } from "../../src/llm";
import { Store } from "../../src/store";
import type { GenProject } from "../../src/types";
import { Llm } from "../../src/llm";
import { AsText, Calls, fakeLlm, samplePlan } from "../helpers";

const T = "2026-01-01T00:00:00.000Z";
const project: GenProject = {
  id: "p1", title: null, brief: "Jelaskan bunga majemuk", format: "9:16", targetSec: 30, language: "id", styleNotes: "tenang", preset: null,
  recipeId: "quick", recipe: "{}", ideaId: null, briefFlags: null, narrationScript: null, concept: null, stepIndex: 0, stepState: null,
  narration: 0, storylines: null, pickedStoryline: null, status: "RUNNING", currentPlanId: null, acceptedVersionId: null,
  errorMessage: null, createdAt: T, updatedAt: T,
};
const story = (i: number, extra: Record<string, unknown> = {}) => ({
  title: `Film ${i}`, pitch: "satu kalimat", opening: "benih jatuh", beats: ["hook", "isi", "akhir"], look: "flat", sound: "tenang",
  bold: false, recommended: false, reason: "karena", ...extra,
});
const planCtx: PlanContext = { brief: project.brief, targetSec: 30, format: "9:16", language: "id", fonts: ["Plus Jakarta Sans"], imageConnected: false, narration: false };
const json = (v: unknown) => JSON.stringify(v);

function rig(replies: Parameters<typeof fakeLlm>[0], models: Parameters<typeof fakeLlm>[1] = {}) {
  const store = new Store(openDatabase(":memory:"));
  const { llm, requests } = fakeLlm(replies, models);
  const director = new Director(llm, new DirectorLog(store), "../generator");
  return { director, requests, store, events: () => store.genEventsForProject("p1").reverse() };
}
const step = (extra: Partial<RecipeStep> = {}): RecipeStep => ({ use: "storylines", ...extra });
const userOf = (req: { messages: Array<{ role: string; content: string }> }) => JSON.parse(req.messages.find((m) => m.role === "user")!.content);
const systemOf = (req: { messages: Array<{ role: string; content: string }> }) => req.messages[0]!.content;

describe("director: storylines", () => {
  const ask = (r: ReturnType<typeof rig>, settings: Record<string, unknown> = { count: 3 }, s = step()) =>
    r.director.storylines({ project, step: s, settings, assets: [], note: "lebih tenang" });

  test("sends the brief and the closing task, guidance and format in the system message, and marks exactly one recommended", async () => {
    const r = rig([json({ storylines: [story(1), story(2, { recommended: true }), story(3, { recommended: true })] })]);
    const list = await ask(r);
    expect(list.map((s) => s.recommended)).toEqual([false, true, false]);
    const req = r.requests[0]!;
    expect(userOf(req)).toMatchObject({ brief: "Jelaskan bunga majemuk", format: "9:16", targetSec: 30, count: 3, note: "lebih tenang" });
    expect(userOf(req).task).toContain("Write 3 different storylines");
    expect(systemOf(req)).toContain("different films");          // Sorot's instructions
    expect(systemOf(req)).toContain("Frame 0 is the thumbnail");  // generator/prompts/story.md
    expect(systemOf(req)).not.toContain("<!--");
    expect(systemOf(req)).toContain("calling the function submit_storylines");   // what to call
  });

  test("with none flagged the first is recommended; extra storylines beyond the count are dropped", async () => {
    const r = rig([json({ storylines: [story(1), story(2), story(3), story(4)] })]);
    const list = await ask(r, { count: 2 });
    expect(list).toHaveLength(2);
    expect(list[0]!.recommended).toBe(true);
  });

  test("requireBold: exactly one bold; a repair call fixes a missing one", async () => {
    const r = rig([json({ storylines: [story(1), story(2)] }), json({ storylines: [story(1), story(2, { bold: true })] })]);
    const list = await ask(r, { count: 2, requireBold: true });
    expect(list.map((s) => s.bold)).toEqual([false, true]);
    expect(r.requests).toHaveLength(2);
    const repair = JSON.parse(r.requests[1]!.messages.at(-1)!.content);
    expect(repair.problems[0]).toContain("exactly one storyline must have");
    expect(repair.task).toContain("Fix these problems");
  });

  test("after one repair it gives up with the problems", async () => {
    const r = rig(["not json at all", json({ storylines: [] })]);
    await expect(ask(r)).rejects.toThrow(DirectorError);
    const r2 = rig([json({ storylines: [{ title: "x" }] }), json({ storylines: [{ title: "x" }] })]);
    await expect(ask(r2)).rejects.toThrow("needs a title, pitch, opening and at least 2 beats");
    expect(r2.requests).toHaveLength(2);
  });

  test("a step prompt is appended after Sorot's instructions, or replaces them; the format stays", async () => {
    const append = rig([json({ storylines: [story(1)] })]);
    await ask(append, { count: 1 }, step({ prompt: { mode: "append", text: "Pick the one a stranger would remember." } }));
    expect(systemOf(append.requests[0]!)).toContain("different films");
    expect(systemOf(append.requests[0]!)).toContain("a stranger would remember");

    const replace = rig([json({ storylines: [story(1)] })]);
    await ask(replace, { count: 1 }, step({ prompt: { mode: "replace", text: "My own rules." } }));
    expect(systemOf(replace.requests[0]!)).toContain("My own rules.");
    expect(systemOf(replace.requests[0]!)).not.toContain("different films");
    expect(systemOf(replace.requests[0]!)).toContain("submit_storylines");
  });

  test("calls are logged with the model, request and response; an LLM failure keeps the project state and is logged", async () => {
    const r = rig([json({ storylines: [story(1)] }), new Error("quota")]);
    await ask(r, { count: 1 });
    await expect(ask(r, { count: 1 })).rejects.toBeInstanceOf(LlmError);
    const [ok, failed] = r.events();
    expect(ok).toMatchObject({ kind: "storylines", model: "m", ok: 1 });
    expect(ok!.request).toContain("Jelaskan bunga majemuk");
    expect(failed).toMatchObject({ kind: "storylines", ok: 0 });
    expect(failed!.response).toContain("quota");
  });
});

describe("director: plan", () => {
  const ask = (r: ReturnType<typeof rig>, ctx: PlanContext = planCtx) =>
    r.director.plan({ project, step: step({ use: "plan" }), settings: {}, assets: [], storyline: story(1) as never, planCtx: ctx, catalog: [{ name: "data-chart", tags: ["chart"] }] });

  test("returns a validated plan; the request carries the storyline, fonts, limits and the task", async () => {
    const r = rig([json(samplePlan())]);
    const { plan } = await ask(r);
    expect(plan.shots).toHaveLength(3);
    const u = userOf(r.requests[0]!);
    expect(u).toMatchObject({ storyline: { title: "Film 1" }, fonts: ["Plus Jakarta Sans"], maxShots: 20, connections: { image: false, narration: false } });
    expect(u.blocks).toEqual([{ name: "data-chart", tags: ["chart"] }]);
    expect(u.task).toContain("30-second 9:16");
    expect(systemOf(r.requests[0]!)).toContain("submit_plan");
    expect(systemOf(r.requests[0]!)).toContain("Beats and pace");          // the plan section of story.md
    expect(systemOf(r.requests[0]!)).toContain("between 168 and 1330 px");  // its look and layout rules
    expect(systemOf(r.requests[0]!)).toContain("at most a third of the seams are plain cuts");   // and the Effects section
    expect(systemOf(r.requests[0]!)).not.toContain("Offer N storylines");   // not the storylines section
  });

  test("a plan that breaks the limits gets one repair call carrying the errors", async () => {
    const bad = samplePlan({ shots: samplePlan().shots.slice(0, 2) });
    const r = rig([json(bad), json(samplePlan())]);
    const { plan } = await ask(r);
    expect(plan.totalSec).toBe(30);
    expect(JSON.parse(r.requests[1]!.messages.at(-1)!.content).problems[0]).toContain("add up to 20 s");
  });

  test("no blocks are offered when the recipe forbids them; two bad plans in a row fail", async () => {
    const r = rig([json(samplePlan()), "{}", "{}"]);
    await ask(r, { ...planCtx, blocksAllowed: false });
    expect(userOf(r.requests[0]!).blocks).toEqual([]);
    await expect(ask(r)).rejects.toThrow("didn't pass the checks");
  });
});

describe("director: a numeric plan in parts", () => {
  const ctx: PlanContext = { ...planCtx, numeric: true, motionPlan: true, fps: 30 };
  const outline = {
    ...samplePlan(), look: { palette: ["#0B1020", "#FFD23F"], fonts: ["Plus Jakarta Sans"], pacing: "brisk" },
    numeric: { typography: { title: { font: "Plus Jakarta Sans", weight: 700, px: 96, tracking: -0.02 } }, shadow: "none", easing: { enter: "power3.out" }, durationsFrames: { hold: 60 }, staggerFrames: {} },
    shots: Array.from({ length: 6 }, (_, i) => ({ id: `s0${i + 1}`, purpose: "beat", durationSec: 5, text: [{ role: "title", value: `Judul ${i + 1}` }], visual: { description: `visual ${i + 1}` }, motion: "", transition: "cut" })),
  };
  // detail of some shots; motion frames may count from the start of the shot
  const specs = (ids: number[], token = (_i: number) => "enter") => json({ shots: ids.map((i) => ({ id: `s0${i}`, heroMove: `gerak ${i}`, reads: `baca ${i}`, handoff: `lanjut ${i}`, motionPlan: [{ token: token(i), fromFrame: 0, toFrame: 18 }] })) });

  test("the film and its shot list first, frames counted in code; then the detail four shots at a time, each batch repaired on its own", async () => {
    const r = rig([json(outline), specs([1, 2, 3, 4], (i) => (i === 2 ? "wobble" : "enter")), specs([1, 2, 3, 4]), specs([5, 6])]);
    const { plan } = await r.director.plan({ project, step: step({ use: "plan" }), settings: {}, assets: [], storyline: null, planCtx: ctx, catalog: [] });
    expect(r.requests.map((q) => q.tool_choice.function.name)).toEqual(["submit_plan_outline", "submit_shot_specs", "submit_shot_specs", "submit_shot_specs"]);
    expect(userOf(r.requests[1]!).shots.map((s: any) => [s.id, s.frames])).toEqual([["s01", [0, 150]], ["s02", [150, 300]], ["s03", [300, 450]], ["s04", [450, 600]]]);
    const problems = JSON.parse(r.requests[2]!.messages.at(-1)!.content).problems as string[];
    expect(problems[0]).toContain('shot 2 (s02): motionPlan[0] uses "wobble"');
    expect(problems.every((m) => m.includes('(s02)'))).toBe(true);   // only the bad shot's own problems
    expect(plan.shots.map((s) => [s.heroMove, s.motionPlan![0]!.fromFrame])).toEqual([1, 2, 3, 4, 5, 6].map((i) => [`gerak ${i}`, (i - 1) * 150]));
    expect(plan.numeric!.totalFrames).toBe(900);
  });

  test("a batch that stays wrong fails the plan", async () => {
    const r = rig([json(outline), specs([1, 2, 3]), specs([1, 2, 3])]);
    await expect(r.director.plan({ project, step: step({ use: "plan" }), settings: {}, assets: [], storyline: null, planCtx: ctx, catalog: [] })).rejects.toThrow("give the detail of s04");
  });
});
describe("director: effects", () => {
  const catalog = [{ name: "data-chart", tags: ["chart"], type: "block", description: "an animated bar chart" }, { name: "glow-orb", tags: ["light", "glow"], type: "component", description: "a soft glowing orb" }];
  const plan = () => validatePlan(samplePlan(), planCtx).plan as Plan;
  const run = (r: ReturnType<typeof rig>, ctx: PlanContext = { ...planCtx, blocks: catalog.map((b) => b.name) }, maxSteps = 6) =>
    r.director.effects({ project, step: step({ use: "plan" }), plan: plan(), planCtx: ctx, catalog, maxSteps, tokenBudget: 50_000 });

  test("the director chooses effects with tools; each choice is checked and kept with its reason; a bad one goes back as an error", async () => {
    const r = rig([
      new Calls([["search_catalog", { query: "light", kind: "any" }], ["set_transition", { shotId: "s01", name: "flash", reason: "x" }]]),
      new Calls([
        ["set_transition", { shotId: "s02", name: "flash", reason: "the number lands" }], ["add_block", { shotId: "s03", name: "data-chart", reason: "the growth" }],
        ["set_look", { shotId: "s01", glowPx: 24, reason: "the coin shines" }], ["set_look", { shotId: "s02", blurPx: 99, reason: "x" }],
        ["add_block", { shotId: "s02", name: "nope", reason: "y" }], ["set_transition", { shotId: "s03", name: "light-leak" }],
      ]),
      new AsText("A flash where the number lands, a chart and a glow."),
    ]);
    const out = await run(r);
    expect(out.plan.shots.map((s) => [s.transition, s.visual.block, s.effects ?? null])).toEqual([
      ["cut", null, { glowPx: 24, reason: "the coin shines" }], ["flash", null, null], ["cut", "data-chart", null],
    ]);
    expect(out.plan.blocks).toEqual(["data-chart"]);
    expect(out.plan.effectNotes).toEqual(["s02 enters with flash: the number lands", "s03 uses the block data-chart: the growth", "s01 look (glowPx): the coin shines"]);
    expect(out.notes.at(-1)).toBe("A flash where the number lands, a chart and a glow.");
    const results = r.requests[1]!.messages.filter((m: any) => m.role === "tool").map((m: any) => JSON.parse(m.content));
    expect(results[0].map((x: any) => x.name)).toEqual(["light-leak", "glow-orb"]);   // the search finds a transition and a component
    expect(results[1].error).toContain("the first shot has nothing before it");
    const errors = r.requests[2]!.messages.filter((m: any) => m.role === "tool").slice(-6).map((m: any) => JSON.parse(m.content).error).filter(Boolean);
    expect(errors).toEqual(["s02 effects.blurPx is a number from 0 to 40", "nope isn't in the catalog: use a name search_catalog returned", "give the reason: what on screen causes this effect"]);
    expect(r.events().map((e) => e.kind)).toEqual(["effects"]);
  });

  test("the pass has the last word on a shot it changed: the plan's own notes about that shot go, others stay", async () => {
    const own = { ...plan(), effectNotes: ["s01 -> s02 wipe: the plan's own choice", "warm light all through the film"] };
    const r = rig([new Calls([["set_transition", { shotId: "s02", name: "zoom", reason: "going deeper" }]]), new AsText("A zoom.")]);
    const out = await r.director.effects({ project, step: step({ use: "plan" }), plan: own, planCtx, catalog, maxSteps: 2, tokenBudget: 50_000 });
    expect(out.plan.effectNotes).toEqual(["warm light all through the film", "s02 enters with zoom: going deeper"]);
  });
  test("a seam that paints a colour must show on the ground: no white flash or pale wipe on a pale film", async () => {
    const pale = validatePlan({ ...samplePlan(), look: { palette: ["#F4F6F8", "#E3E8EC"], fonts: ["Plus Jakarta Sans"], pacing: "calm" } }, planCtx).plan as Plan;
    const r = rig([
      new Calls([["set_transition", { shotId: "s02", name: "flash", reason: "x" }], ["set_transition", { shotId: "s02", name: "wipe", reason: "x" }], ["set_transition", { shotId: "s02", name: "zoom", reason: "deeper" }]]),
      new AsText("A zoom."),
    ]);
    const out = await r.director.effects({ project, step: step({ use: "plan" }), plan: pale, planCtx, catalog, maxSteps: 3, tokenBudget: 50_000 });
    const errors = r.requests[1]!.messages.filter((m: any) => m.role === "tool").map((m: any) => JSON.parse(m.content).error);
    expect(errors).toEqual([
      "a flash won't show on this film's ground #F4F6F8 (contrast 1.08:1); pick a transition that moves or veils the shots instead",
      "a wipe won't show on this film's ground #F4F6F8 (contrast 1.14:1); pick a transition that moves or veils the shots instead",
      undefined,
    ]);
    expect(out.plan.shots[1]!.transition).toBe("zoom");
  });
  test("it is bounded by steps; without blocks there is no block tool and the search finds only transitions", async () => {
    const r = rig([new Calls([["search_catalog", { query: "chart wipe" }]]), new AsText("Only a wipe.")]);
    const out = await run(r, { ...planCtx, blocksAllowed: false }, 1);
    expect(r.requests[0]!.tools.map((t: any) => t.function.name)).toEqual(["search_catalog", "set_transition", "set_look"]);
    expect(r.requests[1]!.tools).toBeUndefined();   // the final prompt has no tools
    expect(JSON.parse(r.requests[1]!.messages.find((m: any) => m.role === "tool")!.content).map((x: any) => x.name)).toEqual(["wipe"]);
    expect(out.plan.effectNotes).toBeUndefined();
  });
});

describe("director: revise", () => {  const current = validatePlan(samplePlan(), planCtx).plan as Plan;
  const ask = (r: ReturnType<typeof rig>, request: string) => r.director.revise({ project, step: step({ use: "plan" }), current, request, planCtx });
  const edited = (id: string, title: string) => ({
    ...samplePlan(), shots: samplePlan().shots.map((s: any) => (s.id === id ? { ...s, text: [{ role: "title", value: title }] } : s)),
  });

  test("a change to the named shot goes through with the summary", async () => {
    const r = rig([json({ plan: edited("s02", "Judul baru"), changeSummary: "Judul shot 2 diganti" })]);
    const out = await ask(r, "ubah judul shot 2");
    expect(out.plan.shots[1]!.text[0]!.value).toBe("Judul baru");
    expect(out.changeSummary).toBe("Judul shot 2 diganti");
    expect(userOf(r.requests[0]!)).toMatchObject({ request: "ubah judul shot 2", shotsNamed: ["s02"] });
    expect(userOf(r.requests[0]!).task).toContain("Change only s02");
  });

  test("a change outside the named shots is rejected once and asked again", async () => {
    const r = rig([json({ plan: edited("s01", "Salah"), changeSummary: "x" }), json({ plan: edited("s02", "Benar"), changeSummary: "ok" })]);
    const out = await ask(r, "ubah judul s02");
    expect(out.plan.shots.map((s) => s.text[0]!.value)).toEqual(["Bunga berbunga?", "Benar", "Mulai dari sekarang"]);
    expect(JSON.parse(r.requests[1]!.messages.at(-1)!.content).problems[0]).toContain("you changed s01");
    const stubborn = rig([json({ plan: edited("s01", "Salah") }), json({ plan: edited("s01", "Salah lagi") })]);
    await expect(ask(stubborn, "ubah judul s02")).rejects.toThrow("you changed s01");
  });

  test("a request that names no shot may change any; an invalid plan is repaired", async () => {
    const r = rig([json({ plan: { ...samplePlan(), title: "" } }), json({ plan: edited("s03", "Penutup baru") })]);
    const out = await ask(r, "buat lebih tenang");
    expect(out.plan.shots[2]!.text[0]!.value).toBe("Penutup baru");
    expect(out.changeSummary).toBe("");
  });

  test("shot names are found by id or number; shots that differ are listed", () => {
    expect([...shotsNamed("ubah s01 dan Shot 3, juga scene ke-2, adegan 9", current)].sort()).toEqual(["s01", "s02", "s03"]);
    expect(shotsNamed("buat lebih tenang", current).size).toBe(0);
    const after = validatePlan(edited("s02", "x"), planCtx).plan as Plan;
    expect(changedShots(current, after)).toEqual(["s02"]);
    expect(changedShots(current, { ...after, shots: after.shots.slice(1) }).sort()).toEqual(["s01", "s02"]);
  });
});

describe("director: gate", () => {
  const ask = (r: ReturnType<typeof rig>, kind: "storylines" | "plan") =>
    r.director.gate({ project, step: step({ gate: "director" }), kind, output: kind === "plan" ? samplePlan() : [story(1), story(2)], rule: "the one a stranger would follow" });

  test("storylines: a pick with an index and a reason", async () => {
    const r = rig([json({ decision: "pick", index: 1, reason: "paling jelas" })]);
    expect(await ask(r, "storylines")).toEqual({ decision: "pick", index: 1, reason: "paling jelas" });
    expect(userOf(r.requests[0]!)).toMatchObject({ kind: "storylines", rule: "the one a stranger would follow" });
    expect(userOf(r.requests[0]!).task).toContain("0 to 1");
  });

  test.each([
    ["an index out of range", { decision: "pick", index: 5, reason: "x" }],
    ["no index", { decision: "pick", reason: "x" }],
    ["a different decision", { decision: "approve", reason: "x" }],
  ])("storylines: %s is repaired once, then refused", async (_name, bad) => {
    const r = rig([json(bad), json(bad)]);
    await expect(ask(r, "storylines")).rejects.toThrow("decision must be");
  });

  test("plan: approve or reject; a reason is required", async () => {
    expect(await ask(rig([json({ decision: "approve", reason: "siap" })]), "plan")).toEqual({ decision: "approve", reason: "siap" });
    expect((await ask(rig([json({ decision: "reject", reason: "terlalu panjang" })]), "plan")).decision).toBe("reject");
    const r = rig([json({ decision: "approve" }), json({ decision: "maybe", reason: "x" })]);
    await expect(ask(r, "plan")).rejects.toThrow('decision must be "approve" or "reject"');
    expect(JSON.parse(r.requests[1]!.messages.at(-1)!.content).problems[0]).toContain("reason");
  });
});

describe("director: tool calling", () => {
  const kinds = [
    ["storylines", "submit_storylines", ["storylines"], () => json({ storylines: [story(1)] }),
      (r: ReturnType<typeof rig>) => r.director.storylines({ project, step: step(), settings: { count: 1 }, assets: [] })],
    ["plan", "submit_plan", ["title", "message", "look", "shots"], () => json(samplePlan()),
      (r: ReturnType<typeof rig>) => r.director.plan({ project, step: step({ use: "plan" }), settings: {}, assets: [], storyline: null, planCtx, catalog: [] })],
    ["revise", "submit_revision", ["plan", "changeSummary"], () => json({ plan: samplePlan(), changeSummary: "ok" }),
      (r: ReturnType<typeof rig>) => r.director.revise({ project, step: step({ use: "plan" }), current: validatePlan(samplePlan(), planCtx).plan as Plan, request: "buat tenang", planCtx })],
    ["gate", "submit_decision", ["decision", "reason"], () => json({ decision: "pick", index: 0, reason: "jelas" }),
      (r: ReturnType<typeof rig>) => r.director.gate({ project, step: step(), kind: "storylines", output: [story(1)] })],
  ] as const;

  test.each(kinds)("%s forces one function (%s) and sends its schema", async (_kind, fn, required, reply, call) => {
    const r = rig([reply()]);
    await call(r);
    const req = r.requests[0]!;
    expect(req.tools).toHaveLength(1);
    expect(req.tools[0]).toMatchObject({ type: "function", function: { name: fn, parameters: { type: "object", required: [...required] } } });
    expect(req.tool_choice).toEqual({ type: "function", function: { name: fn } });
    expect(r.events()[0]!.response).toBe(reply());   // the log keeps the arguments the model gave
    if (fn === "submit_plan") expect(Object.keys(req.tools[0].function.parameters.properties.shots.items.properties.look.properties)).toEqual(["description", "values", "parts"]);   // FR-041
  });

  test("a model that writes the JSON as text instead of calling the function is still understood", async () => {
    const r = rig([new AsText("Here you go: " + json({ decision: "approve", reason: "siap" }))]);
    expect(await r.director.gate({ project, step: step(), kind: "plan", output: samplePlan() })).toEqual({ decision: "approve", reason: "siap" });
  });

  test("no call and no JSON: the model is told it didn't call the function, then the director gives up", async () => {
    const r = rig([new AsText("I think it is fine."), new AsText("Still fine.")]);
    await expect(r.director.gate({ project, step: step(), kind: "plan", output: samplePlan() })).rejects.toThrow("you didn't call submit_decision");
    const history = r.requests[1]!.messages;
    expect(history.at(-2)).toMatchObject({ role: "assistant", content: "I think it is fine." });
    expect(JSON.parse(history.at(-1)!.content).problems[0]).toContain("you didn't call submit_decision");
  });

  test("a call that fails the checks goes back as the function's result, then the model calls it again", async () => {
    const r = rig([json({ decision: "maybe", reason: "x" }), json({ decision: "reject", reason: "terlalu ramai" })]);
    expect(await r.director.gate({ project, step: step(), kind: "plan", output: samplePlan() })).toEqual({ decision: "reject", reason: "terlalu ramai" });
    const history = r.requests[1]!.messages;
    expect(history.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "user"]);
    expect((history[2] as any).tool_calls[0].function.name).toBe("submit_decision");
    expect(history[3]).toMatchObject({ role: "tool", name: "submit_decision" });
    expect((history[3] as any).tool_call_id).toBe("call_1");
    expect(JSON.parse(history[3]!.content)).toMatchObject({ accepted: false, problems: [expect.stringContaining("decision must be")] });
  });

  test("unreadable arguments are reported as such", async () => {
    const r = rig(["{ not json", json({ decision: "approve", reason: "ok" })]);
    await r.director.gate({ project, step: step(), kind: "plan", output: samplePlan() });
    expect(JSON.parse(r.requests[1]!.messages.at(-1)!.content).problems[0]).toBe("the function arguments were not valid JSON: expected a quoted string at character 2, near «{ not json»; send the whole answer again with that fixed");
  });

  test("the answer budget is at least the job's floor, and a larger Generate budget wins (a reasoning model thinks first)", async () => {
    const small = rig([json({ decision: "approve", reason: "ok" })]);
    await small.director.gate({ project, step: step(), kind: "plan", output: samplePlan() });
    expect(small.requests[0]!.max_tokens).toBe(4000);   // the default budget is already above the gate's floor
    const planReq = rig([json(samplePlan())]);
    await planReq.director.plan({ project, step: step({ use: "plan" }), settings: {}, assets: [], storyline: null, planCtx, catalog: [] });
    expect(planReq.requests[0]!.max_tokens).toBe(12000);

    const seen: any[] = [];
    const fetchFn = (async (_u: string, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body)));
      return Response.json({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "submit_decision", arguments: json({ decision: "approve", reason: "ok" }) } }] } }] });
    }) as unknown as typeof fetch;
    const big = new Llm({ llmBaseUrl: "http://llm/v1", llmModel: "m", llmApiKey: "", llmTimeoutSec: 5, llmMaxTokens: 1000, genLlmMaxTokens: 40000 }, fetchFn, 0);   // the clipping budget is not used
    const store = new Store(openDatabase(":memory:"));
    await new Director(big, new DirectorLog(store), "../generator").gate({ project, step: step(), kind: "plan", output: samplePlan() });
    expect(seen[0].max_tokens).toBe(40000);
  });
});

describe("director: scenes", () => {
  const plan = validatePlan(samplePlan(), planCtx).plan as Plan;
  const HTML = '<!doctype html><html><body><div data-composition-id="shot-02" data-width="1080" data-height="1920"><h1>Uang tumbuh sendiri</h1></div></body></html>';
  const input = <T extends object>(extra: T = {} as T) => ({
    project, step: step({ use: "author" }), plan, index: 1, width: 1080, height: 1920, assets: ["assets/ab-logo.png"], ...extra,
  });

  test("scene: one call for one shot with the film around it, the authoring contract and the one function to call", async () => {
    const r = rig([json({ html: HTML }), json({ html: HTML })]);
    expect(await r.director.scene({ ...input(), blocks: { "data-chart": "<div>chart</div>" } })).toBe(HTML);
    const req = r.requests[0]!;
    expect(req.tool_choice).toEqual({ type: "function", function: { name: "submit_scene" } });
    expect(req.tools[0].function.parameters.required).toEqual(["html"]);
    expect(userOf(req)).toMatchObject({
      compositionId: "shot-02", file: "compositions/shot-02.html", size: { width: 1080, height: 1920 },
      shot: { id: "s02" }, film: { title: "Bunga berbunga", shots: 3 }, position: 2, assets: ["assets/ab-logo.png"], fonts: ["Plus Jakarta Sans"],
      blocks: { "data-chart": "<div>chart</div>" },
      // the seams on either side and the neighbours, so the hero can carry across
      effects: null, enters: "cut", leaves: "cut",
      before: { id: "s01", purpose: "hook", lastText: "Bunga berbunga?", handoff: null }, after: { id: "s03", purpose: "payoff", firstText: "Mulai dari sekarang", opens: "visual 3" },
    });
    expect(userOf(req).task).toContain("Write compositions/shot-02.html for shot 2 of 3");
    expect(systemOf(req)).toContain("Sorot draws the transitions between shots");   // the Effects section of the contract
    expect(systemOf(req)).toContain("never `from`");   // HyperFrames' own contract: fromTo only, transforms not width/height
    expect(systemOf(req)).toContain("## Motion craft");
    expect(systemOf(req)).toContain("Writing one scene");          // the authoring contract
    expect(systemOf(req)).toContain('# A worked example');          // one finished shot to learn the craft from
    expect(systemOf(req)).toContain('data-composition-id="shot-02"');
    expect(systemOf(req)).toContain("submit_scene");
    expect(systemOf(req)).not.toContain("Offer N storylines");
    expect(req.max_tokens).toBe(16000);
    // what every shot shares leads the request, so a provider's prefix cache covers it (34% hits before)
    await r.director.scene({ ...input(), index: 2, blocks: { "data-chart": "<div>chart</div>" } });
    const [a, b] = r.requests.map((q) => q.messages[1].content as string);
    expect(a!.slice(0, a!.indexOf('"position"'))).toBe(b!.slice(0, b!.indexOf('"position"')));
  });

  test("a build session: the film is said once, every turn sees the shots before it, turns wait their place, and each request extends the last", async () => {
    const r = rig([json({ html: HTML }), json({ html: HTML }), json({ html: HTML, holds: [] })], { genSession: true });
    const session = { ...input(), session: "v1" };
    await Promise.all([r.director.scene({ ...session, index: 0 }), r.director.scene(session), r.director.repair({ ...session, html: HTML, findings: [{ code: "x", message: "fix it" }] })]);
    const [a, b, c] = r.requests.map((q) => q.messages);
    expect(systemOf(r.requests[0]!)).toContain("Requests come one at a time");
    expect(JSON.parse(a![1]!.content).film.shots).toHaveLength(plan.shots.length);   // the whole plan, once
    expect(r.requests[0]!.tools.map((t: any) => t.function.name)).toEqual(["submit_scene", "submit_repair", "submit_shot_kit"]);
    expect(b!.slice(0, a!.length)).toEqual(a);                                     // the next turn extends the last
    expect(c!.slice(0, b!.length)).toEqual(b);
    expect([a, b, c].map((m) => JSON.parse(m!.at(-1)!.content)).map((t) => [t.request, t.compositionId])).toEqual([["scene", "shot-01"], ["scene", "shot-02"], ["repair", "shot-02"]]);
    // past its budget the session starts again from the opening and the latest shots
    const small = rig([json({ html: HTML }), json({ html: HTML })], { genSession: true, genContextTokens: 1 });
    await small.director.scene({ ...session, index: 0 });
    await small.director.scene(session);
    const again = small.requests[1]!.messages;
    expect(again).toHaveLength(4);
    expect(JSON.parse(again[2]!.content).shotsSoFar).toEqual([{ shot: 1, file: "compositions/shot-01.html", latest: HTML }]);
  });

  test("a turn's tool loop: tool results go back in order, limits and errors answer the model, the last step is forced to submit, and every tool call is logged", async () => {
    const ran: string[] = [];
    const t = (name: string, limit: number, run: (a: any) => Promise<any>) => ({ def: TOOL_DEFS[name as keyof typeof TOOL_DEFS], limit, run: async (a: any) => { ran.push(name); return run(a); } });
    const tools = {
      steps: 3, tools: {
        search_blocks: t("search_blocks", 1, async () => ({ result: { matches: [{ name: "lottie-character-walk" }] } })),
        check: t("check", 3, async () => { throw new Error("lint crashed"); }),
      },
    };
    const r = rig([
      new Calls([["search_blocks", { query: "walk" }]]),
      new Calls([["search_blocks", { query: "again" }], ["check", { html: "x" }], ["nope", {}]]),
      new Calls([["check", { html: "x" }]]),
      json({ html: HTML }),
    ], { genSession: true });
    expect(await r.director.scene({ ...input(), session: "v1", tools })).toBe(HTML);
    expect(r.requests).toHaveLength(4);
    expect(r.requests[0]!.tools.map((x: any) => x.function.name)).toEqual(["search_blocks", "check", "submit_scene", "submit_repair", "submit_shot_kit"]);
    expect(r.requests.map((q) => q.tool_choice?.function?.name ?? "auto")).toEqual(["auto", "auto", "auto", "submit_scene"]);   // 3 tool steps, then forced
    const toolMsgs = r.requests[3]!.messages.filter((m: any) => m.role === "tool").map((m: any) => [m.name, JSON.parse(m.content)]);
    expect(toolMsgs).toEqual([
      ["search_blocks", { matches: [{ name: "lottie-character-walk" }] }],
      ["search_blocks", { error: "limit reached: submit now" }],
      ["check", { error: "lint crashed" }],
      ["nope", { error: expect.stringContaining("no tool named nope: use search_blocks, check, submit_scene") }],
      ["check", { error: "lint crashed" }],
    ]);
    expect(ran).toEqual(["search_blocks", "check", "check"]);
    expect(r.events().map((e) => e.kind)).toEqual(["scene", "search_blocks", "scene", "check", "scene", "check", "scene"]);
    expect(r.events().filter((e) => e.kind === "check").map((e) => e.ok)).toEqual([0, 0]);
  });

  test("a look's frames come back as a picture message right after its results, and the log row counts them", async () => {
    const tools = { steps: 2, tools: { look: { def: TOOL_DEFS.look, limit: 2, run: async () => ({ result: { seen: { description: "a dome" } }, images: ["data:image/png;base64,AAA", "data:image/png;base64,BBB"] }) } } };
    const r = rig([new Calls([["look", { html: "x", times: [1] }]]), json({ html: HTML })], { genSession: true });
    await r.director.scene({ ...input(), session: "v-look", tools });
    const after = r.requests[1]!.messages.slice(-2);
    expect(after[0]).toMatchObject({ role: "tool", name: "look" });
    expect((after[1].content as unknown as Array<{ type: string }>).filter((p) => p.type === "image_url")).toHaveLength(2);
    expect(r.events().find((e) => e.kind === "look")!.response).toContain("+2 image(s)");
  });

  test("compaction: an accepted turn leaves a note and its answer, a failed turn leaves nothing, and a turn past its budget cuts its older tool results; earlier requests stay an exact prefix", async () => {
    const look = (n: number) => ({ def: TOOL_DEFS.look, limit: 5, run: async () => ({ result: { n }, images: ["data:image/png;base64,AAA"] }) });
    const tools = { steps: 4, tools: { check: { def: TOOL_DEFS.check, limit: 3, run: async () => ({ result: { findings: [] } }) }, look: look(1) } };
    const r = rig([
      new Calls([["check", { html: "x" }]]), json({ html: HTML }),                       // turn 1: one tool, accepted
      json({ html: "no" }), json({ html: "still no" }),                                  // turn 2: never valid
      new Calls([["look", { html: "x", times: [1] }]]), new Calls([["look", { html: "y", times: [2] }]]), json({ html: HTML }),   // turn 3: two looks
      json({ html: HTML }),                                                              // turn 4
    ], { genSession: true, genTurnTokens: 1000 });
    const s = { ...input(), session: "v-compact", tools };
    await r.director.scene({ ...s, index: 0 });
    await expect(r.director.scene({ ...s, index: 1 })).rejects.toThrow("didn't pass the checks");
    await r.director.scene({ ...s, index: 2 });
    await r.director.scene({ ...s, index: 0 });
    const roles = (q: any) => q.messages.map((m: any) => m.role + (m.name ? `:${m.name}` : ""));
    // turn 2 starts where turn 1's compacted answer ended: request, note, the accepted call and its result
    expect(roles(r.requests[2]!)).toEqual(["system", "user", "user", "user", "assistant", "tool:submit_scene", "user"]);
    expect(r.requests[2]!.messages[3].content).toBe("tools used: check ×1");
    // turn 3 starts right after turn 1: the failed turn 2 left nothing
    const turn3 = r.requests[4]!.messages;
    expect(turn3.slice(0, 6)).toEqual(r.requests[2]!.messages.slice(0, 6));
    // the second look of turn 3 comes after the first's frames were cut (a budget of 1000 is exceeded by one picture)
    const lastOfTurn3 = r.requests[6]!.messages.slice(6);
    expect(lastOfTurn3.map((m: any) => (typeof m.content === "string" ? m.content : "pictures")).filter((c: string) => c.includes("removed"))).toEqual([
      JSON.stringify({ stub: "look #1 removed: see #2" }), "Frames from look #1 removed: see look #2.",
    ]);
    // turn 4: turn 3 is a note too, so the earlier requests are still its prefix
    expect(r.requests[7]!.messages.slice(0, 6)).toEqual(turn3.slice(0, 6));
    expect(r.requests[7]!.messages.some((m: any) => m.role === "tool" && m.name === "look")).toBeFalse();
  });

  test("each Generate role asks its own model when one is set, else the LLM model", async () => {
    const r = rig([json({ html: HTML }), json({ html: HTML })], { genSceneModel: "cheap", genJudgeModel: "strict" });
    await r.director.scene(input());
    expect([r.requests[0]!.model, r.director.model, r.director.judgeModel, r.events()[0]!.model]).toEqual(["cheap", "cheap", "strict", "cheap"]);
    expect(rig([]).director.model).toBe("m");
  });

  test("with a capability description, a scene call gets its level and the full settings of every part it may use; storylines get the summary, plans every part's settings", async () => {
    const r = rig([json({ html: HTML }), json({ html: HTML }), json({ storylines: [story(1, { recommended: true })] }), json(samplePlan())]);
    const asked: Array<{ level?: string; parts?: string[] }> = [];
    r.director.capabilities = (q) => { asked.push(q); return { level: q.level ?? "compose", kit: [{ name: "shade" }, { name: "camera" }], parts: q.parts } as never; };
    const looked = { ...plan, shots: plan.shots.map((s, i) => (i === 1 ? { ...s, look: { description: "lit", values: {}, parts: [{ part: "shade", settings: {} }] } } : s)) };
    await r.director.scene({ ...input(), plan: looked, level: "free" });
    expect(userOf(r.requests[0]!).capabilities).toEqual({ level: "free", kit: [{ name: "shade" }, { name: "camera" }], parts: ["shade", "camera"] });   // every part, not only the look's
    await r.director.scene(input());
    expect(userOf(r.requests[1]!).capabilities.parts).toEqual(["shade", "camera"]);
    await r.director.storylines({ project, step: step(), settings: { count: 1 }, assets: [] });
    expect(userOf(r.requests[2]!).capabilities).toEqual({ level: "compose", kit: [{ name: "shade" }, { name: "camera" }] });
    // a plan may name parts with settings in its shot looks, so it gets every part's settings
    await r.director.plan({ project, step: step({ use: "plan" }), settings: {}, assets: [], storyline: null, planCtx, catalog: [] });
    expect(userOf(r.requests[3]!).capabilities.parts).toEqual(["shade", "camera"]);
  });

  test("kitShot: one forced submit_shot_kit call at the kit level, checked against the capabilities, with findings when there are some", async () => {
    const r = rig([json({ shotId: "s02", layers: [{ part: "shade", settings: { strength: 2 }, fromSec: 0, toSec: 3 }] }), json({ shotId: "s02", layers: [{ part: "shade", settings: {}, fromSec: 0, toSec: 3 }] })]);
    const shade = { name: "shade", version: "1.0.0", does: "lights", runtime: "dom" as const, needs: { gpu: "no" as const }, settings: { strength: { t: "num" as const, min: 0, max: 1 } }, defaults: {}, example: "x" };
    r.director.capabilities = (q) => ({ level: q.level ?? "compose", kit: [{ name: "shade", does: "lights", runtime: "dom" }] } as never);
    const answer = await r.director.kitShot({ ...input(), kit: [shade], findings: [{ code: "fix_request", message: "Bigger." }] });
    expect(answer).toEqual({ shotId: "s02", layers: [{ part: "shade", settings: {}, fromSec: 0, toSec: 3 }], text: [] });
    expect(r.requests[0]!.tool_choice).toEqual({ type: "function", function: { name: "submit_shot_kit" } });
    expect(userOf(r.requests[0]!)).toMatchObject({ capabilities: { level: "kit" }, findings: [{ code: "fix_request" }] });
    expect(JSON.parse(r.requests[1]!.messages.at(-1)!.content).problems).toEqual(["layers[0].settings.strength: must be between 0 and 1"]);
  });

  test("a markdown fence around the file is removed; a step prompt is appended; blocks default to none", async () => {
    const r = rig(["{\"html\": " + JSON.stringify("```html\n" + HTML + "\n```") + "}"]);
    expect(await r.director.scene(input({ step: step({ use: "author", prompt: { mode: "append", text: "Use big type." } }) }))).toBe(HTML);
    expect(systemOf(r.requests[0]!)).toContain("Use big type.");
    expect(userOf(r.requests[0]!).blocks).toEqual({});
  });

  test.each([
    ["no html", { html: 5 }, '"html" must be the scene file as text'],
    ["a stub", { html: "ok" }, "complete HTML document"],
    ["a huge file", { html: "<div>" + "x".repeat(200_001) }, "under 200 KB"],
  ])("scene: %s is repaired once, then refused", async (_name, bad, message) => {
    const r = rig([json(bad), json(bad)]);
    await expect(r.director.scene(input())).rejects.toThrow(message);
    expect(r.requests).toHaveLength(2);
  });

  test("repair: the findings and the current file go in; the new file and the warnings kept on purpose come out", async () => {
    const r = rig([json({ html: HTML, holds: [{ code: "sweep_static", reason: "a still title card" }, { code: "", reason: "x" }, { code: "no_reason" }, "junk"] })]);
    const out = await r.director.repair(input({ html: "<div>old</div>", findings: [{ code: "scene_missing_text", message: "missing", hint: "add it" }, { code: "sweep_static", message: "still" }] }));
    expect(out).toEqual({ html: HTML, holds: [{ code: "sweep_static", reason: "a still title card" }] });
    const req = r.requests[0]!;
    expect(req.tool_choice.function.name).toBe("submit_repair");
    expect(req.tools[0].function.parameters.required).toEqual(["html"]);
    expect(userOf(req)).toMatchObject({ currentHtml: "<div>old</div>", findings: [{ code: "scene_missing_text", hint: "add it" }, { code: "sweep_static" }] });
    expect(userOf(req).task).toContain("Repair compositions/shot-02.html");
    expect(systemOf(req)).toContain("list it in holds");
  });

  test("repair without holds, and an unusable file", async () => {
    const r = rig([json({ html: HTML })]);
    expect((await r.director.repair(input({ html: "x", findings: [] }))).holds).toEqual([]);
    const bad = rig([json({ html: "no" }), json({ holds: [] })]);
    const told: string[] = [];
    bad.director.onAnswer = (e) => told.push(e.outcome);
    await expect(bad.director.repair(input({ html: "x", findings: [] }))).rejects.toThrow("didn't pass the checks");
    expect(told).toEqual(["malformed", "failed"]);   // malformed once per ask, however many tries
  });
});

describe("director: fix", () => {
  const plan = validatePlan(samplePlan(), planCtx).plan as Plan;
  const findings = [
    { id: "check-1", severity: "must-fix", shotId: "s02", fromSec: 4.2, toSec: 5, code: "text_below_floor", description: "Text is too small.", suggestedFix: "Make it 40 px." },
    { id: "creative-1", severity: "should-fix", shotId: null, code: "creative.opening", description: "The opening is a plain title." },
  ];
  const ask = (r: ReturnType<typeof rig>, extra: Record<string, unknown> = {}) =>
    r.director.fix({ project, step: step({ use: "author" }), plan, planCtx, findings, ...extra });
  const edited = (over: (s: any, i: number) => any) => ({ ...samplePlan(), shots: samplePlan().shots.map(over) });

  test("the plan, the chosen findings and the note go in; scene edits come out, with no approval needed", async () => {
    const r = rig([json({ sceneEdits: [{ shotId: "s02", instruction: "Raise the title to 72 px." }], summary: "Bigger title in shot 2" })]);
    const out = await ask(r, { note: "lebih besar", shotId: "s02" });
    expect(out).toEqual({ plan: null, needsApproval: false, sceneEdits: [{ shotId: "s02", instruction: "Raise the title to 72 px." }], summary: "Bigger title in shot 2" });
    const req = r.requests[0]!;
    expect(req.tool_choice.function.name).toBe("submit_fix");
    expect(req.tools[0].function.parameters.required).toEqual(["sceneEdits", "summary"]);
    expect(userOf(req)).toMatchObject({ approvedPlan: { title: "Bunga berbunga" }, findings: [{ id: "check-1", code: "text_below_floor" }, { id: "creative-1" }], note: "lebih besar", onlyShot: "s02" });
    expect(userOf(req).task).toContain("and do what the note asks, only in shot s02");
    expect(systemOf(req)).toContain("Prefer sceneEdits");
    expect(systemOf(req)).toContain("Revising");   // the revising guidance of story.md
    expect(req.max_tokens).toBe(12000);
  });

  test("a plan edit that keeps the approved words and timing needs no new approval; one that changes them does", async () => {
    const look = edited((s) => ({ ...s, motion: "slower" }));
    const free = await ask(rig([json({ planEdits: look, sceneEdits: [], summary: "Slower motion" })]));
    expect(free).toMatchObject({ needsApproval: false, plan: { shots: [{ motion: "slower" }, {}, {}] } });

    const words = edited((s, i) => (i === 1 ? { ...s, text: [{ role: "title", value: "Judul baru" }] } : s));
    expect((await ask(rig([json({ planEdits: words, sceneEdits: [{ shotId: "s02", instruction: "x" }], summary: "s" })]))).needsApproval).toBe(true);
    const timing = edited((s, i) => ({ ...s, durationSec: [9, 11, 10][i] }));
    expect((await ask(rig([json({ planEdits: timing, sceneEdits: [], summary: "s" })]))).needsApproval).toBe(true);
  });

  test("what the approval covers: title, message and each shot's id, words, length and narration", () => {
    const same = validatePlan(samplePlan(), planCtx).plan as Plan;
    expect(approvalChanges(plan, same)).toBe(false);
    expect(approvalChanges(plan, { ...same, title: "Lain" })).toBe(true);
    expect(approvalChanges(plan, { ...same, message: "Lain" })).toBe(true);
    expect(approvalChanges(plan, { ...same, shots: same.shots.slice(1) })).toBe(true);
    expect(approvalChanges(plan, { ...same, shots: same.shots.map((s, i) => (i === 0 ? { ...s, id: "x" } : s)) })).toBe(true);
    expect(approvalChanges(plan, { ...same, shots: same.shots.map((s, i) => (i === 0 ? { ...s, narration: "kata" } : s)) })).toBe(true);
    expect(approvalChanges(plan, { ...same, shots: same.shots.map((s) => ({ ...s, visual: { ...s.visual, description: "lain" } })) })).toBe(false);
  });

  test.each([
    ["a shot that is not in the plan", { sceneEdits: [{ shotId: "s99", instruction: "x" }], summary: "s" }, "there is no shot s99 in the plan (the shots are s01, s02, s03)"],
    ["nothing to change", { sceneEdits: [], summary: "s" }, "at least one scene edit, or a revised plan"],
    ["edits without a shot or an instruction", { sceneEdits: [{ shotId: "s01" }, { instruction: "x" }, "junk"], summary: "s" }, "at least one scene edit"],
    ["a plan that breaks the limits", { planEdits: { ...samplePlan(), shots: [] }, sceneEdits: [], summary: "s" }, "needs 1 to 20 shots"],
  ])("%s is repaired once, then refused", async (_name, bad, message) => {
    const r = rig([json(bad), json(bad)]);
    await expect(ask(r)).rejects.toThrow(message);
    expect(r.requests).toHaveLength(2);
  });

  test("a null plan edit means none; a missing summary is allowed", async () => {
    const r = rig([json({ planEdits: null, sceneEdits: [{ shotId: "s01", instruction: "Zoom slower." }] })]);
    expect(await ask(r)).toEqual({ plan: null, needsApproval: false, sceneEdits: [{ shotId: "s01", instruction: "Zoom slower." }], summary: "" });
  });
});

describe("director: copy", () => {
  const plan = validatePlan(samplePlan(), planCtx).plan as Plan;
  const ask = (r: ReturnType<typeof rig>) => r.director.copy({ project, step: step({ use: "export" }), plan });

  test("the plan's words go in; a title and a description come out, cleaned and cut to length", async () => {
    const r = rig([json({ title: `<b>${"Judul ".repeat(30)}</b>`, description: "Isi singkat." })]);
    const out = await ask(r);
    expect(out.title.length).toBeLessThanOrEqual(100);
    expect(out.title).not.toMatch(/[<>]/);
    expect(out.description).toBe("Isi singkat.");
    const req = r.requests[0]!;
    expect(req.tool_choice.function.name).toBe("submit_copy");
    expect(userOf(req)).toMatchObject({ language: "id", title: "Bunga berbunga", shots: [{ text: ["Bunga berbunga?"] }, {}, {}] });
    expect(req.max_tokens).toBe(4000);
  });

  test("an answer without both parts is asked again, then fails", async () => {
    await expect(ask(rig([json({ title: "Saja" }), json({ description: "Saja" })]))).rejects.toThrow("give both a title and a description");
  });
});
