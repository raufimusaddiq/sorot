import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../../src/config";
import { openDatabase } from "../../src/db";
import {
  builtFacts, creativeState, creativeVerdict, fromJev, fromLlm, jevQuestions, lintQuestion, MAIN_MESSAGE, questionsFor, type Criterion, type Judgement,
} from "../../src/generate/creative";
import { Director } from "../../src/generate/director";
import { DirectorLog } from "../../src/generate/events";
import { readFindings } from "../../src/generate/findings";
import { Hyperframes } from "../../src/generate/hyperframes";
import { validatePlan, type Plan } from "../../src/generate/planSchema";
import { STEPS, settingsOf } from "../../src/generate/steps";
import { Jev } from "../../src/jev";
import { Llm } from "../../src/llm";
import { Store } from "../../src/store";
import { fakeHyperframes, fakeJev, fakeLlm, noulA, procOk, quickRecipe, samplePlan, sceneHtml, type HfHandler } from "../helpers";

const T = "2026-01-01T00:00:00.000Z";
const json = JSON.stringify;
const plan = (): Plan => validatePlan(samplePlan(), {
  brief: "x", targetSec: 30, format: "9:16", language: "id", fonts: ["Plus Jakarta Sans"], imageConnected: false, narration: false,
}).plan as Plan;
const crit = (id: string, question = "Does `opening` hold the eye?", fail?: "main"): Criterion => ({ id, question, ...(fail ? { fail } : {}) });

describe("what is asked", () => {
  test("the recipe's questions, plus the main-message question unless one of them is the main one", () => {
    const own = [crit("opening"), crit("pace")];
    const asked = questionsFor({ criteria: own }, undefined);
    expect(asked.criteria.map((c) => c.id)).toEqual(["opening", "pace", "main_message"]);
    expect(asked.criteria.at(-1)).toEqual(MAIN_MESSAGE);
    expect(MAIN_MESSAGE.fail).toBe("main");
    const main = questionsFor({ criteria: [crit("mechanism", "Would a muted stranger understand the mechanism in `shots`?", "main")] }, undefined);
    expect(main.criteria.map((c) => c.id)).toEqual(["mechanism"]);
    expect(questionsFor({}, undefined).criteria).toEqual([MAIN_MESSAGE]);
  });

  test("risks: the claim check always, each leftover default, each non-blocking content rule (blocking ones belong to TECHNICAL)", () => {
    const { risks } = questionsFor({}, {
      defaultsAudit: ["everything centred", "three cards in a row"],
      content: [{ id: "tone", question: "Is the tone of `shots` pushy?" }, { id: "advice", question: "Does `shots` give advice?", blocking: true }],
    });
    expect(risks.map((r) => r.id)).toEqual(["misleading_claim", "default_1", "default_2", "tone"]);
    expect(risks[1]!.question).toBe("Does `shots` show this common default: everything centred?");
    expect(questionsFor({}, undefined).risks.map((r) => r.id)).toEqual(["misleading_claim"]);
  });

  test("question lint: one judgment, naming what it reads, leaving counting and timing to code", () => {
    expect(lintQuestion("Does `opening` hold the eye in the first moments?")).toEqual([]);
    expect(lintQuestion(MAIN_MESSAGE.question)).toEqual([]);
    expect(lintQuestion("Is it good?")).toEqual(["name the thing it reads in backticks, for example `shots`, `opening` or `message`"]);
    expect(lintQuestion("Does `opening` hold the eye.")).toEqual(["end it with a question mark"]);
    expect(lintQuestion(`Does \`opening\` ${"hold the eye ".repeat(12)}?`).join()).toContain("under 140 characters");
    for (const q of ["How many shots in `shots` are slow?", "Is `shots` shorter than 30 seconds?", "Do 50 percent of `shots` have text?", "Is `opening` longer than `ending`?", "Does `shots` count as a story?"]) {
      expect(lintQuestion(q).join()).toContain("counting and timing");
    }
    expect(lintQuestion("Does `shots` look calm and warm or bold and loud?")).toEqual(["ask one thing at a time"]);
  });

  test("every Sorot question passes its own lint and names fields the state has", () => {
    const { criteria, risks } = questionsFor({}, { defaultsAudit: ["everything centred"] });
    const state = creativeState(builtFacts("brief", plan(), null, (i) => sceneHtml(i)));
    for (const q of [...criteria, ...risks]) {
      expect(lintQuestion(q.question)).toEqual([]);
      for (const field of [...q.question.matchAll(/`(\w+)`/g)].map((m) => m[1]!)) expect(state).toHaveProperty(field);
    }
  });
});

