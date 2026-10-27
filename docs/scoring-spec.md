# Scoring Specification

## Purpose

Score each candidate segment (10-60s) to rank clips by viral potential. This is a heuristic formula, not a trained model (see [ai-audit.md](ai-audit.md)). Good enough to filter 20 candidates down to the top 5.

Where it runs: Python `media_features.py` measures the audio/visual signals;
the Bun backend computes the text signals, the weighted sum, boosts,
penalties, tiers and post copy (`backend/src/scoring.ts`, `textRules.ts`).

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
With an LLM configured, `clipReview.ts` then blends it 50/50 with the LLM's
0-100 judgement of the excerpt. If `ai-pipeline/model.lgb` exists, its
prediction replaces the weighted sum for the segments it can score.

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
- Note: talking head isn't bad for TikTok, but scene variety helps engagement

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
| ≥ 0.80 | PRIMARY | Auto-render and highlight in UI |
| 0.65 – 0.79 | BACKUP | Show in UI, render on demand |
| < 0.65 | SKIP | Hide by default, accessible via "show all" |

## Scoring Pipeline

```
1. media_features.py measures audio/visual signals per segment (Python)
2. For each segment (Bun, scoring.ts):
   a. Calculate each feature (0.0 – 1.0)
   b. Apply weighted formula → base_score
   c. Check boost conditions → add boosts
   d. Check penalty conditions → subtract penalties
   e. final_score = base_score + boost_total - penalty_total
   f. Determine tier from final_score
3. Sort segments by final_score descending
4. Assign rank (1 = best)
5. Optional LLM review (blend + title/description), optional LightGBM override
6. Write scoredSegments back to the segments JSON
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
