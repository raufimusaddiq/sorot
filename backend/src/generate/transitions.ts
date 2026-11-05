// The seams between shots. HyperFrames' shader transitions are whole demo compositions that capture
// their own two scenes, so they can't sit between Sorot's shot hosts; Sorot writes each seam itself,
// on the root timeline, as GSAP tweens on the shot hosts and one overlay per seam (research R3,
// phase 12). Each half of a seam runs inside its own shot, so the plan's timing never moves.
// The kinds follow HyperFrames' motion guide ("Transitions with a cause").

export interface TransitionKind { name: string; description: string }

export const TRANSITIONS: readonly TransitionKind[] = [
  { name: "cut", description: "a hard cut: nothing between the shots" },
  { name: "fade", description: "dips to the ground colour and back: a pause, a change of time or place" },
  { name: "blur", description: "the shot blurs out and the next one sharpens in on the same stage" },
  { name: "flash", description: "a flash through white: an impact, a reveal, a number landing" },
  { name: "light-leak", description: "a warm film light leak washes over the seam: memory, warmth, a soft turn" },
  { name: "wipe", description: "a band of the accent colour sweeps across and uncovers the next shot: a list, a step forward" },
  { name: "zoom", description: "pushes into the shot with blur and lands on the next one: going deeper, a detail" },
  { name: "iris", description: "a circle closes on the centre and opens on the next shot: focus on one thing" },
];

export const TRANSITION_NAMES = TRANSITIONS.map((t) => t.name);

/** Words a director (or an older plan) uses for one of the kinds. */
const ALIASES: Record<string, string> = {
  "": "cut", none: "cut", "hard cut": "cut", "hard-cut": "cut", "match cut": "cut", "match-cut": "cut",
  crossfade: "fade", dissolve: "fade", "fade-through": "fade", "dip to black": "fade",
  "blur swap": "blur", "blur-swap": "blur", "whip pan": "blur", "whip-pan": "blur",
  "flash-through-white": "flash", "white flash": "flash", "light leak": "light-leak", leak: "light-leak",
  slide: "wipe", push: "wipe", "zoom through": "zoom", "zoom-through": "zoom", "push in": "zoom", "iris-reveal": "iris",
};

/** WCAG relative luminance of a #rgb / #rrggbb colour (alpha ignored); null for anything else. */
export function luminance(hex: string): number | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join("") : m[1]!;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** WCAG contrast ratio between two colours (1 to 21); null when either isn't a hex colour. */
export function contrastOf(a: string, b: string): number | null {
  const la = luminance(a);
  const lb = luminance(b);
  if (la === null || lb === null) return null;
  return Math.round(((Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)) * 100) / 100;
}

/** Below this a seam's colour hardly shows on the ground (a white flash on a white film). */
export const SEAM_MIN_CONTRAST = 1.5;

/**
 * The colour a seam paints over the ground, for the kinds that paint one: a white flash, the
 * accent's wipe, the warm light leak. The others move or veil the shots themselves.
 */
export function seamColour(kind: string, palette: string[]): string | null {
  return kind === "flash" ? "#ffffff" : kind === "wipe" ? accentOf(palette) : kind === "light-leak" ? "#ffc890" : null;
}

/** Chroma (max - min channel, 0 to 1) of a hex colour that `luminance` accepts. */
function chroma(hex: string): number {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(hex.trim());
  if (!m) return 0;
  const h = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join("") : m[1]!;
  const ch = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return (Math.max(...ch) - Math.min(...ch)) / 255;
}

/**
 * The film's accent: plans order the palette ground, ink, accent... but not always, so it is the
 * most saturated colour that is neither the ground (the first) nor the ink (the colour that stands
 * out most on the ground, as `inkOn` picks it); the first wins a tie. A palette of only ground and
 * ink gets the ink; one with no second colour, white.
 */
export function accentOf(palette: string[]): string {
  const hexes = palette.filter((c) => luminance(c) !== null);
  const [ground, ...rest] = hexes;
  if (!ground || !rest.length) return "#ffffff";
  const ink = rest.reduce((best, c) => (contrastOf(c, ground)! > contrastOf(best, ground)! ? c : best));
  const others = rest.filter((c) => c !== ink);
  return others.length ? others.reduce((best, c) => (chroma(c) > chroma(best) ? c : best)) : ink;
}

