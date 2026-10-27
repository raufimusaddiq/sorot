"""features/audio.py and features/text.py — branches the
fixture-based tests in test_pipeline.py don't reach."""

import json
import sys
import types
import wave

import numpy as np
import pytest

from features import audio, text


def write_wav(path, samples, rate=8000, channels=1, width=2):
    data = np.asarray(samples)
    dtype = {1: np.int8, 2: np.int16, 4: np.int32}[width]
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(width)
        wf.setframerate(rate)
        wf.writeframes(data.astype(dtype).tobytes())
    return str(path)


def fake_cupy():
    return types.SimpleNamespace(asarray=np.asarray, sqrt=np.sqrt, mean=np.mean)


# --- audio cache -------------------------------------------------------------

class TestAudioCache:
    def test_missing_and_corrupt(self, tmp_path):
        assert audio._load_audio_cache(None) is None
        assert audio._load_audio_cache(str(tmp_path / "nope.wav")) is None
        bad = tmp_path / "bad.wav"
        bad.write_bytes(b"RIFF....garbage")
        assert audio._load_audio_cache(str(bad)) is None

    def test_mono_stereo_and_8bit(self, tmp_path, monkeypatch):
        monkeypatch.delenv("USE_CUPY", raising=False)
        mono = audio._load_audio_cache(write_wav(tmp_path / "m.wav", [100, -100] * 400))
        assert mono["framerate"] == 8000 and mono["total_rms"] == pytest.approx(100) and mono["gpu"] is False
        stereo = audio._load_audio_cache(write_wav(tmp_path / "s.wav", [50, 0] * 400, channels=2))
        assert len(stereo["samples"]) == 400 and stereo["total_rms"] == pytest.approx(50)
        eight = audio._load_audio_cache(write_wav(tmp_path / "e.wav", [10, -10] * 10, width=1))
        assert eight["total_rms"] == pytest.approx(10)

    def test_cupy_opt_in(self, tmp_path, monkeypatch, capsys):
        wav = write_wav(tmp_path / "g.wav", [200, -200] * 400)
        monkeypatch.setenv("USE_CUPY", "1")
        monkeypatch.setitem(sys.modules, "cupy", None)  # unavailable → NumPy fallback + warning
        cache = audio._load_audio_cache(wav)
        assert cache["gpu"] is False and cache["total_rms"] == pytest.approx(200)
        assert "falling back to NumPy" in capsys.readouterr().err
        monkeypatch.setitem(sys.modules, "cupy", fake_cupy())
        assert audio._load_audio_cache(wav)["gpu"] is True


class TestRmsRatio:
    cache = {"samples": np.array([1.0] * 10 + [3.0] * 10), "framerate": 10, "total_rms": np.sqrt(5.0), "gpu": False}

    def test_ratio_and_guards(self, tmp_path):
        assert audio._extract_audio_rms_ratio(None, 1, 2) is None
        assert audio._extract_audio_rms_ratio(None, 1, 2, {**self.cache, "total_rms": 0}) is None
        assert audio._extract_audio_rms_ratio(None, 2, 1, self.cache) is None
        assert audio._extract_audio_rms_ratio(None, 1, 2, self.cache) == pytest.approx(3 / np.sqrt(5))
        assert audio._extract_audio_rms_ratio(None, 0, 1, {"samples": None}) is None  # malformed cache

    def test_gpu_path_and_gpu_failure_fallback(self, monkeypatch):
        gpu_cache = {**self.cache, "gpu": True}
        monkeypatch.setenv("USE_CUPY", "1")
        monkeypatch.setitem(sys.modules, "cupy", fake_cupy())
        assert audio._extract_audio_rms_ratio(None, 0, 1, gpu_cache) == pytest.approx(1 / np.sqrt(5))
        monkeypatch.setitem(sys.modules, "cupy", None)
        assert audio._extract_audio_rms_ratio(None, 0, 1, gpu_cache) == pytest.approx(1 / np.sqrt(5))


class TestOnsetDensity:
    def test_guards(self):
        assert audio.score_onset_density(None, 0, 1) == 0.5
        short = {"samples": np.ones(100), "framerate": 1000}
        assert audio.score_onset_density(short, 0, 0.1) == 0.5            # < half a second
        tiny_rate = {"samples": np.ones(4), "framerate": 3}
        assert audio.score_onset_density(tiny_rate, 0, 1) == 0.5          # < 4 windows
        silent = {"samples": np.zeros(1000), "framerate": 100}
        assert audio.score_onset_density(silent, 0, 10) == 0.1
        assert audio.score_onset_density({"samples": None, "framerate": 10}, 0, 1) == 0.5

    def test_bursty_audio_scores_higher_than_flat(self):
        rate = 100
        flat = {"samples": np.ones(rate * 10), "framerate": rate}
        bursty = np.ones(rate * 10)
        for i in range(0, rate * 10, 50):            # a loud 100 ms burst every 0.5 s
            bursty[i:i + 10] = 10
        busy = {"samples": bursty, "framerate": rate}
        assert audio.score_onset_density(flat, 0, 10) == 0.2
        assert audio.score_onset_density(busy, 0, 10) > 0.6


# --- context -----------------------------------------------------------------

def transcript(tmp_path, segments, name="t.json"):
    p = tmp_path / name
    p.write_text(json.dumps({"segments": segments}), encoding="utf-8")
    return str(p)


class TestHookStrength:
    """The hook score captions.py uses for hook-first openings."""

    def test_every_band(self):
        assert text.score_hook_strength("Ternyata rahasia ini gimana?") == 1.0
        assert text.score_hook_strength("Ternyata rahasianya sederhana.") == 0.9
        assert text.score_hook_strength("Ini " + " ".join(["kata"] * 12) + "?") == 0.7
        assert text.score_hook_strength("apa " + " ".join(["kata"] * 12) + ".") == 0.6
        assert text.score_hook_strength("Halo semua, apa kabar") == 0.4
        assert text.score_hook_strength(" ".join(["kata"] * 12) + ".") == 0.2

    def test_first_sentence(self):
        assert text._extract_first_sentence("satu. dua") == "satu."
        assert text._extract_first_sentence("satu, dua") == "satu"
        assert text._extract_first_sentence("satu dua") == "satu dua"
