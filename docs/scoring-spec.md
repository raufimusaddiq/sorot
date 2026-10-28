# Scoring Specification

## Purpose

Score each candidate segment (10-60s) to rank clips by viral potential. This is a heuristic formula, not a trained model (see [ai-audit.md](ai-audit.md)). Good enough to filter 20 candidates down to the top 5.

Where it runs: Python `media_features.py` measures the audio/visual signals;
the Bun backend computes the text signals, the weighted sum, boosts,
penalties, tiers and post copy (`backend/src/scoring.ts`, `textRules.ts`).
With Jev or an LLM connected, this rule score is blended 50/50 with their
judgement; a quality gate (Jev, or the same questions answered by text rules)
runs before render either way (see
[Blend, quality gate and rank](#blend-quality-gate-and-rank)).

## Base Formula

Shipped weights (`ai-pipeline/weights.json` v3; feedback training writes
re-fitted ones to `data/weights.json`, which wins):

```
final_score =
  0.17 * hook_strength +
  0.08 * keyword_trigger +
  0.08 * novelty +
  0.09 * clarity +
  0.08 * emotional_energy +
  0.05 * text_sentiment +
  0.06 * pause_structure +
  0.09 * face_presence +
  0.07 * scene_change +
  0.07 * topic_fit +
  0.06 * history_score +
  0.05 * motion +
  0.05 * onset_density
  + boosts - penalties
```

All feature values are 0.0 – 1.0. Weights sum to 1.0. The final score is capped at 1.0.
If `ai-pipeline/model.lgb` exists, its prediction replaces the weighted sum
for the segments it can score. This is the **rule score**; Jev or the LLM
review may then blend it (below).

The per-feature sections below keep their original design notes; the
weights above are the current ones.

## Feature Definitions

### hook_strength (weight: 0.20)
How strong the opening sentence is in the first 3 seconds.

**Implementation:**
- First sentence = text up to the first `.`, `?` or `!` (else up to the first comma)
- Score: `1.0` question + hook phrase · `0.9` hook phrase and < 10 words ·
  `0.7` question or hook phrase · `0.6` question word (apa, kenapa, kok…) ·
  `0.4` short (< 10 words) · `0.2` otherwise

### keyword_trigger (weight: 0.10)
Presence of attention-grabbing Indonesian keywords.

**Keyword list:**
```
rahasia, penting, tidak banyak orang tahu, kesalahan, ternyata,
wajib, harus, jangan, bahaya, untung, sayangnya, fakta,
curhat, jebakan, trik, hack, tip, solusi
```

**Implementation:**
- Count keyword matches in segment text
- `1.0` = 3+ matches, `0.7` = 2 matches, `0.4` = 1 match, `0.0` = none

### novelty (weight: 0.10)
How unique or non-generic the segment content is.

**Implementation (MVP):**
- If segment contains specific numbers/percentages → +0.3
- If segment contains named entities (proper nouns) → +0.3
- If segment has step-by-step structure ("pertama", "kedua", "ketiga") → +0.2
- If segment is purely generic advice → 0.2
- Cap at 1.0

### clarity (weight: 0.10)
How quickly the segment's context can be understood.

**Implementation (MVP):**
- Short segment (< 30s) with clear single topic → 0.9
- Long segment with topic shifts → 0.4
- Mid-range: interpolate
- If segment starts with context-setting phrase ("jadi", "maksudnya", "singkatnya") → +0.2

### emotional_energy (weight: 0.10)
Speech intensity and dynamism from audio analysis.

**Implementation (MVP):**
- Analyze audio RMS energy in the segment vs average
- Segments with > 1.5x average energy → 0.9
- Segments with average energy → 0.5
- Segments with < 0.5x average energy → 0.2
- Future: use prosody detection for better accuracy

### pause_structure (weight: 0.07)
Penalizes segments with too much silence.

**Implementation:**
- Calculate silence ratio = total pause time / segment duration
- `< 10%` silence → 0.9
- `10-25%` → 0.6
- `25-40%` → 0.3
- `> 40%` → 0.1

### face_presence (weight: 0.10)
Whether a face is visible in the video during the segment.

**Implementation** (`features/visual.py`, batch path used by `media_features.py`):
- Check 5 frames per segment, at 10/30/50/70/90 % of its duration
- Detect on full-size frames (640 px wide). Scene/motion features keep their
  224-px copies, which is what they were calibrated on
- Detector: MediaPipe if installed, else OpenCV Haar (`minNeighbors=8`,
  `minSize=40px`). The Docker image uses Haar; OpenCV must stay `<5` (5.0
  removed `CascadeClassifier`)
- **Majority vote**: a face must be found in at least 3 of the 5 frames.
  Single-frame Haar fires on busy textures (measured: 3–13 of 30 frames on a
  no-face video), so one hit is not enough
- `1.0` = face majority plus a smile detected, `0.7` = face majority,
  `0.0` = otherwise
- Calibration (2026-10-27): a real podcast clip went from faces `0.0` on 2 of 3
  segments (224-px single frame) to faces found in 5 of 6 five-second
  segments. A synthetic no-face video scored `0.0` on all segments

### scene_change (weight: 0.08)
Visual activity in the segment.

**Implementation (MVP):**
- Calculate frame difference (optical flow or histogram diff) between consecutive sample frames
- High visual change → 0.8-1.0
- Moderate → 0.5
- Static (talking head, no cuts) → 0.2
- Note: talking head isn't bad for short-form, but scene variety helps engagement

### topic_fit (weight: 0.08)
How well the segment matches the user's niche/topic.

**Implementation (MVP):**
- Default niche keywords are configurable (set in `.env` or UI)
- Count overlap between segment keywords and niche keywords
- `1.0` = strong overlap, `0.5` = moderate, `0.2` = weak, `0.0` = no match
- If no niche is configured, default to 0.5 for all segments

### history_score (weight: 0.07)
Based on how similar past clips performed.

**Implementation (MVP):**
- No history data yet for initial version
- Default to 0.5 for all segments
- Future: track which exported clips were actually uploaded and performed well

## Boosts (added after base score)

| Condition | Boost |
|-----------|-------|
| Sharp question at start | +0.05 |
| Opinion conflict present | +0.05 |
| Contains number/list/step-by-step | +0.03 |
| Emotional moment detected | +0.05 |

**Detection (MVP):**
- "Sharp question": first sentence ends with "?" and contains interrogative ("kok", "kenapa", "bagaimana", "apa")
- "Opinion conflict": segment contains contrast phrases ("tapi", "namun", "sebenarnya", "beda sama")
- "Number/list": contains digits or ordering words ("pertama", "kedua", "1", "2", dll.)
- "Emotional moment": high energy + exclamation mark or emotional words ("sedih", "marah", "kaget", "wow")

## Penalties (subtracted after boosts)

| Condition | Penalty |
|-----------|---------|
| Slow opening (no hook in first 5s) | -0.08 |
| Too much silence (> 30% of segment) | -0.07 |
| Too generic / no specifics | -0.05 |
| No face visible at all | -0.04 |

## Tier Classification

After applying formula + boosts - penalties:

| Score Range | Tier | Action |
|-------------|------|--------|
| ≥ 0.80 | PRIMARY | Rendered with captions (all on a GPU; the best `MAX_RENDER_CLIPS` on a CPU, the rest on request) |
| 0.65 – 0.79 | BACKUP | Same as PRIMARY |
| < 0.65 | SKIP | Not rendered; still listed, renderable on request |

The tier is derived again after the blend, and a clip the quality gate fails
moves to SKIP whatever its score.

## Blend, Quality Gate and Rank

SCORE stage, after the rule score (`backend/src/orchestrator.ts`):

| Mode | When | Final score | `scoredBy` |
|---|---|---|---|
| Jev first | Jev connected and `JEV_DIRECTOR` on | `0.5 × Jev + 0.5 × rules` for the best 200 candidates by rule score plus every Jev pick (`jevDirector.ts` `judgeClips`); the rest, and any Jev failure, keep the rule score | `jev+rules` |
| LLM review | otherwise, with an LLM | `0.5 × LLM + 0.5 × rules`, the LLM's 0-100 answer ÷ 100, in batches of 6 (`clipReview.ts`); a batch it can't answer keeps the rule score | `llm+rules` |
| Rules | neither | the rule score | `rules` |

Jev's score is the quality composite of its answers (`clipGate.ts`
`qualityOf`: 0.25 strong opening, 0.25 stands alone, 0.15 complete ending,
0.10 not filler, 0.25 payoff level ÷ 2, averaged over the answers present),
or 50/50 with `fits_direction` when the job has a direction (`jevScore`).

**Quality gate** (`clipGate.ts`). The verdict is decided in code from the
answers (`verdictFrom`):

- **FAIL** if mostly filler ≥ 0.7, needs earlier context ≥ 0.7, a weak
  opening (≤ 0.3) together with a cut-off ending (≤ 0.3), or payoff ≤ 0.5
  answered with confidence ≥ 0.5
- else **REVIEW** if any risk question (accusation, SARA, sexual, dangerous,
  health/money claim) is ≥ 0.5: a person decides, never an automatic FAIL
- else **PASS**

With Jev first the verdict comes from the same answers as the score; a
PRIMARY/BACKUP clip Jev didn't answer gets the rules' verdict. Otherwise the
best 40 PRIMARY/BACKUP clips are gated after the blend, by Jev when connected,
else by text rules answering the same questions (`ruleAnswers`, no payoff).
A FAIL clip goes to tier SKIP with the reason `Held back: …`. The 0.7 / 0.3
thresholds are TypeSafe's starting points, not calibrated on Indonesian clips.
Question design: [creative-loop.md](creative-loop.md) §3.

**Overlaps and rank.** Candidates (rule windows, Jev or LLM picks) that
overlap by more than half of the shorter one keep only the better-scored one
(with Jev first, a FAIL clip never wins over a passing one). Ranks follow the
final score, with held-back (FAIL) clips last.

## Scoring Pipeline

```
1. media_features.py measures audio/visual signals per segment (Python)
2. For each segment (Bun, scoring.ts):
   a. Calculate each feature (0.0 – 1.0)
   b. Apply weighted formula → base_score (an optional LightGBM prediction replaces it)
   c. Check boost conditions → add boosts
   d. Check penalty conditions → subtract penalties
   e. final_score = base_score + boost_total - penalty_total
   f. Determine tier from final_score
3. Jev first: Jev blend + gate verdict, then drop overlaps. Otherwise: optional
   LLM review (blend + title/description), drop overlaps, then the quality gate
4. Sort: held-back (FAIL) clips last, then final_score descending; assign rank (1 = best)
5. Hook line per clip: Jev's (with its quote title) for the clips that render
   when Jev is first, else the LLM director's line or the rules' (`hooks.ts`)
6. Write scoredSegments back to the segments JSON and save the clips
```

## Feature Values Reference

All features output a float between 0.0 and 1.0:

| Feature | 0.0 | 0.5 | 1.0 |
|---------|-----|-----|-----|
| hook_strength | No hook, slow start | Mild hook | Strong question/hook phrase in first 3s |
| keyword_trigger | No trigger words | 1 trigger word | 3+ trigger words |
| novelty | Purely generic | Some specifics | Unique, named entities, numbers |
| clarity | Confusing, multiple topics | Single topic, moderate length | Clear single topic, short |
| emotional_energy | Flat, monotone | Average | Loud, dynamic, passionate |
| pause_structure | >40% silence | 10-25% | <10% silence |
| face_presence | No face | Face in some frames | Face in all frames |
| scene_change | Static throughout | Some changes | Frequent cuts/movement |
| topic_fit | No niche match | Moderate match | Strong niche match |
| history_score | Poor history | Average | Good history |
| text_sentiment | Strongly negative | Neutral | Strongly positive |
| motion | Static frame | Some movement | Constant movement (optical flow) |
| onset_density | Few audio onsets | Average | Dense onsets (laughs, claps, fast talk) |
