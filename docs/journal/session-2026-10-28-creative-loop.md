# Session 2026-10-28 — creative loop: LLM director, Jev gate, Tebar

Asks: (1) drive the creative work from the LLM instead of under-using it,
(2) Jev as a quality gate with the *right* questions, (3) Tebar as the social
connector; mid-session: LLM/Jev configurable from UI + CLI, a deterministic
fallback everywhere, and "Bun first, Python second". Design + sources:
[creative-loop.md](../creative-loop.md).

## Found
- The LLM only re-rated rule windows (batches of 6, 900 chars, no video
  context): it never chose clip boundaries or hooks, and couldn't be steered.
- Hooks were picked by a regex-score rule inside Python (render/subtitle).
- No publishing; learning needed views/likes typed in by hand.
- The pipeline's in-memory `video` kept `title: null` after IMPORT fetched it,
  so later stages never saw the title (fixed: brief/review now get it).
- CLI `--url` is the global server option: a `connect --url` would have sent
  the request to the LLM host. The connection flag is `--base-url`.

## Changed
- **Director** (`director.ts`): brief (`video.brief`), LLM moments per ~5-min
  part (ids validated, 10-60 s, hook ≤ 6 s sentence), review sees brief +
  direction, overlaps dropped after scoring. `LLM_DIRECTOR` / Settings toggle.
  Job option `direction` (UI textarea, `--direction`).
- **Gate** (`clipGate.ts`, `jev.ts`): 11 questions (5 quality, 5 risk Nouls,
  title check), verdict in code, FAIL → SKIP ranked last, REVIEW = person
  decides. Rules answer the same questions without Jev. `clip.gate*` columns.
  `clipsForVideo` now orders by `rank_pos`.
- **Hooks in Bun** (`hooks.ts`, golden fixture `hooks.json` from the Python):
  every segment carries `hookStart/hookEnd` (null = none); Python only replays.
- **Tebar** (`tebar.ts`, `publisher.ts`): draft / publish (idempotent, body
  saved first) / refresh / retry / sync → `clip_feedback`. `social_post` table.
- **Settings** (`settings.ts`, `setting` table): UI Settings app, `sorot
  connect` (`--key -` from stdin), test calls. Keys masked.
- **Eval** (`gateEval.ts`, `scripts/jev-eval.ts`, synthetic fixture
  `jev-gate-eval.json`): per-question right/unsure/wrong + separation, Jev vs
  rules. It exposed rule gaps (endings on "adalah", "dijamin … sembuh",
  greeting openings); fixed generally → rules 10/12 verdicts on that fixture.

## Verification
- `/verify` gate OPEN. Backend 288/288 (99.5% lines; touched modules:
  clipGate, director, hooks, jev, settings, tebar, gateEval, clipReview,
  options 100%, orchestrator 99.3%, editor 98.6%, publisher 96.6%), tsc
  clean; CLI 38/38 (99.8% lines); UI 133/133 + static build; Python 219/219
  (captions 100%, render 99%, subtitle 99%).
- render.py by hand: success → one `{"success": true}` JSON line on stdout;
  missing segments file → `{"success": false, "error": …}`, exit 1.
- Real `render.py` + ffmpeg: Bun-chosen hook 4.0-5.3 s replayed (11.57 s
  output = 1.55 + 10); `hookStart: null` → no replay (10.0 s) although
  `find_hook` would have found one.
- Real backend → real APIs with invalid keys: TypeSafe `/v1/systemone` 401
  `authentication_error`, Tebar `/v1/me` 401 `invalid_api_key`; both shown as
  test failures, keys masked in `/api/settings`.

## Not verified
- Jev on real (or the synthetic) Indonesian clips: no TypeSafe key here.
  Thresholds 0.7/0.3 are TypeSafe's starting points, not calibrated.
- Tebar publish/insights with a real key; the insights response shape isn't in
  Tebar's docs (tolerant parser). TikTok creator-info shape assumed from the
  option names in the docs.
- Director quality on a real LLM (only fakes in tests); full pipeline with
  Whisper (no model download here).

## Live tests (same day, keys provided: Jev + an OpenAI-compatible Kimi K3 gateway)
- **Jev** (`jev-1.14.0`, `bun run jev-eval`, 16 synthetic cases, ~22k input
  tokens): every labelled yes/no on the right side of 0.7/0.3, separation
  0.74-0.95 (rules 0.20-0.60, risks only "unsure"); verdicts 11/12. The two
  misses were label errors (payoff rubric; an unnamed group = needs context),
  fixed after seeing the answers → 12/12 (circular), rules 9/12.
- **LLM `kimi-k3-1-pro`** is a reasoning model, and the first live run broke
  three things the fakes didn't: (1) `max_tokens` covers its thinking — 20
  tokens gave `content: null`; budgets are now `LLM_MAX_TOKENS` (4000) and an
  empty answer cut by the budget is an LlmError; (2) over a 5-min transcript it
  ignored the system prompt (summarised, or asked "what should I do with
  this?") → 0 picks; every request now ends with a `task` field restating the
  job + format → 18 picks on the 28-min transcript; (3) it read `"hook"` as
  "write a hook" (text) → field renamed `hook_line` (id). Also: a gateway error
  inside HTTP 200 (`all_providers_failed`) now reads "LLM error: …".
- Latency: 30-150 s per call → `LLM_TIMEOUT=300` for this model; review
  batches now run 2 at a time.
- `/verify` (Segment + Score) OPEN: 60/60 focused tests, llm/director/
  clipReview 100%; full backend 289/289. Live SEGMENT on 10 min of the real
  transcript with direction "fokus ke kritik soal harga dan spesifikasi, bukan
  unboxing": brief + 5 LLM picks (all price/spec/brand critique, each with a
  hook line) next to 11 rule windows; without a direction the picks included
  unboxing moments.
- **Full pipeline, real LLM + Jev + Python** (10 min of the real transcript
  over a synthetic 320x180 video, transcript pre-placed — no Whisper model
  here; direction as above; CPU, MAX_RENDER_CLIPS=3, HOOK_FIRST): COMPLETED in
  570 s — SEGMENT 104 s (brief + 3 parts), SCORE 435 s (media features, LLM
  review, Jev gate), RENDER 33 s. 16 candidates → 11 after overlaps; review
  followed the direction (unboxing clips 0.08-0.25, price critique 0.98); one
  review batch hit "upstream unavailable" → 6 candidates kept rule-only scores.
  Jev: both render-tier clips PASS; flagged the "Halo guys…" opening as weak
  (0.26) — the replayed rule hook covers it; replaced one over-claiming LLM
  title (0.92) with the rule title, which is weak ("Dimensity 8400 ya").
  Renders 1080x1920: 55.13 s = 51.16 + 3.9 s rule hook; 40.29 s = 37.76 +
  2.5 s LLM hook. Low tiers (no PRIMARY) come from the synthetic video (no
  faces / motion), not the LLM.
- Fix from that run: one retry for transient LLM failures (network, 429/5xx,
  gateway error in a 200; not timeouts, not 4xx). `/verify` OPEN: 72/72 focused, llm/clipReview/director 100%; backend 290/290.
