"""Self-learning modules: features/supervised.py, train_scorer.py,
learn_weights.py and feedback.py. LightGBM is stubbed, and every path that
writes model/weight files is redirected to tmp_path — the real
ai-pipeline/weights.json and model.lgb are never touched."""

import json
import sys
import types

import numpy as np
import pytest

import feedback
import learn_weights
import train_scorer
from features import supervised


def run_main(module, monkeypatch, capsys, *argv):
    monkeypatch.setattr(sys, "argv", [f"{module.__name__}.py", *argv])
    code = 0
    try:
        module.main()
    except SystemExit as e:
        code = e.code
    out = capsys.readouterr().out.strip()
    return code, json.loads(out) if out else None


# --- fake lightgbm -----------------------------------------------------------

class FakeBooster:
    """predict() returns the first feature column — a 'perfect' model when
    labels are built from that column; constant=True predicts 0.5."""

    def __init__(self, model_file=None, constant=False):
        self.model_file = model_file
        self.constant = constant

    def predict(self, x):
        x = np.asarray(x, dtype=np.float64)
        return np.full(len(x), 0.5) if self.constant else x[:, 0]

    def save_model(self, path):
        with open(path, "w", encoding="utf-8") as f:
            f.write("fake-model")


def fake_lgb(constant=False, booster_error=False):
    def booster(model_file=None):
        if booster_error:
            raise RuntimeError("corrupt model")
        return FakeBooster(model_file)

    return types.SimpleNamespace(
        Booster=booster,
        Dataset=lambda x, label=None: (x, label),
        train=lambda params, ds, num_boost_round=0: FakeBooster(constant=constant),
    )


# --- supervised inference ------------------------------------------------------

@pytest.fixture
def sup(monkeypatch, tmp_path):
    model = tmp_path / "model.lgb"
    monkeypatch.setattr(supervised, "MODEL_PATH", str(model))
    supervised.reset_cache()
    yield model
    supervised.reset_cache()


class TestSupervised:
    def test_no_model_file(self, sup):
        assert supervised.predict({"hookStrength": 1}) is None
        assert supervised.is_model_loaded() is False

    def test_loads_once_and_clamps(self, sup, monkeypatch):
        sup.write_text("x")
        monkeypatch.setitem(sys.modules, "lightgbm", fake_lgb())
        first_key = supervised.FEATURE_ORDER[0]
        assert supervised.predict({first_key: 0.42}) == pytest.approx(0.42)
        assert supervised.predict({first_key: 7}) == 1.0
        assert supervised.predict({first_key: -3}) == 0.0
        assert supervised.is_model_loaded() is True

    def test_broken_model_and_predict_error(self, sup, monkeypatch):
        sup.write_text("x")
        monkeypatch.setitem(sys.modules, "lightgbm", fake_lgb(booster_error=True))
        assert supervised.predict({}) is None
        supervised.reset_cache()
        monkeypatch.setitem(sys.modules, "lightgbm", fake_lgb())
        assert supervised.predict({supervised.FEATURE_ORDER[0]: "not a number"}) is None


# --- train_scorer --------------------------------------------------------------

def records(n, linear_ok=False):
    out = []
    for i in range(n):
        f = {"a": (i % 10) / 10, "b": ((i * 7) % 10) / 10}
        out.append({"features": f, "actual_viral_score": f["a"]})
    return out


@pytest.fixture
def scorer_paths(monkeypatch, tmp_path):
    monkeypatch.setattr(train_scorer, "MODEL_PATH", str(tmp_path / "model.lgb"))
    monkeypatch.setattr(train_scorer, "META_PATH", str(tmp_path / "model.meta.json"))
    weights = tmp_path / "weights.json"
    monkeypatch.setattr(train_scorer, "WEIGHTS_PATH", str(weights))
    return tmp_path, weights


class TestTrainScorerHelpers:
    def test_weights_and_parsing(self, scorer_paths):
        _, weights = scorer_paths
        assert train_scorer._load_weights() == {}
        weights.write_text(json.dumps({"weights": {"a": 1.0}}), encoding="utf-8")
        assert train_scorer._load_weights() == {"a": 1.0}

        keys, x, y = train_scorer._parse_records([
            {"actual_viral_score": None, "features": {"a": 1}},
            {"actual_viral_score": 0.5, "features": json.dumps({"a": 0.1, "b": 0.2})},
            {"actual_viral_score": 0.5, "features": "{not json"},
            {"actual_viral_score": 0.5, "features": [1, 2]},
            {"actual_viral_score": 0.5, "features": {"a": 1}},          # missing "b"
            {"actual_viral_score": 0.9, "features": {"a": 0.3, "b": 0.4}},
        ])
        assert keys == ["a", "b"] and x == [[0.1, 0.2], [0.3, 0.4]] and y == [0.5, 0.9]
        assert train_scorer._parse_records([]) == ([], [], [])

    def test_metrics_and_folds(self):
        assert train_scorer._r2([1, 2, 3], [1, 2, 3]) == 1.0
        assert train_scorer._r2([2, 2], [1, 3]) == 0.0
        assert train_scorer._mae([1, 2], [2, 4]) == 1.5
        folds = train_scorer._cv_folds(11, k=5)
        assert sorted(i for f in folds for i in f) == list(range(11))


