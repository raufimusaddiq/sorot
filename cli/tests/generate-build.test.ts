import { describe, expect, test } from "bun:test";
import { Fail, harness, type Handler } from "./helpers";

const ID = "11111111-2222-3333-4444-555555555555";
const VID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const BASE = "/api/generate/projects";
const VERSIONS = "/api/generate/versions";
const version = (over: object = {}) => ({ id: VID, number: 1, status: "BUILT", step: null, progress: 100, buildMs: 61_000, errorMessage: null, ...over });
const finding = (over: object = {}) => ({ id: "f", severity: "must-fix", shotId: null, code: "x", description: "Something is wrong.", state: "open", ...over });
const verdict = (kind: string, status: string, findings: object[] = [], judgedBy = "code") => ({ kind, status, findings, judgedBy });
const GOOD = [verdict("TECHNICAL", "PASS"), verdict("CREATIVE", "REVIEW", [finding({ severity: "polish", code: "creative.pace", description: "Pace drags." })], "llm:m")];
const project = { id: ID, status: "BUILT" };
const sequence = (...states: unknown[]): Handler => { let i = 0; return () => states[Math.min(i++, states.length - 1)]; };
const routes = (extra: Record<string, unknown> = {}) => ({
  [`GET ${BASE}`]: { projects: [project] },
  [`POST ${BASE}/${ID}/versions`]: { version: version({ status: "QUEUED", progress: 0 }) },
  ...extra,
});

describe("gen build", () => {
  test("follows the build step by step, then prints both verdicts and how to accept", async () => {
    const h = harness(routes({
      [`GET ${VERSIONS}/${VID}`]: sequence(
        { version: version({ status: "QUEUED", progress: 0 }), verdicts: [] },
        { version: version({ status: "BUILDING", step: "author", progress: 20 }), verdicts: [] },
        { version: version({ status: "BUILDING", step: "author", progress: 20 }), verdicts: [] },
        { version: version({ status: "BUILDING", step: "render", progress: 60 }), verdicts: [] },
        { version: version(), verdicts: GOOD },
      ),
    }));
    expect(await h.run("gen", "build", "1111")).toBe(0);
    expect(h.out).toEqual([
      "Waiting in the queue…", "Writing the scenes… 20%", "Rendering the video… 60%",
      `Built version 1 (${VID}) in 61 s.`,
      "TECHNICAL: PASS  (judged by code)", "  nothing to fix",
      "CREATIVE: REVIEW  (judged by llm:m)", "  polish     creative.pace  Pace drags.",
      "Accept it with: sorot gen accept 11111111  ·  fix what is left: sorot gen fix 11111111",
    ]);
  });

  test("--no-watch returns at once with the version id; --json prints the data", async () => {
    const h = harness(routes());
    expect(await h.run("gen", "build", "1111", "--no-watch")).toBe(0);
    expect(h.text()).toContain(`Queued version 1: ${VID}`);
    expect(h.requests.filter((r) => r.path.startsWith(VERSIONS))).toHaveLength(0);
    const j = harness(routes());
    expect(await j.run("gen", "build", "1111", "--no-watch", "--json")).toBe(0);
    expect(JSON.parse(j.out[0]!).id).toBe(VID);
    const w = harness(routes({ [`GET ${VERSIONS}/${VID}`]: { version: version(), verdicts: GOOD } }));
    expect(await w.run("gen", "build", "1111", "--json")).toBe(0);
    expect(JSON.parse(w.out[0]!).verdicts).toHaveLength(2);
  });

  test.each([
    ["FAILED", { status: "FAILED", errorMessage: "quota exceeded" }, "The build failed: quota exceeded. The scenes already written are kept"],
    ["CANCELLED", { status: "CANCELLED" }, "The build was cancelled."],
  ])("a %s build exits 1 and says what happened", async (_name, over, message) => {
    const h = harness(routes({ [`GET ${VERSIONS}/${VID}`]: { version: version(over), verdicts: [] } }));
    expect(await h.run("gen", "build", "1111")).toBe(1);
    expect(h.err[0]).toContain(message);
    const j = harness(routes({ [`GET ${VERSIONS}/${VID}`]: { version: version(over), verdicts: [] } }));
    expect(await j.run("gen", "build", "1111", "--json")).toBe(1);
  });

  test("a build the server refuses (no approved plan) is an error with its reason; a step of unknown name is just 'Building'", async () => {
    const refused = harness(routes({ [`POST ${BASE}/${ID}/versions`]: new Fail(409, "Approve the plan first: nothing is built from an unapproved plan") }));
    expect(await refused.run("gen", "build", "1111")).toBe(1);
    expect(refused.err[0]).toContain("Approve the plan first");
    const odd = harness(routes({ [`GET ${VERSIONS}/${VID}`]: sequence(
      { version: version({ status: "BUILDING", step: "mystery", progress: null }), verdicts: [] }, { version: version(), verdicts: GOOD }) }));
    await odd.run("gen", "build", "1111");
    expect(odd.out[0]).toBe("Building… 0%");
  });

  test("it gives up following after a long wait and prints what it has", async () => {
    const h = harness(routes({ [`GET ${VERSIONS}/${VID}`]: { version: version({ status: "BUILDING", step: "render", progress: 10 }), verdicts: [] } }));
    const real = Date.now;
    let calls = 0;
    Date.now = () => real() + (calls++ > 1 ? 61 * 60_000 : 0);
    try {
      expect(await h.run("gen", "build", "1111")).toBe(0);
    } finally {
      Date.now = real;
    }
    expect(h.out[0]).toBe("Rendering the video… 10%");
  });
});

