# Porting an agent pipeline

You already make videos with a multi-step agent pipeline of your own (a script that researches, writes,
voices, builds with HyperFrames, verifies and exports). This guide rebuilds it as a Sorot recipe without
writing code. Target: **under 30 minutes** (SC-012). Start from the template
[`examples/recipes/agent-explainer.json`](examples/recipes/agent-explainer.json); see
[generate-recipes.md](generate-recipes.md) for how recipes work.

## 1. Map your stages to steps

| Your stage | Sorot step |
|---|---|
| Find the facts, check their sources | `facts` (`research` or `verify`) |
| Write the narration | `script` (`spellNumbers` for TTS) |
| Text-to-speech, word timings | `voice`, `align` |
| Pick a story angle | `storylines` (gate `director`) |
| Name the visual idea, avoid repeating | `concept` (`novelty`) |
| Shot-by-shot plan with colours, type, easing | `plan` (`numeric`, `motionPlan`, `timingFrom: voice`) |
| Write the composition code | `author`, then `check` |
| Look at frames, fix defaults | `look` |
| Render | `render` (`delivery`) |
| Your verify script | `command` + `technical` measures |
| Review quality | `creative` criteria |
| Save the file | `export` |

A stage Sorot has no step for becomes a `command` step (below).

## 2. Put what is yours in Settings

The template contains placeholders so nothing personal ships in a recipe:

- **Voice**: Settings → Voice (engine and voice per language). The template never names a voice.
- **`MY_DATA_SOURCE`**: Settings → Data: a name and a connection for the database or API your facts
  come from (read-only). Replace the name in `facts.sources`.
- **`MY_VERIFY_COMMAND`**: Settings → Commands: your existing verifier as `name`, command, arguments,
  timeout. It must print `{"success":true,"data":{"findings":[…]}}` (see generate-recipes.md) and accept
  `--project-dir` and `--version-dir`; a thin wrapper that calls your script is fine.
- **Models**: Settings → LLM (director) and, for `look` and vision judging, a vision-capable model.

## 3. Import and tune

```bash
sorot gen recipe validate agent-explainer.json
sorot gen recipe import agent-explainer.json
sorot gen recipes            # shows "unavailable: …" until the Settings above exist
```

Then match your numbers: set `output` (size, fps, length window), `rules.layout` and `readability` to
your own, and put your acceptance questions in `creative.criteria`.

## 4. Compare with the old pipeline

Run the same brief both ways and compare the TECHNICAL numbers with your pipeline's own checks (length,
speech match, forbidden numbers, loudness): `sorot gen verdicts <version>` lists every measure with its
value and limit. Differences usually mean a limit to tune, not a missing feature.

## What carries over, and what does not

- Carries over: step order, your prompts (as step prompt text), your checks (as commands), your data.
- Is Sorot's: the output format of every model call, the plan-before-build gate, and the two verdicts.
- Not ported: anything that publishes on its own. In Sorot, publishing is a separate, explicit action.
