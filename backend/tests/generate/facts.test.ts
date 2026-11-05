import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../../src/config";
import { openDatabase } from "../../src/db";
import { Director } from "../../src/generate/director";
import { DirectorLog } from "../../src/generate/events";
import { allowedTexts, factsMarkdown, fetchPageText, headlineOnly, isOnPage, queryData, requiresSourcedNumbers, unsourcedIn, type FactWeb } from "../../src/generate/facts";
import type { RecipeStep } from "../../src/generate/recipe";
import { STEPS, settingsOf } from "../../src/generate/steps";
import { Llm } from "../../src/llm";
import { Store } from "../../src/store";
import type { GenFact } from "../../src/types";
import { makeEnv, quickRecipe, samplePlan, type TestEnv } from "../helpers";

const T = "2026-01-01T00:00:00.000Z";
const json = JSON.stringify;
let tmp: string;
let env: TestEnv | undefined;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "vc-facts-")); });
afterEach(() => { env?.cleanup(); env = undefined; rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });

// ---- helpers: a scripted model that can call tools ------------------------------------------

type Msg = { content?: string; calls?: Array<{ name: string; args: object }> };
function scripted(messages: Array<Msg | string>) {
  const requests: any[] = [];
  const queue = [...messages];
  const fetchFn = (async (_u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    requests.push(body);
    const m = queue.shift();
    if (!m) return new Response("no more replies", { status: 500 });
    const forced = body.tool_choice?.function?.name as string | undefined;
    if (typeof m === "string") {
      const call = { id: "c", type: "function", function: { name: forced, arguments: m } };
      return Response.json({ choices: [{ message: forced ? { role: "assistant", content: null, tool_calls: [call] } : { role: "assistant", content: m }, finish_reason: "stop" }] });
    }
    const calls = (m.calls ?? []).map((c, i) => ({ id: `c${i}`, type: "function", function: { name: c.name, arguments: json(c.args) } }));
    return Response.json({ choices: [{ message: { role: "assistant", content: m.content ?? null, ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: calls.length ? "tool_calls" : "stop" }] });
  }) as unknown as typeof fetch;
  return { llm: new Llm({ llmBaseUrl: "http://llm/v1", llmModel: "m", llmApiKey: "", llmTimeoutSec: 5 }, fetchFn, 0), requests };
}
const verdict = (args: object): Msg => ({ calls: [{ name: "submit_verification", args }] });

const PAGE = "Bank Indonesia menetapkan suku bunga acuan sebesar 5,75 persen pada rapat bulanan terakhir, menurut siaran pers resmi yang dirilis hari ini setelah rapat dewan gubernur selesai dan keputusan diambil bersama. ".repeat(2);
const QUOTE = "Bank Indonesia menetapkan suku bunga acuan sebesar 5,75 persen";

function rig(replies: Array<Msg | string>, opts: { settings?: Record<string, unknown>; pages?: Record<string, string | Error>; searched?: string[]; dataSources?: Array<{ name: string; kind: "sqlite"; path: string }> } = {}) {
  const config = { ...loadConfig({}), genDir: join(tmp, "generate"), dataSources: opts.dataSources ?? [] };
  const store = new Store(openDatabase(":memory:"));
  const recipe = quickRecipe();
  store.saveGenProject({
    id: "p1", title: null, brief: "Jelaskan suku bunga", format: "9:16", targetSec: 30, language: "id", styleNotes: null, preset: null, recipeId: "quick", recipe: json(recipe),
    ideaId: null, briefFlags: null, narrationScript: null, concept: null, stepIndex: 0, stepState: null, narration: 0, storylines: null, pickedStoryline: null,
    status: "RUNNING", currentPlanId: null, acceptedVersionId: null, errorMessage: null, createdAt: T, updatedAt: T,
  });
  const { llm, requests } = scripted(replies);
  const fetched: string[] = [];
  const web: FactWeb = {
    fetchText: async (url) => {
      fetched.push(url);
      const p = opts.pages?.[url];
      if (p instanceof Error) throw p;
      if (p === undefined) throw new Error("the page answered HTTP 404");
      return p;
    },
    search: async (q) => { opts.searched?.push(q); return [{ title: "Hasil", url: "https://bi.go.id/rapat", snippet: "suku bunga" }]; },
  };
  const fact = (id: string, over: Partial<GenFact> = {}): GenFact => store.saveGenFact({
    id, projectId: "p1", ideaId: null, claim: "Suku bunga acuan BI adalah 5,75 persen", value: "5,75%", sourceUrl: "https://bi.go.id/rapat", status: "unverified",
    originalValue: null, evidence: null, addedBy: "owner", createdAt: T, updatedAt: T, ...over,
  });
  const progress: number[] = [];
  const ctxFor = (withSettings: Record<string, unknown> = {}) => {
    const step = { use: "facts", with: { ...opts.settings, ...withSettings } } as RecipeStep;
    return {
      project: store.getGenProject("p1")!, version: null, recipe, step, settings: settingsOf("facts", step.with), store, log: new DirectorLog(store),
      director: new Director(llm, new DirectorLog(store), "../generator"), web, config: config as never, progress: (p: number) => progress.push(Math.round(p)),
    } as any;
  };
  return { store, requests, fetched, fact, ctxFor, progress, config };
}
const factOf = (r: ReturnType<typeof rig>, id: string) => r.store.getGenFact(id)!;
const pages = { "https://bi.go.id/rapat": PAGE };

describe("facts helpers", () => {
  test("a quote is on the page whatever its case, spacing and punctuation", () => {
    expect(isOnPage("bank indonesia   menetapkan suku bunga acuan sebesar 5,75 persen!", PAGE)).toBeTrue();
    expect(isOnPage("suku bunga acuan sebesar 6 persen", PAGE)).toBeFalse();
    expect(isOnPage("", PAGE)).toBeFalse();
    expect(headlineOnly("BI naikkan bunga")).toBeTrue();
    expect(headlineOnly(PAGE)).toBeFalse();
  });

  test("a page is fetched as readable text; a non-address or a failing page is an error", async () => {
    const html = "<html><head><style>p{}</style><script>var x=1</script></head><body><p>Halo &amp; selamat</p>   <b>datang</b></body></html>";
    const seen: string[] = [];
    const f = (async (url: string) => { seen.push(url); return new Response(html); }) as unknown as typeof fetch;
    expect(await fetchPageText("https://x.id/a", f)).toBe("Halo & selamat datang");
    await expect(fetchPageText("ftp://x", f)).rejects.toThrow("not a web address");
    await expect(fetchPageText("https://x.id/a", (async () => new Response("no", { status: 503 })) as never)).rejects.toThrow("HTTP 503");
    expect(seen).toEqual(["https://x.id/a"]);
  });

  test("allowed numbers are the brief's and those of verified or corrected facts only", () => {
    const f = (status: GenFact["status"], claim: string): GenFact => ({ id: claim, projectId: "p1", ideaId: null, claim, value: null, sourceUrl: null, status, originalValue: null, evidence: null, addedBy: "owner", createdAt: T, updatedAt: T });
    const facts = [f("verified", "bunga 5,75%"), f("corrected", "inflasi 2,8%"), f("unverified", "kurs 16.000"), f("unverifiable", "ihsg 7.000")];
    expect(allowedTexts("brief 30 detik", facts).join("|")).toContain("5,75%");
    expect(unsourcedIn(["Bunga lima koma tujuh lima persen, inflasi 2,8%, kurs 16.000, 30 detik"], "brief 30 detik", facts)).toEqual(["16.000"]);
    expect(unsourcedIn(["tanpa angka"], "x", facts)).toEqual([]);
  });

  test("a recipe requires sourced numbers when its technical step asks for them", () => {
    const withMeasure = (v: unknown) => ({ steps: [{ use: "technical", with: { measures: { sourcedNumbers: v } } }] });
    expect(requiresSourcedNumbers(withMeasure(true))).toBeTrue();
    expect(requiresSourcedNumbers(withMeasure({}))).toBeTrue();
    expect(requiresSourcedNumbers(withMeasure(false))).toBeFalse();
    expect(requiresSourcedNumbers({ steps: [{ use: "technical" }] })).toBeFalse();
    expect(requiresSourcedNumbers({ steps: [] })).toBeFalse();
  });

  test("facts.md lists each claim with its status, source, evidence and what a correction replaced", () => {
    const md = factsMarkdown([
      { id: "a", projectId: "p1", ideaId: null, claim: "Bunga 5,75%", value: "5,75%", sourceUrl: "https://bi.go.id", status: "corrected", originalValue: "6%", evidence: "sebesar 5,75 persen", addedBy: "owner", createdAt: T, updatedAt: T },
      { id: "b", projectId: "p1", ideaId: null, claim: "Kurs naik", value: null, sourceUrl: null, status: "unverifiable", originalValue: null, evidence: null, addedBy: "director", createdAt: T, updatedAt: T },
    ]);
    expect(md).toContain("- **Bunga 5,75%** (5,75%) — corrected");
    expect(md).toContain("  - Was: 6%");
    expect(md).toContain('  - Evidence: "sebesar 5,75 persen"');
    expect(md).toContain("- **Kurs naik** — could not be verified, added by director");
  });
});

describe("data sources", () => {
  const source = () => {
    const path = join(tmp, "data.db");
    const db = new Database(path);
    db.run("CREATE TABLE IF NOT EXISTS rate (month TEXT, pct REAL)");
    if ((db.query("SELECT count(*) AS n FROM rate").get() as { n: number }).n === 0) for (let i = 0; i < 60; i++) db.run("INSERT INTO rate VALUES (?, ?)", [`m${i}`, 5 + i / 100]);
    db.close();
    return [{ name: "bi", kind: "sqlite" as const, path }];
  };

  test("a SELECT runs read-only and returns at most 50 rows", () => {
    const r = queryData(source(), "bi", "SELECT month, pct FROM rate ORDER BY month LIMIT 55;");
    expect(r.columns).toEqual(["month", "pct"]);
    expect(r.rows).toHaveLength(50);
    expect(r.truncated).toBeTrue();
    expect(queryData(source(), "bi", "select count(*) as n from rate").rows).toEqual([[60]]);
    expect(queryData(source(), "bi", "select * from rate where month = 'none'").rows).toEqual([]);
  });

  test.each([
    ["DELETE FROM rate", "Only a single SELECT"], ["SELECT 1; DROP TABLE rate", "Only a single SELECT"], ["UPDATE rate SET pct = 0", "Only a single SELECT"],
    ["SELECT * FROM rate WHERE 1 UNION SELECT 1, 2 -- attach", "Only a single SELECT"],
  ])("%s is refused", (sql, message) => expect(() => queryData(source(), "bi", sql)).toThrow(message));

  test("an unknown source names the known ones", () => {
    expect(() => queryData(source(), "nope", "SELECT 1")).toThrow('no data source "nope" (bi)');
    expect(() => queryData([], "nope", "SELECT 1")).toThrow("none registered");
  });
});

describe("verify", () => {
  test("a claim the page states is verified, with the passage as evidence", async () => {
    const r = rig([verdict({ verdict: "verified", evidence: QUOTE, reason: "stated" })], { pages });
    r.fact("f1");
    expect(await STEPS.facts.run(r.ctxFor())).toEqual({ status: "done", outputRef: "1 verified, 0 corrected, 0 unverifiable" });
    expect(factOf(r, "f1")).toMatchObject({ status: "verified", evidence: QUOTE, value: "5,75%", originalValue: null });
    expect(r.fetched).toEqual(["https://bi.go.id/rapat"]);
    expect(JSON.parse(r.requests[0].messages[1].content)).toMatchObject({ claim: "Suku bunga acuan BI adalah 5,75 persen", sourceUrl: "https://bi.go.id/rapat" });
    expect(r.requests[0].tool_choice.function.name).toBe("submit_verification");
    expect(r.progress).toEqual([100]);
  });

  test("a wrong value is corrected to what the source states, keeping the original", async () => {
    const r = rig([verdict({ verdict: "corrected", correctedValue: "5,75 persen", evidence: QUOTE, reason: "differs" })], { pages });
    r.fact("f1", { claim: "Suku bunga acuan BI adalah 6 persen", value: "6%" });
    const result = await STEPS.facts.run(r.ctxFor());
    expect(factOf(r, "f1")).toMatchObject({ status: "corrected", value: "5,75 persen", originalValue: "6%", evidence: QUOTE });
    expect(result.outputRef).toBe("0 verified, 1 corrected, 0 unverifiable");
  });

  test("a claim the page does not state is unverifiable, and the run says so", async () => {
    const r = rig([verdict({ verdict: "unverifiable", reason: "the page says nothing about it" })], { pages });
    r.fact("f1");
    const result = await STEPS.facts.run(r.ctxFor());
    expect(factOf(r, "f1")).toMatchObject({ status: "unverifiable", evidence: "the page says nothing about it" });
    expect(result.reason).toBe("1 fact could not be verified");
  });

  test.each([
    ["evidence that is not on the page", { verdict: "verified", evidence: "Bank Indonesia menurunkan bunga menjadi 5 persen", reason: "x" }, "copied word for word"],
    ["a verdict without evidence", { verdict: "verified", reason: "x" }, "copied word for word"],
    ["a made-up verdict", { verdict: "probably", reason: "x" }, "verified, corrected or unverifiable"],
    ["a quote too short to mean anything", { verdict: "verified", evidence: "5,75 persen", reason: "x" }, "only 11 characters"],
    ["a verified claim whose number the quote lacks", { verdict: "verified", evidence: "Bank Indonesia menetapkan suku bunga acuan sebesar", reason: "x" }, "does not state 5,75"],
    ["a correction the quote does not support", { verdict: "corrected", correctedValue: "9 persen", evidence: QUOTE, reason: "x" }, "correctedValue must be a value that the evidence states"],
    ["a correction without a value", { verdict: "corrected", evidence: QUOTE, reason: "x" }, "correctedValue must be"],
  ])("%s is sent back; a second bad answer is an error", async (_name, args, message) => {
    const r = rig([verdict(args), verdict(args)], { pages });
    r.fact("f1");
    await expect(STEPS.facts.run(r.ctxFor())).rejects.toThrow(message);
    expect(factOf(r, "f1").status).toBe("unverified");
  });

  test("a bad answer that the model fixes on the second try is accepted", async () => {
    const r = rig([verdict({ verdict: "verified", evidence: "not on the page at all", reason: "x" }), verdict({ verdict: "verified", evidence: QUOTE, reason: "stated" })], { pages });
    r.fact("f1");
    await STEPS.facts.run(r.ctxFor());
    expect(factOf(r, "f1").status).toBe("verified");
  });

  test("a page that is only a headline is not evidence, unless the recipe says it is", async () => {
    const headline = "Bank Indonesia menetapkan suku bunga acuan sebesar 5,75 persen";
    const verified = verdict({ verdict: "verified", evidence: headline, reason: "stated" });
    const strict = rig([verified], { pages: { "https://bi.go.id/rapat": headline } });
    strict.fact("f1");
    await STEPS.facts.run(strict.ctxFor());
    expect(factOf(strict, "f1")).toMatchObject({ status: "unverifiable", evidence: "the source is only a headline, which is not evidence" });
    const lax = rig([verified], { pages: { "https://bi.go.id/rapat": headline } });
    lax.fact("f1");
    await STEPS.facts.run(lax.ctxFor({ headlinesAsEvidence: true }));
    expect(factOf(lax, "f1").status).toBe("verified");
  });

  test("a source that can't be read, or no source at all, is unverifiable with the reason", async () => {
    const r = rig([], { pages: { "https://down.id/x": new Error("ECONNRESET") } });
    r.fact("f1", { sourceUrl: "https://down.id/x" });
    r.fact("f2", { sourceUrl: null });
    r.fact("f3", { sourceUrl: "https://gone.id/y" });
    const result = await STEPS.facts.run(r.ctxFor());
    expect(factOf(r, "f1")).toMatchObject({ status: "unverifiable", evidence: "the source can't be read (ECONNRESET)" });
    expect(factOf(r, "f2")).toMatchObject({ status: "unverifiable", evidence: "it has no source" });
    expect(factOf(r, "f3").evidence).toContain("HTTP 404");
    expect(result.reason).toBe("3 facts could not be verified");
    expect(r.requests).toHaveLength(0);
  });

  test("facts read from a registered data source already carry their evidence; the facts that were verified are left alone", async () => {
    const r = rig([], { pages });
    r.fact("d1", { sourceUrl: "data:bi", evidence: "bi: SELECT ... -> pct | 5.75" });
    r.fact("d2", { sourceUrl: "data:bi", evidence: null });
    r.fact("v1", { status: "verified", evidence: QUOTE });
    r.fact("c1", { status: "corrected", evidence: QUOTE });
    const result = await STEPS.facts.run(r.ctxFor());
    expect([factOf(r, "d1").status, factOf(r, "d2").status, factOf(r, "v1").status, factOf(r, "c1").status]).toEqual(["verified", "unverifiable", "verified", "corrected"]);
    expect(result.outputRef).toBe("1 verified, 0 corrected, 1 unverifiable");
  });

  test("brief-only leaves the list as it is; with no facts there is nothing to do", async () => {
    const r = rig([], { pages });
    r.fact("f1");
    expect(await STEPS.facts.run(r.ctxFor({ mode: "brief-only" }))).toEqual({ status: "done", outputRef: "brief only" });
    expect(factOf(r, "f1").status).toBe("unverified");
    expect(await STEPS.facts.run(rig([]).ctxFor())).toMatchObject({ outputRef: "0 verified, 0 corrected, 0 unverifiable" });
  });

  test("no web access of its own: the step fetches pages itself", async () => {
    const r = rig([verdict({ verdict: "verified", evidence: QUOTE, reason: "stated" })]);
    r.fact("f1", { sourceUrl: "https://bi.go.id/rapat" });
    const ctx = r.ctxFor();
    delete ctx.web;
    const real = globalThis.fetch;
    globalThis.fetch = (async () => new Response(`<p>${PAGE}</p>`)) as never;
    try {
      await STEPS.facts.run(ctx);
    } finally {
      globalThis.fetch = real;
    }
    expect(factOf(r, "f1").status).toBe("verified");
  });
});

describe("research", () => {
  const callTools = (...calls: Array<{ name: string; args: object }>): Msg => ({ calls });
  const answer = (facts: object[]): Msg => ({ content: json({ facts }) });

  test("the director searches, reads a page and reports facts with sources; each is then checked like the owner's", async () => {
    const searched: string[] = [];
    const r = rig([
      callTools({ name: "search_web", args: { query: "suku bunga acuan BI" } }),
      callTools({ name: "fetch_url", args: { url: "https://bi.go.id/rapat" } }),
      answer([{ claim: "Suku bunga acuan BI adalah 5,75 persen", value: "5,75%", sourceUrl: "https://bi.go.id/rapat" }, { claim: "tanpa sumber", value: "1" }, { claim: "Suku bunga acuan BI adalah 5,75 PERSEN", value: "5,75%", sourceUrl: "https://bi.go.id/rapat" }]),
      verdict({ verdict: "verified", evidence: QUOTE, reason: "stated" }),
    ], { pages, searched, settings: { mode: "research", maxSteps: 4 } });
    const result = await STEPS.facts.run(r.ctxFor());
    expect(searched).toEqual(["suku bunga acuan BI"]);
    expect(r.requests[0].tools.map((t: any) => t.function.name)).toEqual(["fetch_url", "search_web"]);
    const facts = r.store.genFactsForProject("p1");
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ addedBy: "director", status: "verified", sourceUrl: "https://bi.go.id/rapat" });
    expect(result.outputRef).toBe("1 verified, 0 corrected, 0 unverifiable");
    // the tools' answers went back to the model
    expect(JSON.parse(r.requests[1].messages.at(-1).content).results[0].url).toBe("https://bi.go.id/rapat");
  });

  test("with a data source the director can query it; its answer is the evidence and counts as verified", async () => {
    const path = join(tmp, "data.db");
    const db = new Database(path);
    db.run("CREATE TABLE rate (month TEXT, pct REAL)");
    db.run("INSERT INTO rate VALUES ('2026-01', 5.75)");
    db.close();
    const r = rig([
      callTools({ name: "query_data", args: { source: "bi", sql: "SELECT pct FROM rate" } }, { name: "query_data", args: { source: "bi", sql: "DROP TABLE rate" } }),
      answer([{ claim: "Suku bunga Januari 2026 adalah 5,75 persen", value: "5,75%", sourceUrl: "data:bi" }]),
    ], { settings: { mode: "research", sources: ["bi", "other"] }, dataSources: [{ name: "bi", kind: "sqlite", path }] });
    const result = await STEPS.facts.run(r.ctxFor());
    expect(r.requests[0].tools.map((t: any) => t.function.name)).toContain("query_data");
    expect(r.requests[0].tools.find((t: any) => t.function.name === "query_data").function.description).toContain("(bi)");
    const [fact] = r.store.genFactsForProject("p1");
    expect(fact).toMatchObject({ sourceUrl: "data:bi", status: "verified", addedBy: "director" });
    expect(fact!.evidence).toContain("SELECT pct FROM rate -> pct | 5.75");
    expect(JSON.parse(r.requests[1].messages.at(-1).content).error).toContain("Only a single SELECT");   // the unsafe query went back as an error
    expect(result.outputRef).toBe("1 verified, 0 corrected, 0 unverifiable");
  });

  test("a tool that fails goes back to the model as an error; with no web search the tool says so; research stops at maxSteps", async () => {
    const r = rig([
      callTools({ name: "fetch_url", args: { url: "https://down.id" } }),
      { content: json({ facts: [] }) },
    ], { settings: { mode: "research", maxSteps: 3 } });
    await STEPS.facts.run(r.ctxFor());
    expect(JSON.parse(r.requests[1].messages.at(-1).content).error).toContain("HTTP 404");

    const noWeb = rig([callTools({ name: "search_web", args: { query: "x" } }), { content: json({ facts: [] }) }], { settings: { mode: "research" } });
    const ctx = noWeb.ctxFor();
    delete ctx.web;
    await STEPS.facts.run(ctx);
    expect(JSON.parse(noWeb.requests[1].messages.at(-1).content).error).toBe("Web search isn't available");

    const endless = rig([callTools({ name: "search_web", args: { query: "a" } }), callTools({ name: "search_web", args: { query: "b" } }), answer([{ claim: "c", value: null, sourceUrl: "https://x" }])], { settings: { mode: "research", maxSteps: 2 } });
    await STEPS.facts.run(endless.ctxFor());
    expect(endless.requests[2].messages.at(-1).content).toContain("Stop researching");
    expect(endless.store.genFactsForProject("p1")[0]!.addedBy).toBe("director");
  });
});

