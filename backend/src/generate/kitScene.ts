import type { Capabilities } from "./capabilities";
import { checkPartRefs } from "./capabilities";
import { shotId } from "./composer";
import { scriptJson, type KitManifest } from "./kit";
import type { Plan, Shot } from "./planSchema";
import { contrastOf } from "./transitions";

// The kit level (research R24): the model answers with parts, settings and times for one shot
// (`submit_shot_kit`); this module checks the answer and writes compositions/shot-NN.html from it, so
// a model that can't write a scene still makes a finished one. The planned text is always written
// into the markup, in the plan's words; the parts draw and move around it.

export interface KitLayer { part: string; settings: Record<string, unknown>; fromSec: number; toSec: number; layer?: number }
export interface KitShot { shotId: string; layers: KitLayer[]; text: Array<{ role: string; value: string }> }

const MAX_LAYERS = 8;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Checks a kit-level answer: the shot, known and allowed parts with valid settings, times inside the shot, and only planned lines. */
export function validateKitShot(parsed: unknown, shot: Shot, caps: Capabilities | undefined, kit: KitManifest[]): { value?: KitShot; errors?: string[] } {
  const errors: string[] = [];
  const o = isObj(parsed) ? parsed : {};
  if (o.shotId !== shot.id) errors.push(`shotId must be "${shot.id}"`);
  const raw = Array.isArray(o.layers) ? o.layers : [];
  if (raw.length < 1 || raw.length > MAX_LAYERS) errors.push(`layers: 1 to ${MAX_LAYERS} parts`);
  const layers: KitLayer[] = raw.map((l, i) => {
    const x = isObj(l) ? l : {};
    const fromSec = typeof x.fromSec === "number" ? round2(x.fromSec) : 0;
    const toSec = typeof x.toSec === "number" ? round2(x.toSec) : shot.durationSec;
    if (fromSec < 0 || toSec > shot.durationSec + 0.01 || toSec <= fromSec) errors.push(`layers[${i}]: fromSec and toSec must lie inside the shot's ${shot.durationSec} s, from before to`);
    return {
      part: typeof x.part === "string" ? x.part : "", settings: isObj(x.settings) ? x.settings : {}, fromSec, toSec: Math.min(toSec, shot.durationSec),
      ...(Number.isInteger(x.layer) ? { layer: x.layer as number } : {}),
    };
  });
  if (caps) errors.push(...checkPartRefs(layers, caps, kit, "layers").map((p) => p.message));
  const planned = new Set(shot.text.map((t) => t.value.replace(/\s+/g, " ").trim()));
  const text = (Array.isArray(o.text) ? o.text : []).filter(isObj).map((t) => ({ role: typeof t.role === "string" ? t.role : "body", value: typeof t.value === "string" ? t.value : "" }));
  for (const t of text) if (!planned.has(t.value.replace(/\s+/g, " ").trim())) errors.push(`text "${t.value}" isn't one of the shot's planned lines (${[...planned].map((p) => `"${p}"`).join(", ") || "none"})`);
  return errors.length ? { errors } : { value: { shotId: shot.id, layers, text } };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const HEX = /^#[0-9a-fA-F]{3,8}$/;
const roleClass = (role: string) => `t-${role.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "body"}`;

/** The palette colour that reads best on the ground (WCAG contrast), for the shot's text. */
export function inkOn(palette: string[]): { ground: string; ink: string } {
  const hexes = palette.filter((c) => HEX.test(c));
  const ground = hexes[0] ?? "#000000";
  const candidates = [...hexes.slice(1), "#ffffff", "#000000"];
  const ink = candidates.reduce((best, c) => ((contrastOf(c, ground) ?? 0) > (contrastOf(best, ground) ?? 0) ? c : best), candidates[0]!);
  return { ground, ink };
}

export interface KitSceneInput {
  plan: Plan;
  index: number;
  width: number;
  height: number;
  answer: KitShot;
  kit: KitManifest[];
}

/**
 * The scene for a kit-level shot: a stage with one layer per part (back to front), the planned text
 * in the plan's words and order, and a script that mounts each part on the shot's timeline between
 * its times. A part with a `target` setting acts on the stage (the text, the other layers); a part
 * without one draws into its own layer.
 */
export function writeKitScene({ plan, index, width, height, answer, kit }: KitSceneInput): string {
  const shot = plan.shots[index]!;
  const id = shotId(index);
  const { ink } = inkOn(plan.look.palette);
  const font = plan.look.fonts[0] ?? "sans-serif";
  const roles = new Map(answer.text.map((t) => [t.value.replace(/\s+/g, " ").trim(), t.role]));
  const lines = shot.text.map((t) => ({ role: roles.get(t.value.replace(/\s+/g, " ").trim()) ?? t.role, value: t.value }));
  const layers = answer.layers.map((l, i) => ({ ...l, order: l.layer ?? i })).sort((a, b) => a.order - b.order);
  const acts = (part: string) => kit.find((m) => m.name === part)?.settings.target !== undefined;
  const sel = `[data-composition-id="${id}"]`;
  const title = Math.round(height * 0.065);
  const body = Math.round(height * 0.036);
  // the arrival the text gets when no part reveals it; the film's first frame must not be empty
  const revealed = layers.some((l) => acts(l.part) && /\.t-/.test(String(l.settings.target ?? "")));
  const textIn = revealed ? "" : index === 0
    ? `tl.fromTo(root.querySelector(".k-text"), { y: 30 }, { y: 0, duration: 0.6, ease: "expo.out" }, 0);`
    : `tl.fromTo(root.querySelector(".k-text"), { y: 40, opacity: 0 }, { y: 0, opacity: 1, duration: 0.6, ease: "expo.out" }, 0.15);`;
  const mounts = layers.map((l, i) => {
    const host = acts(l.part) ? "stage" : `layers[${i}]`;
    const seed = `${shot.id}-${l.part}-${i}`;
    return `SorotKitRuntime.mount(${scriptJson(l.part)}, ${host}, ${scriptJson(l.settings)}, { tl: tl, start: ${l.fromSec}, duration: ${round2(l.toSec - l.fromSec)}, seed: ${scriptJson(seed)} });`;
  });
  return `<!doctype html>
<html lang="${esc(plan.language)}"><body>
  <div data-composition-id="${id}" data-width="${width}" data-height="${height}">
    <style>
      ${sel} { position: relative; width: ${width}px; height: ${height}px; overflow: hidden; }
      ${sel} .k-stage, ${sel} .k-layer { position: absolute; left: 0; top: 0; width: ${width}px; height: ${height}px; }
      ${sel} .k-text { position: absolute; left: ${Math.round(width * 0.08)}px; width: ${Math.round(width * 0.84)}px; top: ${Math.round(height * 0.3)}px; display: flex; flex-direction: column; gap: ${Math.round(height * 0.02)}px; color: ${ink}; font-family: "${esc(font)}", sans-serif; text-align: center; }
      ${sel} .k-text .t-title { font-size: ${title}px; font-weight: 700; line-height: 1.1; }
      ${sel} .k-text p { font-size: ${body}px; font-weight: 400; line-height: 1.3; }
    </style>
    <div class="k-stage">
${layers.map((l, i) => `      <div class="k-layer" data-kit-layer="${i}" data-part="${esc(l.part)}" style="z-index: ${i}"></div>`).join("\n")}
      <div class="k-text" style="z-index: ${layers.length}">
${lines.map((t) => (t.role === "title" ? `        <h1 class="${roleClass(t.role)}">${esc(t.value)}</h1>` : `        <p class="${roleClass(t.role)}">${esc(t.value)}</p>`)).join("\n")}
      </div>
    </div>
    <script>
      (function () {
        var root = document.querySelector('${sel}');
        var stage = root.querySelector(".k-stage");
        var layers = root.querySelectorAll("[data-kit-layer]");
        window.__timelines = window.__timelines || {};
        var tl = gsap.timeline({ paused: true });
        ${mounts.join("\n        ")}
        ${textIn}
        window.__timelines["${id}"] = tl;
      })();
    </script>
  </div>
</body></html>
`;
}
