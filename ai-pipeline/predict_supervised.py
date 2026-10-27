#!/usr/bin/env python3
"""Predictions of the optional trained scorer (model.lgb, from train_scorer.py).

The Bun scorer calls this only when ai-pipeline/model.lgb exists; it replaces
the weighted sum for segments the model can score.

    python predict_supervised.py --features F.json
    F.json: [{"index": 0, "features": {"hookStrength": 0.9, ...}}, ...]

stdout: {"success": true, "data": {"predictions": {"0": 0.71, ...}}} (null = no prediction)
"""

import argparse
import json
import sys

from features import supervised


def main():
    parser = argparse.ArgumentParser(description="Score feature vectors with the trained model")
    parser.add_argument("--features", required=True)
    args = parser.parse_args()
    try:
        with open(args.features, "r", encoding="utf-8") as f:
            rows = json.load(f)
        preds = {str(r["index"]): supervised.predict(r["features"]) for r in rows}
        print(json.dumps({"success": True, "data": {"predictions": preds, "modelLoaded": supervised.is_model_loaded()}}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
