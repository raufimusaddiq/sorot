import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { Fail, harness } from "./helpers";

/** A file under the harness's working directory, as its fake file system keys it. */
const at = (file: string) => resolve("/home/u", file).replaceAll("\\", "/");

const R = "/api/generate/recipes";
const recipe = { id: "mine", name: "Mine", version: 2, steps: [{ use: "author" }] };
const row = (over: object = {}) => ({ id: "mine", name: "Mine", version: 2, builtIn: false, available: true, reasons: [], recipe, ...over });

describe("gen steps, recipes", () => {
  test("the step library and the recipes, with whether each runs here", async () => {
    const h = harness({
      "GET /api/generate/steps": { steps: [{ type: "render", gates: ["none"], fields: { quality: {}, fps: {} } }, { type: "export", gates: ["none", "owner"], fields: {} }] },
      [`GET ${R}`]: { recipes: [row({ id: "quick", name: "Quick", builtIn: true }), row({ available: false, reasons: ["voice: no voice engine is set up in Settings"] })] },
    });
    expect(await h.run("gen", "steps")).toBe(0);
    expect(h.out[0]).toContain("render");
    expect(h.out[0]).toContain("quality, fps");
    expect(h.out[0]).toContain("none, owner");
    expect(await h.run("gen", "recipes")).toBe(0);
    expect(h.out[1]).toMatch(/quick\s+Quick\s+2\s+example\s+yes/);
    expect(h.out[1]).toMatch(/mine\s+Mine\s+2\s+yours\s+no: voice/);
    expect(await h.run("gen", "steps", "--json")).toBe(0);
    expect(await h.run("gen", "recipes", "--json")).toBe(0);
  });
});

