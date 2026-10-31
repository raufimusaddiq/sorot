<!--
Authoring contract v1, passed to the director's `scene` and `repair` calls.

Derived from the HyperFrames render contract (https://github.com/heygen-com/hyperframes,
Apache-2.0, Copyright HeyGen) and its CLI docs (`hyperframes docs data-attributes|compositions|gsap`),
condensed and checked against hyperframes 0.8.223 (`lint` / `check` outputs in
backend/tests/fixtures/hyperframes/). Sorot's own rules are marked [Sorot].
-->

# Writing one scene

You write ONE file, `compositions/shot-NN.html`: a sub-composition for one shot. Sorot writes the
root `index.html`, the timing and the audio; you write only what the shot looks like and how it
moves.

## File shape

```html
<!doctype html>
<html lang="id">
  <body>
    <div data-composition-id="shot-03" data-width="1080" data-height="1920">
      <!-- the shot's elements -->
      <style>
        [data-composition-id="shot-03"] { width: 1080px; height: 1920px; /* ... */ }
        /* every rule is scoped under [data-composition-id="shot-03"] */
      </style>
      <script>
        (function () {
          window.__timelines = window.__timelines || {};
          const tl = gsap.timeline({ paused: true });
          // tweens go here, positioned in seconds from the START OF THIS SHOT
          window.__timelines["shot-03"] = tl;
        })();
      </script>
    </div>
  </body>
</html>
```

- The file is a full HTML document with no `<head>`: GSAP and the fonts are already loaded by the
  root, so never add `<script src>` or `<link>`. Select elements through the scoped
  `[data-composition-id="shot-03"] ...` prefix so shots can't touch each other.
- `data-composition-id` equals the file's shot id (`shot-NN`). `data-width` / `data-height` are
  the format size given in the request. Never change them.
- **[Sorot]** Do NOT set `data-start` or `data-duration` on the composition root. Sorot sets them
  on the host element in `index.html` from the approved plan. Elements inside the shot may use
  `data-start` / `data-duration` relative to the shot to appear and disappear on their own.
- Add `class="clip"` to elements that appear on a schedule (they carry `data-start`,
  `data-duration`). `data-track-index` is optional and only orders the Studio timeline; use CSS
  `z-index` for paint order.

## Animation

- One GSAP timeline per composition, created with `{ paused: true }` and registered on
  `window.__timelines["<composition id>"]`. The runtime seeks it; never call `play()`.
- Use `set`, `to`, `from`, `fromTo`. Safe properties: `opacity`, `x`, `y`, `scale`, `scaleX`,
  `scaleY`, `rotation`, `width`, `height`, `visibility`. The position argument is an absolute
  time in seconds on this shot's timeline.
- Finite tweens only: no `repeat: -1`. Compute repeat counts from the shot's duration.
- Every tween must have a visible reason in the plan (what it shows, hands off, or emphasises).
  Do not add decoration that the plan does not mention.

## Determinism (a render must give the same video every time)

- No `Date.now()`, `new Date()`, `performance.now()`, or unseeded `Math.random()`. If you need
  variation, use a seeded generator written inline.
- No network at render time: no `fetch`, no `XMLHttpRequest`, no CDN `<script>` or `<link>`, no
  remote images or fonts. GSAP is already loaded by the root.
- No `setTimeout`, `setInterval` or `requestAnimationFrame` to drive motion.
- Do not read the clock, the viewport size, or anything that differs between machines.

## Assets and fonts

- **[Sorot]** Use only paths that exist under `assets/` (the request lists them). Reference them
  as `assets/<file>`, never absolute or remote URLs.
- **[Sorot]** Use only the font families listed in the request (bundled or uploaded). They are
  already declared with `@font-face` in the root; refer to them by `font-family` name only.
- Images: set an explicit size or `object-fit`; do not rely on intrinsic size.

## Text

- **[Sorot]** Every piece of on-screen text from the plan's shot (`title`, `lines`, `numbers`)
  must appear in the scene exactly as written (same words, same numbers). Do not add, drop,
  translate or reword plan text. Extra text that is not in the plan is not allowed.
- **[Sorot]** Keep text inside the frame's safe area (at least 64 px from each edge) and big
  enough to read on a phone: body text at least 40 px on a 1080-wide frame, titles larger.
- **[Sorot]** A line of text stays on screen at least 0.5 s plus 0.25 s per word.
- Indonesian text is the default: use the given language as is.

## Layout

- Lay out with flex or grid and explicit sizes; avoid elements that overflow the frame or
  overlap by accident. If a `check` layout warning is intended (a label on a shape), keep it
  with a reason in `holds`.
- A scene that nothing moves in is reported as `sweep_static`. A still shot should still have at
  least a small entrance or hold motion; or mark the shot as a hold in the plan.

## How findings are reported (what you repair)

`lint` and `check` return findings with `code`, `severity` (`error` | `warning` | `info`),
`message`, `fixHint`, and a `selector` or `file`/`line`. Fix every `error`. For a `warning`
either fix it or keep it with a reason (`holds: [{code, reason}]`) when it is intended.
Examples: `missing_timeline_registry` (register the timeline), `non_deterministic_code` (remove
the clock or random call), `sweep_static` (nothing moves).

## Output

Return ONLY the JSON object the request asks for (`{"html": "..."}`; for `repair` also
`holds`). No markdown fences, no commentary.
