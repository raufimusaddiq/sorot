# The creative loop: Jev director → gate → Tebar → learning

> Design + what is built (2026-10-28). Three asks: (1) stop under-using the
> model in the creative work (it only re-rated rule output), (2) put Jev in as
> a quality gate that asks the *right* questions, (3) publish through
> [Tebar](https://tebar.app). Together they close a loop Sorot didn't have:
> the clips you post now feed their real results back into scoring.
>
> The first build made the LLM the director (§2). Live tests the same day
> showed Jev doing the *judging* parts of that job far faster, cheaper and
> more steadily, so with Jev connected **Jev directs** (§1) and the LLM is kept
> for what only it can do: write.

```
 transcript ──► 🎬 FIND (code windows ─► Jev) ──► ⚖️ SCORE + 🚦 GATE (Jev) ──► hook + title (Jev) ──► render ──► 🚀 PUBLISH (Tebar)
                  (or the LLM director)            rules 50% + Jev 50%           line Noul · quote          LLM copy → you → post
        ▲         (rules always kept as candidates)   PASS/REVIEW/FAIL                                              │
        │                                                                                                           ▼
        └──────────────────────── weights.json ◄── feedback training ◄── clip_feedback ◄── metrics sync (6 h) ◄─────┘
```

Every arrow has a deterministic fallback: no Jev → the LLM director if one is
configured, and the same gate questions answered by text rules; no LLM →
rule segments, rule hook, template copy; no Tebar → download and post by hand
(results can still be typed in).

---

## 1. Jev first (default when Jev is connected)

### Why

Measured on the same 10 minutes of a real Indonesian phone-review transcript,
with the direction "fokus ke kritik soal harga dan spesifikasi, bukan
unboxing" (CPU, synthetic 320x180 video, transcript pre-placed; details in the
[journal](journal/session-2026-10-28-creative-loop.md)):

| | LLM director + review (reasoning model via an OpenAI-compatible gateway) | Jev first (`jev-1.14.0`) |
|---|---|---|
| SEGMENT + SCORE | 539 s (run 1), 388 s (run 2) | 10 s (two runs) |
| Calls | brief + 3 parts + review batches, 30-150 s each; one "upstream unavailable" | 206 windows + 22-23 candidates + hook/title for the render-tier clips, 6 in flight |
| Cost | not measured (gateway price unknown) | 242k input tokens for the 206 windows ≈ $0.01 at TypeSafe's listed $0.042 / M (prices change) |
| Followed the direction | yes (price critique 0.96-1.0, unboxing 0.08-0.25) | yes (`fits_direction` 0.93-0.95 on the price-shock openings) |
| Failure seen | answered 1-10 instead of 0-100 once → every clip SKIP | none; but see *Limits* |

Jev can't write, and it can't search the web. It *can* answer a fixed
question about a piece of text in tens of milliseconds (37 ms server time on
the request we timed), with probabilities
that move little between identical requests (≤ 0.04 in our test) — and
deciding which moment is a clip, which line hooks, and which sentence is the
title are all questions of that shape once code proposes the options.

### What Jev decides (`backend/src/jevDirector.ts`)

| Step | Code proposes | Jev answers | Code keeps |
|---|---|---|---|
| **Find** (SEGMENT) | one window per line that starts a sentence (previous line ends with `. ! ? …` or a ≥ 0.6 s pause), grown to 25 s then to the next sentence end; 15-60 s | the five quality questions (§3) + `fits_direction` when there is a direction | non-FAIL windows, best first, no overlaps > 50 %; top 40 as `source: "jev"` next to the rule windows |
| **Score + gate** (SCORE) | every candidate (best 200 by rule score + every Jev pick) | the full gate questions (quality + risks) + `fits_direction` | `finalScore` = 0.5 × Jev (quality composite, 50/50 with the fit) + 0.5 × rules; the verdict from the *same* answers (`verdictFrom`); a reason built from them ("Jev: strong opening, complete ending, clear payoff, fits your direction") |
| **Hook** | every line of the clip; lines ≥ 3 s in are teaser candidates | per line: the gate's hook question, and for candidates "is this an ad, a sponsor read or a like/subscribe request?" (one Noul each — a single Choice picked a sponsor line) | measured against the clip's **own opening** (line 0): opening ≥ 0.7 → no replay; else the best non-ad line if ≥ 0.7, or ≥ 0.5 when the opening is ≤ 0.3. Jev's "no replay" stands — the rules' hook only fills clips Jev had no line to judge |
| **Title** | the clip's sentences of 15-110 chars | a Choice, one judgment: "which of these sentences, used as the clip's post title, would make the most viewers want to watch it?" — each option described by the sentence itself | the quote (≤ 80 chars) + 2 rule hashtags. A quote can't over-claim, so no title check is needed |

Hooks and titles are asked only for the clips that will render
(`MAX_RENDER_CLIPS` on CPU). A Jev failure keeps the rules' answers for that
clip; after 3 failures in a row the rest of the video uses the rules.
`JEV_DIRECTOR=false` (or the Settings / `sorot connect jev --director false`
toggle) makes Jev a gate only, and the LLM director (§2) runs if configured.

### The context Jev reads (its "system prompt")

Jev has no system prompt: a request is `model` + `state` + `questions`.
TypeSafe's [state guide](https://docs.typesafe.ai/concepts/state.md) puts the
briefing in the state — "the material you would present to a panel of
experts before asking them to make a judgment". So every request Sorot sends
(screening, judging, the gate, hooks/titles, the publish-copy check) is built
by `jevState()` (`clipGate.ts`) and carries one `context` object:

- `task` — judging moments of a longer Indonesian video as 15-60 s vertical
  clips for TikTok, Reels and Shorts;
