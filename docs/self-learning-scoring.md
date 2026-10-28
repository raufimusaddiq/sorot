# Self-Learning Scoring System

> **Status (2026-10-27): original design doc.** What exists today: posted-clip
> metrics → a time-normalised viral score, and after 5+ results a linear
> re-weighting of all 13 features (Pearson + EMA, `backend/src/learning.ts`,
> written to `data/weights.json`). The LightGBM model (`train_scorer.py`) only
> switches on with 200+ labelled clips. Metrics are typed in
> (`POST /api/clips/{id}/feedback`) or, with Tebar connected, pulled by its
> metrics sync (`backend/src/publisher.ts`: every `TEBAR_SYNC_HOURS`, default 6,
> or `POST /api/social/sync`), which sums a clip's published posts into its
> `clip_feedback` row the same way; training runs on `POST /api/feedback/train`.
> File names below (`feedback.py`, `learn_weights.py`, `score.py`) are the
> original Python plan; see
> [ai-audit.md](ai-audit.md) and [api-spec.md → Feedback](api-spec.md#feedback--self-learning).

## Problem
Current scoring uses fixed weights and hand-crafted rules. As more videos are analyzed and clips are posted, the system should learn which features actually predict viral performance — and adjust weights automatically.

## Architecture

```
Clip Processing Pipeline (existing)
    │
    ├── Score clip → Post to a platform → Track performance
    │                                        │
    └────────────────────────────────────────┘
                    Feedback Loop
    
    ┌─────────────────────────────────────┐
    │         Learning Pipeline           │
    │                                     │
    │  1. Collect: clip features + views  │
    │  2. Train: update weight model      │
    │  3. Deploy: save new weights.json   │
    │  4. Score: use learned weights      │
    └─────────────────────────────────────┘
```

## Data Model

### Feedback Table (new)
```sql
CREATE TABLE IF NOT EXISTS clip_feedback (
    id TEXT PRIMARY KEY,
    clip_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    
    -- Features at time of scoring (snapshot)
    features TEXT NOT NULL,  -- JSON: {hookStrength:0.8, keywordTrigger:0.5, ...}
    predicted_score REAL NOT NULL,
    predicted_tier TEXT NOT NULL,
    
    -- Actual outcomes (filled later)
    post_views INTEGER DEFAULT 0,
    post_likes INTEGER DEFAULT 0,
    post_comments INTEGER DEFAULT 0,
    post_shares INTEGER DEFAULT 0,
    post_saves INTEGER DEFAULT 0,
    
    -- Derived performance metric (0-1)
    actual_viral_score REAL,
    
    -- Timestamps
    posted_at TEXT,
    last_checked TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

### Weights Store (file-based)
```json
// ai-pipeline/weights.json
{
  "version": 3,
  "trained_on": 47,
  "last_updated": "2026-04-19T12:00:00Z",
  "weights": {
    "hookStrength": 0.20,
    "keywordTrigger": 0.10,
    "novelty": 0.10,
    "clarity": 0.10,
    "emotionalEnergy": 0.10,
    "facePresence": 0.10,
    "pauseStructure": 0.07,
    "sceneChange": 0.08,
    "topicFit": 0.08,
    "historyScore": 0.07
  },
  "thresholds": {
    "PRIMARY": 0.80,
    "BACKUP": 0.65
  },
  "keyword_weights": {
    "rahasia": 1.2,
    "penting": 1.1,
    "trik": 1.0
  }
}
```

## Learning Approaches (increasing complexity)

### Approach 1: Simple Weight Adjustment (Phase 1 — implement first)

No ML libraries needed. Statistical correlation.

```python
def update_weights_from_feedback(feedback_records, current_weights):
    """Adjust weights based on which features correlate with actual viral performance."""
    
    # For each feature, calculate correlation with actual_viral_score
    feature_correlations = {}
    for feature in current_weights:
        pairs = [
            (r["features"][feature], r["actual_viral_score"])
            for r in feedback_records
            if r.get("actual_viral_score") is not None
        ]
        if len(pairs) < 5:
            continue  # not enough data
        
        # Pearson correlation
        x_vals = [p[0] for p in pairs]
        y_vals = [p[1] for p in pairs]
        correlation = pearson_correlation(x_vals, y_vals)
        feature_correlations[feature] = max(correlation, 0.05)  # floor at 0.05
    
    # Normalize to sum=1.0
    total = sum(feature_correlations.values())
    new_weights = {k: round(v / total, 4) for k, v in feature_correlations.items()}
    
    # Blend with current weights (EMA, alpha=0.3)
    alpha = 0.3
    blended = {}
    for k in current_weights:
        old = current_weights[k]
        new = new_weights.get(k, old)
        blended[k] = round(old * (1 - alpha) + new * alpha, 4)
    
    # Re-normalize
    total = sum(blended.values())
    return {k: round(v / total, 4) for k, v in blended.items()}
```

**Trigger:** Run after every 10 new feedback records with actual performance data.

### Approach 2: Linear Regression (Phase 2 — lightweight ML)

Use scikit-learn or manual implementation. Only numpy needed.

```python
import numpy as np

def train_linear_model(feedback_records):
    """Train a linear model: features → viral_score"""
    X = []
    y = []
    for r in feedback_records:
        if r.get("actual_viral_score") is None:
            continue
        feature_vector = [
            r["features"]["hookStrength"],
            r["features"]["keywordTrigger"],
            r["features"]["novelty"],
            r["features"]["clarity"],
            r["features"]["emotionalEnergy"],
            r["features"]["pauseStructure"],
            r["features"]["facePresence"],
            r["features"]["sceneChange"],
            r["features"]["topicFit"],
            r["features"]["historyScore"],
        ]
        X.append(feature_vector)
        y.append(r["actual_viral_score"])
    
    X = np.array(X)
    y = np.array(y)
    
    # Ridge regression (with L2 regularization to prevent overfitting on small data)
    from numpy.linalg import inv
    lamda = 0.1  # regularization strength
    n_features = X.shape[1]
    weights = inv(X.T @ X + lamda * np.eye(n_features)) @ X.T @ y
    
    # weights are now the learned feature importance
    # Normalize to positive values that sum to 1
    weights = np.maximum(weights, 0.01)
    weights = weights / weights.sum()
    
    return {
        "hookStrength": round(weights[0], 4),
        "keywordTrigger": round(weights[1], 4),
        # ... etc
    }
```

### Approach 3: Reinforcement Learning (Phase 3 — advanced)

Treat each scoring decision as an action in a contextual bandit problem.

```
State:    Video features (10 dimensions)
Action:   Score the clip as PRIMARY / BACKUP / SKIP
Reward:   Actual viral performance (views, likes, shares)
```

Use **LinUCB** (Linear Upper Confidence Bound) — a contextual bandit algorithm:
- Balances exploration (trying new weight combinations) vs exploitation (using best-known weights)
- Works well with small datasets
- No deep learning needed

```python
class LinUCBScorer:
    def __init__(self, n_features=10, alpha=0.5):
        self.alpha = alpha
        self.A = {tier: np.eye(n_features) for tier in ["PRIMARY", "BACKUP", "SKIP"]}
        self.b = {tier: np.zeros(n_features) for tier in ["PRIMARY", "BACKUP", "SKIP"]}
    
    def predict(self, features):
        """Score a clip and choose best tier."""
        x = np.array(features)
        scores = {}
        for tier in self.A:
            theta = inv(self.A[tier]) @ self.b[tier]
            p = theta @ x + self.alpha * np.sqrt(x @ inv(self.A[tier]) @ x)
            scores[tier] = p
        return max(scores, key=scores.get)
    
    def update(self, features, tier, reward):
        """Learn from outcome."""
        x = np.array(features)
        self.A[tier] += np.outer(x, x)
        self.b[tier] += reward * x
```

## Viral Score Calculation

How to convert post metrics into a 0-1 viral score:

```python
def calculate_viral_score(views, likes, comments, shares, saves, followers=0):
    """Normalize post metrics into 0-1 viral performance score."""
    
    if views == 0:
        return 0.0
    
    # Engagement rate (likes+comments+shares+saves / views)
    engagement = (likes + comments + shares + saves) / max(views, 1)
    
    # Viral multiplier: high views relative to follower count
    viral_ratio = views / max(followers, 100)
    
    # Log-scale view score (diminishing returns)
    import math
    view_score = min(math.log10(max(views, 1)) / 7, 1.0)  # 10M views = 1.0
    
    # Weighted combination
    score = (
        view_score * 0.4 +           # raw reach
        min(engagement * 20, 1.0) * 0.35 +  # engagement rate (5% = 1.0)
        min(math.log10(max(viral_ratio, 1)) / 4, 1.0) * 0.25  # viral ratio
    )
    
    return round(min(score, 1.0), 4)
```

## Implementation Plan

### New Files

| File | Purpose |
|------|---------|
| `ai-pipeline/feedback.py` | Collect clip features + post performance |
| `ai-pipeline/learn_weights.py` | Weight learning (Phase 1-3) |
| `ai-pipeline/weights.json` | Current learned weights (versioned) |
| `backend/.../FeedbackController.java` | Feedback API endpoints |
| `backend/.../FeedbackService.java` | Orchestrate feedback collection + trigger learning |

### New API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | /api/feedback | List all feedback records |
| POST | /api/clips/{id}/feedback | Manually submit performance data |
| POST | /api/feedback/sync | Pull platform metrics for all posted clips |
| POST | /api/feedback/train | Trigger weight retraining |
| GET | /api/feedback/weights | View current learned weights |
| GET | /api/feedback/stats | Learning stats (samples, accuracy, version) |

### Modified Files

| File | Change |
|------|--------|
| `ai-pipeline/score.py` | Load weights from `weights.json` instead of hardcoded |
| `backend/.../PipelineOrchestrator.java` | Save clip features to feedback table after scoring |
| `frontend src/app/page.tsx` | Show learned weight indicators, manual feedback form |

## Execution Order

1. **Phase 1: Feedback collection**
   - Add `clip_feedback` table to schema.sql
   - Save features + predicted score when clip is scored
   - Add platform performance sync (manual input first, auto-sync later)
   - Calculate `actual_viral_score` from metrics

2. **Phase 1: Simple weight adjustment**
   - Build `learn_weights.py` with correlation-based updates
   - Add `weights.json` loading to `score.py`
   - Add train trigger endpoint
   - Test: manually input feedback for existing clips → retrain → verify weight changes

3. **Phase 2: Linear regression**
   - Add numpy to requirements.txt
   - Build regression model in `learn_weights.py`
   - A/B test: compare correlation weights vs regression weights

4. **Phase 3: Contextual bandits**
   - Build LinUCB scorer
   - Add exploration mode (occasionally score with different weights)
   - Full learning loop: post → measure → learn → score better

5. **Integration**
   - Frontend shows learning progress (samples collected, weight version)
   - Auto-retrain after N new feedback records
   - Weight rollback if performance degrades

## Minimum Viable Learning (ship first)

The simplest useful version:
1. After posting a clip, user manually enters view/like counts
2. System calculates viral score
3. After 10+ clips with feedback, run correlation analysis
4. Adjust weights and save to `weights.json`
5. Next scoring uses updated weights

This gives immediate value with zero ML complexity.
