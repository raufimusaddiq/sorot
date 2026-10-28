# The creative loop: LLM director → Jev gate → Tebar → learning

> Design + what is built (2026-10-28). Three asks: (1) let the LLM drive the
> creative work instead of only re-rating rule output, (2) put Jev in as a
> quality gate that asks the *right* questions, (3) publish through
> [Tebar](https://tebar.app). Together they close a loop Sorot didn't have:
> the clips you post now feed their real results back into scoring.

```
 transcript ──► 🎬 DIRECTOR (LLM) ─────► ⚖️ SCORE ───► 🚦 GATE (Jev) ──► render ──► 🚀 PUBLISH (Tebar)
   brief · own moments · hook       rules + LLM review   PASS/REVIEW/FAIL            draft → you → post
        ▲   (rules always kept as candidates)                 │ rules if no Jev               │
        │                                                     ▼                               ▼
        └────────────── weights.json ◄── feedback training ◄── clip_feedback ◄── metrics sync (6 h)
```

Every arrow has a deterministic fallback: no LLM → rule segments, rule hook,
template copy; no Jev → the same gate questions answered by text rules; no
Tebar → download and post by hand (results can still be typed in).

---

## 1. LLM-led creative process ("director")

### What was under-used

Before: the LLM saw rule-made 10-60 s windows (cut at pauses) in batches of 6,
truncated to 900 characters, with no idea what the video was about. It could
re-rate them and write copy — it couldn't choose *where a clip starts or
ends*, which line is the hook, or follow what the creator wanted.

### What the LLM decides now (`backend/src/director.ts`)

| Step | LLM call | Code keeps |
|---|---|---|
| **Brief** | 1 call on a transcript sample (≤ 6 000 chars, evenly spaced runs): summary, topics, people (spelled right), audience, angle. Saved on the video (`video.brief`). | — |
| **Moments** | 1 call per ~5-minute part (45 s overlap, fits a 4k-context local model): up to 4 moments as line ids `{start, end, hook, why}`. | ids must exist and sit in that part; 10-60 s (trimmed / extended by whole lines); hook inside the clip, cut to one 1.2-6 s sentence; duplicates across parts dropped. |
| **Review** | as before, now with the brief (title, summary, people) and the direction. | 50/50 blend with the rule score. |
| **Hook** | the moment's `hook` line. | Bun decides *every* hook now (rules port of `find_hook` for rule clips); render.py only replays it. |
| **Copy per platform** | at publish time: TikTok / Instagram / YouTube / Threads / X / LinkedIn styles. | platform limits (characters, hashtags) cut in code; Jev checks it. |

Rule windows are always kept as candidates; after scoring, any two candidates
overlapping by more than half of the shorter one keep only the better-scored.

**Direction** — a free-text field at import (UI *Options*, `sorot import
--direction "…"`, API `options.direction`, ≤ 500 chars): "only the funny
parts", "Pak Budi's money advice", "for TikTok, 30-45 s". It reaches the
brief, the moment picks, the review score and the post copy.

**Cost/latency** — about `1 + minutes/4.25 + candidates/6` LLM calls per video
(an hour: ~1 + 14 + ~20). `LLM_DIRECTOR=false` (or the Settings toggle) goes
back to review-only. After 2 failed parts in a row the director stops and the
rules carry on; the stage text shows "LLM picking moments 3/14".

**Why not an agent loop?** The discovery agent is a tool-calling loop; here a
fixed map-reduce is easier to bound (calls, time, context size), works on small
local models, and every LLM output is checked in code before it is used.

---

## 2. Jev as the quality gate

### Why Jev here

Jev (TypeSafe's "System One" decision model) doesn't write text: it answers
typed questions — `noul` (probability of yes), `choice`, `score` (ordered
levels) — about a `state`, with calibrated probabilities. That is what a gate
needs: bounded answers code can threshold, cheap enough to run on every clip.
Per TypeSafe's model page (checked 2026-10-28; prices change): `jev-1.14.0`,
$0.042 per million input tokens, output free, 64k tokens per request / 32k per
question, **English is its best language** — "test on your own content before
relying on Jev for a non-English workload".
Sources: [Models](https://docs.typesafe.ai/models.md),
[System One API](https://docs.typesafe.ai/api/system-one.md).

### Where it runs

1. **Clip gate** (SCORE stage, before render): the best ≤ 40 clips in the render
   tiers, one request each (4 in flight). FAIL → tier SKIP (not rendered,
   still listed with the reason, renderable on request) and ranked last.
2. **LLM title check**: when the LLM wrote the title, `title_overclaims` asks if
   it claims more than the clip says; if yes, the rule title (quoted from the
   transcript) replaces it.
3. **Publish copy check**: one request fans out a question per platform:
   "does `posts.<platform>` claim something `excerpt` does not say?" → a
   warning on the draft (you decide).
4. **Connection test** in Settings.

### The questions — and why each is the "right" one

TypeSafe's own guidance, which the questions follow (and `tests/clipGate.test.ts`
checks mechanically):
[jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md),
[confidence](https://docs.typesafe.ai/confidence.md),
[composite scoring](https://docs.typesafe.ai/patterns/composite-scoring.md),
[state](https://docs.typesafe.ai/concepts/state.md).

- **One judgment per question**, combined in code ("hiding several judgments
  inside one question" is a listed failure mode).
- **Literal and pointed**: each instruction names the state field it reads
  (`opening`, `closing`, `excerpt`, `title`); code extracts the first/last
  sentences so the model doesn't have to ("reduce hops").
- **Criteria describe observable text**, true and false aligned with the
  question (never inverted), with Indonesian markers as examples (`"dia"`,
  `"yang tadi"`, `"oke jadi"`) because Jev reads literally and English is its
  strongest language.
- **No counting, lengths or timing** asked of the model — durations, limits
  and overlaps are code.
- **Risks as separate Nouls, not one Choice** — they can co-occur, and a Choice
  "leans toward the option that comes first".
- **Score levels that stand alone** (no "better than the previous").
- **State filtered** to what the questions need (≤ 3 000 chars of excerpt; no
  LLM reason, which would bias the judge).

| id | type | asks | used for |
|---|---|---|---|
| `hook_opening` | noul | Would `opening`, heard at the very start of a short video, make a viewer want to keep watching? | FAIL with a cut-off ending; note alone |
| `needs_prior_context` | noul | Does `excerpt` depend on something said before it started? | FAIL ≥ 0.7 — the #1 reason a cut clip doesn't work |
| `ends_complete` | noul | Does `closing` finish the point `excerpt` was making? | FAIL with a weak opening; note alone |
| `mostly_filler` | noul | Is most of `excerpt` greetings, thanks, sponsor reads, promotion, housekeeping or small talk? | FAIL ≥ 0.7 |
| `payoff` | score 0-2 | What does a viewer get from `excerpt` by watching it to the end? | FAIL ≤ 0.5 *and* confidence ≥ 0.5 |
| `risk_accusation` | noul | …accuse a named, real person, company or institution of a crime or wrongdoing? | REVIEW ≥ 0.5 (UU ITE defamation risk) |
| `risk_sara` | noul | …insult, mock or stereotype people for religion, ethnicity, race or group? | REVIEW ≥ 0.5 |
| `risk_sexual` | noul | …describe sexual acts or intimate body parts explicitly? | REVIEW ≥ 0.5 |
| `risk_dangerous` | noul | …encourage or explain violence, self-harm, illegal drug use or another dangerous act? | REVIEW ≥ 0.5 |
| `risk_health_money` | noul | …present a health cure or a guaranteed money result as fact? | REVIEW ≥ 0.5 |
| `title_overclaims` | noul | Does `title` claim something that `excerpt` does not say? | replace the LLM title ≥ 0.7 |

**Verdict, in code** (`verdictFrom`): FAIL if any fail rule fires; else REVIEW
if any risk ≥ 0.5; else PASS. Risks never FAIL a clip: a person decides
(publishing a REVIEW clip needs an explicit confirmation; a FAIL clip needs
`override`). Thresholds 0.7 / 0.3 are TypeSafe's suggested *starting points*
for a Noul — **not yet calibrated on Indonesian clips**. A `quality` composite
(0-1) is stored with the raw answers on each clip (`clip.gate`) so later
training can use them as features.

### Deterministic fallback

Without Jev (or for a clip whose Jev call failed; after 3 failures in a row the
rest of the video uses it) `ruleAnswers()` answers the same questions:
hook = the rule hook score of the opening (greetings → 0.1); needs context =
opening starts with *tapi / terus / makanya / karena…* (0.8) or a back-reference
(*dia, itu, yang tadi*: 0.6); ending = cut on a comma or a word a sentence
can't end on (*dan, yang, adalah, di…*: 0.15), a full stop (0.8), an open
question (0.3); filler = share of greeting/promo sentences; risks = keyword
lists that only ever flag REVIEW. No payoff or title answer — the rules can't
judge those. Same verdict code. `clip.gate.by` says which answered.

### Is the question right? Measure it

`cd backend && JEV_API_KEY=… bun run jev-eval [labels.json] [--out answers.json]`
runs Jev **and** the rules over labelled excerpts and prints, per question, how
many answers land on the right side of 0.7 / 0.3, how many are unsure, and the
separation between the yes- and no-labelled means. The shipped fixture
(`backend/tests/fixtures/jev-gate-eval.json`, 16 cases) is **synthetic** —
written to exercise each question, not real data.

First live run (2026-10-28, `jev-1.14.0`, 16 cases, ~22k input tokens):

| | Jev | rules |
|---|---|---|
| Yes/no answers on the right side of 0.7 / 0.3 | all labelled cases | hook 2/4, filler 6/7, risks 0/4 (all "unsure") |
| Separation (yes-mean − no-mean) | 0.74 – 0.95 | 0.20 – 0.60 (0.30 for needs-context after the fix) |
| Verdicts | 11/12, then 12/12 after two label fixes | 10/12, then 9/12 after the fixes |

The two misses were my labels, not the questions — and I fixed them *after*
seeing Jev's answers, so 12/12 is partly circular: the payoff rubric itself
calls a concrete savings rule "useful information" (level 2, I had written 1),
and the SARA example refers to "suku itu / mereka" without naming them, which
is exactly `needs_prior_context` (FAIL beats REVIEW). On a synthetic set this
says the questions read as intended; it is not evidence about real clips.
Next: label 50+ of your own clips, run the eval, then move thresholds — or
rewrite a question whose separation stays small.

---

## 3. Tebar connector (publish + metrics back)

Tebar posts to Instagram, Threads, TikTok, YouTube, LinkedIn, X, Telegram,
Discord and Pinterest through one REST API (`https://api.tebar.app/v1`,
`Authorization: Bearer tb_live_…`, JSON snake_case, errors
`{"error": {"code", "message"}}`). Source: [API](https://docs.tebar.app/api),
[posts](https://docs.tebar.app/api/posts), [media](https://docs.tebar.app/api/media),
[stats](https://docs.tebar.app/api/komentar-statistik), [limits](https://docs.tebar.app/batasan),
[TikTok](https://docs.tebar.app/tiktok), [YouTube](https://docs.tebar.app/youtube).
API access needs a paid plan (Starter, Basic or Pro; the free plan answers
`403 plan_required`, new accounts get a 14-day Pro trial —
[plans](https://docs.tebar.app/paket)).

### Flow (`backend/src/publisher.ts`, `tebar.ts`)

1. **Draft** `POST /api/clips/{id}/publish/draft {accountIds}` — nothing sent:
   LLM copy per platform (template without it), Jev copy check, platform limits
   from Tebar's limits page (TikTok 2 200 chars / 10 min, Instagram 2 200 + 30
   hashtags / 3 s-15 min, Threads 500, YouTube title 100 + description 5 000,
   X 280…), file ≤ 300 MB, the clip's gate verdict. TikTok's privacy options
   come from `GET /accounts/{id}/tiktok/creator-info`.
2. **You decide** what Sorot never decides for you: final text, TikTok
   "who can see it" (Tebar: required for non-business accounts, never
   auto-filled), YouTube title and **made for kids** (asked every upload),
   schedule time.
3. **Publish** `POST /api/clips/{id}/publish` — upload the finished clip
   (`POST /media/upload` raw under 95 MB, else `/media/uploads` parts), then
   `POST /posts` with an `Idempotency-Key`. The row (`social_post`) and the
   exact request body are saved *before* sending, so **Retry** re-sends the same
   key + body: Tebar returns the existing post instead of posting twice.
4. **Status** `GET /posts/{id}` → per-account `published` + permalink / `failed`
   + `error_code` (PUBLISHED, PARTIAL, FAILED, SCHEDULED).
5. **Metrics → learning** every `TEBAR_SYNC_HOURS` (6) or *Sync*: status, then
   `GET /posts/{id}/insights` for published posts, summed per clip →
   `clip_feedback` → the existing feedback training re-weights the scorer.
   Before, you typed views/likes in by hand.

Sorot polls; Tebar's webhooks need a public HTTPS URL, which a local app
doesn't have.

### Known limits / not verified

- **No live Tebar call was made** (no key here); the client is built from the
  docs and tested against a fake. `/me` and the error format were confirmed
  against the real API (401 `unauthenticated` without a key).
- The **post-insights response shape isn't shown** in Tebar's docs (only metric
  names, `null` = not reported). `extractMetrics()` reads the shallowest level
  with metric fields and never double-counts. Verify with a real key.
- Per-post metrics by platform (Tebar's stats page): Threads, Instagram,
  TikTok, YouTube yes; LinkedIn / X / Pinterest not yet; Telegram / Discord no.
  Platforms report 24-48 h late, so fresh clips' scores are understated.
- Quotas: TikTok 15 posts/day, YouTube 10 videos/day per Tebar account.
  Published posts can't be edited or deleted through Tebar.

---

## 4. Connections from the UI and CLI

LLM, Jev and Tebar (URL, model, key, on/off, director) are set in **Settings**
(studio dock) or `sorot connect`, saved in SQLite (`setting` table) and win
over the env; *Use .env* / `--reset` clears them. Changes apply without a
restart. Keys are never returned — only "set" and the last four characters;
`sorot connect … --key -` reads the key from stdin (not shell history).
`sorot connect test llm|jev|tebar` makes one small real call.

## 5. Bun first

All of this is Bun: director, gate, Jev and Tebar clients, settings,
publisher, and now **hook selection** (`hooks.ts`, a golden-tested port of
`captions.py find_hook`). Python changed by ~20 lines: render.py / subtitle.py
read `hookStart`/`hookEnd` from the segment (null = no replay) and fall back to
their own `find_hook` only for segment files written before this change.
Python stays media-only: Whisper, ffmpeg render/burn, OpenCV, audio features,
LightGBM.

## 6. Next

- Run `jev-eval` with a key and real labelled clips; calibrate per question.
- Try Jev on an English gloss of the excerpt (LLM translation) vs Indonesian
  and keep whichever separates better.
- Use `clip.gate.answers` as extra features in feedback training (TypeSafe's
  composite-scoring pattern), once enough posted clips have metrics.
- Tebar comments → an LLM-drafted reply queue (Tebar treats comment text as
  untrusted; so must we).
