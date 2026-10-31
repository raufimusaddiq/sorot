import { describe, expect, test } from "bun:test";
import { Fail, harness, type Handler } from "./helpers";

const ID = "11111111-2222-3333-4444-555555555555";
const story = (i: number, extra: object = {}) => ({
  title: `Film ${i}`, pitch: `Pitch ${i}`, opening: `Opening ${i}`, beats: ["hook", "isi", "akhir"], recommended: i === 1, bold: false, ...extra,
});
const plan = (title = "Bunga berbunga") => ({
  title, message: "Uang tumbuh sendiri", totalSec: 30, assumptions: ["Angka 5 ditambah"],
  shots: [1, 2, 3].map((n) => ({ id: `s0${n}`, durationSec: 10, purpose: n === 1 ? "hook" : "beat", text: [{ role: "title", value: `Judul ${n}` }], visual: { description: `Visual ${n}` } })),
});
const row = (revision: number, over: object = {}) => ({ id: `plan-${revision}`, revision, plan: plan(), approvedAt: null, changeSummary: null, ...over });
const project = (over: object = {}) => ({
  id: ID, title: null, brief: "Jelaskan bunga majemuk", status: "WAITING", format: "9:16", targetSec: 30, language: "id", recipeId: "quick",
  storylines: [story(1), story(2), story(3)], pickedStoryline: null, stepState: null, errorMessage: null, createdAt: "2026-10-31T10:00:00.000Z", ...over,
});
const detail = (over: object = {}, plans: object[] = [], assets: object[] = []) => ({ project: project(over), plans, versions: [], assets, exports: [] });
const BASE = "/api/generate/projects";

/** GET /projects/:id answers each of `states` in turn (the last repeats). */
const sequence = (...states: unknown[]): Handler => { let i = 0; return () => states[Math.min(i++, states.length - 1)]; };

