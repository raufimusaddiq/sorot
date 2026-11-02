import { describe, expect, test } from "bun:test";
import { frameDiffArgs, motionFindings, parseFrameDiffs } from "../../src/generate/motion";
import type { Plan } from "../../src/generate/planSchema";

// a plan of shots with these lengths (seconds) at 10 fps, so frame n is n / 10 s
const plan = (...shots: Array<number | [number, boolean]>) => ({
  shots: shots.map((s, i) => ({ id: `s0${i + 1}`, durationSec: Array.isArray(s) ? s[0] : s, hold: Array.isArray(s) ? s[1] : false })),
}) as unknown as Plan;
const moving = (n: number, v = 0.3) => Array<number>(n).fill(v);
const codes = (diffs: number[], p: Plan) => motionFindings(diffs, p, 10).map((f) => [f.code, f.severity, f.shotId, f.fromSec, f.toSec]);

describe("motion measure", () => {
  test.each<[string, number[], Plan, unknown[]]>([
    ["smooth motion", moving(40), plan(4), []],
    ["a one-frame spike", [...moving(15), 20, ...moving(24)], plan(4), [["motion_jump", "must-fix", "s01", 1.6, 1.6]]],
    ["an out-and-back teleport is one jump", [...moving(15), 2.5, 2.5, ...moving(23)], plan(4), [["motion_jump", "should-fix", "s01", 1.6, 1.7]]],
    ["a spike right at a seam is the cut, not a jump", [...moving(19), 30, ...moving(20)], plan(2, 2), []],
    ["a stop of 1 s between moves", [...moving(10), ...moving(10, 0), ...moving(20)], plan(4), [["motion_stall", "should-fix", "s01", 1, 2]]],
    ["a stop twice the threshold", [...moving(5), ...moving(17, 0), ...moving(18)], plan(4), [["motion_stall", "must-fix", "s01", 0.5, 2.2]]],
    ["a short settle", [...moving(10), ...moving(5, 0), ...moving(25)], plan(4), []],
    ["a shot that ends still (it never moves again)", [...moving(10), ...moving(30, 0)], plan(4), []],
    ["a hold shot", [...moving(10), ...moving(10, 0), ...moving(20)], plan([4, true]), []],
    ["a mostly still shot", [...moving(5, 0), 0.3, ...moving(9, 0), 0.3, ...moving(24, 0)], plan(4), []],
  ])("%s", (_name, diffs, p, found) => {
    expect(codes(diffs, p) as unknown[]).toEqual(found);
  });

  test("ffmpeg prints one YAVG per frame pair", () => {
    expect(parseFrameDiffs("frame:0 pts:512\nlavfi.signalstats.YAVG=0.1\nframe:1\nlavfi.signalstats.YAVG=4.5\n")).toEqual([0.1, 4.5]);
    expect(frameDiffArgs("v.mp4")).toContain("format=gray,tblend=all_mode=difference,lutyuv=y='if(gt(val\\,24)\\,255\\,0)',signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-");
  });
});
