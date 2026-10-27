"""features/audio.py, features/context.py, features/text.py — branches the
fixture-based tests in test_pipeline.py don't reach."""

import json
import sys
import types
import wave

import numpy as np
import pytest

from features import audio, context, text


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


class TestEmotionalEnergy:
    @pytest.mark.parametrize("ratio,audio_score", [(2.0, 1.0), (1.5, 0.8), (1.0, 0.5), (0.5, 0.3), (0.2, 0.1)])
    def test_audio_bands(self, monkeypatch, ratio, audio_score):
        monkeypatch.setattr(audio, "_extract_audio_rms_ratio", lambda *a, **k: ratio)
        assert audio.score_emotional_energy("biasa saja") == round(0.3 * 0.4 + audio_score * 0.6, 4)

    def test_text_signals(self, monkeypatch):
        monkeypatch.setattr(audio, "_extract_audio_rms_ratio", lambda *a, **k: None)
        words = list(audio.EMOTION_WORDS)
        assert audio.score_emotional_energy(" ".join(words[:3])) == 0.7
        assert audio.score_emotional_energy(" ".join(words[:2])) == 0.6
        assert audio.score_emotional_energy(words[0]) == 0.5
        assert audio.score_emotional_energy("wah!! GILA BANGET") == round(0.3 + 0.15 + 0.1, 4)
        assert audio.score_emotional_energy("oke!") == 0.4


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


class TestSilenceAndPauses:
    def test_silence_ratio_guards(self, tmp_path):
        assert context._calc_silence_ratio(None, 0, 10) is None
        assert context._calc_silence_ratio(transcript(tmp_path, []), 0, 10) is None
        one = transcript(tmp_path, [{"start": 0, "end": 5}], "one.json")
        assert context._calc_silence_ratio(one, 0, 10) is None
        two = transcript(tmp_path, [{"start": 5, "end": 12}, {"start": 8, "end": 15}], "two.json")
        assert context._calc_silence_ratio(two, 10, 10) is None          # zero-length clip
        bad = tmp_path / "bad.json"
        bad.write_text("{", encoding="utf-8")
        assert context._calc_silence_ratio(str(bad), 0, 10) is None

    @pytest.mark.parametrize("gap,expected", [(0.5, 0.9), (2, 0.7), (3, 0.4), (6, 0.1)])
    def test_pause_bands_from_silence(self, tmp_path, gap, expected):
        t = transcript(tmp_path, [{"start": 0, "end": 2}, {"start": 2 + gap, "end": 10}])
        assert context.score_pause_structure("x", 10, t, 0, 10) == expected

    @pytest.mark.parametrize("words,duration,expected", [(0, 10, 0.3), (30, 10, 0.9), (17, 10, 0.7),
                                                         (10, 10, 0.4), (60, 10, 0.5)])
    def test_pause_bands_from_word_rate(self, words, duration, expected):
        assert context.score_pause_structure(" ".join(["kata"] * words), duration) == expected


class TestTopicAndHistory:
    def test_topic_fit_bands(self):
        kws = ["satu", "dua", "tiga", "empat", "lima", "enam", "tujuh", "delapan", "sembilan", "sepuluh"]
        assert context.score_topic_fit("x", None) == 0.5
        assert context.score_topic_fit("satu dua tiga empat", kws) == 1.0
        assert context.score_topic_fit("satu dua", kws) == 0.7
        assert context.score_topic_fit("satu", kws) == 0.3

    def test_history_handles_bad_records(self):
        assert context.score_history([None], "a b c") == 0.5
        assert context.score_history([{"text": "a b", "actual_viral_score": 1}], "a b c") == 0.5
        assert context.score_history([{"text": "a b c", "actual_viral_score": None}], "a b c") == 0.5


# --- text --------------------------------------------------------------------

class TestKeywordCorpus:
    def reset(self, monkeypatch, corpus_dir):
        monkeypatch.setattr(text, "_CORPUS_DIR", str(corpus_dir))
        monkeypatch.setattr(text, "_CORPUS_IDF", None)

    def test_too_few_docs_and_unreadable_files(self, tmp_path, monkeypatch):
        corpus = tmp_path / "corpus"
        corpus.mkdir()
        (corpus / "a.txt").write_text("rahasia penting banget", encoding="utf-8")
        (corpus / "readme.md").write_text("ignored", encoding="utf-8")
        (corpus / "folder.txt").mkdir()               # open() fails → skipped
        (corpus / "empty.txt").write_text("", encoding="utf-8")
        self.reset(monkeypatch, corpus)
        assert text._load_keyword_corpus() is None
        assert text._load_keyword_corpus() is None    # cached empty sentinel

    def test_all_tokens_filtered_as_stopwords(self, tmp_path, monkeypatch):
        corpus = tmp_path / "corpus"
        corpus.mkdir()
        for i in range(3):
            (corpus / f"{i}.txt").write_text("sama semua", encoding="utf-8")
        self.reset(monkeypatch, corpus)
        assert text._load_keyword_corpus() is None

    def test_tfidf_scoring_path(self, tmp_path, monkeypatch):
        corpus = tmp_path / "corpus"
        corpus.mkdir()
        docs = ["rahasia dapur", "rahasia bisnis", "tips dapur", "tips bisnis", "lain lagi"]
        for i, d in enumerate(docs):
            (corpus / f"{i}.txt").write_text(d, encoding="utf-8")
        self.reset(monkeypatch, corpus)
        idf = text._load_keyword_corpus()
        assert set(idf) == {"rahasia", "dapur", "bisnis", "tips"}
        assert text.score_keyword_trigger("rahasia dapur") == 1.0

    @pytest.mark.parametrize("density,expected", [(0.9, 1.0), (0.6, 0.85), (0.3, 0.65), (0.2, 0.4), (0.05, 0.2)])
    def test_tfidf_density_bands(self, density, expected):
        assert text._score_keyword_trigger_tfidf("kunci kunci", {"kunci": density}) == expected

    def test_tfidf_no_tokens_or_no_match(self):
        assert text._score_keyword_trigger_tfidf("a b", {"kunci": 1}) == 0.1
        assert text._score_keyword_trigger_tfidf("lainnya saja", {"kunci": 1}) == 0.1


class TestTextBands:
    def test_static_keyword_counts(self, monkeypatch):
        monkeypatch.setattr(text, "_load_keyword_corpus", lambda: None)
        kws = list(text.KEYWORD_TRIGGERS)
        filler = " ".join(["isi"] * 60)
        assert text.score_keyword_trigger(" ".join(kws[:3]) + " " + filler) == 0.85
        assert text.score_keyword_trigger(" ".join(kws[:2]) + " " + filler) == 0.65
        assert text.score_keyword_trigger(kws[0] + " " + filler) == 0.4

    def test_hook_question_word_and_long_clarity(self):
        long_plain = "gimana " + " ".join(["kata"] * 12) + "."
        assert text.score_hook_strength(long_plain.replace("gimana ", "")) == 0.2
        assert text.score_hook_strength("apa " + " ".join(["kata"] * 12) + ".") == 0.6
        assert text.score_clarity(90, "isi") == 0.4