describe("what the judge sees", () => {
  test("the brief, the plan and what each scene shows, with the build history nowhere in it", () => {
    const story = { title: "Film", pitch: "Satu", opening: "Benih", beats: [], look: "", sound: "", bold: false, recommended: true, reason: "" };
    const SAMPLE = ["Bunga berbunga?", "x", "Mulai dari sekarang"];
    const facts = builtFacts("Jelaskan bunga majemuk", plan(), story, (i) => (i === 1 ? null : sceneHtml(i, SAMPLE[i]!)));
    expect(facts).toMatchObject({
      brief: "Jelaskan bunga majemuk", message: "Bunga majemuk membuat uang tumbuh sendiri", storyline: "Film: Satu Opening: Benih",
      look: "#0B1020 #FFD23F; Plus Jakarta Sans; brisk; flat",
    });
    expect(facts.shots.map((s) => [s.id, s.from, s.seconds])).toEqual([["s01", 0, 10], ["s02", 10, 10], ["s03", 20, 10]]);
    expect(facts.shots[0]).toMatchObject({ onScreen: "Bunga berbunga?", planned: ["Bunga berbunga?"], drawn: "visual 1", moves: "slide in", hold: false });
    expect(facts.shots[1]!.onScreen).toBe("(no scene was written)");
    expect(facts.opening).toBe("Bunga berbunga? — visual 1");
    expect(facts.ending).toBe("Mulai dari sekarang — visual 3");
    expect(JSON.stringify(facts)).not.toMatch(/repair|finding|round/i);
  });

  test("long scene text is cut; the Jev state describes only the fields it sends", () => {
    const long = builtFacts("b", plan(), null, () => `<p>${"word ".repeat(200)}</p>`);
    expect(long.shots[0]!.onScreen.length).toBe(400);
    expect(long.shots[0]!.onScreen.endsWith("…")).toBe(true);
    const state = creativeState(long) as { context: { fields: Record<string, string>; task: string }; storyline?: string };
    expect(Object.keys(state.context.fields)).toEqual(["brief", "message", "look", "opening", "ending", "shots"]);
    expect(state.context.task).toContain("short 2D motion video");
    expect(state).not.toHaveProperty("storyline");
    const withStory = creativeState(builtFacts("b", plan(), { title: "T", pitch: "P", opening: "O" } as never, () => null)) as { context: { fields: object } };
    expect(Object.keys(withStory.context.fields)).toContain("storyline");
  });

  test("each question becomes one Noul", () => {
    expect(jevQuestions([crit("a", "Q one `x`?"), crit("b")])).toEqual({
      a: { type: "noul", instructions: "Q one `x`?" }, b: { type: "noul", instructions: "Does `opening` hold the eye?" },
    });
  });
});

