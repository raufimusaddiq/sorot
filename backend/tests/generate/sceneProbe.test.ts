import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { Plan } from "../../src/generate/planSchema";
import { PROBE_FILE, PROBE_PREFIX, probeConfig, probeFindings, readProbe, withProbe, type ProbeData, type ProbeFade, type ProbeFrame, type ProbeTween } from "../../src/generate/sceneProbe";

// shots of these lengths (s), cut unless a transition is named; frames are 100 × 100 so a share is r[2] * r[3] / 10000
const plan = (...shots: Array<number | [number, string]>) => ({
  shots: shots.map((s, i) => ({ id: `s0${i + 1}`, durationSec: Array.isArray(s) ? s[0] : s, transition: Array.isArray(s) ? s[1] : "cut" })),
}) as unknown as Plan;
const data = (over: Partial<ProbeData>): ProbeData => ({
  size: [100, 100], tweens: [], fades: [], frames: [], ...over,
  labels: { a: { l: "div.a", c: "shot-01" }, b: { l: "div.b", c: "shot-01" }, t: { l: "p.t", c: "shot-01", x: "Rumah kita" }, m: { l: "div.m", c: "main" }, ...over.labels },
});
const fade = (el: string, s: number, way: "in" | "out", share = 1, e = s + 0.15): ProbeFade =>
  ({ el, s, e, before: { o: way === "in" ? 0 : 1, a: share }, after: { o: way === "in" ? 1 : 0, a: share } });
const tween = (kit: string | null, s = 1, e = 4, p = ["scaleX", "y"], el = "a", auto = false): ProbeTween => ({ el, p, s, e, kit, auto });
const moment = (t: number, text: Partial<ProbeFrame["texts"][number]> | null, object: [number, number, number, number] | null, first = false, box = false): ProbeFrame => ({
  t, c: "shot-01", ...(first ? { first } : {}),
  texts: text ? [{ el: "t", r: [10, 10, 40, 10], o: 1, v: 1, ...text }] : [],
  objects: object ? [{ el: "b", r: object, o: 1, ...(box ? { box: 1 as const } : {}) }] : [],
});
const house: [number, number, number, number] = [0, 0, 60, 60];
const codes = (d: Partial<ProbeData>, p = plan(6)) => probeFindings(data(d), p).map((f) => [f.code, f.severity, f.shot, f.time]);

