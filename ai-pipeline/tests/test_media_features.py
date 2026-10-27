"""media_features.py (audio/visual measurements for the Bun scorer) and
predict_supervised.py (optional trained model)."""

import json
import sys

import media_features
import predict_supervised
from features import supervised


def run_main(module, monkeypatch, capsys, *argv):
    monkeypatch.setattr(sys, "argv", [f"{module.__name__}.py", *argv])
    code = 0
    try:
        module.main()
    except SystemExit as e:
        code = e.code
    return code, json.loads(capsys.readouterr().out.strip().splitlines()[-1])


def write_segments(tmp_path, key="segments"):
    p = tmp_path / "s.json"
    p.write_text(json.dumps({"videoId": "v1", key: [
        {"index": 0, "startTime": 0, "endTime": 10}, {"index": 1, "startTime": 10, "endTime": 20},
    ]}), encoding="utf-8")
    return str(p)


class TestMediaFeatures:
    def test_measures_each_segment(self, monkeypatch, tmp_path, capsys):
        seen = {}
        monkeypatch.setattr(media_features, "_load_audio_cache", lambda path: seen.setdefault("audio", path) and "cache")
        monkeypatch.setattr(media_features, "_batch_analyze_video",
                            lambda video, segs: {0: {"faces": 0.9, "scene": 0.4, "motion": 0.7}})
        monkeypatch.setattr(media_features, "_extract_audio_rms_ratio", lambda a, s, e, audio_cache=None: 1.5 if s == 0 else None)
        monkeypatch.setattr(media_features, "score_onset_density", lambda cache, s, e: 0.8)
        code, env = run_main(media_features, monkeypatch, capsys, "--segments", write_segments(tmp_path),
                             "--video", "v.mp4", "--audio", "a.wav")
        assert code == 0 and seen["audio"] == "a.wav"
        assert env["data"] == {"videoId": "v1", "segments": [
            {"index": 0, "rmsRatio": 1.5, "onsetDensity": 0.8, "facePresence": 0.9, "sceneChange": 0.4, "motion": 0.7},
            {"index": 1, "rmsRatio": None, "onsetDensity": 0.8, "facePresence": 0.5, "sceneChange": 0.5, "motion": 0.5},
        ]}

    def test_scored_segments_input_no_video_data_and_errors(self, monkeypatch, tmp_path, capsys):
        monkeypatch.setattr(media_features, "_load_audio_cache", lambda path: None)
        monkeypatch.setattr(media_features, "_batch_analyze_video", lambda video, segs: None)
        code, env = run_main(media_features, monkeypatch, capsys, "--segments", write_segments(tmp_path, "scoredSegments"),
                             "--video", "v.mp4")
        assert code == 0 and env["data"]["segments"][0]["facePresence"] == 0.5
        assert env["data"]["segments"][0]["rmsRatio"] is None
        code, env = run_main(media_features, monkeypatch, capsys, "--segments", str(tmp_path / "missing.json"), "--video", "v")
        assert code == 1 and env["success"] is False


class TestPredictSupervised:
    def test_predictions_by_index(self, monkeypatch, tmp_path, capsys):
        f = tmp_path / "f.json"
        f.write_text(json.dumps([{"index": 3, "features": {"hookStrength": 0.9}}, {"index": 5, "features": {}}]))
        monkeypatch.setattr(supervised, "predict", lambda feats: 0.7 if feats else None)
        monkeypatch.setattr(supervised, "is_model_loaded", lambda: True)
        code, env = run_main(predict_supervised, monkeypatch, capsys, "--features", str(f))
        assert code == 0 and env["data"] == {"predictions": {"3": 0.7, "5": None}, "modelLoaded": True}
        code, env = run_main(predict_supervised, monkeypatch, capsys, "--features", str(tmp_path / "nope.json"))
        assert code == 1 and env["success"] is False
