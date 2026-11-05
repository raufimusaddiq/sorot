# Writing and sharing a kit part

A kit part is a small browser script that draws or moves something, with a manifest that tells a
director what it does and which settings it takes. Parts make every director better: a small model
builds whole shots from them at the `kit` level, and a strong one mounts them in its own scenes. The
contract is in `specs/001-2d-video-generator/contracts/kit.md`; this page is the how-to.

## A part on disk

```text
glow-ring/
  part.json      the manifest
  part.js        one browser script (no build step, nothing from the network)
  example.json   the settings, length and markup the check renders
  ...            any local files the script needs (an image, a pinned library)
```

### part.json

```json
{
  "name": "glow-ring",
  "version": "1.0.0",
  "does": "A soft ring of light that breathes in once behind a shape.",
  "runtime": "dom",
  "needs": { "gpu": "no" },
  "settings": {
    "target": { "t": "str", "max": 120 },
    "size": { "t": "num", "min": 0.2, "max": 2 },
    "color": { "t": "str", "max": 30 }
  },
  "defaults": { "target": "", "size": 1, "color": "" },
  "example": "A ring behind the title: {\"target\": \".t-title\", \"size\": 1.2}."
}
```

- `name`: lowercase letters, digits and `-`, at most 40 characters; not a built-in's name.
- `does` and `example`: one line each. They go to the director word for word, so say what it sees.
- `runtime`: `dom` (HTML/SVG and GSAP), `canvas` or `webgl`. WebGL parts are offered only at the
  `free` level, and only where the machine draws WebGL.
- `needs.gpu`: `no`, `preferred` (draws on a CPU, slowly) or `required`. A part that wants a GPU is
  timed against the frame budget.
- `settings`: the recipe field schema (`bool`, `int`, `num`, `enum`, `str`, `strs`, `obj`, `list`).
  A setting named `target` means the part acts on elements already in the shot (a CSS selector; empty
  means the whole shot); without one, the part draws into an empty layer of its own.
- `defaults`: valid values for some or all settings.

### part.js

```js
window.SorotKit = window.SorotKit || {};
window.SorotKit["glow-ring"] = {
  mount(host, s, ctx) {
    // ctx: { tl, start, duration, fps, rand, look: { palette, keyLightDeg }, size: { width, height } } (size = the host's box, else the frame)
    const ring = document.createElement("div");
    ring.style.cssText = `position:absolute;left:50%;top:40%;width:${400 * s.size}px;height:${400 * s.size}px;` +
      `margin:-${200 * s.size}px;border-radius:50%;background:radial-gradient(circle, ${s.color || ctx.look.palette[2]} 0%, transparent 70%)`;
    host.appendChild(ring);
    ctx.tl.fromTo(ring, { scale: 0.6, opacity: 0 }, { scale: 1, opacity: 0.8, duration: 1.2, ease: "expo.out" }, ctx.start);
  },
};
```

The rules are the scenes' rules, because a render must be the same every time:

- No clock (`Date.now`, `performance.now`), no timers, no `requestAnimationFrame`, no network, no
  `Math.random`. Use `ctx.rand()` (seeded) for anything random.
- Put motion on `ctx.tl` at times from `ctx.start`, or return `{ render(t) }` and draw time `t` from
  scratch (Sorot drives it from the timeline, so any frame can be drawn in any order).
- Light things from `ctx.look.keyLightDeg` (0 = from the top, clockwise) and colour them from
  `ctx.look.palette`, so your part matches the rest of the film.
- Prefer gradients to `filter: blur()` and big `box-shadow`s: on a CPU, blur made a scene 4 to 5
  times slower to render (2026-11-01 measurement).

Scenes mount a part with `SorotKitRuntime.mount("glow-ring", host, { size: 1.2 }, { tl, start: 0.5, duration: 2 })`;
the runtime adds your defaults and builds `ctx`.

### example.json

```json
{ "durationSec": 2, "settings": { "target": ".title" }, "markup": "<h1 class=\"title\" style=\"...\">Hello</h1>" }
```

`markup` is put in the example's stage before the part is mounted, so a part with a `target` has
something to act on.

## Adding it

```bash
sorot gen kit add ./glow-ring
```

Or zip the folder and add it in Settings → Generate → Kit. Sorot then:

1. validates the manifest and the example's settings, and refuses a script that uses a clock, timers,
   `Math.random` or the network, or that doesn't register `window.SorotKit["<name>"]`;
2. renders the example in a throwaway project: `lint` and `check` must report no errors, and two
   renders of its first second must give the same frames (compared with ffmpeg's `framemd5`);
3. stores it in `data/kit/<name>/` and offers it to directors from their next call.

Adding a part with the same name again replaces your earlier copy.

## Sharing it

`sorot gen kit export glow-ring -o glow-ring.zip` (or Export in Settings) gives a `.zip` anyone can
add. A recipe only **names** parts, in the author step: `"require": ["kit:glow-ring"]`. On an install
without that part the recipe shows as unavailable ("kit part glow-ring isn't installed"); a recipe never
carries part code, so importing one can't bring in a script.
