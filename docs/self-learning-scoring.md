# Self-Learning Scoring System

Posted clips' real results re-weight the clip scorer. The code is in Bun (`learning.ts`, `feedback.ts`), plus an optional LightGBM model in Python (`train_scorer.py`). API: [api-spec.md → Feedback](api-spec.md#feedback--self-learning). For what is a rule and what is a model, see [ai-audit.md](ai-audit.md).

## Problem
Scoring is a weighted sum of 13 hand-written signals (`scoring.ts`) with hand-set weights. As clips are posted, the system should learn which features actually predict viral performance on your accounts, and adjust the weights.

## Architecture

```
Score clip (scoring.ts) → post it → metrics
    ├── typed in: Learning panel → POST /api/clips/{id}/feedback
    └── Tebar: metrics sync every TEBAR_SYNC_HOURS (6) or POST /api/social/sync (publisher.ts)
                 │
    clip_feedback: feature snapshot + metrics + actual_viral_score
                 │  POST /api/feedback/train
    data/weights.json → the next SCORE stage
```

## Data Model

### `clip_feedback` (`db.ts`)
```sql
CREATE TABLE IF NOT EXISTS clip_feedback (
    id TEXT PRIMARY KEY,
    clip_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    features TEXT NOT NULL,          -- JSON snapshot of the clip's 13 scores
    predicted_score REAL NOT NULL,
    predicted_tier TEXT NOT NULL,
    post_views INTEGER DEFAULT 0,
    post_likes INTEGER DEFAULT 0,
    post_comments INTEGER DEFAULT 0,
    post_shares INTEGER DEFAULT 0,
    post_saves INTEGER DEFAULT 0,
    actual_viral_score REAL,         -- 0-1, see below
    posted_at TEXT,
    last_checked TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```
The table holds one row per clip, created by the first submitted metrics, never at scoring time. Tebar's sync sums a clip's published posts into its row.

### Weights (file-based)
`loadWeights` (`scoring.ts`) picks the weights:
- `data/weights.json` (learned; it survives image rebuilds) wins over the shipped `ai-pipeline/weights.json`;
- `DEFAULT_WEIGHTS` (`ruleConstants.ts`) fills any missing feature.

The shipped file looks like this:
```json
{
  "version": 3,
  "trained_on": 0,
  "last_updated": "2026-04-21T00:00:00Z",
  "weights": {
    "hookStrength": 0.17, "keywordTrigger": 0.08, "novelty": 0.08, "clarity": 0.09,
    "emotionalEnergy": 0.08, "textSentiment": 0.05, "pauseStructure": 0.06, "facePresence": 0.09,
    "sceneChange": 0.07, "topicFit": 0.07, "historyScore": 0.06, "motion": 0.05, "onsetDensity": 0.05
  }
}
```
Tiers are set in code (`determineTier`: PRIMARY ≥ 0.78, BACKUP ≥ 0.63); the file's `thresholds` key isn't read. Feedback also feeds scoring directly: `historyScore` is the mean viral score of the 3 past clips sharing the most words with this one (≥ 3 shared words), or 0.5 without history.

## Viral Score Calculation (`viralScore`, `learning.ts`)

The score is normalised by time on the platform: 10k views in 2 hours ≠ 10k in 2 months. `postedAt` is required: ISO-8601 with a zone, not in the future.

```
hours      = max(hours since postedAt, 0.1)
velocity   = min(log10(max(views per day, 1)) / 6, 1)                  # 1M views/day = 1
engagement = min((likes + comments + shares + saves) / views × 20, 1)  # 5 % = 1
save       = min(saves / views × 100, 1)                               # 1 % = 1
comment    = min(comments / views × 200, 1)                            # 0.5 % = 1
score      = 0.35 velocity + 0.25 engagement + 0.20 save + 0.20 comment     (0 when views = 0)
```

## Learning (`trainWeights`, `learning.ts`)

`POST /api/feedback/train` (the Learning panel's *Retrain scoring*) runs four steps:
1. It needs ≥ 5 clips with an `actual_viral_score`; with fewer it answers `insufficient_data`.
2. Each of the 13 features gets the Pearson correlation between that feature and the viral score, floored at 0.05. A feature with < 5 samples uses its current weight in place of a correlation.
3. The correlations are normalised to sum 1, blended into the current weights (EMA, alpha 0.3: `0.7 × old + 0.3 × new`), then normalised again.
4. The result goes to `data/weights.json` with `version` + 1 and `trained_on`; the response lists each weight change.

Each training run also writes the same rows to `data/feedback/feedback_export.json` for the supervised model.

### Supervised model (optional, `train_scorer.py`)
Run it by hand: `python train_scorer.py --feedback data/feedback/feedback_export.json [--dry-run]`.
- It needs ≥ 200 labelled rows.
- It 5-fold cross-validates LightGBM against the linear weights.
- It writes `ai-pipeline/model.lgb` only if LightGBM's R² beats the linear weights' by ≥ 0.05.

While `model.lgb` exists, SCORE runs `predict_supervised.py`, whose prediction replaces the weighted sum (boosts and penalties still apply).

## API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | /api/clips/{id}/feedback | Submit a posted clip's metrics (`views, likes, comments, shares, saves, postedAt`) |
| POST | /api/social/sync | Pull Tebar metrics now |
| POST | /api/feedback/train | Retrain the weights |
| GET | /api/feedback | Logged results |
| GET | /api/feedback/weights | Current weights, version, sample counts |

Not built: automatic retraining after N new results, weight rollback, and the ridge-regression and LinUCB (contextual bandit) learners.
