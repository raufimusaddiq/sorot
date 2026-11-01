import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/db";
import { Director } from "../../src/generate/director";
import { DirectorLog } from "../../src/generate/events";
import { mirrorProject, readMirror } from "../../src/generate/mirror";
import { earlierConcepts, normalise, overlap, repeatOf, SAME_WORDS } from "../../src/generate/novelty";
import type { RecipeStep } from "../../src/generate/recipe";
import { STEPS, settingsOf } from "../../src/generate/steps";
import { Store } from "../../src/store";
import type { GenProject } from "../../src/types";
import { fakeLlm, quickRecipe, samplePlan } from "../helpers";

const T = "2026-01-01T00:00:00.000Z";
const json = JSON.stringify;
let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "vc-concept-")); });
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const concept = (mechanism: string, text = "Benih tumbuh jadi pohon di layar.", boltOn = false) => json({ mechanism, concept: text, boltOn });
const SAME = json({ same: true, as: "bunga yang mekar" });
const DIFFERENT = json({ same: false });

function rig(replies: Parameters<typeof fakeLlm>[0], over: Partial<GenProject> = {}) {
  const store = new Store(openDatabase(":memory:"));
  const { llm, requests } = fakeLlm(replies);
  const recipe = quickRecipe();
  const project = (id: string, extra: Partial<GenProject>): GenProject => ({
    id, title: null, brief: "Jelaskan bunga majemuk", format: "9:16", targetSec: 30, language: "id", styleNotes: null, preset: null, recipeId: "quick",
    recipe: json(recipe), ideaId: null, briefFlags: null, narrationScript: null, concept: null, stepIndex: 0, stepState: null, narration: 0, storylines: null,
    pickedStoryline: null, status: "RUNNING", currentPlanId: null, acceptedVersionId: null, errorMessage: null, createdAt: T, updatedAt: T, ...extra,
  } as GenProject);
  store.saveGenProject(project("p1", { createdAt: "2026-03-01T00:00:00.000Z", ...over }));
  const earlier = (id: string, c: string, recipeId = "quick", createdAt = T) => store.saveGenProject(project(id, { concept: c, recipeId, createdAt }));
  const ctxFor = (withSettings: Record<string, unknown> = {}) => {
    const step = { use: "concept", with: withSettings } as RecipeStep;
    return {
      project: store.getGenProject("p1")!, version: null, recipe, step, settings: settingsOf("concept", step.with), store, log: new DirectorLog(store),
      director: new Director(llm, new DirectorLog(store), "../generator"), progress: () => {},
    } as never;
  };
  return { store, requests, ctxFor, earlier };
}
const body = (req: { messages: Array<{ content: string }> }) => JSON.parse(req.messages[1]!.content);
const stored = (store: Store) => JSON.parse(store.getGenProject("p1")!.concept!);

describe("novelty", () => {
  test("text is compared by its words; the same idea in other words is caught, a different one is not", () => {
    expect(normalise("  Benih, tumbuh!  jadi POHON. ")).toBe("benih tumbuh jadi pohon");
    expect(overlap("benih tumbuh jadi pohon", "benih tumbuh jadi pohon besar")).toBeCloseTo(0.8);
    expect(overlap("", "apa saja")).toBe(0);
    expect(SAME_WORDS).toBe(0.7);
    const earlier = ["Benih tumbuh jadi pohon di layar", "Roda gigi saling memutar uang"];
    expect(repeatOf("benih tumbuh jadi pohon di layar!", earlier)).toBe(earlier[0]);
    expect(repeatOf("Benih tumbuh jadi pohon besar di layar", earlier)).toBe(earlier[0]);
    expect(repeatOf("Peta yang terbuka perlahan", earlier)).toBeNull();
  });

  test("the earlier concepts are those of the same recipe's other videos, newest first, at most lastN", () => {
    const r = rig([]);
    r.earlier("old", json({ mechanism: "tua", concept: "paling lama" }), "quick", "2026-01-01T00:00:00.000Z");
    r.earlier("new", json({ mechanism: "baru", concept: "terbaru" }), "quick", "2026-02-01T00:00:00.000Z");
    r.earlier("other", json({ mechanism: "lain", concept: "resep lain" }), "story", "2026-02-15T00:00:00.000Z");
    const project = r.store.getGenProject("p1")!;
    expect(earlierConcepts(r.store, project, 30)).toEqual(["baru\nterbaru", "tua\npaling lama"]);
    expect(earlierConcepts(r.store, project, 1)).toEqual(["baru\nterbaru"]);
  });
});

