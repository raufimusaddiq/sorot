import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Plan, Shot } from "./planSchema";

// The composer writes what must not be left to a model: the root index.html, with every shot's
// start and length taken from the approved plan (FR-008/FR-009), the bundled fonts and a local
// GSAP, so a render is the same every time and works offline. The director writes only what a
// shot looks like (compositions/shot-NN.html); checkScene holds each scene to the plan.
// Structure verified against hyperframes 0.8.223 (research R5).

export const GSAP_FILE = "assets/gsap.min.js";

export const shotNumber = (index: number) => String(index + 1).padStart(2, "0");
/** The composition id of the shot at `index` (0-based): shot-01, shot-02... */
export const shotId = (index: number) => `shot-${shotNumber(index)}`;
export const shotFile = (index: number) => `compositions/${shotId(index)}.html`;

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * The video's size: the recipe's output gives the long and short side (1080x1920 -> 1920 and 1080),
 * the project's format says which way round: 9:16 vertical, 16:9 wide, 1:1 a square of the short side.
 */
export function sizeFor(format: string, output: { width: number; height: number }): { width: number; height: number } {
  const long = Math.max(output.width, output.height);
  const short = Math.min(output.width, output.height);
  return format === "16:9" ? { width: long, height: short } : format === "1:1" ? { width: short, height: short } : { width: short, height: long };
}

/** Start of each shot in seconds: the plan's durations added up. */
export function shotStarts(plan: Plan): number[] {
  let t = 0;
  return plan.shots.map((s) => {
    const start = t;
    t = round3(t + s.durationSec);
    return round3(start);
  });
}

export interface FontFace { family: string; weight: number; /** Path inside the project, e.g. assets/fonts/x.woff2. */ path: string }

/**
 * The bundled fonts as @font-face sources: files named `<family-slug>-latin-<weight>-normal.woff2`
 * in generator/fonts. Only families the plan uses are returned.
 */
export function bundledFontFaces(generatorDir: string, families: string[]): FontFace[] {
  const dir = join(generatorDir, "fonts");
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".woff2"));
  return families.flatMap((family) => {
    const slug = family.toLowerCase().replace(/\s+/g, "-");
    return files.flatMap((f) => {
      const m = new RegExp(`^${slug}-latin-(\\d{3})-normal\\.woff2$`).exec(f);
      return m ? [{ family, weight: Number(m[1]), path: `assets/fonts/${f}` }] : [];
    });
  }).sort((a, b) => a.family.localeCompare(b.family) || a.weight - b.weight);
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const HEX = /^#[0-9a-fA-F]{3,8}$/;

export interface ComposeInput {
  plan: Plan;
  width: number;
  height: number;
  fonts: FontFace[];
  /** A music asset from the project's assets/, laid under the whole video. */
  music?: { path: string; volume: number } | null;
}

/** The root index.html: one host per shot, in the plan's order and with the plan's timing. */
export function buildRoot({ plan, width, height, fonts, music }: ComposeInput): string {
  const starts = shotStarts(plan);
  const total = round3(plan.shots.reduce((n, s) => n + s.durationSec, 0));
  const ground = plan.look.palette.find((c) => HEX.test(c)) ?? "#000000";
  const faces = fonts.map((f) =>
    `      @font-face { font-family: "${esc(f.family)}"; font-weight: ${f.weight}; src: url("${esc(f.path)}") format("woff2"); }`).join("\n");
  const hosts = plan.shots.map((s, i) =>
    `      <div id="host-${shotNumber(i)}" data-composition-id="${shotId(i)}" data-composition-src="${shotFile(i)}" data-start="${starts[i]}" data-duration="${s.durationSec}" data-width="${width}" data-height="${height}" data-track-index="0"></div>`).join("\n");
  const audio = music
    ? `\n      <audio id="music" class="clip" src="${esc(music.path)}" data-start="0" data-duration="${total}" data-track-index="1" data-volume="${music.volume}"></audio>`
    : "";
  return `<!doctype html>
<html lang="${esc(plan.language)}" data-resolution="${height >= width ? "portrait" : "landscape"}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${width}, height=${height}" />
    <script src="${GSAP_FILE}"></script>
    <style>
${faces}
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { margin: 0; width: ${width}px; height: ${height}px; overflow: hidden; background: ${ground}; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${total}" data-width="${width}" data-height="${height}">${audio}
${hosts}
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      const tl = gsap.timeline({ paused: true });
      window.__timelines["main"] = tl;
      tl.seek(0);
    </script>
  </body>
</html>
`;
}