describe("gen new", () => {
  test("creates the project from flags, follows the director and prints the storylines", async () => {
    const h = harness({
      [`POST ${BASE}`]: { project: project({ status: "RUNNING" }) },
      [`GET ${BASE}/${ID}`]: sequence(detail({ status: "RUNNING", storylines: null }), detail()),
    });
    expect(await h.run("gen", "new", "Jelaskan bunga majemuk", "--recipe", "quick", "--format", "16:9", "--length", "45", "--lang", "en",
      "--style", "tenang", "--preset", "story", "--narration", "--no-stop")).toBe(0);
    expect(h.requests[0]).toMatchObject({ method: "POST", path: BASE, body: {
      brief: "Jelaskan bunga majemuk", recipeId: "quick", format: "16:9", targetSec: 45, language: "en", styleNotes: "tenang", preset: "story",
      narration: true, buildWithoutStopping: true,
    } });
    expect(h.requests.filter((r) => r.method === "GET")).toHaveLength(2);
    expect(h.text()).toContain("1) Film 1 (recommended)");
    expect(h.text()).toContain("First 2 s: Opening 2");
    expect(h.text()).toContain("sorot gen pick 11111111 <1-3>");
  });

  test("with only a brief it sends only the brief; --no-wait returns at once; --json prints the data", async () => {
    const h = harness({ [`POST ${BASE}`]: { project: project() }, [`GET ${BASE}/${ID}`]: detail() });
    expect(await h.run("gen", "new", "Brief saja", "--no-wait")).toBe(0);
    expect(h.requests[0]!.body).toEqual({ brief: "Brief saja" });
    expect(h.requests).toHaveLength(1);
    expect(h.text()).toContain(`Started ${ID}`);
    const j = harness({ [`POST ${BASE}`]: { project: project() }, [`GET ${BASE}/${ID}`]: detail() });
    expect(await j.run("gen", "new", "x", "--json")).toBe(0);
    expect(JSON.parse(j.out[0]!).project.id).toBe(ID);
    const nw = harness({ [`POST ${BASE}`]: { project: project() } });
    expect(await nw.run("gen", "new", "x", "--no-wait", "--json")).toBe(0);
    expect(JSON.parse(nw.out[0]!).id).toBe(ID);
    expect(await harness().run("gen", "new")).toBe(2);
  });

  test("a failure says what went wrong, that the work is kept, and how to retry; the exit code is 1", async () => {
    const h = harness({
      [`POST ${BASE}`]: { project: project() },
      [`GET ${BASE}/${ID}`]: detail({ status: "FAILED", errorMessage: "quota exceeded" }),
    });
    expect(await h.run("gen", "new", "x")).toBe(1);
    expect(h.err[0]).toContain("Failed: quota exceeded");
    expect(h.err[0]).toContain("sorot gen retry 11111111");
    const j = harness({ [`POST ${BASE}`]: { project: project() }, [`GET ${BASE}/${ID}`]: detail({ status: "FAILED" }) });
    expect(await j.run("gen", "new", "x", "--json")).toBe(1);
  });

  test("a project that is still building, or has nothing to show, is reported plainly", async () => {
    const still = harness({ [`POST ${BASE}`]: { project: project() }, [`GET ${BASE}/${ID}`]: detail({ status: "BUILDING" }) });
    const originalNow = Date.now;
    let calls = 0;
    Date.now = () => originalNow() + (calls++ > 0 ? 31 * 60_000 : 0);   // the wait gives up after 30 minutes
    try {
      expect(await still.run("gen", "new", "x")).toBe(0);
    } finally {
      Date.now = originalNow;
    }
    expect(still.text()).toContain("Still working (BUILDING)");
    const bare = harness({ [`POST ${BASE}`]: { project: project() }, [`GET ${BASE}/${ID}`]: detail({ storylines: null }) });
    expect(await bare.run("gen", "new", "x")).toBe(0);
    expect(bare.text()).toContain("11111111: WAITING");
  });

  test("a plan that already exists is printed as a shot table", async () => {
    const h = harness({ [`POST ${BASE}`]: { project: project() }, [`GET ${BASE}/${ID}`]: detail({}, [row(1)]) });
    expect(await h.run("gen", "new", "short", "--length", "12")).toBe(0);
    expect(h.out[0]).toBe("Bunga berbunga — revision 1, not approved yet");
    expect(h.text()).toMatch(/SHOT\s+SEC\s+PURPOSE\s+TITLE\s+VISUAL/);
    expect(h.text()).toContain("Judul 2");
    expect(h.text()).toContain("Total 30 s of 30 s");
    expect(h.text()).toContain("Assumed: Angka 5 ditambah");
  });
});

describe("gen list, show and project references", () => {
  const list = { projects: [project(), project({ id: "99999999-0000-0000-0000-000000000000", title: "Lain", status: "BUILT" })] };

  test("list is a table; show prints each recipe step with its state, the files and the next move", async () => {
    const h = harness({
      [`GET ${BASE}`]: list,
      [`GET ${BASE}/${ID}`]: detail({
        recipe: { steps: [{ use: "storylines" }, { use: "plan", id: "plan-1" }, { use: "author" }] },
        stepState: { storylines: { status: "waiting", reason: "waiting for the owner" }, "plan-1": { status: "done" } },
        errorMessage: "late warning",
      }, [], [{ kind: "logo", path: "assets/12345678-logo.png" }]),
    });
    expect(await h.run("gen", "list")).toBe(0);
    expect(h.out[0]!.split(/\n/)[0]).toMatch(/^ID\s+STATUS\s+FORMAT\s+SEC\s+CREATED\s+TITLE$/);
    expect(h.text()).toContain("11111111");
    expect(h.text()).toContain("Lain");
    h.out.length = 0;
    expect(await h.run("gen", "show", "1111")).toBe(0);
    expect(h.text()).toContain("[WAITING]  9:16 · 30 s · id · recipe quick");
    expect(h.text()).toContain("waiting  storylines — waiting for the owner");
    expect(h.text()).toContain("done     plan-1");
    expect(h.text()).toContain("pending  author");
    expect(h.text()).toContain("Error: late warning");
    expect(h.text()).toContain("Files: logo 12345678-logo.png");
    expect(h.text()).toContain("sorot gen pick 11111111");
    const j = await harness({ [`GET ${BASE}`]: list }).run("gen", "list", "--json");
    expect(j).toBe(0);
  });

  test("a reference must match exactly one project", async () => {
    const dup = { projects: [project(), project({ id: "11111111-aaaa-bbbb-cccc-dddddddddddd" })] };
    const many = harness({ [`GET ${BASE}`]: dup });
    expect(await many.run("gen", "show", "1111")).toBe(2);
    expect(many.err[0]).toContain("More than one project starts with 1111");
    const none = harness({ [`GET ${BASE}`]: list });
    expect(await none.run("gen", "show", "zzzz")).toBe(2);
    expect(none.err[0]).toContain("No project starts with zzzz");
    const full = harness({ [`GET ${BASE}/${ID}`]: detail() });
    expect(await full.run("gen", "show", ID, "--json")).toBe(0);
    expect(full.requests).toHaveLength(1);
  });

  test("an API error is shown and the exit code is 1", async () => {
    const h = harness({ [`GET ${BASE}/${ID}`]: new Fail(404, "Project not found") });
    expect(await h.run("gen", "show", ID)).toBe(1);
    expect(h.err[0]).toBe("Project not found");
  });
});