describe("gen verdicts, cancel, accept", () => {
  const shown = [
    verdict("TECHNICAL", "FAIL", [
      finding({ severity: "polish", code: "craft", description: "A nit." }),
      finding({ severity: "must-fix", shotId: "s02", fromSec: 4.2, toSec: 5, code: "text_below_floor", description: "Text is too small.", suggestedFix: "Make it 40 px." }),
      finding({ severity: "should-fix", shotId: "s03", fromSec: 12, code: "sweep_static", description: "Nothing moves." }),
      finding({ severity: "should-fix", shotId: "s01", code: "dead_stretch", state: "kept", keptReason: "a still title card" }),
      finding({ severity: "should-fix", code: "late", state: "kept" }),
    ]),
  ];

  test("worst first, with shot, time, code and fix; kept warnings last with their reasons; a verdict not run yet says so", async () => {
    const h = harness({ [`GET ${VERSIONS}/${VID}`]: { version: version({ number: 2 }), verdicts: shown } });
    expect(await h.run("gen", "verdicts", VID)).toBe(0);
    expect(h.out).toEqual([
      "Version 2: BUILT", "TECHNICAL: FAIL  (judged by code)",
      "  must-fix   s02 · 4.2 to 5 s  text_below_floor  Text is too small.", "             Fix: Make it 40 px.",
      "  should-fix s03 · 12 s  sweep_static  Nothing moves.", "  polish     craft  A nit.",
      "  kept       dead_stretch (s01): a still title card", "  kept       late: no reason given",
      "CREATIVE: not judged yet",
    ]);
  });

  test("a project id means its newest version; --json prints the data; a project without a build is a usage error", async () => {
    const h = harness({
      [`GET ${BASE}`]: { projects: [project] }, [`GET ${BASE}/${ID}`]: { versions: [{ id: VID }, { id: "older" }] },
      [`GET ${VERSIONS}/${VID}`]: { version: version(), verdicts: GOOD },
    });
    expect(await h.run("gen", "verdicts", "1111", "--json")).toBe(0);
    expect(JSON.parse(h.out[0]!).version.id).toBe(VID);
    const none = harness({ [`GET ${BASE}`]: { projects: [project] }, [`GET ${BASE}/${ID}`]: { versions: [] } });
    expect(await none.run("gen", "verdicts", "1111")).toBe(2);
    expect(none.err[0]).toContain("no build yet");
    expect(await harness().run("gen", "verdicts")).toBe(2);
  });

  test("cancel and accept act on a version id or a project's newest one", async () => {
    const h = harness({
      [`POST ${VERSIONS}/${VID}/cancel`]: { version: version({ status: "CANCELLED" }) },
      [`POST ${VERSIONS}/${VID}/accept`]: { project: { status: "ACCEPTED" } },
    });
    expect(await h.run("gen", "cancel", VID)).toBe(0);
    expect(h.out.at(-1)).toBe("Version 1: CANCELLED");
    expect(await h.run("gen", "accept", VID)).toBe(0);
    expect(h.out.at(-1)).toBe("Accepted. The project is now ACCEPTED.");
    expect(await h.run("gen", "accept", VID, "--json")).toBe(0);
    expect(JSON.parse(h.out.at(-1)!).project.status).toBe("ACCEPTED");
    expect(await h.run("gen", "cancel", VID, "--json")).toBe(0);

    const refused = harness({ [`POST ${VERSIONS}/${VID}/accept`]: new Fail(409, "TECHNICAL failed: fix the must-fix findings before accepting") });
    expect(await refused.run("gen", "accept", VID)).toBe(1);
    expect(refused.err[0]).toContain("TECHNICAL failed");
  });
});