describe("answers to a verdict", () => {
  const c = [crit("a"), crit("b"), crit("c"), crit("main_message", "Q?", "main")];
  const r = [crit("claim", "Does `shots` claim?")];
  const level = (js: Judgement[]) => js.map((j) => j.level);

  test("Jev's probabilities: a criterion is met from 0.7, fails at 0.3 or under, and is borderline between; a risk is flagged from 0.7", () => {
    expect(level(fromJev({ a: 0.7, b: 0.3, c: 0.5, main_message: 0.95, claim: 0.7 }, c, r))).toEqual(["yes", "no", "borderline", "yes", "no"]);
    expect(level(fromJev({ a: 1, b: 1, c: 1, main_message: 1, claim: 0.69 }, c, r))).toEqual(["yes", "yes", "yes", "yes", "yes"]);
    expect(level(fromJev({}, c, r))).toEqual(["no", "no", "no", "no", "yes"]);   // unanswered counts as no
    expect(fromJev({ a: 1 }, c, r).map((j) => j.kind)).toEqual(["criterion", "criterion", "criterion", "criterion", "risk"]);
  });

  test("the LLM judge's answers: no fails, partly is borderline; the reason, shot and fix are kept", () => {
    const js = fromLlm({
      criteria: [
        { id: "a", answer: "yes", reason: "" }, { id: "b", answer: "partly", reason: "slow", shotId: "s02" },
        { id: "c", answer: "no", reason: "flat", shotId: "s03", fromSec: 20, toSec: 25, suggestedFix: "add motion" }, { id: "main_message", answer: "yes", reason: "" },
      ],
      risks: [{ id: "claim", flagged: true, reason: "a number is invented", shotId: "s01", suggestedFix: "remove it" }],
    }, c, r);
    expect(level(js)).toEqual(["yes", "borderline", "no", "yes", "no"]);
    expect(js[2]).toMatchObject({ reason: "flat", shotId: "s03", fromSec: 20, toSec: 25, suggestedFix: "add motion" });
    expect(js[4]).toMatchObject({ kind: "risk", reason: "a number is invented", shotId: "s01" });
  });

  const judged = (levels: string[], riskLevel = "yes") => [
    ...c.map((x, i): Judgement => ({ criterion: x, kind: "criterion", level: levels[i] as never })),
    ...r.map((x): Judgement => ({ criterion: x, kind: "risk", level: riskLevel as never })),
  ];

  test.each([
    ["all met", ["yes", "yes", "yes", "yes"], "yes", "PASS"],
    ["one borderline", ["borderline", "yes", "yes", "yes"], "yes", "REVIEW"],
    ["one criterion failed", ["no", "yes", "yes", "yes"], "yes", "REVIEW"],
    ["two failed", ["no", "no", "yes", "yes"], "yes", "REVIEW"],
    ["three failed", ["no", "no", "no", "yes"], "yes", "FAIL"],
    ["the main question failed", ["yes", "yes", "yes", "no"], "yes", "FAIL"],
    ["the main question borderline", ["yes", "yes", "yes", "borderline"], "yes", "REVIEW"],
    ["a risk flagged", ["yes", "yes", "yes", "yes"], "no", "REVIEW"],
  ] as const)("%s: %s", (_name, levels, risk, status) => {
    expect(creativeVerdict(judged([...levels], risk)).status).toBe(status);
  });

  test("findings: a failed criterion or a flagged risk is a should-fix, a borderline one polish; nothing met is a finding", () => {
    const { findings } = creativeVerdict(fromLlm({
      criteria: [
        { id: "a", answer: "no", reason: "", suggestedFix: "x" }, { id: "b", answer: "partly", reason: "" },
        { id: "c", answer: "yes", reason: "" }, { id: "main_message", answer: "yes", reason: "" },
      ],
      risks: [{ id: "claim", flagged: true, reason: "invented number", shotId: "s02" }],
    }, c, r));
    expect(findings.map((f) => [f.code, f.severity, f.state, f.shotId])).toEqual([
      ["creative.a", "should-fix", "open", null], ["creative.b", "polish", "open", null], ["creative.claim", "should-fix", "open", "s02"],
    ]);
    expect(findings[0]).toMatchObject({ description: "Not met: Does opening hold the eye?", suggestedFix: "x", rule: "a" });
    expect(findings[1]!.description).toBe("Only partly met: Does opening hold the eye?");
    expect(findings[2]!.description).toBe("invented number");
    const fromJevRisk = creativeVerdict(fromJev({ a: 1, b: 1, c: 1, main_message: 1, claim: 0.9 }, c, r)).findings;
    expect(fromJevRisk[0]!.description).toBe("Possible risk: Does shots claim?");
  });
});