class TestEvaluate:
    def test_insufficient_and_missing_dependency(self, scorer_paths, monkeypatch):
        assert train_scorer.evaluate(records(3), min_rows=10)["status"] == "insufficient_data"
        monkeypatch.setitem(sys.modules, "lightgbm", None)
        assert train_scorer.evaluate(records(20), min_rows=10)["status"] == "missing_dependency"

    def test_writes_model_when_it_beats_linear(self, scorer_paths, monkeypatch):
        tmp, weights = scorer_paths
        weights.write_text(json.dumps({"weights": {"a": 0.0, "b": 0.0}}), encoding="utf-8")
        monkeypatch.setitem(sys.modules, "lightgbm", fake_lgb())
        report = train_scorer.evaluate(records(40), min_rows=10)
        assert report["status"] == "trained" and report["model_written"] is True
        assert report["lgb_r2"] == 1.0
        assert (tmp / "model.lgb").read_text() == "fake-model"
        assert json.loads((tmp / "model.meta.json").read_text())["trained_on"] == 40

    def test_below_margin_and_dry_run(self, scorer_paths, monkeypatch):
        tmp, weights = scorer_paths
        weights.write_text(json.dumps({"weights": {"a": 1.0}}), encoding="utf-8")   # linear is perfect
        monkeypatch.setitem(sys.modules, "lightgbm", fake_lgb(constant=True))
        report = train_scorer.evaluate(records(40), min_rows=10)
        assert report["status"] == "below_margin" and "not written" in report["message"]
        assert not (tmp / "model.lgb").exists()
        assert train_scorer.evaluate(records(40), min_rows=10, write_model=False)["status"] == "evaluated"

    def test_cli(self, scorer_paths, monkeypatch, capsys):
        tmp, _ = scorer_paths
        fb = tmp / "fb.json"
        fb.write_text(json.dumps(records(3)), encoding="utf-8")
        code, out = run_main(train_scorer, monkeypatch, capsys, "--feedback", str(fb), "--min-rows", "10", "--dry-run")
        assert code == 0 and out["data"]["status"] == "insufficient_data"
        code, out = run_main(train_scorer, monkeypatch, capsys, "--feedback", str(tmp / "missing.json"))
        assert code == 1 and out["success"] is False


# --- learn_weights -------------------------------------------------------------

@pytest.fixture
def weights_file(monkeypatch, tmp_path):
    p = tmp_path / "weights.json"
    monkeypatch.setattr(learn_weights, "WEIGHTS_PATH", str(p))
    return p


class TestLearnWeights:
    def test_defaults_when_no_weights_file(self, weights_file):
        cur = learn_weights.load_current_weights()
        assert cur["version"] == 0
        assert set(cur["weights"]) == set(learn_weights.FEATURE_KEYS)

    def test_string_features_and_sparse_features(self, weights_file):
        weights_file.write_text(json.dumps({"version": 1, "weights": {k: 0.1 for k in learn_weights.FEATURE_KEYS}}))
        recs = [{"features": json.dumps({"hookStrength": i / 10}), "actual_viral_score": i / 10} for i in range(6)]
        recs.append({"features": "{broken", "actual_viral_score": 0.5})
        out = learn_weights.train_weights(recs, min_samples=5)["data"]
        assert out["status"] == "trained" and out["version"] == 2
        assert "hookStrength" in out["weight_changes"]

    def test_all_zero_weights_are_kept(self, weights_file):
        weights_file.write_text(json.dumps({"version": 0, "weights": {k: 0.0 for k in learn_weights.FEATURE_KEYS}}))
        recs = [{"features": {}, "actual_viral_score": 0.5}] * 5
        out = learn_weights.train_weights(recs, min_samples=5)["data"]
        assert out["new_weights"] == {k: 0.0 for k in learn_weights.FEATURE_KEYS}
        assert out["weight_changes"] == {}

    def test_cli(self, weights_file, monkeypatch, capsys, tmp_path):
        weights_file.write_text(json.dumps({"version": 7, "trained_on": 3, "last_updated": "x", "weights": {"a": 1}}))
        code, out = run_main(learn_weights, monkeypatch, capsys, "--action", "status")
        assert code == 0 and out["data"]["version"] == 7

        fb = tmp_path / "fb.json"
        fb.write_text(json.dumps([{"features": {}, "actual_viral_score": 0.1}]))
        code, out = run_main(learn_weights, monkeypatch, capsys, "--action", "train", "--feedback", str(fb))
        assert out["data"]["status"] == "insufficient_data"

        code, out = run_main(learn_weights, monkeypatch, capsys, "--action", "train")
        assert code == 1 and "--feedback required" in out["error"]


# --- feedback ------------------------------------------------------------------

class TestFeedbackCli:
    def test_calc_and_error(self, monkeypatch, capsys):
        code, out = run_main(feedback, monkeypatch, capsys, "--action", "calc-viral-score", "--views", "1000",
                             "--likes", "50", "--comments", "5", "--shares", "2", "--saves", "10",
                             "--hours-since-post", "24")
        assert code == 0
        assert out["data"]["viralScore"] == feedback.calculate_viral_score(1000, 50, 5, 2, 10, 24)
        assert out["data"]["hoursSincePost"] == 24.0

        def boom(*a, **k):
            raise ValueError("bad input")
        monkeypatch.setattr(feedback, "calculate_viral_score", boom)
        code, out = run_main(feedback, monkeypatch, capsys, "--action", "calc-viral-score")
        assert code == 1 and out == {"success": False, "error": "bad input"}
