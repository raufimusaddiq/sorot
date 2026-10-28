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