describe("creative step", () => {
  let tmp: string;
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  function rig(opts: {
    jev?: ReturnType<typeof fakeJev>["jev"]; replies?: Parameters<typeof fakeLlm>[0]; vision?: string; mode?: string; criteria?: Criterion[]; handlers?: Record<string, HfHandler>;
  } = {}) {
    tmp = mkdtempSync(join(tmpdir(), "vc-creative-"));
    const store = new Store(openDatabase(":memory:"));
    const recipe = quickRecipe();
    recipe.rules = { defaultsAudit: ["everything centred"] };
    const dir = join(tmp, "v1");
    mkdirSync(join(dir, "compositions"), { recursive: true });
    [0, 1, 2].forEach((i) => writeFileSync(join(dir, `compositions/shot-0${i + 1}.html`), sceneHtml(i)));
    store.saveGenProject({
      id: "p1", title: null, brief: "Jelaskan bunga majemuk", format: "9:16", targetSec: 30, language: "id", styleNotes: null, preset: null, recipeId: "quick", recipe: JSON.stringify(recipe),
      ideaId: null, briefFlags: null, narrationScript: null, concept: null, stepIndex: 0, stepState: null, narration: 0, storylines: null, pickedStoryline: null,
      status: "BUILDING", currentPlanId: "pl1", acceptedVersionId: null, errorMessage: null, createdAt: T, updatedAt: T,
    });
    store.saveGenPlan({ id: "pl1", projectId: "p1", revision: 1, plan: JSON.stringify(plan()), changeRequest: null, changeSummary: null, approvedAt: T, createdAt: T });
    store.saveGenVersion({
      id: "v1", projectId: "p1", planId: "pl1", number: 1, parentVersionId: null, status: "BUILDING", step: null, progress: null, projectDir: dir, renderKind: "draft",
      draftPath: null, stepState: null, hyperframesVersion: null, buildMs: null, errorMessage: null, createdAt: T, updatedAt: T,
    });
    const requests: any[] = [];
    const queue = [...(opts.replies ?? [])];
    const fetchFn = (async (_u: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      const reply = queue.shift() as string | undefined;
      if (reply === undefined) return new Response("no more replies", { status: 500 });
      const call = { id: "c1", type: "function", function: { name: body.tool_choice.function.name, arguments: reply } };
      return Response.json({ choices: [{ message: { role: "assistant", content: null, tool_calls: [call] } }] });
    }) as unknown as typeof fetch;
    const llm = new Llm({ llmBaseUrl: "http://llm/v1", llmModel: "text-model", llmApiKey: "", llmTimeoutSec: 5, llmVisionModel: opts.vision ?? "" }, fetchFn, 0);
    const fake = fakeHyperframes(opts.handlers ?? {});
    const step = { ...recipe.steps.find((s) => s.use === "creative")!, with: { ...(opts.criteria ? { criteria: opts.criteria } : {}), ...(opts.mode ? { vision: opts.mode } : {}) } };
    const ctx = {
      project: store.getGenProject("p1")!, version: store.getGenVersion("v1")!, recipe, step, settings: settingsOf("creative", step.with), store,
      log: new DirectorLog(store), director: new Director(llm, new DirectorLog(store), "../generator"), hyperframes: new Hyperframes(loadConfig({}), fake.exec),
      jev: opts.jev as Jev, exec: fake.exec, config: loadConfig({}), connected: () => false, catalog: async () => [], progress: () => {},
    };
    if (!opts.jev) ctx.jev = new Jev({ jevUrl: "", jevModel: "", jevApiKey: "", jevTimeoutSec: 5 });   // Jev off
    return { store, dir, ctx, requests, verdict: () => store.genVerdictsForVersion("v1")[0]!, events: () => store.genEventsForProject("p1").reverse() };
  }

  const LLM_PASS = json({
    criteria: ["opening", "pace", "main_message"].map((id) => ({ id, answer: "yes", reason: "ok" })),
    risks: ["misleading_claim", "default_1"].map((id) => ({ id, flagged: false, reason: "" })),
  });

  test("Jev answers the recipe's questions and the verdict follows its answers; the state carries the facts and context", async () => {
    const asked: any[] = [];
    const { jev, requests } = fakeJev((state, id) => { asked.push([id, state]); return noulA(id === "pace" ? 0.5 : id === "default_1" || id === "misleading_claim" ? 0.1 : 0.9); });
    const r = rig({ jev, criteria: [crit("opening"), crit("pace", "Is the pace of `shots` comfortable?")] });
    expect(await STEPS.creative.run(r.ctx)).toEqual({ status: "done", outputRef: "REVIEW" });
    expect(r.verdict()).toMatchObject({ kind: "CREATIVE", status: "REVIEW", judgedBy: "jev:jev-1.14.0" });
    const body = requests[0]!;
    expect(Object.keys(body.questions)).toEqual(["opening", "pace", "main_message", "misleading_claim", "default_1"]);
    expect(body.state.brief).toBe("Jelaskan bunga majemuk");
    expect(body.state.shots).toHaveLength(3);
    expect(body.state.context.fields.shots).toContain("every shot in order");
    expect(JSON.parse(r.verdict().findings)).toEqual([expect.objectContaining({ code: "creative.pace", severity: "polish", source: "creative", state: "open" })]);
    expect(readFindings(r.dir).map((f) => f.source)).toEqual(["creative"]);
    expect(JSON.parse(r.verdict().inputs!)).toEqual({ criteria: ["opening", "pace", "main_message"], risks: ["misleading_claim", "default_1"], pictures: 0, shots: 3 });
    expect(r.events()[0]).toMatchObject({ kind: "judge", model: "jev-1.14.0", ok: 1 });
    expect(JSON.parse(r.events()[0]!.response!)).toMatchObject({ opening: 0.9, pace: 0.5 });
  });

  test("a failed main question fails the verdict, and the findings tell what to change", async () => {
    const { jev } = fakeJev((_s, id) => noulA(id === "main_message" ? 0.05 : 0.95));
    const r = rig({ jev, criteria: [crit("opening")] });
    await STEPS.creative.run(r.ctx);
    expect(r.verdict().status).toBe("FAIL");
    expect(JSON.parse(r.verdict().findings)[0]).toMatchObject({ code: "creative.main_message", severity: "should-fix" });
  });

  test("when Jev fails the LLM judges instead, from fresh messages, and never sees a history", async () => {
    const { jev } = fakeJev(() => new Error("down"));
    const r = rig({ jev, replies: [LLM_PASS], criteria: [crit("opening"), crit("pace")] });
    await STEPS.creative.run(r.ctx);
    expect(r.verdict()).toMatchObject({ status: "PASS", judgedBy: "llm:text-model" });
    expect(r.requests).toHaveLength(1);
    const req = r.requests[0]!;
    expect(req.tool_choice.function.name).toBe("submit_judgement");
    expect(req.messages.map((m: any) => m.role)).toEqual(["system", "user"]);
    const sent = JSON.parse(req.messages[1].content);
    expect(sent.criteria.map((c: any) => c.id)).toEqual(["opening", "pace", "main_message"]);
    expect(sent.criteria[0].question).not.toContain("`");
    expect(sent.risks.map((c: any) => c.id)).toEqual(["misleading_claim", "default_1"]);
    expect(sent.facts.shots[0].onScreen).toBe("Bunga berbunga?");
    expect(req.messages[0].content).toContain("fresh judge");
  });

  test("with Jev off the LLM judges; its answers become findings with the shot and the time", async () => {
    const r = rig({ criteria: [crit("opening"), crit("pace")], replies: [json({
      criteria: [
        { id: "opening", answer: "no", reason: "the first shot is a plain title", shotId: "s01", fromSec: 0, toSec: 3, suggestedFix: "start with the coin" },
        { id: "pace", answer: "partly", reason: "shot 2 drags" }, { id: "main_message", answer: "yes", reason: "" },
      ],
      risks: [{ id: "misleading_claim", flagged: true, reason: "the rate is not in the brief", shotId: "s02" }, { id: "default_1", flagged: false, reason: "" }],
    })] });
    await STEPS.creative.run(r.ctx);
    expect(r.verdict().status).toBe("REVIEW");
    expect(JSON.parse(r.verdict().findings).map((f: any) => [f.code, f.severity, f.shotId, f.fromSec])).toEqual([
      ["creative.opening", "should-fix", "s01", 0], ["creative.pace", "polish", null, undefined], ["creative.misleading_claim", "should-fix", "s02", undefined],
    ]);
  });

  test("a judge that skips a question is told which, and asked again once", async () => {
    const r = rig({ replies: [json({ criteria: [{ id: "main_message", answer: "yes", reason: "" }], risks: [] }), json({
      criteria: [{ id: "main_message", answer: "yes", reason: "" }], risks: ["misleading_claim", "default_1"].map((id) => ({ id, flagged: false, reason: "" })),
    })] });
    await STEPS.creative.run(r.ctx);
    expect(r.verdict().status).toBe("PASS");
    expect(JSON.parse(r.requests[1].messages.at(-1).content).problems[0]).toContain("you didn't answer: misleading_claim, default_1");
    const stubborn = rig({ replies: [json({ criteria: [], risks: [] }), json({ criteria: [], risks: [] })] });
    await expect(STEPS.creative.run(stubborn.ctx)).rejects.toThrow("didn't pass the checks");
  });

  test("vision: with a vision model the judge gets HyperFrames' review sheets as pictures and the verdict says so; the sheets are kept with the version", async () => {
    const r = rig({
      vision: "vl-model", replies: [LLM_PASS], criteria: [crit("opening"), crit("pace")],
      handlers: {
        snapshot: () => {
          const out = join(tmp, "snaps");
          mkdirSync(out, { recursive: true });
          writeFileSync(join(out, "review-beats-1.jpg"), "BEATS");
          writeFileSync(join(out, "review-beats-2.jpg"), "BEATS2");   // only the first page of each goes to the judge
          writeFileSync(join(out, "review-phone-1.jpg"), "PHONE");
          return procOk(JSON.stringify({ ok: true, outputDir: out, frames: [{ path: join(out, "f1.png"), time: 1 }] }));
        },
      },
    });
    await STEPS.creative.run(r.ctx);
    expect(r.verdict()).toMatchObject({ judgedBy: "llm-vision:vl-model" });
    expect(JSON.parse(r.verdict().inputs!).pictures).toBe(2);
    const req = r.requests[0]!;
    expect(req.model).toBe("vl-model");
    const urls = req.messages[1].content.filter((p: any) => p.type === "image_url").map((p: any) => p.image_url.url);
    expect(urls).toEqual([`data:image/jpeg;base64,${Buffer.from("BEATS").toString("base64")}`, `data:image/jpeg;base64,${Buffer.from("PHONE").toString("base64")}`]);
    expect(JSON.parse(req.messages[1].content[0].text).pictures).toBe(2);
    expect(readFileSync(join(r.dir, "sheets/review-beats.jpg"), "utf-8")).toBe("BEATS");
    expect(readFileSync(join(r.dir, "sheets/review-phone.jpg"), "utf-8")).toBe("PHONE");
  });

  test("vision falls back to the first frames when there are no sheets, and to text when the snapshot fails or vision is off", async () => {
    const frames = rig({
      vision: "vl-model", replies: [LLM_PASS], criteria: [crit("opening"), crit("pace")],
      handlers: { snapshot: () => {
        const out = join(tmp, "snaps");
        mkdirSync(out, { recursive: true });
        const list = ["a", "b", "c", "d", "e"].map((n, i) => { writeFileSync(join(out, `${n}.png`), n); return { path: join(out, `${n}.png`), time: i }; });
        return procOk(JSON.stringify({ ok: true, outputDir: out, frames: list }));
      } },
    });
    await STEPS.creative.run(frames.ctx);
    expect(frames.requests[0].messages[1].content.filter((p: any) => p.type === "image_url")).toHaveLength(4);
    expect(frames.requests[0].messages[1].content[1].image_url.url).toStartWith("data:image/png;base64,");

    const crashed = rig({ vision: "vl-model", replies: [LLM_PASS], criteria: [crit("opening"), crit("pace")], handlers: { snapshot: () => ({ exitCode: 2, stdout: "", stderr: "no browser", timedOut: false, aborted: false }) } });
    await STEPS.creative.run(crashed.ctx);
    expect(crashed.verdict().judgedBy).toBe("llm:text-model");
    expect(typeof crashed.requests[0].messages[1].content).toBe("string");

    const off = rig({ vision: "vl-model", mode: "off", replies: [LLM_PASS], criteria: [crit("opening"), crit("pace")] });
    await STEPS.creative.run(off.ctx);
    expect(off.verdict().judgedBy).toBe("llm:text-model");
    expect(off.ctx.hyperframes).toBeDefined();
  });

  test("vision: on without a vision model is an error, not a silent downgrade; a cancelled snapshot is not swallowed", async () => {
    const r = rig({ mode: "on", replies: [LLM_PASS] });
    await expect(STEPS.creative.run(r.ctx)).rejects.toThrow("needs a vision model");
    expect(r.requests).toHaveLength(0);
    const cancelled = rig({ vision: "vl-model", replies: [LLM_PASS], handlers: { snapshot: () => ({ exitCode: 137, stdout: "", stderr: "", timedOut: false, aborted: true }) } });
    await expect(STEPS.creative.run(cancelled.ctx)).rejects.toThrow("cancelled");
  });

  test("the verdict is replaced when the step runs again", async () => {
    const { jev } = fakeJev((_s, id) => noulA(id === "misleading_claim" || id.startsWith("default") ? 0.1 : 0.9));
    const r = rig({ jev });
    await STEPS.creative.run(r.ctx);
    await STEPS.creative.run(r.ctx);
    expect(r.store.genVerdictsForVersion("v1")).toHaveLength(1);
    expect(r.verdict().status).toBe("PASS");
  });
});
