import { describe, expect, test } from "bun:test";
import { buildRoot, bundledFontFaces, checkScene, shotFile, shotId, shotStarts, visibleText } from "../../src/generate/composer";
import { validatePlan, type Plan } from "../../src/generate/planSchema";
import { samplePlan, sceneHtml as scene } from "../helpers";

const planOf = (over: Record<string, unknown> = {}): Plan =>
  validatePlan(samplePlan(over), {
    brief: "x", targetSec: 30, format: "9:16", language: "id", fonts: ["Plus Jakarta Sans", "Inter"], imageConnected: false, narration: false,
  }).plan as Plan;

describe("root composition", () => {
  test("every shot is a host with the plan's start and length, in the plan's order", () => {
    const plan = planOf();
    expect(shotStarts(plan)).toEqual([0, 10, 20]);
    const html = buildRoot({ plan, width: 1080, height: 1920, fonts: [] });
    expect(html).toContain('<div id="root" data-composition-id="main" data-start="0" data-duration="30" data-width="1080" data-height="1920">');
    expect(html).toContain('<div id="host-01" data-composition-id="shot-01" data-composition-src="compositions/shot-01.html" data-start="0" data-duration="10" data-width="1080" data-height="1920" data-track-index="0"></div>');
    expect(html).toContain('data-composition-id="shot-03" data-composition-src="compositions/shot-03.html" data-start="20" data-duration="10"');
    expect(html).toContain('<script src="assets/gsap.min.js"></script>');
    expect(html).toContain('window.__timelines["main"] = tl;');
    expect(html).toContain('data-resolution="portrait"');
    expect(html).toContain("background: #0B1020;");
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toContain("<audio");
  });

  test("uneven durations add up exactly; a wide format is landscape; a bad colour falls back to black", () => {
    const plan = planOf({ shots: samplePlan().shots.map((s: any, i: number) => ({ ...s, durationSec: [8.5, 9.3, 12.2][i] })) });
    expect(shotStarts(plan)).toEqual([0, 8.5, 17.8]);
    const html = buildRoot({ plan: { ...plan, look: { ...plan.look, palette: ["red", "javascript:1"] } }, width: 1920, height: 1080, fonts: [] });
    expect(html).toContain('data-duration="30"');
    expect(html).toContain('data-start="17.8" data-duration="12.2"');
    expect(html).toContain('data-resolution="landscape"');
    expect(html).toContain("background: #000000;");
  });

  test("fonts become @font-face rules and music a track under the whole video; attribute values are escaped", () => {
    const plan = planOf();
    const html = buildRoot({
      plan: { ...plan, language: 'i"d' }, width: 1080, height: 1920,
      fonts: [{ family: "Plus Jakarta Sans", weight: 700, path: "assets/fonts/pj-700.woff2" }, { family: 'Odd"Font', weight: 400, path: "assets/fonts/odd.woff2" }],
      music: { path: "assets/ab-lagu.mp3", volume: 0.12 },
    });
    expect(html).toContain('@font-face { font-family: "Plus Jakarta Sans"; font-weight: 700; src: url("assets/fonts/pj-700.woff2") format("woff2"); }');
    expect(html).toContain('font-family: "Odd&quot;Font"');
    expect(html).toContain('<audio id="music" class="clip" src="assets/ab-lagu.mp3" data-start="0" data-duration="30" data-track-index="1" data-volume="0.12"></audio>');
    expect(html).toContain('lang="i&quot;d"');
  });

  test("names", () => {
    expect([shotId(0), shotId(11), shotFile(2)]).toEqual(["shot-01", "shot-12", "compositions/shot-03.html"]);
  });

  test("the bundled fonts are found by family and weight in generator/fonts", () => {
    const faces = bundledFontFaces("../generator", ["Plus Jakarta Sans", "Bebas Neue", "Nope"]);
    expect(faces).toEqual([
      { family: "Bebas Neue", weight: 400, path: "assets/fonts/bebas-neue-latin-400-normal.woff2" },
      { family: "Plus Jakarta Sans", weight: 400, path: "assets/fonts/plus-jakarta-sans-latin-400-normal.woff2" },
      { family: "Plus Jakarta Sans", weight: 700, path: "assets/fonts/plus-jakarta-sans-latin-700-normal.woff2" },
    ]);
    expect(bundledFontFaces("/no/such/folder", ["Inter"])).toEqual([]);
  });
});

