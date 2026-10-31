import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/db";
import { Director, DirectorError, changedShots, shotsNamed } from "../../src/generate/director";
import { DirectorLog } from "../../src/generate/events";
import { validatePlan, type Plan, type PlanContext } from "../../src/generate/planSchema";
import type { RecipeStep } from "../../src/generate/recipe";
import { LlmError } from "../../src/llm";
import { Store } from "../../src/store";
import type { GenProject } from "../../src/types";
import { Llm } from "../../src/llm";
import { AsText, fakeLlm, samplePlan } from "../helpers";

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

function rig(replies: Parameters<typeof fakeLlm>[0]) {
  const store = new Store(openDatabase(":memory:"));
  const { llm, requests } = fakeLlm(replies);
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
    expect(systemOf(req)).toContain("hook frame is never black"); // generator/prompts/story.md
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

describe("director: revise", () => {
  const current = validatePlan(samplePlan(), planCtx).plan as Plan;
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
    expect(JSON.parse(r.requests[1]!.messages.at(-1)!.content).problems[0]).toBe("the function arguments were not valid JSON");
  });

  test("the answer budget is at least the job's floor, and a larger configured one wins (a reasoning model thinks first)", async () => {
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
    const big = new Llm({ llmBaseUrl: "http://llm/v1", llmModel: "m", llmApiKey: "", llmTimeoutSec: 5, llmMaxTokens: 40000 }, fetchFn, 0);
    const store = new Store(openDatabase(":memory:"));
    await new Director(big, new DirectorLog(store), "../generator").gate({ project, step: step(), kind: "plan", output: samplePlan() });
    expect(seen[0].max_tokens).toBe(40000);
  });
});
