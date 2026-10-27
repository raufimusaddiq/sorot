# What is actually "AI" in Sorot

An honest inventory, so nobody (including us) mistakes a rule for a model.
Checked against the code on 2026-10-27.

## Summary

| Part | What it really is | Where |
|---|---|---|
| Speech → text | **Neural network**: faster-whisper (`large-v3-turbo` in Docker) with word timestamps | `ai-pipeline/transcribe.py` |
| Faces, smiles | **Classic machine learning**: OpenCV Haar cascades (pre-trained, 2001-era detectors). MediaPipe is used only if installed — it is not, by default | `ai-pipeline/features/visual.py`, `reframe.py` |
| Motion | Signal processing: Farneback optical flow | `features/visual.py` |
| Scene changes | Signal processing: colour-histogram difference | `features/visual.py` |
| Audio energy, onsets | Signal processing: RMS ratio, onset counting | `features/audio.py` |
| Hook, keywords, novelty, clarity, sentiment, pauses, topic fit, history | **Rules**: Indonesian word lists, regexes, counts; keywords use TF-IDF when `data/corpus/*.txt` exists | `backend/src/textRules.ts` |
| Clip score | **Hand-tuned weighted sum** of the 13 signals above + boosts/penalties → PRIMARY ≥ 0.80, BACKUP ≥ 0.65 | `backend/src/scoring.ts`, `ai-pipeline/weights.json` |
| Titles, descriptions, hashtags | **Templates** (first question or hook line + keyword → hashtag map + CTA) | `backend/src/textRules.ts` |
| "Learning" from your posts | **Linear re-weighting**: Pearson correlation of each feature with your real viral scores, blended into the weights (EMA, α = 0.3) after 5+ results | `backend/src/learning.ts` |
| Supervised model | **LightGBM**, but only after **200+** labelled clips *and* only if it beats the linear weights in 5-fold CV. Until then no `model.lgb` exists and it never runs | `ai-pipeline/train_scorer.py`, `predict_supervised.py` |
| Discovery ranking | **Hand-set formula**: 40% best caption moments, 15% strong-moment rate, 10% speech density, 20% view velocity, 15% length fit | `backend/src/captionAnalysis.ts` |
| LLM (optional) | **Large language model** you plug in (Ollama, Groq, OpenRouter, OpenAI…). Off unless `LLM_BASE_URL` + `LLM_MODEL` are set | `backend/src/llm.ts` |

So, out of the box: one neural model (Whisper), one classic detector (Haar),
and everything else is rules and signal processing. That is a deliberate
trade — it is fast, explainable, deterministic and runs offline on a laptop —
but it should be described as *heuristic scoring*, not "AI that predicts virality".

## What the LLM adds (when configured)

- **Clip review** (`clipReview.ts`): excerpts go to the LLM in batches of 6. The
  final score is 50% formula, 50% LLM judgement; the LLM also writes the title,
  description and hashtags. Each clip stores `scoredBy` (`rules` or `llm+rules`)
  and a one-sentence `reason`. If the LLM fails, that batch keeps the formula.
- **Auto-discover agent** (`discoveryAgent.ts`): a tool-calling loop at
  temperature 0.8 — `web_search` (Bing HTML or SearXNG), `youtube_search`,
  `analyze_video`, `channel_videos`, `source_channels`. Only videos the tools
  actually returned can be picked, and every pick carries the LLM's reason.
  Without an LLM, or when it fails, the algorithm path runs instead (random
  anchor queries → caption analysis → best predicted scores, ≤ 2 per channel).

## Known limits

- The clip score has never been validated against real performance: until
  you feed back results, the weights are the author's guesses.
- "Strong moment" (caption window ≥ 0.55) is relative: ~10% of windows on a
  horror-story channel, over half on a busy talk podcast. Compare within a search.
- Haar cascades miss profile and small faces; framing falls back to a centre crop.
- Keyword rules are Indonesian-specific.

## History of this audit

- Before the 2026-10 fixes, two features were silently constant: `topicFit`
  (niche keywords were never passed to the scorer) and `historyScore` (feedback
  history was never loaded). Both are fed now.
- Feedback training only re-weighted 11 of the 13 features and would have
  dropped `motion` and `onsetDensity` (and the tier thresholds) from
  `weights.json`; learned weights were also written into the code folder,
  which a Docker rebuild wiped. Fixed: all 13, written to `data/weights.json`.
- Discovery used to score only the first minutes of captions; it now scores
  the whole video.
- The Python CTA picker used Python's per-process randomised `hash()`, so the
  same clip got a different call to action on every run. The Bun port is stable.