// ---- plan-lock: what a scene must keep ----------------------------------------------------

export interface SceneIssue {
  code: string;
  message: string;
  /** What to do about it, for the director. */
  hint: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** The text a viewer would read: markup, styles, scripts and comments removed, entities decoded, spaces collapsed. */
export function visibleText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ").replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") return String.fromCodePoint(e[1]!.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, " ").trim();
}

const NONDETERMINISTIC: Array<[RegExp, string]> = [
  [/\bDate\.now\s*\(/, "Date.now()"], [/\bnew\s+Date\s*\(/, "new Date()"], [/\bperformance\.now\s*\(/, "performance.now()"],
  [/\bMath\.random\s*\(/, "Math.random()"], [/\bsetTimeout\s*\(/, "setTimeout()"], [/\bsetInterval\s*\(/, "setInterval()"],
  [/\brequestAnimationFrame\s*\(/, "requestAnimationFrame()"], [/\brepeat\s*:\s*(-1|Infinity)\b/, "an endless repeat"],
  [/\bfetch\s*\(/, "fetch()"], [/\bXMLHttpRequest\b/, "XMLHttpRequest"],
];

/** Holds one scene to the approved plan and to HyperFrames' determinism rules, before anything renders. */
export function checkScene(html: string, shot: Shot, index: number, project: { assets: string[] }): SceneIssue[] {
  const id = shotId(index);
  const issues: SceneIssue[] = [];
  const add = (code: string, message: string, hint: string) => issues.push({ code, message, hint });

  const root = new RegExp(`<[a-z][^>]*\\bdata-composition-id\\s*=\\s*["']${id}["'][^>]*>`, "i").exec(html)?.[0];
  if (!root) add("scene_wrong_composition", `The scene has no element with data-composition-id="${id}".`, `Wrap the shot in <div data-composition-id="${id}" data-width data-height>.`);
  else if (/\bdata-(start|duration)\s*=/.test(root)) {
    add("scene_own_timing", `The scene's root sets its own data-start or data-duration.`, "Remove them from the root: Sorot sets the shot's start and length from the plan.");
  }
  if (!new RegExp(`__timelines\\s*\\[\\s*["']${id}["']\\s*\\]\\s*=`).test(html)) {
    add("scene_missing_timeline", `The timeline isn't registered as window.__timelines["${id}"].`, `End the script with window.__timelines["${id}"] = tl;`);
  }

  const text = visibleText(html);
  for (const t of shot.text) {
    const wanted = t.value.replace(/\s+/g, " ").trim();
    if (wanted && !text.includes(wanted)) {
      add("scene_missing_text", `The planned ${t.role} "${wanted}" isn't in the scene's markup.`, "Put the text in the HTML exactly as planned (not only built by a script), or the plan and the video disagree.");
    }
  }

  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join("\n");
  for (const [re, label] of NONDETERMINISTIC) {
    if (re.test(scripts)) add("scene_nondeterministic", `The script uses ${label}.`, "A render must be the same every time: drive everything from the GSAP timeline, with no clock, random numbers, timers or network.");
  }
  if (/<script\b[^>]*\bsrc\s*=|<link\b|@import\b/i.test(html) || /(src|href)\s*=\s*["']\s*(https?:)?\/\//i.test(html) || /url\(\s*["']?\s*(https?:)?\/\//i.test(html)) {
    add("scene_remote_resource", "The scene loads something from outside the project (a script, stylesheet, font, image or CDN).", "Remove it: GSAP and the fonts are already loaded, and images must come from assets/.");
  }
  const known = new Set(project.assets);
  for (const ref of new Set([...html.matchAll(/(?<![\w/-])assets\/[\w./%@+-]+/g)].map((m) => m[0]))) {
    if (!known.has(ref)) add("scene_unknown_asset", `The scene uses ${ref}, which isn't in the project.`, `Use only these files: ${project.assets.join(", ") || "(none)"}.`);
  }
  return issues;
}
