import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { Fail, harness } from "./helpers";

const ID = "11111111-2222-3333-4444-555555555555";
const BASE = "/api/generate/projects";
const IDEAS = "/api/generate/ideas";
const at = (file: string) => resolve("/home/u", file).replaceAll("\\", "/");
const idea = (id: string, over: object = {}) => ({ id, slug: `slug-${id}`, brief: `Brief ${id}\nbaris dua`, status: "new", projectId: null, flags: null, ...over });

describe("gen ideas, idea", () => {
  test("lists the ideas with their status, optionally by status", async () => {
    const h = harness({ [`GET ${IDEAS}`]: { ideas: [idea("IDEA-1"), idea("IDEA-2", { status: "built" })] } });
    expect(await h.run("gen", "ideas")).toBe(0);
    expect(h.out[0]).toMatch(/IDEA-1\s+new\s+slug-IDEA-1\s+Brief IDEA-1 baris dua/);
    expect(await h.run("gen", "ideas", "--status", "built")).toBe(0);
    expect(h.requests.at(-1)!.path).toBe(`${IDEAS}?status=built`);
    expect(await h.run("gen", "ideas", "--json")).toBe(0);
    const none = harness({ [`GET ${IDEAS}`]: { ideas: [] } });
    await none.run("gen", "ideas");
    expect(none.out[0]).toContain("No ideas yet");
  });

  test("add reads the brief from a file: the slug comes from its name, the id and facts from options", async () => {
    const h = harness({ [`POST ${IDEAS}`]: (b: any) => ({ idea: idea(b.id ?? "gen-id", b) }) });
    h.texts.set(at("Bunga Majemuk.md"), "  Jelaskan bunga majemuk.\n");
    h.existing.add(at("Bunga Majemuk.md"));
    h.texts.set(at("facts.md"), "Bunga 5,75 persen | 5,75% | https://bi.go.id/a\n");
    h.existing.add(at("facts.md"));
    expect(await h.run("gen", "idea", "add", "Bunga Majemuk.md", "--id", "IDEA-042", "--facts", "facts.md")).toBe(0);
    expect(h.requests.at(-1)!.body).toEqual({ slug: "bunga-majemuk", brief: "Jelaskan bunga majemuk.", id: "IDEA-042", facts: [{ claim: "Bunga 5,75 persen", value: "5,75%", sourceUrl: "https://bi.go.id/a" }] });
    expect(h.out.at(-1)).toContain("Added bunga-majemuk");
    expect(await h.run("gen", "idea", "add", "Bunga Majemuk.md", "--slug", "lain", "--json")).toBe(0);
    expect(h.requests.at(-1)!.body).toEqual({ slug: "lain", brief: "Jelaskan bunga majemuk." });
    expect(await h.run("gen", "idea", "add", "missing.md")).toBe(2);
    expect(h.err.at(-1)).toContain("No such file");
    expect(await h.run("gen", "idea", "dance")).toBe(2);
    const taken = harness({ [`POST ${IDEAS}`]: new Fail(409, "An idea with the slug lain exists already") });
    taken.texts.set(at("a.md"), "x");
    taken.existing.add(at("a.md"));
    expect(await taken.run("gen", "idea", "add", "a.md")).toBe(1);
  });

  test("show prints the idea, its video, flags and facts", async () => {
    const h = harness({ [`GET ${IDEAS}/IDEA-1`]: { idea: idea("IDEA-1", { status: "built", projectId: ID, flags: { language: "id" } }), facts: [{ claim: "Bunga", value: "5%", sourceUrl: "https://x.id" }, { claim: "Tanpa nilai", value: null, sourceUrl: "https://y.id" }] } });
    expect(await h.run("gen", "idea", "show", "IDEA-1")).toBe(0);
    expect(h.out).toEqual([
      "slug-IDEA-1 (IDEA-1): built · video 11111111", "Brief IDEA-1\nbaris dua", 'Flags: {"language":"id"}', "Fact: Bunga (5%) — https://x.id", "Fact: Tanpa nilai — https://y.id",
    ]);
    expect(await h.run("gen", "idea", "show", "IDEA-1", "--json")).toBe(0);
    const plain = harness({ [`GET ${IDEAS}/IDEA-2`]: { idea: idea("IDEA-2"), facts: [] } });
    await plain.run("gen", "idea", "show", "IDEA-2");
    expect(plain.out).toEqual(["slug-IDEA-2 (IDEA-2): new", "Brief IDEA-2\nbaris dua"]);
  });
});