- `viewer` — each clip is posted on its own: viewers haven't seen the rest,
  decide in the first seconds, stay only for a payoff;
- `text` — Indonesian speech recognition: guessed punctuation, misheard words;
- `fields` — what each field *in this request* is (`excerpt`, `opening`,
  `closing`, `title`, `direction`, `lines`, `posts`), and nothing else.

Before, only the gate state had a one-line note ("…cut from a podcast,
interview, talk show"), and the hook/title request had no context at all.
Measured live (`jev-1.14.0`, 2026-10-28; three runs per version):

| | old note | `context` |
|---|---|---|
| Fixture separation (yes-mean − no-mean): `needs_prior_context` | 0.727 / 0.737 / 0.728 | 0.802 / 0.827 / 0.815 |
| `hook_opening` | 0.775 / 0.765 / 0.775 | 0.790 / 0.795 / 0.790 |
| `ends_complete` · `mostly_filler` · `title_overclaims` | ~0.94 · ~0.95 · ~0.93 | ~0.96 · ~0.96 · 0.94 |
| Fixture verdicts | 12/12 ×3 | 12/12 ×3 |
| 206 real windows: rank correlation of the Jev score, old vs new | — | 0.976 |
| Real windows that FAIL screening | 120 | 107 |
| Input tokens for the 206 windows | 241 902 | 266 416 (+10 %, ≈ $0.001) |

Small fixture (16 synthetic cases, 5 labelled for `needs_prior_context`), so
read this as "better on every question, consistently", not as a calibrated
accuracy. On the real clips the hook question ranks lines sensibly with the
context ("Sekarang kok berani jualan seri Note di harga flagship?" 0.83-0.89;
"Dominant di kelas entry level." 0.17; "Huh!" 0.31).

**What is measured, and where code decides.** The hook is the clearest case
of "the right question is not enough": before, any line ≥ 0.7 was replayed
and Jev's "none" was overwritten by the rules' hook. Now the teaser is
compared with the clip's own opening (same question, same request), and Jev's
decision stands — a clip that opens with its strongest line (0.89) gets no
replay; one that opens with "Halo guys…" (~0.2) replays "Ini adalah HP
Infinix termahal yang pernah dijual di Indonesia." (~0.6), in 3 of 3 runs.

### Where the LLM is still needed

- **Post copy** per platform at publish time (Jev then checks it).
- **✨ Auto-discover**: the agent that decides what to search for and which
  channels/videos are worth importing — open-ended search is LLM work.
- **Director without Jev** (§2), and the brief, which Jev-first doesn't make.

### Limits (measured, not fixed)

- **Borderline clips flip between runs.** Run 3's best clip (27.4-60.4 s,
  final 0.69, rendered) passed with `needs_prior_context` 0.67. In run 4 it
  wasn't a candidate (it failed screening or lost the overlap to its
  neighbour; screening answers aren't stored), and the window one line
  earlier (25.6-51.2 s) passed screening, then failed the gate at 0.72 — so
  run 4's best was 0.64, just under BACKUP, and nothing rendered. A third window went 0.67 → 0.70
  (PASS → FAIL). Answers move little, but a hard threshold turns a small move
  into a different verdict near the line. Possible fix, not built: re-ask
  answers within ±0.05 of a threshold and average. (Since run 4, a FAIL clip
  can no longer win an overlap against a passing one in SCORE.)
- **Tiers come out lower than with the LLM.** Jev's score (quality + direction
  fit) topped out at ~0.86 here, where the LLM gave 0.96-1.0, so with the same rule half
  fewer clips reach BACKUP (0.65). On this synthetic video (no faces, no
  motion) the rule half is low anyway; check tiers on a real video before
  changing thresholds.
- English is Jev's best language (TypeSafe's model page); these are
  Indonesian clips, and the 0.7 / 0.3 thresholds are uncalibrated for them.

---

## 2. The LLM director (when Jev is off or `JEV_DIRECTOR=false`)

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

## 3. Jev as the quality gate

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
- **Context in the state** (Jev has no system prompt; see §1): the same
  `context` object in every request, describing only the fields sent.
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

## 4. Tebar connector (publish + metrics back)

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

## 5. Connections from the UI and CLI

LLM, Jev and Tebar (URL, model, key, on/off; a director toggle for the LLM and Jev) are set in **Settings**
(studio dock) or `sorot connect`, saved in SQLite (`setting` table) and win
over the env; *Use .env* / `--reset` clears them. Changes apply without a
restart. Keys are never returned — only "set" and the last four characters;
`sorot connect … --key -` reads the key from stdin (not shell history).
`sorot connect test llm|jev|tebar` makes one small real call.

## 6. Bun first

All of this is Bun: both directors, gate, Jev and Tebar clients, settings,
publisher, and now **hook selection** (`hooks.ts`, a golden-tested port of
`captions.py find_hook`). Python changed by ~20 lines: render.py / subtitle.py
read `hookStart`/`hookEnd` from the segment (null = no replay) and fall back to
their own `find_hook` only for segment files written before this change.
Python stays media-only: Whisper, ffmpeg render/burn, OpenCV, audio features,
LightGBM.

## 7. Next

- Run `jev-eval` with a key and real labelled clips; calibrate per question.
- Jev-first on a real video (faces, motion): compare tiers and picks with the
  LLM director, then decide on the BACKUP line and borderline re-asks (§1).
- Try Jev on an English gloss of the excerpt (LLM translation) vs Indonesian
  and keep whichever separates better.
- Use `clip.gate.answers` as extra features in feedback training (TypeSafe's
  composite-scoring pattern), once enough posted clips have metrics.
- Tebar comments → an LLM-drafted reply queue (Tebar treats comment text as
  untrusted; so must we).
