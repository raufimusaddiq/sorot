# Kit Contract: parts, levels and the capability description

FR-038 to FR-047, research [R22 to R30](../research.md#part-3-any-look-any-director-2026-11-01).
The kit raises the floor of quality; it never limits what a director may draw.

## A part on disk

```text
<name>/
  part.json      the manifest (below)
  part.js        one browser script, no build step, no imports from the network
  example.json   the settings, shot length (durationSec) and optional markup (placed in the example's stage) the check renders
  (any local files the script needs: textures, fonts, a pinned library)
```

Built-in parts: `generator/kit/<name>/`. User parts: `data/kit/<name>/`.

### part.json

```json
{
  "name": "shade",
  "version": "1.0.0",
  "does": "Lights any shape from the film's key light: gradient body, highlight and rim.",
  "runtime": "dom",
  "needs": { "gpu": "no" },
  "settings": {
    "material": { "t": "enum", "values": ["matte", "gloss", "metal", "glass", "paper"] },
    "strength": { "t": "num", "min": 0, "max": 1 }
  },
  "defaults": { "material": "matte", "strength": 0.6 },
  "example": "A circle lit from the upper left as a metal coin."
}
```

- `name`: lowercase slug, unique on the install.
- `runtime`: `dom` (HTML/SVG + GSAP), `canvas` or `webgl`. Tells the capability description what
  the machine must draw.
- `needs.gpu`: `no`, `preferred` (runs on CPU but slowly) or `required`. With `preferred` or
  `required` the part counts against the frame-time budget, and a CPU install's `maxLevel` may
  hide it.
- `settings`: the recipe field schema (`steps/schema.ts`: bool, int, num, enum, str, strs, obj,
  list), so the same checker validates kit-level answers and the UI can draw a form.
- `does` and `example`: one line each; they go to the director verbatim.

### part.js

```js
window.SorotKit = window.SorotKit || {};
window.SorotKit["shade"] = {
  mount(host, settings, ctx) {
    // ctx: { tl, start, duration, fps, rand (seeded), look: { palette, keyLightDeg }, size: {width, height} }
    // draw into host; add motion to ctx.tl at times relative to the shot; or return { render(t) }
  },
};
```

Scenes mount parts through the runtime the root loads (`generator/kit/_runtime.js`):
`SorotKitRuntime.mount(name, host, settings, { tl, start, duration, seed })` merges the part's
defaults, builds `ctx` and, when `mount` returns `{ render(t) }`, drives it from a timeline tween.

Rules (the scene determinism rules, R3): no clock, no network, no unseeded randomness, no timers;
motion lives on `ctx.tl` or in a pure `render(t)`. Heavy setup returns a promise registered on
`window.__hf.buildReady`.

### Adding a user part (`sorot gen kit add`)

1. The manifest validates; the name is free; the files stay inside the part's folder.
2. The example renders in a throwaway project: `lint` and `check` have no errors, and two renders
   give the same frames.
3. It is stored in `gen_kit_part` and offered to the director on its next call.

A recipe only names parts (`author.require`, a shot's `look.parts`); it never carries part code.

## Levels (per shot)

| Level | The director returns | Checks |
|---|---|---|
| `kit` | `submit_shot_kit`: `{shotId, layers: [{part, settings, fromSec, toSec, layer?}], text}` | parts and settings against the capability description; Sorot writes the scene |
| `compose` | `submit_scene` HTML that mounts kit parts (`SorotKit["x"].mount`) and adds its own GSAP | plan-lock, kit calls (known parts, valid settings), lint/check |
| `free` | `submit_scene` HTML with any drawing code the contract allows (its own canvas, WebGL, Three.js via the `three` part) | the same, plus the frame-time budget |

Implementation note (owner's decision, 2026-11-02): a WebGL **part** (`three`, `iso`) is offered at
every level on a machine that can draw WebGL, since it is Sorot's own tested code; what stays
`free`-only is the model writing its own canvas/WebGL.

Fallback: after the step's repair rounds, or over the frame-time budget, the shot is rebuilt one
level down from the same shot spec, with a `level_drop` finding. A failure at `kit` fails the
build.

Choosing (`author.level: auto`), revised by the owner on 2026-11-02 ("we don't stop our director's
creativity"): every shot starts at the highest level ≤ `maxLevel` and the machine's cap; the record
(`gen_model_record`, Calibrate) is reported as the model's proven level and never lowers where a
shot starts. A pin per recipe (`author.level`) or per model (Settings) wins.

## The capability description (every director call)

Generated per call from what is installed and connected, never written by hand:

```json
{
  "capabilities": {
    "level": "compose",
    "levelMeans": "write the scene HTML; use kit parts by mounting them; no WebGL",
    "kit": [{ "name": "shade", "does": "...", "runtime": "dom" }],
    "kitDetail": { "shade": { "settings": { "...": "..." }, "defaults": {}, "example": "..." } },
    "renderer": { "hyperframes": "0.8.223", "runtimes": ["dom", "canvas", "webgl"], "gpu": true, "frameBudgetMs": 400 },
    "connections": { "image": true, "voice": true, "vision": false }
  }
}
```

- Plan calls get `kit` (name and one line per part); scene and kit-level calls also get
  `kitDetail` for the parts the shot uses or may use.
- Answers outside it (an unknown part or setting, a runtime the level or machine doesn't allow)
  are validation errors sent back with the director's one repair call.