describe("gen recipe", () => {
  test("show prints the recipe; new and copy make an editable copy", async () => {
    const h = harness({
      [`GET ${R}/mine`]: { recipe: row() },
      [`POST ${R}`]: (b: any) => ({ recipe: { id: b.id } }),
    });
    expect(await h.run("gen", "recipe", "show", "mine")).toBe(0);
    expect(JSON.parse(h.out[0]!).id).toBe("mine");
    expect(await h.run("gen", "recipe", "show", "mine", "--json")).toBe(0);
    expect(await h.run("gen", "recipe", "new", "fresh", "--name", "Fresh")).toBe(0);
    expect(h.requests.at(-1)!.body).toEqual({ fromId: "quick", id: "fresh", name: "Fresh" });
    expect(h.out.at(-1)).toContain("Created fresh from quick");
    expect(await h.run("gen", "recipe", "copy", "mine", "again", "--json")).toBe(0);
    expect(h.requests.at(-1)!.body).toEqual({ fromId: "mine", id: "again", name: "again" });
    expect(await h.run("gen", "recipe", "new", "--from", "story", "x")).toBe(0);
    expect(h.requests.at(-1)!.body.fromId).toBe("story");
  });

  test("edit opens your editor and saves what you changed; no change, a bad edit, no editor or an example are explained", async () => {
    const h = harness({ [`GET ${R}/mine`]: { recipe: row() }, [`PUT ${R}/mine`]: (b: any) => ({ recipe: { version: 3, got: b.recipe } }) });
    h.state.editor = "vim";
    h.state.onRun = () => h.texts.set("/tmp/sorot-recipe-mine.json", JSON.stringify({ ...recipe, name: "Changed" }));
    expect(await h.run("gen", "recipe", "edit", "mine")).toBe(0);
    expect(h.requests.at(-1)!.body.recipe.name).toBe("Changed");
    expect(h.out.at(-1)).toBe("Saved mine as version 3.");
    h.state.onRun = () => h.texts.set("/tmp/sorot-recipe-mine.json", JSON.stringify(recipe));
    expect(await h.run("gen", "recipe", "edit", "mine")).toBe(0);
    expect(h.out.at(-1)).toBe("No changes.");
    expect(await h.run("gen", "recipe", "edit", "mine", "--json")).toBe(0);
    h.state.onRun = () => h.texts.set("/tmp/sorot-recipe-mine.json", "{ nope");
    expect(await h.run("gen", "recipe", "edit", "mine")).toBe(2);
    expect(h.err.at(-1)).toContain("not valid JSON");
    h.state.editor = "";
    expect(await h.run("gen", "recipe", "edit", "mine")).toBe(2);
    const ex = harness({ [`GET ${R}/quick`]: { recipe: row({ builtIn: true }) } });
    ex.state.editor = "vim";
    expect(await ex.run("gen", "recipe", "edit", "quick")).toBe(2);
    expect(ex.err.at(-1)).toContain("copy it first");
  });

  test("an editor that fails saves nothing", async () => {
    const h = harness({ [`GET ${R}/mine`]: { recipe: row() } });
    h.state.editor = "vim";
    h.state.runCode = 1;
    expect(await h.run("gen", "recipe", "edit", "mine")).toBe(2);
    expect(h.err.at(-1)).toContain("exited with code 1");
  });

  test("validate checks a recipe by id or from a file: errors exit 1, warnings are listed", async () => {
    const verdict = (b: any) => (b.recipe.name === "Bad" ? { ok: false, errors: ["plan: needed"], warnings: [] } : { ok: true, errors: [], warnings: ["creative: no criteria"] });
    const h = harness({ [`GET ${R}/mine`]: { recipe: row() }, [`POST ${R}/validate`]: verdict });
    expect(await h.run("gen", "recipe", "validate", "mine")).toBe(0);
    expect(h.out).toEqual(["⚠ creative: no criteria", "The recipe is valid."]);
    h.texts.set(at("bad.json"), JSON.stringify({ ...recipe, name: "Bad" }));
    expect(await h.run("gen", "recipe", "validate", "bad.json")).toBe(1);
    expect(h.out.at(-1)).toBe("✗ plan: needed");
    h.texts.set(at("broken.json"), "{ nope");
    expect(await h.run("gen", "recipe", "validate", "broken.json")).toBe(2);
    expect(await h.run("gen", "recipe", "validate", "mine", "--json")).toBe(0);
  });

  test("export prints the recipe or saves it; import reads a file and says what it still needs", async () => {
    const h = harness({
      [`GET ${R}/mine/export`]: () => new Response(JSON.stringify(recipe)),
      [`POST ${R}/import`]: (b: any) => ({ recipe: { id: b.recipe.id } }),
    });
    expect(await h.run("gen", "recipe", "export", "mine")).toBe(0);
    expect(JSON.parse(h.out[0]!).id).toBe("mine");
    expect(await h.run("gen", "recipe", "export", "mine", "-o", "mine.json")).toBe(0);
    expect(JSON.parse(h.texts.get(at("mine.json"))!).id).toBe("mine");
    expect(await h.run("gen", "recipe", "import", "mine.json")).toBe(0);
    expect(h.requests.at(-1)!.body.recipe.id).toBe("mine");
    expect(h.out.at(-1)).toContain("Imported mine");
    expect(await h.run("gen", "recipe", "import", "mine.json", "--json")).toBe(0);
    const refused = harness({ [`POST ${R}/import`]: new Fail(409, "A recipe with the id mine exists already") });
    refused.texts.set(at("mine.json"), JSON.stringify(recipe));
    expect(await refused.run("gen", "recipe", "import", "mine.json")).toBe(1);
  });

  test("delete, an unknown subcommand, and passing a step that waits for you", async () => {
    const h = harness({
      [`DELETE ${R}/mine`]: { deleted: true },
      "GET /api/generate/projects": { projects: [{ id: "11111111-2222-3333-4444-555555555555" }] },
      "POST /api/generate/projects/11111111-2222-3333-4444-555555555555/steps/script/approve": { project: { status: "RUNNING" } },
    });
    expect(await h.run("gen", "recipe", "delete", "mine")).toBe(0);
    expect(h.out.at(-1)).toContain("Deleted mine");
    expect(await h.run("gen", "recipe", "delete", "mine", "--json")).toBe(0);
    expect(await h.run("gen", "recipe", "dance")).toBe(2);
    expect(await h.run("gen", "approve-step", "1111", "script")).toBe(0);
    expect(h.out.at(-1)).toBe("Passed script. The project is RUNNING.");
    expect(await h.run("gen", "approve-step", "1111", "script", "--json")).toBe(0);
  });
});