describe("gen storylines, pick, retry", () => {
  const routes = (): Record<string, unknown> => ({
    [`GET ${BASE}`]: { projects: [project()] },
    [`POST ${BASE}/${ID}/storylines`]: { project: project() },
    [`POST ${BASE}/${ID}/storylines/1/pick`]: { project: project() },
    [`POST ${BASE}/${ID}/retry`]: { project: project() },
  });

  test("new storylines with a note; pick numbers start at 1 and send the note; retry runs again", async () => {
    const h = harness({ ...routes(), [`GET ${BASE}/${ID}`]: detail() });
    expect(await h.run("gen", "storylines", "1111", "--note", "lebih berani")).toBe(0);
    expect(h.requests.find((r) => r.path.endsWith("/storylines"))!.body).toEqual({ note: "lebih berani" });
    expect(h.text()).toContain("1) Film 1");

    const p = harness({ ...routes(), [`GET ${BASE}/${ID}`]: sequence(detail({ status: "RUNNING" }), detail({ pickedStoryline: 1 }, [row(1)])) });
    expect(await p.run("gen", "pick", "1111", "2", "--note", "lebih tenang")).toBe(0);
    expect(p.requests.find((r) => r.path.endsWith("/pick"))!.body).toEqual({ note: "lebih tenang" });
    expect(p.text()).toContain("Bunga berbunga — revision 1");

    const r = harness({ ...routes(), [`GET ${BASE}/${ID}`]: detail({ status: "FAILED", errorMessage: "again" }) });
    expect(await r.run("gen", "retry", "1111")).toBe(1);
    expect(r.requests.some((x) => x.path.endsWith("/retry"))).toBe(true);
  });

  test("a bad storyline number is a usage error", async () => {
    const h = harness(routes());
    expect(await h.run("gen", "pick", "1111", "0")).toBe(2);
    expect(await h.run("gen", "pick", "1111", "x")).toBe(2);
    expect(await h.run("gen", "pick", "1111")).toBe(2);
    expect(h.err[0]).toContain("starts at 1");
  });
});

