"""Optional supervised-scorer inference path (P3.5-C).

When ``ai-pipeline/model.lgb`` is present AND lightgbm is importable,
``predict(feature_vec)`` returns a 0-1 predicted viral score derived from
a gradient-boosted-tree model trained on ``clip_feedback``. Otherwise
returns ``None`` and the caller falls back to the linear weighted formula.

This is strictly additive — no behavior change when the model file is
absent, so the existing pipeline is unchanged until someone runs
``train_scorer.py`` and generates ``model.lgb``.
"""

import os
import threading as _threading

from .constants import DEFAULT_WEIGHTS


SCRIPT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_PATH = os.path.join(SCRIPT_DIR, "model.lgb")
# The feature vector fed to the model is DEFAULT_WEIGHTS.keys() in the order
# that features are registered. train_scorer.py writes this ordering alongside
# the model.
FEATURE_ORDER = list(DEFAULT_WEIGHTS.keys())

_MODEL = None
_MODEL_LOCK = _threading.Lock()
_MODEL_LOAD_TRIED = False


def _load_model():
    global _MODEL, _MODEL_LOAD_TRIED
    if _MODEL_LOAD_TRIED:
        return _MODEL
    with _MODEL_LOCK:
        if _MODEL_LOAD_TRIED:
            return _MODEL
        _MODEL_LOAD_TRIED = True
        if not os.path.exists(MODEL_PATH):
            return None
        try:
            import lightgbm as lgb
            _MODEL = lgb.Booster(model_file=MODEL_PATH)
        except Exception:
            _MODEL = None
        return _MODEL


def predict(scores):
    """Return a 0-1 predicted score or ``None`` to signal 'fall back to linear'.

    ``scores`` is a segment's feature dict, as the backend writes it for
    predict_supervised.py.
    """
    model = _load_model()
    if model is None:
        return None
    try:
        import numpy as np
        vec = np.array(
            [[float(scores.get(k, 0.0)) for k in FEATURE_ORDER]],
            dtype=np.float64,
        )
        pred = float(model.predict(vec)[0])
        return max(0.0, min(1.0, pred))
    except Exception:
        return None


def is_model_loaded():
    """Diagnostic helper for tests / status endpoints."""
    return _load_model() is not None


def reset_cache():
    """Force a re-probe of ``model.lgb`` on next predict(). For tests."""
    global _MODEL, _MODEL_LOAD_TRIED
    with _MODEL_LOCK:
        _MODEL = None
        _MODEL_LOAD_TRIED = False