// ---- the plan and the script refuse unsourced numbers ------------------------------------

describe("plans and scripts refuse numbers nothing has verified", () => {
  const factual = () => {
    const recipe = quickRecipe();
    recipe.steps.find((s) => s.use === "technical")!.with = { measures: { sourcedNumbers: true } };
    return recipe;
  };

  test("the plan step refuses to finish while a number lacks a verified fact: the director gets one repair call first", async () => {
    const unsourced = json(samplePlan({ shots: samplePlan().shots.map((s: any, i: number) => (i === 0 ? { ...s, text: [{ role: "title", value: "Bunga 5,75% per tahun" }] } : s)) }));
    const r = rig([unsourced, unsourced]);
    const recipe = factual();
    const ctx = r.ctxFor();
    ctx.recipe = recipe;
    ctx.step = { use: "plan", gate: "owner" };
    ctx.settings = settingsOf("plan", undefined);
    ctx.connected = () => false;
    ctx.catalog = async () => [];
    await expect(STEPS.plan.run(ctx)).rejects.toThrow('these numbers have no verified fact: 5,75% (in s01 title "Bunga 5,75% per tahun")');
    expect(r.store.genPlansForProject("p1")).toHaveLength(0);

    r.fact("f1", { status: "verified", claim: "Bunga acuan 5,75 persen", value: "5,75%" });
    const again = rig([json(samplePlan({ shots: samplePlan().shots.map((s: any, i: number) => (i === 0 ? { ...s, text: [{ role: "title", value: "Bunga 5,75% per tahun" }] } : s)) }))]);
    again.fact("f1", { status: "verified", claim: "Bunga acuan 5,75 persen", value: "5,75%" });
    const ok = again.ctxFor();
    ok.recipe = recipe;
    ok.step = { use: "plan", gate: "owner" };
    ok.settings = settingsOf("plan", undefined);
    ok.connected = () => false;
    ok.catalog = async () => [];
    await STEPS.plan.run(ok);
    expect(again.store.genPlansForProject("p1")).toHaveLength(1);
  });

  test("a brief with no numbers (market_data false) holds the plan to it too: a number goes back to the director, not to the verdict at the end", async () => {
    const withNumber = json(samplePlan({ shots: samplePlan().shots.map((s: any, i: number) => (i === 0 ? { ...s, text: [{ role: "title", value: "Hemat 87 ribu" }] } : s)) }));
    const r = rig([withNumber, json(samplePlan())]);
    r.store.updateGenProject("p1", { briefFlags: JSON.stringify({ forbiddenNumbers: true }) });
    const ctx = r.ctxFor();
    ctx.step = { use: "plan", gate: "owner" };
    ctx.settings = settingsOf("plan", undefined);
    ctx.connected = () => false;
    ctx.catalog = async () => [];
    await STEPS.plan.run(ctx);
    expect(JSON.stringify(r.requests[1])).toContain("87 ribu (in s01 title");
    expect(r.store.genPlansForProject("p1")).toHaveLength(1);
  });

  test("the script step refuses the same way, after a repair call; a recipe that does not ask for sourced numbers is not held to it", async () => {
    const line = json({ lines: [{ id: "l1", text: "Bunga acuan lima koma tujuh lima persen." }] });
    const r = rig([line, line]);
    r.store.updateGenProject("p1", { narration: 1 });
    const ctx = r.ctxFor();
    ctx.project = r.store.getGenProject("p1")!;
    ctx.recipe = factual();
    ctx.step = { use: "script" };
    ctx.settings = settingsOf("script", { spellNumbers: false });
    await expect(STEPS.script.run(ctx)).rejects.toThrow("these numbers have no verified fact: lima koma tujuh lima persen");   // after one repair call
    const free = rig([line]);
    free.store.updateGenProject("p1", { narration: 1 });
    const c2 = free.ctxFor();
    c2.project = free.store.getGenProject("p1")!;
    c2.step = { use: "script" };
    c2.settings = settingsOf("script", { spellNumbers: false });
    await STEPS.script.run(c2);
    expect(free.store.getGenProject("p1")!.narrationScript).toContain("lima koma");
  });
});