describe("gen plan, revise, approve", () => {
  const withPlan = (plans: object[] = [row(1)], extra: Record<string, unknown> = {}) => harness({
    [`GET ${BASE}`]: { projects: [project()] }, [`GET ${BASE}/${ID}`]: detail({ pickedStoryline: 0 }, plans), ...extra,
  });

  test("plan prints the shot table, or the raw row with --json; no plan is a usage error", async () => {
    const h = withPlan();
    expect(await h.run("gen", "plan", "1111")).toBe(0);
    expect(h.text()).toContain("Edit: sorot gen plan 11111111 --edit");
    const j = withPlan();
    expect(await j.run("gen", "plan", "1111", "--json")).toBe(0);
    expect(JSON.parse(j.out[0]!).revision).toBe(1);
    const none = withPlan([]);
    expect(await none.run("gen", "plan", "1111")).toBe(2);
    expect(none.err[0]).toContain("no plan yet");
  });

  test("an approved plan has no edit hint", async () => {
    const h = withPlan([row(2, { approvedAt: "2026-10-31" })]);
    await h.run("gen", "plan", "1111");
    expect(h.out[0]).toContain("revision 2, approved");
    expect(h.text()).not.toContain("--edit");
  });

  test("--edit opens $EDITOR on the JSON and saves a changed plan as a new revision", async () => {
    const h = withPlan([row(1)], { [`PUT ${BASE}/${ID}/plan`]: { plan: { revision: 2 } } });
    h.state.editor = "nano";
    h.state.onRun = (cmd) => {
      const text = h.texts.get(cmd[1]!)!;
      h.texts.set(cmd[1]!, text.replace("Bunga berbunga", "Judul editan"));
    };
    expect(await h.run("gen", "plan", "1111", "--edit")).toBe(0);
    expect(h.runs[0]!.cmd[0]).toBe("nano");
    expect(h.runs[0]!.cmd[1]).toBe("/tmp/sorot-plan-11111111.json");
    expect(h.requests.find((r) => r.method === "PUT")!.body.plan.title).toBe("Judul editan");
    expect(h.text()).toContain("Saved as revision 2");
    const quiet = withPlan([row(1)], { [`PUT ${BASE}/${ID}/plan`]: { plan: { revision: 2 } } });
    quiet.state.editor = "nano";
    quiet.state.onRun = () => { throw new Error("unused"); };
    quiet.state.onRun = undefined;
    quiet.texts.set("/tmp/sorot-plan-11111111.json", "");
    quiet.state.onRun = (cmd) => quiet.texts.set(cmd[1]!, JSON.stringify(plan()));
    expect(await quiet.run("gen", "plan", "1111", "--edit")).toBe(0);
    expect(quiet.text()).toBe("No changes.");
    const asJson = withPlan([row(1)], { [`PUT ${BASE}/${ID}/plan`]: { plan: { revision: 2 } } });
    asJson.state.editor = "vi";
    asJson.state.onRun = (cmd) => asJson.texts.set(cmd[1]!, JSON.stringify({ ...plan(), title: "Lain" }));
    expect(await asJson.run("gen", "plan", "1111", "--edit", "--json")).toBe(0);
    expect(JSON.parse(asJson.out[0]!)).toEqual({ plan: { revision: 2 } });
  });

  test.each([
    ["no editor is set", { editor: "" }, [row(1)], "Set $EDITOR"],
    ["the plan is approved", { editor: "nano" }, [row(1, { approvedAt: "2026-10-31" })], "approved and locked"],
    ["the editor fails", { editor: "nano", runCode: 3 }, [row(1)], "exited with code 3"],
  ])("--edit refuses when %s", async (_name, state, plans, message) => {
    const h = withPlan(plans);
    Object.assign(h.state, state);
    expect(await h.run("gen", "plan", "1111", "--edit")).toBe(2);
    expect(h.err[0]).toContain(message);
    expect(h.requests.some((r) => r.method === "PUT")).toBe(false);
  });

  test("--edit with text that is not JSON saves nothing", async () => {
    const h = withPlan();
    h.state.editor = "nano";
    h.state.onRun = (cmd) => h.texts.set(cmd[1]!, "{ not json");
    expect(await h.run("gen", "plan", "1111", "--edit")).toBe(2);
    expect(h.err[0]).toContain("not valid JSON");
  });

  test("revise sends the request and prints the summary and the new plan", async () => {
    const h = withPlan([row(2, { changeSummary: "Judul diganti" })], {
      [`POST ${BASE}/${ID}/plan/revise`]: { plan: row(2), changeSummary: "Judul diganti" },
    });
    expect(await h.run("gen", "revise", "1111", "ubah judul shot 2")).toBe(0);
    expect(h.requests.find((r) => r.path.endsWith("/revise"))!.body).toEqual({ request: "ubah judul shot 2" });
    expect(h.out[0]).toBe("Revision 2: Judul diganti");
    expect(h.text()).toContain("Bunga berbunga — revision 2");
    const bare = withPlan([row(2)], { [`POST ${BASE}/${ID}/plan/revise`]: { plan: row(2), changeSummary: "" } });
    await bare.run("gen", "revise", "1111", "x");
    expect(bare.out[0]).toBe("Revision 2: (no summary)");
    const j = withPlan([row(2)], { [`POST ${BASE}/${ID}/plan/revise`]: { plan: row(2), changeSummary: "s" } });
    expect(await j.run("gen", "revise", "1111", "x", "--json")).toBe(0);
    expect(await harness().run("gen", "revise", "1111")).toBe(2);
  });

  test("approve sends the current revision's id", async () => {
    const h = withPlan([row(3), row(2), row(1)], { [`POST ${BASE}/${ID}/plan/approve`]: { project: project() } });
    expect(await h.run("gen", "approve", "1111")).toBe(0);
    expect(h.requests.find((r) => r.path.endsWith("/approve"))!.body).toEqual({ planId: "plan-3" });
    expect(h.text()).toContain("Approved revision 3");
    const j = withPlan([row(1)], { [`POST ${BASE}/${ID}/plan/approve`]: { project: project() } });
    expect(await j.run("gen", "approve", "1111", "--json")).toBe(0);
    const none = withPlan([]);
    expect(await none.run("gen", "approve", "1111")).toBe(2);
    const stale = withPlan([row(1)], { [`POST ${BASE}/${ID}/plan/approve`]: new Fail(409, "That isn't the current plan") });
    expect(await stale.run("gen", "approve", "1111")).toBe(1);
  });
});