describe("concept step", () => {
  test("records the mechanism and the idea on the project; with nothing earlier there is nothing to compare with", async () => {
    const r = rig([concept("Benih jadi pohon")]);
    expect(await STEPS.concept.run(r.ctxFor())).toEqual({ status: "done", outputRef: "concept" });
    expect(stored(r.store)).toEqual({ mechanism: "Benih jadi pohon", concept: "Benih tumbuh jadi pohon di layar." });
    expect(r.requests).toHaveLength(1);
    expect(body(r.requests[0]!)).toMatchObject({ earlierConcepts: [], language: "id" });
    expect(r.requests[0]!.tool_choice.function.name).toBe("submit_concept");
  });

  test("it is shown the earlier concepts to differ from, and the director's 'same idea?' check passes a new one", async () => {
    const r = rig([concept("Roda gigi"), DIFFERENT]);
    r.earlier("e1", json({ mechanism: "Benih jadi pohon", concept: "Pohon tumbuh" }));
    await STEPS.concept.run(r.ctxFor({ novelty: { lastN: 5 } }));
    expect(body(r.requests[0]!).earlierConcepts).toEqual(["Benih jadi pohon\nPohon tumbuh"]);
    expect(r.requests[1]!.tool_choice.function.name).toBe("submit_sameidea");
    expect(body(r.requests[1]!)).toMatchObject({ earlier: ["Benih jadi pohon\nPohon tumbuh"] });
    expect(stored(r.store).mechanism).toBe("Roda gigi");
  });

  test("a repeat is asked about once more, naming what it repeats; a second repeat stops the run", async () => {
    const earlier = json({ mechanism: "Benih jadi pohon", concept: "Benih tumbuh jadi pohon di layar." });
    const once = rig([concept("Benih jadi pohon"), concept("Peta terbuka", "Peta dibuka lapis demi lapis."), DIFFERENT]);
    once.earlier("e1", earlier);
    await STEPS.concept.run(once.ctxFor());
    expect(body(once.requests[1]!).note).toContain("repeats this earlier one");
    expect(stored(once.store).mechanism).toBe("Peta terbuka");

    const twice = rig([concept("Benih jadi pohon"), concept("Benih jadi pohon"), ]);
    twice.earlier("e1", earlier);
    await expect(STEPS.concept.run(twice.ctxFor())).rejects.toThrow("repeats an earlier video's idea");
    expect(twice.store.getGenProject("p1")!.concept).toBeNull();

    const byDirector = rig([concept("Peta terbuka", "Sesuatu yang baru"), SAME, concept("Lensa", "Kaca pembesar"), SAME]);
    byDirector.earlier("e1", json({ mechanism: "bunga mekar", concept: "kelopak" }));
    await expect(STEPS.concept.run(byDirector.ctxFor())).rejects.toThrow("bunga yang mekar");
  });

  test("a same-idea answer that names nothing falls back to the first earlier concept", async () => {
    const r = rig([concept("Peta terbuka", "Sesuatu yang baru"), json({ same: true }), concept("Lensa", "Kaca pembesar"), DIFFERENT]);
    r.earlier("e1", json({ mechanism: "bunga mekar", concept: "kelopak" }));
    await STEPS.concept.run(r.ctxFor());
    expect(body(r.requests[2]!).note).toContain("bunga mekar");
  });

  test("with the mechanism test a bolt-on is refused and tried again; without it the answer stands", async () => {
    const r = rig([concept("Judul besar", "Judul di atas gradien", true), concept("Benih", "Benih tumbuh", false)]);
    await STEPS.concept.run(r.ctxFor({ mechanismTest: true }));
    expect(JSON.parse(r.requests[1]!.messages.at(-1)!.content).problems[0]).toContain("bolt-on");
    expect(stored(r.store).mechanism).toBe("Benih");
    const lax = rig([concept("Judul besar", "Judul di atas gradien", true)]);
    await STEPS.concept.run(lax.ctxFor());
    expect(stored(lax.store).mechanism).toBe("Judul besar");
    const empty = rig([json({ mechanism: "", concept: "", boltOn: false }), json({ mechanism: "", concept: "", boltOn: false })]);
    await expect(STEPS.concept.run(empty.ctxFor())).rejects.toThrow("both the mechanism and the concept");
  });

  test("a bad same-idea answer is asked again; CONCEPT.txt mirrors the idea and the plan is told about it", async () => {
    const r = rig([concept("Peta terbuka", "Sesuatu yang baru"), json({ same: "maybe" }), DIFFERENT]);
    r.earlier("e1", json({ mechanism: "bunga mekar", concept: "kelopak" }));
    await STEPS.concept.run(r.ctxFor());
    expect(r.requests).toHaveLength(3);
    expect(mirrorProject({ genDir: tmp }, r.store, "p1")).toContain("CONCEPT.txt");
    expect(readMirror({ genDir: tmp }, "p1", "CONCEPT.txt")).toBe("Peta terbuka\n\nSesuatu yang baru\n");

    const planned = rig([json(samplePlan())], { concept: json({ mechanism: "Peta terbuka", concept: "Sesuatu yang baru" }) });
    const ctx = planned.ctxFor() as any;
    ctx.step = { use: "plan", gate: "owner" };
    ctx.settings = settingsOf("plan", undefined);
    ctx.connected = () => false;
    ctx.catalog = async () => [];
    ctx.config = {};
    await STEPS.plan.run(ctx);
    expect(body(planned.requests[0]!).concept).toEqual({ mechanism: "Peta terbuka", concept: "Sesuatu yang baru" });
  });
});