describe("scene probe", () => {
  test.each<[string, Partial<ProbeData>, unknown[]]>([
    // 1. hard swaps
    ["two full-frame layers cross-fading in 0.15 s", { fades: [fade("a", 2.5, "out"), fade("b", 2.52, "in")] }, [["hard_swap", "error", 0, 2.5]]],
    ["a swap of two half-frame layers", { fades: [fade("a", 2.5, "out", 0.5), fade("b", 2.5, "in", 0.9)] }, [["hard_swap", "warning", 0, 2.5]]],
    ["small elements swapping (a word, a card)", { fades: [fade("a", 2.5, "out", 0.2), fade("b", 2.5, "in", 0.2)] }, []],
    ["a slow cross-fade", { fades: [fade("a", 2.5, "out", 1, 3.1), fade("b", 2.5, "in", 1, 3.1)] }, []],
    ["one layer leaving, the next coming a beat later", { fades: [fade("a", 2.5, "out"), fade("b", 2.8, "in")] }, []],
    ["a swap on the shot's last frames belongs to the seam", { fades: [fade("a", 5.85, "out"), fade("b", 5.85, "in")] }, []],
    ["the root's seam overlays are not a shot's", { fades: [fade("m", 2.5, "out"), fade("b", 2.5, "in")] }, []],
    // 2. fighting moves
    ["a kit part and the scene's own tween on the same scale and y", { tweens: [tween("camera#0", 0, 6), tween(null)] }, [["fighting_tweens", "warning", 0, 1]]],
    ["two of the scene's own (HyperFrames' overlapping_gsap_tweens says so)", { tweens: [tween(null, 0, 6), tween(null)] }, []],
    ["a hand-off: one ends as the other starts", { tweens: [tween("camera#0", 0, 1.02), tween(null)] }, []],
    ["other properties, other elements, overwrite auto, one part's own tweens", {
      tweens: [tween("camera#0", 0, 6), tween(null, 1, 4, ["opacity"]), tween(null, 1, 4, ["y"], "b"), tween(null, 1, 4, ["y"], "a", true), tween("camera#0", 2, 5)],
    }, []],
    // 3. text over drawn objects
    ["text partly over a drawing in 2 of its 3 moments", { frames: [moment(1, {}, [30, 0, 40, 40]), moment(2, {}, [30, 0, 40, 40]), moment(3, {}, null)] }, [["text_over_object", "warning", 0, 1]]],
    ["a drawing passing under the text once", { frames: [moment(1, {}, house), moment(2, {}, null), moment(3, {}, null)] }, []],
    ["text on a small shape drawn from CSS boxes (a hull of divs) counts like an svg", { frames: [moment(1, {}, [0, 0, 40, 40], false, true), moment(2, {}, [0, 0, 40, 40], false, true)] }, [["text_over_object", "warning", 0, 1]]],
    ["text on a CSS-drawn panel or card (a fifth of the frame or more) is a label on its card, but the same size svg is a drawing", { frames: [moment(1, {}, house, false, true), moment(2, {}, house, false, true)] }, []],
    ["a text wholly inside a drawing much bigger than itself is a label on it; one only partly over a drawing is not", { frames: [moment(1, {}, [0, 0, 80, 50]), moment(2, {}, [0, 0, 80, 50])] }, []],
    ["a backdrop behind the text", { frames: [moment(1, {}, [0, 0, 100, 60]), moment(2, {}, [0, 0, 100, 60])] }, []],
    ["text only grazing the drawing", { frames: [moment(1, {}, [45, 0, 40, 40]), moment(2, {}, [45, 0, 40, 40])] }, []],
    ["a label kept on purpose (data-layout-allow-overlap), or text not yet readable", {
      frames: [moment(1, { overlap: true }, house), moment(2, { overlap: true }, house), moment(3, { o: 0.2 }, house), moment(4, { v: 0.2 }, house)],
    }, []],
    // 4. first frames
    ["a title half out of its mask on the film's first frame", { frames: [moment(0, { v: 0.5 }, null, true)] }, [["first_frame_partial_text", "warning", 0, 0]]],
    ["a title fully hidden, or whole, on the first frame", { frames: [moment(0, { v: 0 }, null, true), moment(0, { v: 0.97 }, null, true)] }, []],
    ["half out of its mask later in the shot is a reveal", { frames: [moment(1, { v: 0.5 }, null)] }, []],
  ])("%s", (_name, d, found) => {
    expect(codes(d) as unknown[]).toEqual(found);
  });

  test("the film's first frame must show an opening line whole: hidden or half-revealed is an empty first frame", () => {
    const titled = { shots: [{ ...plan(6).shots[0], text: [{ role: "title", value: "Rumah kita" }] }] } as unknown as Plan;
    expect(codes({ frames: [moment(0, { v: 0 }, null, true)] }, titled)).toEqual([["first_frame_no_text", "warning", 0, 0]]);
    expect(codes({ frames: [moment(0, { o: 0 }, null, true), moment(0.5, {}, null)] }, titled).map((c) => c[0])).toEqual(["first_frame_no_text"]);
    expect(codes({ frames: [moment(0, {}, null, true)] }, titled)).toEqual([]);
  });

  test("the page looks at each first frame after a cut and at moments clear of the seams", () => {
    expect(probeConfig(plan(2, [2, "push"], 2), 30, { moments: 1 })).toEqual({
      fps: 30, fadeMaxSec: 0.3,
      // shot 1 ends 0.4 s early (the push reaches in), shot 2 has no first frame of its own (the push covers it)
      frames: [{ t: 0, c: "shot-01", first: true }, { t: 0.8, c: "shot-01" }, { t: 3.2, c: "shot-02" }, { t: 4, c: "shot-03", first: true }, { t: 5, c: "shot-03" }],
    });
  });

  test("the probe's line is read from the console warnings; a cut line or a page that never got ready is none", () => {
    const line = PROBE_PREFIX + JSON.stringify(data({}));
    expect(readProbe(["Some warning", line])).toEqual(data({}));
    expect(readProbe(["Some warning", line.slice(0, 40), `${PROBE_PREFIX}{"v":1,"error":"the page never became ready"}`])).toBeNull();
  });

  test("the root loads the probe only while the check runs, after GSAP and the kit, and is put back even when the check fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vc-probe-"));
    try {
      mkdirSync(join(dir, "assets"));
      const root = '<html><head><script src="assets/gsap.min.js"></script>\n  </head><body></body></html>';
      writeFileSync(join(dir, "index.html"), root);
      const config = probeConfig(plan(2), 30);
      const during = await withProbe(dir, config, async () => [readFileSync(join(dir, "index.html"), "utf-8"), readFileSync(join(dir, PROBE_FILE), "utf-8")]);
      expect(during[0]).toContain(`<script src="assets/gsap.min.js"></script>\n    <script src="${PROBE_FILE}"></script>\n  </head>`);
      expect(during[1]).toStartWith(`window.__sorotProbe = ${JSON.stringify(config)};\n(function () {`);
      await expect(withProbe(dir, config, async () => { throw new Error("no browser"); })).rejects.toThrow("no browser");
      expect([readFileSync(join(dir, "index.html"), "utf-8"), existsSync(join(dir, PROBE_FILE))]).toEqual([root, false]);
      writeFileSync(join(dir, "index.html"), "<!doctype html>");
      expect(await withProbe(dir, config, async () => readFileSync(join(dir, "index.html"), "utf-8"))).toBe("<!doctype html>");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
