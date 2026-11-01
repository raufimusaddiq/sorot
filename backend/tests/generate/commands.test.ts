import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../../src/config";
import { openDatabase } from "../../src/db";
import { CommandError, parseCommandOutput, runCommand } from "../../src/generate/commands";
import { isCreative, readFindings, saveFindings } from "../../src/generate/findings";
import type { RecipeStep } from "../../src/generate/recipe";
import { STEPS, settingsOf } from "../../src/generate/steps";
import type { ExecFn } from "../../src/runner";
import { Store } from "../../src/store";
import { procOk, quickRecipe, samplePlan } from "../helpers";

const T = "2026-01-01T00:00:00.000Z";
const json = JSON.stringify;
let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "vc-cmd-")); });
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const ok = (...findings: object[]) => json({ success: true, data: { findings } });

describe("parseCommandOutput", () => {
  test("findings are read from the last line, with defaults for what is left out", () => {
    const found = parseCommandOutput(`noise\n${ok({ severity: "must-fix", description: " Logo missing ", shotId: "s02", fromSec: 1, toSec: 2, code: "brand.logo", suggestedFix: "Add it" }, { description: "Spacing" })}`, "brand");
    expect(found).toEqual([
      { severity: "must-fix", shotId: "s02", code: "brand.logo", description: "Logo missing", state: "open", rule: "command:brand", suggestedFix: "Add it", fromSec: 1, toSec: 2 },
      { severity: "should-fix", shotId: null, code: "command.brand", description: "Spacing", state: "open", rule: "command:brand" },
    ]);
    expect(parseCommandOutput(ok(), "x")).toEqual([]);
  });

  test.each([
    ["not json", "didn't print a JSON result"],
    [json({ success: false, error: "boom" }), "reported an error: boom"],
    [json({ success: false }), "no reason given"],
    [json({ success: true, data: {} }), "no findings list"],
    [ok({ severity: "huge", description: "x" }), 'severity "huge"'],
    [ok({ severity: "polish" }), "no description"],
    [ok({}), "no description"],
  ])("%s is refused", (stdout, message) => {
    expect(() => parseCommandOutput(stdout, "brand")).toThrow(CommandError);
    expect(() => parseCommandOutput(stdout, "brand")).toThrow(message);
  });
});

function rig(commands = [{ name: "brand", cmd: "python", args: ["check.py"], timeoutSec: 30 }], over: object = {}, exec?: ExecFn) {
  const config = { ...loadConfig({}), genDir: join(tmp, "generate"), commands, ...over };
  const store = new Store(openDatabase(":memory:"));
  const recipe = quickRecipe();
  store.saveGenProject({
    id: "p1", title: null, brief: "x", format: "9:16", targetSec: 30, language: "id", styleNotes: null, preset: null, recipeId: "quick", recipe: json(recipe),
    ideaId: null, briefFlags: null, narrationScript: null, concept: null, stepIndex: 0, stepState: null, narration: 0, storylines: null, pickedStoryline: null,
    status: "BUILDING", currentPlanId: "pl1", acceptedVersionId: null, errorMessage: null, createdAt: T, updatedAt: T,
  });
  store.saveGenPlan({ id: "pl1", projectId: "p1", revision: 1, plan: json(samplePlan()), changeRequest: null, changeSummary: null, approvedAt: T, createdAt: T });
  const dir = join(tmp, "generate", "p1", "v1");
  mkdirSync(dir, { recursive: true });
  store.saveGenVersion({
    id: "v1", projectId: "p1", planId: "pl1", number: 1, parentVersionId: null, status: "BUILDING", step: null, progress: null, projectDir: dir, renderKind: "draft",
    draftPath: null, stepState: null, hyperframesVersion: null, buildMs: null, errorMessage: null, createdAt: T, updatedAt: T,
  });
  const calls: Array<{ cmd: string; args: string[]; timeoutMs?: number }> = [];
  const run: ExecFn = exec ?? (async () => procOk(ok({ severity: "must-fix", description: "Logo missing" })));
  const wrapped: ExecFn = async (cmd, args, opts) => { calls.push({ cmd, args, timeoutMs: opts?.timeoutMs }); return run(cmd, args, opts); };
  const ctxFor = (withSettings: Record<string, unknown> = { name: "brand" }) => {
    const step = { use: "command", with: withSettings } as RecipeStep;
    return { project: store.getGenProject("p1")!, version: store.getGenVersion("v1")!, recipe, step, settings: settingsOf("command", step.with), store, exec: wrapped, config: config as never } as never;
  };
  return { dir, calls, ctxFor, config };
}

describe("runCommand and the command step", () => {
  test("runs the registered command on this build and joins its findings to TECHNICAL", async () => {
    const r = rig();
    expect(await STEPS.command.run(r.ctxFor())).toEqual({ status: "done", outputRef: "1 findings" });
    expect(r.calls).toEqual([{ cmd: "python", args: ["check.py", "--project-dir", `${r.config.genDir}/p1`, "--version-dir", r.dir], timeoutMs: 30_000 }]);
    const found = readFindings(r.dir);
    expect(found).toMatchObject([{ id: "command-technical:brand-1", source: "command-technical:brand", severity: "must-fix", rule: "command:brand" }]);
    expect(isCreative(found[0]!)).toBeFalse();
  });

  test("`counts: creative` files them with the CREATIVE verdict instead; running again replaces its own findings only", async () => {
    const r = rig();
    saveFindings(r.dir, "check", [{ severity: "polish", shotId: null, code: "x", description: "kept", state: "open" }]);
    await STEPS.command.run(r.ctxFor({ name: "brand", counts: "creative" }));
    await STEPS.command.run(r.ctxFor({ name: "brand", counts: "creative" }));
    const found = readFindings(r.dir);
    expect(found.map((f) => f.source)).toEqual(["check", "command-creative:brand"]);
    expect(isCreative(found[1]!)).toBeTrue();
  });

  test("an unknown command, one switched off, a missing build, a failure and a timeout are errors with the reason", async () => {
    await expect(STEPS.command.run(rig().ctxFor({ name: "other" }))).rejects.toThrow('"other" isn\'t registered in Settings');
    await expect(STEPS.command.run(rig(undefined, { commandsEnabled: false }).ctxFor())).rejects.toThrow("custom commands are off");
    const noBuild = rig();
    const ctx = noBuild.ctxFor() as any;
    ctx.version = { ...ctx.version, projectDir: null };
    await expect(runCommand(ctx, "brand")).rejects.toThrow("needs a built version");
    const failing = rig(undefined, {}, async () => ({ ...procOk("", "Traceback: boom"), exitCode: 2 }));
    await expect(STEPS.command.run(failing.ctxFor())).rejects.toThrow("failed (exit 2): Traceback: boom");
    const slow = rig(undefined, {}, async () => ({ ...procOk(), timedOut: true }));
    await expect(STEPS.command.run(slow.ctxFor())).rejects.toThrow("took longer than 30 s");
    const silent = rig(undefined, {}, async () => ({ ...procOk("", ""), exitCode: 1 }));
    await expect(STEPS.command.run(silent.ctxFor())).rejects.toThrow("failed (exit 1)");
  });
});
