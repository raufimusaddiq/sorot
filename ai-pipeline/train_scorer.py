#!/usr/bin/env python3
"""P3.5-C — Train a supervised viral-score model from ``clip_feedback``.

Expects a JSON feedback dump (the backend writes one to
``data/feedback/feedback_export.json``):
a list of records with:
  - ``features``: dict of feature_name -> float (or JSON-encoded string)
  - ``actual_viral_score``: float label in [0, 1]

5-fold CV compares gradient-boosted trees against the current linear
weights baseline. The lightgbm model is written to ``model.lgb`` ONLY when:

  1. There are >= MIN_ROWS (default 200) rows with labels, AND
  2. LightGBM CV R² beats the linear baseline by at least R2_MARGIN.

This guards against swapping the scorer in on noisy / tiny datasets.
Refusing early keeps the public-API contract: ``features/supervised.py``
returns None when no model exists, and the linear path stays authoritative.
"""

import argparse
import json
import math
import os
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.path.join(SCRIPT_DIR, "model.lgb")
META_PATH = os.path.join(SCRIPT_DIR, "model.lgb.meta.json")
WEIGHTS_PATH = os.path.join(SCRIPT_DIR, "weights.json")

MIN_ROWS = 200
R2_MARGIN = 0.05


def _load_weights():
    try:
        with open(WEIGHTS_PATH, "r", encoding="utf-8") as f:
            return json.load(f).get("weights", {})
    except Exception:
        return {}


def _parse_records(records):
    valid_x = []
    valid_y = []
    feature_keys = None
    for r in records:
        y = r.get("actual_viral_score")
        if y is None:
            continue
        feats = r.get("features")
        if isinstance(feats, str):
            try:
                feats = json.loads(feats)
            except Exception:
                continue
        if not isinstance(feats, dict):
            continue
        if feature_keys is None:
            feature_keys = sorted(feats.keys())
        # Keep the schema stable: skip rows missing keys we've already seen.
        if not all(k in feats for k in feature_keys):
            continue
        valid_x.append([float(feats[k]) for k in feature_keys])
        valid_y.append(float(y))
    return feature_keys or [], valid_x, valid_y


def _linear_predict(x_row, feature_keys, weights):
    return sum(weights.get(k, 0.0) * v for k, v in zip(feature_keys, x_row))


def _r2(y_true, y_pred):
    import numpy as np
    y_true = np.array(y_true, dtype=np.float64)
    y_pred = np.array(y_pred, dtype=np.float64)
    ss_res = float(((y_true - y_pred) ** 2).sum())
    ss_tot = float(((y_true - y_true.mean()) ** 2).sum())
    if ss_tot == 0:
        return 0.0
    return 1.0 - ss_res / ss_tot


def _mae(y_true, y_pred):
    import numpy as np
    return float(np.mean(np.abs(np.array(y_true) - np.array(y_pred))))


def _cv_folds(n, k=5, seed=13):
    import random
    idx = list(range(n))
    random.Random(seed).shuffle(idx)
    folds = [[] for _ in range(k)]
    for i, v in enumerate(idx):
        folds[i % k].append(v)
    return folds


def evaluate(records, min_rows=MIN_ROWS, write_model=True):
    feature_keys, x, y = _parse_records(records)
    n = len(x)
    if n < min_rows:
        return {
            "status": "insufficient_data",
            "rows": n,
            "min_required": min_rows,
            "message": f"Need at least {min_rows} labeled rows; got {n}.",
        }

    try:
        import lightgbm as lgb
        import numpy as np
    except ImportError as e:
        return {
            "status": "missing_dependency",
            "message": f"Install lightgbm to train: {e}",
        }

    weights = _load_weights()

    folds = _cv_folds(n, k=5)
    linear_preds = [0.0] * n
    lgb_preds = [0.0] * n

    for hold_idx, hold in enumerate(folds):
        train_idx = [i for fold_id, fold in enumerate(folds) if fold_id != hold_idx for i in fold]
        x_tr = np.array([x[i] for i in train_idx], dtype=np.float64)
        y_tr = np.array([y[i] for i in train_idx], dtype=np.float64)
        x_hd = np.array([x[i] for i in hold], dtype=np.float64)

        model = lgb.train(
            {
                "objective": "regression",
                "metric": "rmse",
                "learning_rate": 0.05,
                "num_leaves": 15,
                "min_data_in_leaf": max(5, len(train_idx) // 20),
                "feature_fraction": 0.9,
                "bagging_fraction": 0.8,
                "bagging_freq": 5,
                "verbosity": -1,
            },
            lgb.Dataset(x_tr, label=y_tr),
            num_boost_round=200,
        )
        preds = model.predict(x_hd)

        for k, i in enumerate(hold):
            lgb_preds[i] = float(preds[k])
            linear_preds[i] = _linear_predict(x[i], feature_keys, weights)

    lgb_r2 = _r2(y, lgb_preds)
    lin_r2 = _r2(y, linear_preds)
    lgb_mae = _mae(y, lgb_preds)
    lin_mae = _mae(y, linear_preds)

    report = {
        "status": "evaluated",
        "rows": n,
        "feature_keys": feature_keys,
        "linear_r2": round(lin_r2, 4),
        "lgb_r2": round(lgb_r2, 4),
        "linear_mae": round(lin_mae, 4),
        "lgb_mae": round(lgb_mae, 4),
        "r2_margin": round(lgb_r2 - lin_r2, 4),
        "min_margin_required": R2_MARGIN,
        "model_written": False,
    }

    if write_model and (lgb_r2 - lin_r2) >= R2_MARGIN:
        # Refit on ALL data before writing.
        x_all = np.array(x, dtype=np.float64)
        y_all = np.array(y, dtype=np.float64)
        final = lgb.train(
            {
                "objective": "regression",
                "metric": "rmse",
                "learning_rate": 0.05,
                "num_leaves": 15,
                "min_data_in_leaf": max(5, n // 20),
                "feature_fraction": 0.9,
                "bagging_fraction": 0.8,
                "bagging_freq": 5,
                "verbosity": -1,
            },
            lgb.Dataset(x_all, label=y_all),
            num_boost_round=200,
        )
        final.save_model(MODEL_PATH)
        with open(META_PATH, "w", encoding="utf-8") as f:
            json.dump(
                {"feature_keys": feature_keys, "trained_on": n, "report": report},
                f, ensure_ascii=False, indent=2,
            )
        report["model_written"] = True
        report["status"] = "trained"
    elif write_model:
        report["status"] = "below_margin"
        report["message"] = (
            f"lightgbm R² {lgb_r2:.3f} did not beat linear baseline "
            f"{lin_r2:.3f} by >= {R2_MARGIN}; model not written."
        )

    return report


def main():
    parser = argparse.ArgumentParser(description="Train supervised viral-score model")
    parser.add_argument("--feedback", required=True, help="Path to feedback JSON dump")
    parser.add_argument("--min-rows", type=int, default=MIN_ROWS)
    parser.add_argument("--dry-run", action="store_true", help="Report CV scores but don't write model.lgb")
    args = parser.parse_args()

    try:
        with open(args.feedback, "r", encoding="utf-8") as f:
            records = json.load(f)
        result = evaluate(records, min_rows=args.min_rows, write_model=not args.dry_run)
        print(json.dumps({"success": True, "data": result}, ensure_ascii=False, indent=2))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}, ensure_ascii=False))
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