describe("gen asset", () => {
  const setup = () => {
    const h = harness({ [`GET ${BASE}`]: { projects: [project()] }, [`POST ${BASE}/${ID}/assets`]: (b: any) => ({ asset: { kind: b.kind, shotId: b.shotId ?? null } }) });
    h.existing.add("/home/u/logo.png");
    h.bytesOf.set("/home/u/logo.png", new Uint8Array([1, 2, 3]));
    h.existing.add("/abs/lagu.mp3");
    h.bytesOf.set("/abs/lagu.mp3", new Uint8Array([9]));
    return h;
  };

  test("uploads the file with its kind from the extension, or from --kind and --shot", async () => {
    const h = setup();
    expect(await h.run("gen", "asset", "1111", "logo.png")).toBe(0);
    expect(h.requests.at(-1)!.body).toEqual({ file: "logo.png", size: 3, kind: "image", shotId: undefined });
    expect(h.text()).toContain("Uploaded logo.png as image.");
    expect(await h.run("gen", "asset", "1111", "logo.png", "--kind", "logo", "--shot", "s02")).toBe(0);
    expect(h.requests.at(-1)!.body).toMatchObject({ kind: "logo", shotId: "s02" });
    expect(h.out.at(-1)).toBe("Uploaded logo.png as logo for s02.");
    expect(await h.run("gen", "asset", "1111", "/abs/lagu.mp3", "--json")).toBe(0);
    expect(h.requests.at(-1)!.body).toMatchObject({ file: "lagu.mp3", kind: "music" });
  });

  test("a missing file, a type it can not place, and a server refusal", async () => {
    const h = setup();
    expect(await h.run("gen", "asset", "1111", "nope.png")).toBe(2);
    expect(h.err[0]).toContain("File not found: nope.png");
    h.existing.add("/home/u/data.bin");
    expect(await h.run("gen", "asset", "1111", "data.bin")).toBe(2);
    expect(h.err.at(-1)).toContain("--kind logo|image|font|music");
    const refused = harness({ [`GET ${BASE}`]: { projects: [project()] }, [`POST ${BASE}/${ID}/assets`]: new Fail(400, "A logo must be .png") });
    refused.existing.add("/home/u/logo.png");
    refused.bytesOf.set("/home/u/logo.png", new Uint8Array([1]));
    expect(await refused.run("gen", "asset", "1111", "logo.png")).toBe(1);
    expect(refused.err[0]).toContain("A logo must be .png");
  });
});