// ---- settings, routes and creation -------------------------------------------------------

describe("data settings and fact routes", () => {
  const put = (kind: string, body: unknown) => env!.json("PUT", `/api/settings/${kind}`, body);
  const base = "/api/generate";

  test("data sources: a validated list of read-only SQLite files, tested by opening them", async () => {
    env = makeEnv();
    expect((await env.json("POST", "/api/settings/data/test")).body.data.error).toBe("No data sources registered");
    const path = join(tmp, "x.db");
    const db = new Database(path);
    db.run("CREATE TABLE t (a)");
    db.close();
    const saved = await put("data", { sources: [{ name: "bi", kind: "sqlite", path }] });
    expect(saved.body.data.data).toMatchObject({ active: true, sources: [{ name: "bi", kind: "sqlite", path }] });
    expect(env.app.generate.connections().dataSources).toEqual(["bi"]);
    expect((await env.json("POST", "/api/settings/data/test")).body.data).toMatchObject({ ok: true, detail: "bi: 1 table" });
    writeFileSync(join(tmp, "empty.db"), "");
    await put("data", { sources: [{ name: "bi", kind: "sqlite", path }, { name: "e", kind: "sqlite", path: join(tmp, "missing.db") }] });
    expect((await env.json("POST", "/api/settings/data/test")).body.data.error).toContain("e can't be opened");
    for (const [bad, message] of [
      [[{ name: "Bad Name", kind: "sqlite", path }], "sources[0].name"],
      [[{ name: "a", kind: "sqlite", path }, { name: "a", kind: "sqlite", path }], "listed twice"],
      [[{ name: "a", kind: "csv", path }], 'only "sqlite"'],
      [[{ name: "a", kind: "sqlite", path: " " }], "sources[0].path"],
      ["nope", "list of at most 20"],
    ] as const) expect((await put("data", { sources: bad })).body.error).toContain(message);
  });

  const project = async () => {
    env = makeEnv({ llmBaseUrl: "http://llm/v1", llmModel: "m" });
    env.app.start();
    const created = await env.json("POST", `${base}/projects`, { brief: "Jelaskan suku bunga", targetSec: 30 });
    await env.app.generate.whenIdle();
    return created.body.data.project.id as string;
  };

  test("facts are listed, added with a source, edited (which makes them unchecked again) and deleted", async () => {
    const id = await project();
    expect((await env!.json("GET", `${base}/projects/${id}/facts`)).body.data.facts).toEqual([]);
    const added = await env!.json("POST", `${base}/projects/${id}/facts`, { claim: " Bunga acuan 5,75 persen ", value: "5,75%", sourceUrl: "https://bi.go.id/rapat" });
    expect(added.status).toBe(201);
    expect(added.body.data.fact).toMatchObject({ claim: "Bunga acuan 5,75 persen", value: "5,75%", status: "unverified", addedBy: "owner", projectId: id });
    const factId = added.body.data.fact.id as string;
    env!.app.store.updateGenFact(factId, { status: "corrected", originalValue: "6%", evidence: "kutipan" });

    const edited = await env!.json("PATCH", `${base}/facts/${factId}`, { value: "5,5%" });
    expect(edited.body.data.fact).toMatchObject({ value: "5,5%", status: "unverified", evidence: null, originalValue: null, claim: "Bunga acuan 5,75 persen" });
    expect((await env!.json("PATCH", `${base}/facts/${factId}`, { sourceUrl: "https://bi.go.id/lain", claim: "Bunga naik" })).body.data.fact).toMatchObject({ claim: "Bunga naik", sourceUrl: "https://bi.go.id/lain" });
    expect(env!.app.generate.facts(id)).toHaveLength(1);

    expect((await env!.json("DELETE", `${base}/facts/${factId}`)).body.data).toEqual({ deleted: true });
    expect((await env!.json("DELETE", `${base}/facts/${factId}`)).status).toBe(404);
    expect((await env!.json("PATCH", `${base}/facts/nope`, { value: "1" })).status).toBe(404);
    expect((await env!.json("GET", `${base}/projects/nope/facts`)).status).toBe(404);
  });

  test.each([
    [{ claim: " ", sourceUrl: "https://x.id" }, "claim:"],
    [{ claim: "x".repeat(401), sourceUrl: "https://x.id" }, "claim:"],
    [{ claim: "ok", sourceUrl: "bi.go.id" }, "sourceUrl:"],
    [{ claim: "ok", sourceUrl: "https://x.id", value: "v".repeat(121) }, "value is at most"],
  ])("a bad fact %j is refused", async (body, message) => {
    const id = await project();
    const r = await env!.json("POST", `${base}/projects/${id}/facts`, body);
    expect([r.status, r.body.error]).toEqual([400, expect.stringContaining(message)]);
  });

  test("verify checks the list against its sources now and answers the facts; the facts.md mirror follows", async () => {
    const id = await project();
    await env!.json("POST", `${base}/projects/${id}/facts`, { claim: "Suku bunga acuan BI adalah 5,75 persen", value: "5,75%", sourceUrl: "https://bi.go.id/rapat" });
    env!.fetchHandler.fn = async (url, init) => {
      if (String(url).startsWith("https://bi.go.id")) return new Response(`<p>${PAGE}</p>`);
      const body = JSON.parse(String(init?.body));
      const call = { id: "c", type: "function", function: { name: body.tool_choice.function.name, arguments: json({ verdict: "verified", evidence: QUOTE, reason: "stated" }) } };
      return Response.json({ choices: [{ message: { role: "assistant", content: null, tool_calls: [call] }, finish_reason: "tool_calls" }] });
    };
    const verified = await env!.json("POST", `${base}/projects/${id}/facts/verify`);
    expect(verified.body.data.facts).toMatchObject([{ status: "verified", evidence: QUOTE }]);
    expect(await (await env!.req("GET", `${base}/projects/${id}/files/facts.md`)).text()).toContain("- **Suku bunga acuan BI adalah 5,75 persen** (5,75%) — verified");
    expect(env!.app.store.genFactsForProject(id)[0]!.status).toBe("verified");
  });

  test("a project starts with the owner's facts and its brief flag; a bad fact refuses the whole request", async () => {
    env = makeEnv({ llmBaseUrl: "http://llm/v1", llmModel: "m" });
    env.app.start();
    const bad = await env.json("POST", `${base}/projects`, { brief: "Tentang bunga", targetSec: 30, facts: [{ claim: "ok", sourceUrl: "nope" }] });
    expect([bad.status, bad.body.error]).toEqual([400, expect.stringContaining("sourceUrl:")]);
    expect(env.app.store.listGenProjects()).toHaveLength(0);
    const good = await env.json("POST", `${base}/projects`, {
      brief: "Tentang bunga", targetSec: 30, forbiddenNumbers: ["5,75%"], facts: [{ claim: "Bunga 5,75 persen", value: "5,75%", sourceUrl: "https://bi.go.id/rapat" }],
    });
    const id = good.body.data.project.id as string;
    await env.app.generate.whenIdle();
    expect(good.body.data.project.briefFlags).toEqual({ forbiddenNumbers: ["5,75%"] });
    expect(env.app.generate.facts(id)).toMatchObject([{ claim: "Bunga 5,75 persen", addedBy: "owner" }]);
    const all = await env.json("POST", `${base}/projects`, { brief: "Tentang bunga", targetSec: 30, forbiddenNumbers: true });
    expect(all.body.data.project.briefFlags).toEqual({ forbiddenNumbers: true });
    await env.app.generate.whenIdle();
  });
});