/** The kind a plan's transition names, or null when it names none Sorot can build. */
export function transitionKind(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  return TRANSITION_NAMES.includes(s) ? s : ALIASES[s] ?? null;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

export interface SeamInput {
  /** The kind on each shot: how that shot enters from the one before (the first shot's is ignored). */
  transitions: string[];
  starts: number[];
  durations: number[];
  /** The ground colour (fade, iris) and the accent (wipe). */
  ground: string;
  accent: string;
  /** Host element id of the shot at an index: host-01... */
  host: (index: number) => string;
}

export interface Seams {
  /** One overlay element per seam that needs one, placed above the shot hosts. */
  overlays: string[];
  /** Lines of GSAP on the root timeline `tl`. */
  tweens: string[];
  /** The non-cut seams, as `{ index, kind }` (index = the shot that enters). */
  used: Array<{ index: number; kind: string }>;
}

/**
 * Overlays and tweens for every seam. Half a seam is `half` seconds: a fifth of the shorter of the
 * two shots, at most 0.4 s, so a short shot keeps most of its time to itself.
 */
export function seams({ transitions, starts, durations, ground, accent, host }: SeamInput): Seams {
  const overlays: string[] = [];
  const tweens: string[] = [];
  const used: Seams["used"] = [];
  for (let i = 1; i < transitions.length; i++) {
    const kind = transitionKind(transitions[i] ?? "") ?? "cut";
    if (kind === "cut") continue;
    used.push({ index: i, kind });
    const at = starts[i] as number;
    const half = r3(Math.min(0.4, 0.2 * Math.min(durations[i - 1] as number, durations[i] as number)));
    const before = r3(at - half);
    const out = `"#${host(i - 1)}"`;
    const into = `"#${host(i)}"`;
    const seam = `"#seam-${String(i + 1).padStart(2, "0")}"`;
    const overlay = (style: string) => overlays.push(
      `      <div id="${seam.slice(2, -1)}" class="seam" aria-hidden="true" style="position:absolute;inset:0;pointer-events:none;z-index:50;opacity:0;${style}"></div>`,
    );
    const veil = (peak: number, fadeIn: number) => {
      tweens.push(`      tl.fromTo(${seam}, { opacity: 0 }, { opacity: ${peak}, duration: ${fadeIn}, ease: "power2.in", immediateRender: false }, ${r3(at - fadeIn)});`);
      tweens.push(`      tl.to(${seam}, { opacity: 0, duration: ${half}, ease: "power2.out" }, ${at});`);
    };
    if (kind === "fade") {
      overlay(`background:${ground};`);
      veil(1, half);
    } else if (kind === "flash") {
      overlay("background:#ffffff;");
      veil(1, r3(half * 0.6));
    } else if (kind === "light-leak") {
      overlay("background:radial-gradient(circle at 82% 18%, rgba(255,236,200,0.95) 0%, rgba(255,160,70,0.75) 28%, rgba(255,90,40,0.35) 52%, rgba(255,90,40,0) 75%);mix-blend-mode:screen;inset:0 -15%;");
      tweens.push(`      tl.fromTo(${seam}, { xPercent: 12 }, { xPercent: -12, duration: ${r3(half * 2)}, ease: "sine.inOut", immediateRender: false }, ${before});`);
      veil(1, half);
    } else if (kind === "wipe") {
      overlay(`background:${accent};clip-path:inset(0 100% 0 0);opacity:1;`);
      tweens.push(`      tl.fromTo(${seam}, { clipPath: "inset(0% 100% 0% 0%)" }, { clipPath: "inset(0% 0% 0% 0%)", duration: ${half}, ease: "power3.in", immediateRender: false }, ${before});`);
      tweens.push(`      tl.to(${seam}, { clipPath: "inset(0% 0% 0% 100%)", duration: ${half}, ease: "power3.out" }, ${at});`);
    } else if (kind === "iris") {
      overlay(`background:${ground};clip-path:circle(0% at 50% 50%);opacity:1;`);
      tweens.push(`      tl.fromTo(${seam}, { clipPath: "circle(0% at 50% 50%)" }, { clipPath: "circle(75% at 50% 50%)", duration: ${half}, ease: "power2.in", immediateRender: false }, ${before});`);
      tweens.push(`      tl.to(${seam}, { clipPath: "circle(0% at 50% 50%)", duration: ${half}, ease: "power2.out" }, ${at});`);
    } else if (kind === "blur") {
      tweens.push(`      tl.fromTo(${out}, { filter: "blur(0px)" }, { filter: "blur(14px)", duration: ${half}, ease: "power2.in", immediateRender: false }, ${before});`);
      tweens.push(`      tl.fromTo(${into}, { filter: "blur(14px)" }, { filter: "blur(0px)", duration: ${half}, ease: "power2.out", immediateRender: false }, ${at});`);
    } else {
      // zoom
      tweens.push(`      tl.fromTo(${out}, { scale: 1, filter: "blur(0px)" }, { scale: 1.18, filter: "blur(10px)", duration: ${half}, ease: "power3.in", immediateRender: false }, ${before});`);
      tweens.push(`      tl.fromTo(${into}, { scale: 0.88, filter: "blur(10px)" }, { scale: 1, filter: "blur(0px)", duration: ${half}, ease: "power3.out", immediateRender: false }, ${at});`);
    }
  }
  return { overlays, tweens, used };
}