describe("gen fix, restore", () => {
  const fixed = (over: object = {}) => ({ version: version({ number: 2, projectId: ID, status: "QUEUED", progress: 0 }), plan: null, needsApproval: false, summary: "Judul diperbesar", ...over });

  test("fixes into a new version and follows it; --finding repeats, a note and a shot travel along", async () => {
    const h = harness(routes({
      [`POST ${VERSIONS}/${VID}/fix`]: fixed(),
      [`GET ${VERSIONS}/${VID}`]: { version: version({ number: 2 }), verdicts: GOOD },
    }));
    expect(await h.run("gen", "fix", VID, "--finding", "f1", "--finding", "f2", "--note", "lebih besar", "--shot", "s02")).toBe(0);
    expect(h.requests.find((r) => r.path === `${VERSIONS}/${VID}/fix`)!.body).toEqual({ findingIds: ["f1", "f2"], note: "lebih besar", shotId: "s02" });
    expect(h.out[0]).toBe("Judul diperbesar");
    expect(h.out).toContain(`Built version 2 (${VID}) in 61 s.`);
    expect(h.out.at(-1)).toContain("sorot gen fix 11111111");
  });

  test("with no options it fixes the open must-fix items; --no-watch returns at once", async () => {
    const h = harness(routes({ [`POST ${VERSIONS}/${VID}/fix`]: fixed() }));
    expect(await h.run("gen", "fix", VID, "--no-watch")).toBe(0);
    expect(h.requests.find((r) => r.path === `${VERSIONS}/${VID}/fix`)!.body).toEqual({});
    expect(h.out).toEqual(["Judul diperbesar", `Queued version 2: ${VID}. Follow it with: sorot gen verdicts 11111111`]);
  });

  test("a fix that changes the plan's words waits for approval; --json prints the answer; the server's refusal is an error", async () => {
    const waiting = fixed({ version: null, plan: { projectId: ID }, needsApproval: true, summary: "Judul diganti" });
    const h = harness(routes({ [`POST ${VERSIONS}/${VID}/fix`]: waiting }));
    expect(await h.run("gen", "fix", VID)).toBe(0);
    expect(h.out[0]).toBe("Judul diganti");
    expect(h.out[1]).toContain("needs your approval");
    const j = harness(routes({ [`POST ${VERSIONS}/${VID}/fix`]: waiting }));
    expect(await j.run("gen", "fix", VID, "--json")).toBe(0);
    expect(JSON.parse(j.out[0]!).needsApproval).toBe(true);
    const refused = harness({ [`POST ${VERSIONS}/${VID}/fix`]: new Fail(409, "Nothing to fix") });
    expect(await refused.run("gen", "fix", VID)).toBe(1);
    expect(refused.err[0]).toContain("Nothing to fix");
  });

  test("restore makes a version's plan current again", async () => {
    const h = harness({ [`POST ${VERSIONS}/${VID}/restore`]: { project: { id: ID } } });
    expect(await h.run("gen", "restore", VID)).toBe(0);
    expect(h.out[0]).toBe("Restored. Build again with: sorot gen build 11111111");
    expect(await h.run("gen", "restore", VID, "--json")).toBe(0);
    expect(JSON.parse(h.out.at(-1)!).project.id).toBe(ID);
  });
});
