import { describe, expect, test } from "bun:test";
import { STEPS, settingsOf } from "../../src/generate/steps";
import { checkObject, STEP_SPECS, STEP_TYPES } from "../../src/generate/steps/schema";
import { notImplemented, type StepContext } from "../../src/generate/steps/types";

describe("step registry", () => {
  test.each(STEP_TYPES.map((t) => [t]))("%s: has a module whose defaults pass its own schema", (type) => {
    const mod = STEPS[type];
    expect(mod).toMatchObject({ type, spec: STEP_SPECS[type] });
    expect(typeof mod.run).toBe("function");
    const errors: string[] = [];
    checkObject(mod.spec.fields, mod.defaults, type, errors);
    expect(errors).toEqual([]);
    expect(mod.spec.gates.length).toBeGreaterThan(0);
  });

  test("settings are the recipe's values over the defaults", () => {
    expect(settingsOf("check", undefined)).toEqual({ warnings: "fix-or-hold", rounds: 3 });
    expect(settingsOf("check", { rounds: 1 })).toEqual({ warnings: "fix-or-hold", rounds: 1 });
    expect(settingsOf("storylines", { count: 5 })).toMatchObject({ count: 5, requireBold: false });
  });

  test("a step type without a module fails loudly", async () => {
    await expect(notImplemented("dance")({} as StepContext)).rejects.toThrow("dance step is not implemented");
  });
});