describe("scene checks (plan-lock)", () => {
  const shot = planOf().shots[0]!;   // title "Bunga berbunga?"
  const check = (html: string, assets: string[] = []) => checkScene(html, shot, 0, { assets });
  const codes = (html: string, assets?: string[]) => check(html, assets).map((i) => i.code);

  test("a scene that keeps every rule has no issues", () => {
    expect(check(scene(0, "Bunga berbunga?"))).toEqual([]);
  });

  test.each<[string, string, string]>([
    ["the planned text is missing", scene(0, "Judul lain"), "scene_missing_text"],
    ["the text only exists in a script", scene(0, "").replace("</h1>", "</h1><script>document.title='Bunga berbunga?'</script>"), "scene_missing_text"],
    ["a root that sets its own timing", scene(0, "Bunga berbunga?").replace('data-height="1920">', 'data-height="1920" data-start="0" data-duration="3">'), "scene_own_timing"],
    ["no composition root for the shot", scene(0, "Bunga berbunga?").replaceAll("shot-01", "shot-07"), "scene_wrong_composition"],
    ["a timeline that isn't registered", scene(0, "Bunga berbunga?").replace('window.__timelines["shot-01"] = tl;', ""), "scene_missing_timeline"],
    ["Date.now", scene(0, "Bunga berbunga?").replace("tl.fromTo", "const t = Date.now(); tl.fromTo"), "scene_nondeterministic"],
    ["new Date", scene(0, "Bunga berbunga?").replace("tl.fromTo", "const t = new Date(); tl.fromTo"), "scene_nondeterministic"],
    ["performance.now", scene(0, "Bunga berbunga?").replace("tl.fromTo", "performance.now(); tl.fromTo"), "scene_nondeterministic"],
    ["Math.random", scene(0, "Bunga berbunga?").replace("tl.fromTo", "Math.random(); tl.fromTo"), "scene_nondeterministic"],
    ["setTimeout", scene(0, "Bunga berbunga?").replace("tl.fromTo", "setTimeout(() => {}, 5); tl.fromTo"), "scene_nondeterministic"],
    ["setInterval", scene(0, "Bunga berbunga?").replace("tl.fromTo", "setInterval(() => {}, 5); tl.fromTo"), "scene_nondeterministic"],
    ["requestAnimationFrame", scene(0, "Bunga berbunga?").replace("tl.fromTo", "requestAnimationFrame(() => {}); tl.fromTo"), "scene_nondeterministic"],
    ["an endless repeat", scene(0, "Bunga berbunga?").replace("duration: 0.5 }", "duration: 0.5, repeat: -1 }"), "scene_nondeterministic"],
    ["an endless repeat (Infinity)", scene(0, "Bunga berbunga?").replace("duration: 0.5 }", "duration: 0.5, repeat:Infinity }"), "scene_nondeterministic"],
    ["fetch", scene(0, "Bunga berbunga?").replace("tl.fromTo", "fetch('/x'); tl.fromTo"), "scene_nondeterministic"],
    ["XMLHttpRequest", scene(0, "Bunga berbunga?").replace("tl.fromTo", "new XMLHttpRequest(); tl.fromTo"), "scene_nondeterministic"],
    ["a script from a CDN", scene(0, "Bunga berbunga?", '<script src="https://cdn.jsdelivr.net/npm/gsap"></script>'), "scene_remote_resource"],
    ["a local script tag", scene(0, "Bunga berbunga?", '<script src="assets/x.js"></script>'), "scene_remote_resource"],
    ["a stylesheet link", scene(0, "Bunga berbunga?", '<link rel="stylesheet" href="x.css">'), "scene_remote_resource"],
    ["a remote image", scene(0, "Bunga berbunga?", '<img src="//img.example.com/a.png">'), "scene_remote_resource"],
    ["a remote url() in CSS", scene(0, "Bunga berbunga?").replace("font-family", "background: url(https://x.com/a.png); font-family"), "scene_remote_resource"],
    ["an @import", scene(0, "Bunga berbunga?").replace("<style>", "<style>@import 'x.css';"), "scene_remote_resource"],
    ["an asset that doesn't exist", scene(0, "Bunga berbunga?", '<img src="assets/missing.png">'), "scene_unknown_asset"],
  ])("flags %s", (_name, html, code) => {
    expect(codes(html)).toContain(code);
  });

  test("assets that exist are fine, however they are referenced; the hint lists what exists", () => {
    const html = scene(0, "Bunga berbunga?", '<img src="assets/ab-logo.png"><div style="background:url(assets/ab-bg.png)"></div>');
    expect(codes(html, ["assets/ab-logo.png", "assets/ab-bg.png"])).toEqual([]);
    const issue = check(scene(0, "Bunga berbunga?", '<img src="assets/nope.png">'), ["assets/ab-logo.png"]).find((i) => i.code === "scene_unknown_asset")!;
    expect(issue.message).toContain("assets/nope.png");
    expect(issue.hint).toContain("assets/ab-logo.png");
    expect(check(scene(0, "Bunga berbunga?", '<img src="assets/nope.png">')).find((i) => i.code === "scene_unknown_asset")!.hint).toContain("(none)");
  });

  test("text matches across tags, entities and line breaks; a second planned line is checked too", () => {
    const two = { ...shot, text: [{ role: "title", value: "Bunga & bunga" }, { role: "body", value: "uang tumbuh" }] };
    const html = scene(0, "Bunga <b>&amp;</b>\n bunga", "<p>uang   tumbuh &#33;</p>");
    expect(checkScene(html, two, 0, { assets: [] })).toEqual([]);
    const missing = checkScene(scene(0, "Bunga &amp; bunga"), two, 0, { assets: [] });
    expect(missing.map((i) => i.message)).toEqual(['The planned body "uang tumbuh" isn\'t in the scene\'s markup.']);
    expect(checkScene(scene(0, ""), { ...shot, text: [{ role: "title", value: "  " }] }, 0, { assets: [] })).toEqual([]);
  });

  test("visible text ignores styles, scripts and comments and decodes entities", () => {
    expect(visibleText('<style>.a{}</style><!-- hi --><p>A&nbsp;&amp;&#x42;&#67;&unknown;</p><script>var s="no"</script>')).toBe("A &BC&unknown;");
  });
});