describe("gen run", () => {
  const detail = (status: string, extra: object = {}) => ({ project: { id: ID, status, errorMessage: null, ideaId: "IDEA-1" }, versions: [], exports: [], verdictStatuses: {}, ...extra });
  const sequence = (...states: unknown[]) => { let i = 0; return () => states[Math.min(i++, states.length - 1)]; };
  const routes = (...states: unknown[]) => ({ "POST /api/generate/run": { project: { id: ID } }, [`GET ${BASE}/${ID}`]: sequence(...states) });

  test("starts the run, follows it to the exported video and says how to publish it", async () => {
    const exported = detail("EXPORTED", { exports: [{ id: "ex-1", title: "Bunga berbunga" }] });
    const h = harness(routes(detail("RUNNING"), detail("BUILDING"), detail("BUILT", { versions: [{ id: "v1", status: "BUILT" }], verdictStatuses: { v1: { TECHNICAL: "PASS" } } }), exported));
    expect(await h.run("gen", "run", "--recipe", "auto", "--idea", "IDEA-1")).toBe(0);
    expect(h.requests.find((r) => r.path === "/api/generate/run")!.body).toEqual({ recipeId: "auto", ideaId: "IDEA-1" });
    expect(h.out).toEqual(['Exported "Bunga berbunga": ex-1\nPost it with: sorot publish --generated ex-1 --to <accounts>']);
    const next = harness(routes(exported));
    expect(await next.run("gen", "run")).toBe(0);
    expect(next.requests.find((r) => r.path === "/api/generate/run")!.body).toEqual({ recipeId: "quick" });
  });

  test("--json prints the project and exits 0 only when a video was exported", async () => {
    const ok = harness(routes(detail("EXPORTED", { exports: [{ id: "ex-1", title: "t" }] })));
    expect(await ok.run("gen", "run", "--recipe", "auto", "--json")).toBe(0);
    expect(JSON.parse(ok.out[0]!).project.status).toBe("EXPORTED");
    const failed = harness(routes(detail("FAILED", { project: { id: ID, status: "FAILED", errorMessage: "x" } })));
    expect(await failed.run("gen", "run", "--recipe", "auto", "--json")).toBe(1);
  });

  test("a run that fails, waits for you or ends on a TECHNICAL FAIL exits 1 and says what to do", async () => {
    const failed = harness(routes(detail("FAILED", { project: { id: ID, status: "FAILED", errorMessage: "quota exceeded", ideaId: "IDEA-1" } })));
    expect(await failed.run("gen", "run", "--recipe", "auto")).toBe(1);
    expect(failed.err[0]).toContain("The run failed: quota exceeded. Run it again to retry: sorot gen run --recipe auto --idea IDEA-1");
    const noIdea = harness(routes(detail("FAILED", { project: { id: ID, status: "FAILED", errorMessage: "x" } })));
    await noIdea.run("gen", "run");
    expect(noIdea.err[0]).toContain("--idea <ID>");
    const waiting = harness(routes(detail("WAITING")));
    expect(await waiting.run("gen", "run", "--recipe", "quick")).toBe(1);
    expect(waiting.err[0]).toContain("waiting for you at a gate");
    const stuck = harness(routes(detail("BUILT", { versions: [{ id: "v1", status: "BUILT" }], verdictStatuses: { v1: { TECHNICAL: "FAIL" } } })));
    expect(await stuck.run("gen", "run", "--recipe", "auto")).toBe(1);
    expect(stuck.err[0]).toContain("stopped with the video BUILT");
  });

  test("it gives up following after a long wait; --no-wait returns at once; the server's refusal is an error", async () => {
    const slow = harness(routes(detail("BUILDING")));
    const real = Date.now;
    let calls = 0;
    Date.now = () => real() + (calls++ > 2 ? 3 * 60 * 60_000 : 0);
    try {
      expect(await slow.run("gen", "run", "--recipe", "auto")).toBe(1);
    } finally {
      Date.now = real;
    }
    expect(slow.err[0]).toContain("stopped with the video BUILDING");
    const quick = harness({ "POST /api/generate/run": { project: { id: ID } } });
    expect(await quick.run("gen", "run", "--no-wait")).toBe(0);
    expect(quick.out[0]).toBe(`Started ${ID}. Follow it with: sorot gen show 11111111`);
    expect(await quick.run("gen", "run", "--no-wait", "--json")).toBe(0);
    const empty = harness({ "POST /api/generate/run": new Fail(404, "The idea bank has no new idea for the recipe quick") });
    expect(await empty.run("gen", "run")).toBe(1);
    expect(empty.err[0]).toContain("no new idea");
  });
});

describe("gen files, import-history", () => {
  test("lists the files of a video, or prints one", async () => {
    const h = harness({
      [`GET ${BASE}`]: { projects: [{ id: ID }] },
      [`GET ${BASE}/${ID}/files`]: { files: ["BRIEF.md", "facts.md"] },
      [`GET ${BASE}/${ID}/files/facts.md`]: () => new Response("# Facts\n- x\n"),
    });
    expect(await h.run("gen", "files", "1111")).toBe(0);
    expect(h.out).toEqual(["BRIEF.md", "facts.md"]);
    expect(await h.run("gen", "files", "1111", "facts.md")).toBe(0);
    expect(h.out.at(-1)).toBe("# Facts\n- x");
    expect(await h.run("gen", "files", "1111", "--json")).toBe(0);
  });

  test("import-history sends the file and says what came in; a missing or broken file is a usage error", async () => {
    const h = harness({ "POST /api/generate/import-history": { concepts: 2, ideas: 1, skipped: 3 } });
    h.texts.set(at("history.json"), JSON.stringify({ concepts: [], ideas: [] }));
    h.existing.add(at("history.json"));
    expect(await h.run("gen", "import-history", "history.json")).toBe(0);
    expect(h.out.at(-1)).toBe("Imported 2 concepts and 1 idea; 3 already there.");
    expect(h.requests.at(-1)!.body).toEqual({ concepts: [], ideas: [] });
    expect(await h.run("gen", "import-history", "history.json", "--json")).toBe(0);
    expect(await h.run("gen", "import-history", "nope.json")).toBe(2);
    h.texts.set(at("bad.json"), "{ nope");
    h.existing.add(at("bad.json"));
    expect(await h.run("gen", "import-history", "bad.json")).toBe(2);
    expect(h.err.at(-1)).toContain("not valid JSON");
    const one = harness({ "POST /api/generate/import-history": { concepts: 1, ideas: 0, skipped: 0 } });
    one.texts.set(at("h.json"), "{}");
    one.existing.add(at("h.json"));
    await one.run("gen", "import-history", "h.json");
    expect(one.out[0]).toBe("Imported 1 concept and 0 ideas; 0 already there.");
  });
});
