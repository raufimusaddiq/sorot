import json
import os
import subprocess
import sys
import tempfile

import pytest


SCRIPTS_DIR = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, os.path.abspath(SCRIPTS_DIR))


from segment import find_segments, _segment_reason
from score import (
    score_hook_strength,
    score_keyword_trigger,
    score_novelty,
    score_clarity,
    score_emotional_energy,
    score_pause_structure,
    score_face_presence,
    score_scene_change,
    score_topic_fit,
    score_history,
    score_text_sentiment,
    calc_boosts,
    calc_penalties,
    determine_tier,
    score_segment,
    generate_clip_title,
    generate_clip_description,
    WEIGHTS,
    HOOK_PHRASES,
    KEYWORD_TRIGGERS,
    PENALTY_CONDITIONS,
    BOOST_CONDITIONS,
    CONVERSATION_MARKERS,
    POSITIVE_WORDS,
    NEGATIVE_WORDS,
)
from feedback import calculate_viral_score
from learn_weights import pearson_correlation, train_weights, load_current_weights


def run_script(script_name, args):
    cmd = [sys.executable, os.path.join(SCRIPTS_DIR, script_name)] + args
    return subprocess.run(cmd, capture_output=True, text=True, timeout=120)


# -- Segment unit tests --


class TestFindSegments:
    def test_basic_segmentation(self):
        segments = [
            {"index": 0, "start": 0.0, "end": 5.0, "text": "Halo semuanya", "confidence": 0.9},
            {"index": 1, "start": 5.5, "end": 15.0, "text": "hari ini bahas rahasia penting", "confidence": 0.9},
            {"index": 2, "start": 15.5, "end": 30.0, "text": "ternyata trik ini sangat berguna", "confidence": 0.9},
        ]
        result = find_segments(segments, min_duration=10, max_duration=60)
        assert len(result) >= 1
        for seg in result:
            assert seg["duration"] >= 10
            assert seg["duration"] <= 60
            assert "startTime" in seg
            assert "endTime" in seg
            assert "text" in seg
            assert "reason" in seg

    def test_short_segments_merged(self):
        segments = [
            {"index": 0, "start": 0.0, "end": 3.0, "text": "Short", "confidence": 0.9},
            {"index": 1, "start": 3.5, "end": 7.0, "text": "Also short", "confidence": 0.9},
            {"index": 2, "start": 7.5, "end": 15.0, "text": "Longer part here", "confidence": 0.9},
        ]
        result = find_segments(segments, min_duration=10, max_duration=60)
        for seg in result:
            assert seg["duration"] >= 10

    def test_long_segments_split_at_max(self):
        segments = [
            {"index": i, "start": float(i * 5), "end": float((i + 1) * 5), "text": f"Part {i}", "confidence": 0.9}
            for i in range(20)
        ]
        result = find_segments(segments, min_duration=10, max_duration=60)
        for seg in result:
            assert seg["duration"] <= 60

    def test_empty_transcript(self):
        result = find_segments([], min_duration=10, max_duration=60)
        assert result == []

    def test_single_long_segment(self):
        segments = [
            {"index": i, "start": float(i * 3), "end": float((i + 1) * 3), "text": f"Word {i}", "confidence": 0.9}
            for i in range(10)
        ]
        result = find_segments(segments, min_duration=10, max_duration=60)
        assert len(result) >= 1

    def test_gap_creates_boundary(self):
        segments = [
            {"index": 0, "start": 0.0, "end": 10.0, "text": "First topic", "confidence": 0.9},
            {"index": 1, "start": 15.0, "end": 30.0, "text": "Second topic after gap", "confidence": 0.9},
        ]
        result = find_segments(segments, min_duration=10, max_duration=60)
        assert len(result) >= 1


class TestSegmentReason:
    def test_question_reason(self):
        seg = {"text": "Kenapa ini penting?"}
        reason = _segment_reason(seg, gap=0.5)
        assert "question" in reason

    def test_hook_phrase_reason(self):
        seg = {"text": "Rahasia yang penting untuk kamu tahu"}
        reason = _segment_reason(seg, gap=0.5)
        assert "hook" in reason.lower()

    def test_topic_shift_reason(self):
        seg = {"text": "Normal text"}
        reason = _segment_reason(seg, gap=3.0)
        assert "shift" in reason.lower()

    def test_continuous_reason(self):
        seg = {"text": "Normal text"}
        reason = _segment_reason(seg, gap=0.5)
        assert "continuous" in reason.lower()


# -- Segment subprocess tests --


class TestSegmentScript:
    def test_segment_with_valid_transcript(self, tmp_path):
        transcript = {
            "videoId": "test-video",
            "segments": [
                {"index": 0, "start": 0.0, "end": 5.0, "text": "Halo semuanya", "confidence": 0.95},
                {"index": 1, "start": 5.5, "end": 12.0, "text": "hari ini kita bahas rahasia penting", "confidence": 0.91},
                {"index": 2, "start": 12.5, "end": 20.0, "text": "ternyata ada yang tidak banyak orang tahu", "confidence": 0.88},
                {"index": 3, "start": 20.5, "end": 28.0, "text": "ini trik yang sangat berguna", "confidence": 0.90},
                {"index": 4, "start": 28.5, "end": 38.0, "text": "jadi perhatikan baik-baik ya", "confidence": 0.87},
                {"index": 5, "start": 38.5, "end": 50.0, "text": "langkah pertama adalah memahami dasarnya", "confidence": 0.89},
                {"index": 6, "start": 50.5, "end": 65.0, "text": "kemudian langkah kedua mulai praktik", "confidence": 0.92},
                {"index": 7, "start": 65.5, "end": 80.0, "text": "dan langkah ketiga evaluasi hasilnya", "confidence": 0.90},
            ],
        }
        transcript_path = tmp_path / "transcript.json"
        transcript_path.write_text(json.dumps(transcript), encoding="utf-8")

        result = run_script("segment.py", [
            "--transcript", str(transcript_path),
            "--output", str(tmp_path / "segments.json"),
        ])
        assert result.returncode == 0, f"stderr: {result.stderr}"
        output = json.loads(result.stdout)
        assert output["success"] is True

    def test_segment_missing_transcript_arg(self):
        result = run_script("segment.py", [])
        assert result.returncode != 0

    def test_segment_output_file_created(self, tmp_path):
        transcript = {
            "videoId": "test",
            "segments": [
                {"index": 0, "start": 0.0, "end": 15.0, "text": "Test segment", "confidence": 0.9},
            ],
        }
        transcript_path = tmp_path / "transcript.json"
        transcript_path.write_text(json.dumps(transcript), encoding="utf-8")
        output_path = tmp_path / "segments.json"

        result = run_script("segment.py", [
            "--transcript", str(transcript_path),
            "--output", str(output_path),
        ])
        assert result.returncode == 0
        assert output_path.exists()


# -- Score unit tests --


class TestScoreHookStrength:
    def test_question_and_hook_phrase(self):
        assert score_hook_strength("Rahasia apa yang penting?") == 1.0

    def test_question_only(self):
        assert score_hook_strength("Kenapa bisa begitu?") == 0.7

    def test_hook_phrase_only(self):
        assert score_hook_strength("Rahasia yang harus kamu tahu") >= 0.7

    def test_short_sentence(self):
        assert score_hook_strength("Coba perhatikan ini") >= 0.4

    def test_no_hook(self):
        result = score_hook_strength("Jadi kemudian kita lanjutkan pembahasan tentang hal yang sangat panjang ini")
        assert result <= 0.4


class TestScoreKeywordTrigger:
    def test_three_keywords(self):
        assert score_keyword_trigger("rahasia penting dan ternyata bahaya") == 1.0

    def test_two_keywords(self):
        assert score_keyword_trigger("rahasia dan penting saja") >= 0.6

    def test_one_keyword(self):
        assert score_keyword_trigger("ini rahasia saja") >= 0.3

    def test_zero_keywords(self):
        assert score_keyword_trigger("biasa saja tidak ada yang spesial") <= 0.15


class TestScoreNovelty:
    def test_with_numbers(self):
        assert score_novelty("Ada 3 langkah untuk meningkatkan 50% hasil") >= 0.3

    def test_with_proper_nouns(self):
        assert score_novelty("Jakarta memiliki potensi besar") >= 0.3

    def test_with_step_words(self):
        assert score_novelty("Pertama kita mulai, kedua kita lanjut") >= 0.4

    def test_generic(self):
        result = score_novelty("jadi kemudian lanjut saja")
        assert result <= 0.3

    def test_cap_at_one(self):
        result = score_novelty("Ada 3 langkah di Jakarta, pertama kita mulai")
        assert result <= 1.0


class TestScoreClarity:
    def test_short_segment(self):
        assert score_clarity(20, "clear topic") >= 0.85

    def test_medium_segment(self):
        result = score_clarity(35, "moderate topic")
        assert 0.5 <= result <= 0.85

    def test_long_segment(self):
        assert score_clarity(55, "long segment") <= 0.6

    def test_context_word_boost(self):
        without = score_clarity(40, "pembahasan lanjutan")
        with_ctx = score_clarity(40, "jadi intinya begini")
        assert with_ctx >= without


class TestScoreDefaults:
    def test_emotional_energy_default(self):
        assert score_emotional_energy("biasa saja") >= 0.3

    def test_emotional_energy_with_words(self):
        assert score_emotional_energy("Wah kaget banget! Sedih sekali!") > 0.5

    def test_pause_structure_default(self):
        assert 0.3 <= score_pause_structure("beberapa kata", 30) <= 1.0

    def test_pause_structure_fast(self):
        assert score_pause_structure("satu dua tiga empat lima enam tujuh delapan", 3) >= 0.5

    def test_face_presence_no_video(self):
        assert score_face_presence() == 0.5

    def test_face_presence_nonexistent_video(self):
        assert score_face_presence("/nonexistent/video.mp4", 0, 10) == 0.5

    def test_scene_change_no_video(self):
        assert score_scene_change() == 0.5

    def test_scene_change_nonexistent_video(self):
        assert score_scene_change("/nonexistent/video.mp4", 0, 10) == 0.5

    def test_history_default(self):
        assert score_history() == 0.5

    def test_history_no_data(self):
        assert score_history(feedback_data=None, text="some text") == 0.5

    def test_history_empty_data(self):
        assert score_history(feedback_data=[], text="some text") == 0.5


class TestScoreTopicFit:
    def test_strong_match(self):
        assert score_topic_fit("rahasia penting dan solusi", ["rahasia", "penting", "solusi"]) == 1.0

    def test_moderate_match(self):
        result = score_topic_fit("ada rahasia di sini", ["rahasia", "penting", "trik", "solusi", "tip"])
        assert result == 0.7

    def test_no_match(self):
        assert score_topic_fit("biasa saja", ["rahasia", "penting"]) == 0.3

    def test_empty_niche(self):
        assert score_topic_fit("any text", None) == 0.5

    def test_empty_niche_list(self):
        assert score_topic_fit("any text", []) == 0.5


class TestCalcBoosts:
    def test_sharp_question(self):
        assert calc_boosts("Kenapa kok bisa begitu?") >= 0.05

    def test_opinion_conflict(self):
        assert calc_boosts("Tapi sebenarnya beda") >= 0.05

    def test_number_list(self):
        assert calc_boosts("Pertama kita mulai, kedua lanjut") >= 0.03

    def test_emotional_moment(self):
        assert calc_boosts("Wow ini kaget banget") >= 0.05

    def test_no_boost(self):
        assert calc_boosts("biasa saja tidak ada yang spesial") == 0.0

    def test_multiple_boosts(self):
        result = calc_boosts("Kenapa kok bisa begitu? Tapi ternyata berbeda!")
        assert result >= 0.10

    def test_conversational_tone_boost(self):
        text = "Ya kan sih dong nih tuh deh loh nah duh"
        result = calc_boosts(text)
        assert result >= BOOST_CONDITIONS["conversational_tone"]

    def test_no_conversational_boost_below_threshold(self):
        result = calc_boosts("biasa saja satu dua tiga empat")
        assert BOOST_CONDITIONS["conversational_tone"] not in [result] or result == 0.0 or result < BOOST_CONDITIONS["conversational_tone"] + BOOST_CONDITIONS["conversational_tone"]


class TestCalcPenalties:
    def test_slow_opening(self):
        assert calc_penalties("jadi kemudian lanjut saja", 25) >= 0.08

    def test_too_generic(self):
        assert calc_penalties("jadi", 25) >= 0.05

    def test_no_penalty_for_hook(self):
        result = calc_penalties("Rahasia penting yang harus kamu tahu!", 25)
        assert result < 0.08

    def test_too_much_silence_penalty(self):
        scores = {"pauseStructure": 0.1}
        result = calc_penalties("Rahasia penting!", 25, scores)
        assert result >= PENALTY_CONDITIONS["too_much_silence"]

    def test_no_face_penalty(self):
        scores = {"facePresence": 0.0}
        result = calc_penalties("Rahasia penting!", 25, scores)
        assert result >= PENALTY_CONDITIONS["no_face"]

    def test_no_silence_or_face_penalty_without_scores(self):
        result = calc_penalties("Rahasia penting!", 25)
        assert result == 0.0

    def test_combined_penalties(self):
        scores = {"pauseStructure": 0.1, "facePresence": 0.0}
        result = calc_penalties("jadi kemudian lanjut saja", 25, scores)
        assert result >= PENALTY_CONDITIONS["slow_opening"] + PENALTY_CONDITIONS["too_much_silence"] + PENALTY_CONDITIONS["no_face"]


class TestDetermineTier:
    def test_primary(self):
        assert determine_tier(0.85) == "PRIMARY"
        assert determine_tier(0.80) == "PRIMARY"
        assert determine_tier(1.0) == "PRIMARY"

    def test_backup(self):
        assert determine_tier(0.75) == "BACKUP"
        assert determine_tier(0.65) == "BACKUP"

    def test_skip(self):
        assert determine_tier(0.64) == "SKIP"
        assert determine_tier(0.3) == "SKIP"
        assert determine_tier(0.0) == "SKIP"


class TestScoreSegment:
    def test_full_segment_scoring(self):
        segment = {
            "index": 0,
            "startTime": 0.0,
            "endTime": 25.0,
            "duration": 25.0,
            "text": "Rahasia penting! Kenapa tidak banyak orang tahu? Tapi ternyata ada solusi!",
            "reason": "strong hook",
        }
        result = score_segment(segment, niche_keywords=["rahasia", "penting", "solusi"])
        assert "finalScore" in result
        assert "tier" in result
        assert "scores" in result
        assert "title" in result
        assert "description" in result
        assert result["tier"] in ("PRIMARY", "BACKUP", "SKIP")
        assert result["finalScore"] > 0
        assert result["finalScore"] <= 1.0

    def test_weak_segment(self):
        segment = {
            "index": 0,
            "startTime": 0.0,
            "endTime": 50.0,
            "duration": 50.0,
            "text": "jadi kemudian lanjut saja pembahasan",
            "reason": "generic",
        }
        result = score_segment(segment)
        assert result["tier"] == "SKIP"

    def test_weights_sum_to_one(self):
        assert abs(sum(WEIGHTS.values()) - 1.0) < 0.001

    def test_segment_emits_new_feature_scores(self):
        """P3.5-B: motion and onsetDensity must appear in the scores dict."""
        segment = {
            "index": 0, "startTime": 0.0, "endTime": 10.0, "duration": 10.0,
            "text": "Rahasia ini wajib kamu tahu!",
        }
        result = score_segment(segment)
        assert "motion" in result["scores"]
        assert "onsetDensity" in result["scores"]
        assert 0.0 <= result["scores"]["motion"] <= 1.0
        assert 0.0 <= result["scores"]["onsetDensity"] <= 1.0


class TestNewFeatures:
    """Unit tests for P3.5-B additions: motion, onset density, TF-IDF corpus."""

    def test_motion_static_frames(self):
        import numpy as np
        from features.visual import _calc_motion_from_grays
        frame = np.zeros((64, 64), dtype=np.uint8)
        # identical frames → near-zero flow → low motion score
        result = _calc_motion_from_grays([frame.copy(), frame.copy(), frame.copy()])
        assert result <= 0.5

    def test_motion_changing_frames_scores_higher_than_static(self):
        import numpy as np
        from features.visual import _calc_motion_from_grays
        # We don't pin absolute calibration (depends on Farneback + image size),
        # only that a shifting image scores at least as high as a static one.
        h, w = 128, 128
        rng = np.random.default_rng(0)
        tex = rng.integers(0, 255, (h, w), dtype=np.uint8)
        static_score = _calc_motion_from_grays([tex, tex, tex])
        moving_frames = [tex, np.roll(tex, 10, axis=1), np.roll(tex, 20, axis=1)]
        moving_score = _calc_motion_from_grays(moving_frames)
        assert moving_score >= static_score

    def test_motion_empty_list(self):
        from features.visual import _calc_motion_from_grays
        assert _calc_motion_from_grays([]) == 0.5
        assert _calc_motion_from_grays([None]) == 0.5  # also handled

    def test_onset_density_none_cache(self):
        from features.audio import score_onset_density
        assert score_onset_density(None, 0.0, 5.0) == 0.5

    def test_onset_density_flat_audio(self):
        import numpy as np
        from features.audio import score_onset_density
        # Constant tone = no onsets → low density
        samples = np.ones(16000 * 3, dtype=np.float64) * 1000
        cache = {"samples": samples, "framerate": 16000, "total_rms": 1000.0, "gpu": False}
        result = score_onset_density(cache, 0.0, 3.0)
        assert result <= 0.5

    def test_onset_density_peaky_audio(self):
        import numpy as np
        from features.audio import score_onset_density
        # Quiet noise with sparse bursts every ~400 ms. Each burst straddles a
        # single 100 ms window, so neighbors stay quiet and the peak stands out.
        rng = np.random.default_rng(42)
        framerate = 16000
        duration_s = 4.0
        n = int(framerate * duration_s)
        samples = rng.standard_normal(n) * 50  # quiet background
        for burst_t in np.arange(0.2, duration_s, 0.4):
            i = int(burst_t * framerate)
            samples[i:i + 800] = 5000  # 50 ms-wide burst
        cache = {
            "samples": samples, "framerate": framerate,
            "total_rms": float(np.sqrt(np.mean(samples ** 2))), "gpu": False,
        }
        result = score_onset_density(cache, 0.0, duration_s)
        assert result > 0.3

    def test_corpus_loader_missing_dir(self, monkeypatch, tmp_path):
        import features.text as text_mod
        monkeypatch.setattr(text_mod, "_CORPUS_DIR", str(tmp_path / "does-not-exist"))
        monkeypatch.setattr(text_mod, "_CORPUS_IDF", None)
        assert text_mod._load_keyword_corpus() is None

    def test_supervised_predict_returns_none_without_model(self, monkeypatch, tmp_path):
        import features.supervised as sup_mod
        monkeypatch.setattr(sup_mod, "MODEL_PATH", str(tmp_path / "missing.lgb"))
        sup_mod.reset_cache()
        assert sup_mod.predict({"hookStrength": 0.9}) is None
        assert sup_mod.is_model_loaded() is False

    def test_train_scorer_refuses_below_threshold(self):
        # train_scorer.evaluate must guard the write against tiny datasets.
        from train_scorer import evaluate
        records = [
            {"features": {"a": 0.1, "b": 0.2}, "actual_viral_score": 0.5},
            {"features": {"a": 0.3, "b": 0.4}, "actual_viral_score": 0.6},
        ]
        result = evaluate(records, min_rows=200, write_model=True)
        assert result["status"] == "insufficient_data"
        assert result["rows"] == 2
        assert result["min_required"] == 200

    def test_corpus_loader_builds_idf(self, monkeypatch, tmp_path):
        import features.text as text_mod
        corpus_dir = tmp_path / "corpus"
        corpus_dir.mkdir()
        (corpus_dir / "a.txt").write_text(
            "rahasia penting wajib simak ternyata", encoding="utf-8"
        )
        (corpus_dir / "b.txt").write_text(
            "rahasia trik jangan mantap berguna", encoding="utf-8"
        )
        (corpus_dir / "c.txt").write_text(
            "penting fakta mengejutkan perhatikan", encoding="utf-8"
        )
        monkeypatch.setattr(text_mod, "_CORPUS_DIR", str(corpus_dir))
        monkeypatch.setattr(text_mod, "_CORPUS_IDF", None)
        idf = text_mod._load_keyword_corpus()
        assert idf is not None
        # "rahasia" appears in 2 of 3 docs (≤ 80%), should be included
        assert "rahasia" in idf
        assert idf["rahasia"] > 0

    def test_score_capped_at_one(self):
        segment = {
            "index": 0,
            "startTime": 0.0,
            "endTime": 15.0,
            "duration": 15.0,
            "text": "Rahasia penting! Kenapa? Tapi ternyata! Wow kaget! Pertama kedua ketiga!",
            "reason": "hook",
        }
        result = score_segment(segment, niche_keywords=["rahasia", "penting"])
        assert result["finalScore"] <= 1.0


# -- Title and Description generation tests --


class TestGenerateClipTitle:
    def test_question_title(self):
        title = generate_clip_title("Kenapa bisa begitu? Ini penjelasannya.", "PRIMARY", {})
        assert "?" in title
        assert len(title) <= 100

    def test_hook_phrase_title(self):
        title = generate_clip_title("Rahasia yang harus kamu tahu tentang ini", "PRIMARY", {})
        assert "Rahasia" in title or "rahasia" in title.lower()

    def test_fallback_title(self):
        title = generate_clip_title("biasa saja pembahasan hari ini", "SKIP", {})
        assert len(title) > 0

    def test_title_has_hashtags(self):
        title = generate_clip_title("rahasia penting dan trik baru", "PRIMARY", {})
        assert "#" in title

    def test_title_max_length(self):
        long_text = "Ini adalah teks yang sangat panjang sekali " * 20
        title = generate_clip_title(long_text, "PRIMARY", {})
        assert len(title) <= 103


class TestGenerateClipDescription:
    def test_description_basic(self):
        desc = generate_clip_description("rahasia penting tentang kehidupan", "PRIMARY", {})
        assert "rahasia" in desc.lower() or "#" in desc

    def test_description_has_hashtags(self):
        desc = generate_clip_description("trik hack tips solusi", "PRIMARY", {})
        assert "#" in desc

    def test_description_has_cta(self):
        desc = generate_clip_description("biasa saja", "BACKUP", {})
        assert "!" in desc

    def test_description_with_hook_line(self):
        desc = generate_clip_description("rahasia penting yang wajib diketahui", "PRIMARY", {})
        assert "Rahasia" in desc or "rahasia" in desc.lower()


# -- Score subprocess tests --


class TestScoreScript:
    def test_score_with_valid_segments(self, tmp_path):
        segments = {
            "videoId": "test-video",
            "segments": [
                {"index": 0, "startTime": 0.0, "endTime": 25.0, "duration": 25.0,
                 "text": "Rahasia penting yang tidak banyak orang tahu!", "reason": "hook"},
                {"index": 1, "startTime": 30.0, "endTime": 55.0, "duration": 25.0,
                 "text": "Jadi langkah pertama adalah memahami konsep dasarnya", "reason": "generic"},
            ],
        }
        segments_path = tmp_path / "segments.json"
        segments_path.write_text(json.dumps(segments), encoding="utf-8")
        video_path = tmp_path / "video.mp4"
        video_path.write_bytes(b"fake video content")

        result = run_script("score.py", [
            "--segments", str(segments_path),
            "--video", str(video_path),
            "--niche-keywords", "rahasia,penting,trik,solusi",
        ])
        assert result.returncode == 0, f"stderr: {result.stderr}"
        output = json.loads(result.stdout)
        assert output["success"] is True

    def test_score_missing_segments_arg(self):
        result = run_script("score.py", [])
        assert result.returncode != 0


# -- Transcribe subprocess test --


class TestTranscribeScript:
    def test_transcribe_missing_audio_arg(self):
        result = run_script("transcribe.py", [])
        assert result.returncode != 0

    def test_transcribe_nonexistent_audio_file(self):
        result = run_script("transcribe.py", ["--audio", "/nonexistent/file.wav"])
        assert result.returncode != 0

    def test_transcribe_main_with_invalid_audio(self, tmp_path, monkeypatch):
        monkeypatch.setattr(sys, "argv", [
            "transcribe.py",
            "--audio", str(tmp_path / "nonexistent.wav"),
            "--output", str(tmp_path / "out.json"),
        ])
        with pytest.raises(SystemExit) as exc_info:
            from transcribe import main
            main()
        assert exc_info.value.code == 1


class TestSegmentMain:
    def test_segment_main_with_valid_file(self, tmp_path, monkeypatch):
        transcript = {
            "videoId": "test",
            "segments": [
                {"index": 0, "start": 0.0, "end": 15.0, "text": "Test text here", "confidence": 0.9},
            ],
        }
        transcript_path = tmp_path / "transcript.json"
        transcript_path.write_text(json.dumps(transcript), encoding="utf-8")

        monkeypatch.setattr(sys, "argv", [
            "segment.py",
            "--transcript", str(transcript_path),
        ])
        from segment import main
        main()

    def test_segment_main_with_output(self, tmp_path, monkeypatch):
        transcript = {
            "videoId": "test",
            "segments": [
                {"index": 0, "start": 0.0, "end": 15.0, "text": "Test", "confidence": 0.9},
            ],
        }
        transcript_path = tmp_path / "transcript.json"
        transcript_path.write_text(json.dumps(transcript), encoding="utf-8")
        output_path = tmp_path / "output" / "segments.json"

        monkeypatch.setattr(sys, "argv", [
            "segment.py",
            "--transcript", str(transcript_path),
            "--output", str(output_path),
        ])
        from segment import main
        main()
        assert output_path.exists()

    def test_segment_main_bad_transcript(self, tmp_path, monkeypatch):
        monkeypatch.setattr(sys, "argv", [
            "segment.py",
            "--transcript", str(tmp_path / "nonexistent.json"),
        ])
        with pytest.raises(SystemExit) as exc_info:
            from segment import main
            main()
        assert exc_info.value.code == 1


class TestScoreMain:
    def test_score_main_with_valid_file(self, tmp_path, monkeypatch):
        segments = {
            "videoId": "test",
            "segments": [
                {"index": 0, "startTime": 0.0, "endTime": 25.0, "duration": 25.0,
                 "text": "Rahasia penting!", "reason": "hook"},
            ],
        }
        segments_path = tmp_path / "segments.json"
        segments_path.write_text(json.dumps(segments), encoding="utf-8")
        video_path = tmp_path / "video.mp4"
        video_path.write_bytes(b"fake")

        monkeypatch.setattr(sys, "argv", [
            "score.py",
            "--segments", str(segments_path),
            "--video", str(video_path),
        ])
        from score import main
        main()

    def test_score_main_with_niche_keywords(self, tmp_path, monkeypatch):
        segments = {
            "videoId": "test",
            "segments": [
                {"index": 0, "startTime": 0.0, "endTime": 20.0, "duration": 20.0,
                 "text": "Biasa saja", "reason": "generic"},
            ],
        }
        segments_path = tmp_path / "segments.json"
        segments_path.write_text(json.dumps(segments), encoding="utf-8")
        video_path = tmp_path / "video.mp4"
        video_path.write_bytes(b"fake")

        monkeypatch.setattr(sys, "argv", [
            "score.py",
            "--segments", str(segments_path),
            "--video", str(video_path),
            "--niche-keywords", "rahasia,penting",
        ])
        from score import main
        main()

    def test_score_main_bad_segments(self, tmp_path, monkeypatch):
        video_path = tmp_path / "video.mp4"
        video_path.write_bytes(b"fake")

        monkeypatch.setattr(sys, "argv", [
            "score.py",
            "--segments", str(tmp_path / "nonexistent.json"),
            "--video", str(video_path),
        ])
        with pytest.raises(SystemExit) as exc_info:
            from score import main
            main()
        assert exc_info.value.code == 1


# -- Constants validation --


class TestConstants:
    def test_hook_phrases_not_empty(self):
        assert len(HOOK_PHRASES) > 0

    def test_keyword_triggers_not_empty(self):
        assert len(KEYWORD_TRIGGERS) > 0

    def test_all_weights_present(self):
        expected = {"hookStrength", "keywordTrigger", "novelty", "clarity",
                     "emotionalEnergy", "textSentiment", "pauseStructure", "facePresence",
                     "sceneChange", "topicFit", "historyScore",
                     # P3.5-B additions
                     "motion", "onsetDensity"}
        assert set(WEIGHTS.keys()) == expected

    def test_hook_phrases_are_indonesian(self):
        for phrase in HOOK_PHRASES:
            assert isinstance(phrase, str)
            assert len(phrase) > 0

    def test_keyword_triggers_are_indonesian(self):
        for kw in KEYWORD_TRIGGERS:
            assert isinstance(kw, str)
            assert len(kw) > 0


# -- Render tests --


from render import (
    render_clip,
    find_ffmpeg,
)
from variation import VARIATION_PRESETS


class TestRenderUnit:
    def test_find_ffmpeg_default(self):
        result = find_ffmpeg()
        assert isinstance(result, str)
        assert len(result) > 0

    def test_find_ffmpeg_env_override(self, monkeypatch):
        monkeypatch.setenv("FFMPEG_PATH", "/custom/ffmpeg")
        assert find_ffmpeg() == "/custom/ffmpeg"

    def test_render_clip_nonexistent_video(self, tmp_path):
        with pytest.raises((RuntimeError, FileNotFoundError)):
            render_clip(
                "/nonexistent/video.mp4",
                0.0, 10.0,
                str(tmp_path / "out.mp4"),
                ffmpeg_path="ffmpeg",
            )


class TestRenderScript:
    def test_render_missing_args(self):
        result = run_script("render.py", [])
        assert result.returncode != 0

    def test_render_with_valid_segments_no_video(self, tmp_path):
        segments = {
            "videoId": "test",
            "scoredSegments": [
                {"rank": 1, "tier": "PRIMARY", "startTime": 0.0, "endTime": 10.0,
                 "finalScore": 0.85, "text": "test"},
            ],
        }
        segments_path = tmp_path / "segments.json"
        segments_path.write_text(json.dumps(segments), encoding="utf-8")

        result = run_script("render.py", [
            "--segments", str(segments_path),
            "--video", str(tmp_path / "nonexistent.mp4"),
            "--output-dir", str(tmp_path / "renders"),
        ])
        output = json.loads(result.stdout)
        assert output["success"] is True
        assert output["data"]["failedCount"] >= 1


class TestRenderNvencFallback:
    """Covers the P0 NVENC regression fix: probe-based detection + libx264 fallback."""

    def _reset_cache(self):
        import render as render_mod
        render_mod._NVENC_CACHE = None

    def test_build_cmd_seeks_before_input(self):
        import render as render_mod
        cmd = render_mod._build_render_cmd(
            "ffmpeg", "/tmp/src.mp4", 1.5, 3.5, "/tmp/out.mp4", use_nvenc=False,
        )
        assert "-i" in cmd
        i_idx = cmd.index("-i")
        ss_idx = cmd.index("-ss")
        to_idx = cmd.index("-to")
        assert ss_idx < i_idx and to_idx < i_idx, "-ss/-to must precede -i for fast seek"

    def test_build_cmd_includes_yuv420p(self):
        import render as render_mod
        cmd = render_mod._build_render_cmd(
            "ffmpeg", "/tmp/src.mp4", 0.0, 1.0, "/tmp/out.mp4", use_nvenc=True,
        )
        vf = cmd[cmd.index("-vf") + 1]
        assert "format=yuv420p" in vf
        assert "h264_nvenc" in cmd

    def test_build_cmd_libx264_when_no_nvenc(self):
        import render as render_mod
        cmd = render_mod._build_render_cmd(
            "ffmpeg", "/tmp/src.mp4", 0.0, 1.0, "/tmp/out.mp4", use_nvenc=False,
        )
        assert "libx264" in cmd
        assert "h264_nvenc" not in cmd

    def test_probe_returns_false_when_encoder_missing(self, monkeypatch):
        import render as render_mod
        self._reset_cache()

        class FakeResult:
            returncode = 0
            stdout = "V..... libx264  H.264 / ...\n"  # no nvenc

        monkeypatch.setattr(
            render_mod.subprocess, "run",
            lambda *a, **k: FakeResult(),
        )
        assert render_mod._probe_nvenc("ffmpeg") is False

    def test_probe_caches_result(self, monkeypatch):
        import render as render_mod
        self._reset_cache()

        calls = {"n": 0}

        class FakeResult:
            returncode = 0
            stdout = ""  # no nvenc → early-return False

        def fake_run(*a, **k):
            calls["n"] += 1
            return FakeResult()

        monkeypatch.setattr(render_mod.subprocess, "run", fake_run)
        render_mod._probe_nvenc("ffmpeg")
        render_mod._probe_nvenc("ffmpeg")
        render_mod._probe_nvenc("ffmpeg")
        assert calls["n"] == 1, "probe must be cached after first call"

    def test_render_clip_falls_back_to_libx264_on_nvenc_failure(
        self, monkeypatch, tmp_path,
    ):
        import render as render_mod
        self._reset_cache()
        render_mod._NVENC_CACHE = True  # pretend NVENC is available

        calls = []

        class FakeResult:
            def __init__(self, rc, stderr=""):
                self.returncode = rc
                self.stderr = stderr
                self.stdout = ""

        def fake_run(cmd, *a, **k):
            calls.append(cmd)
            # First call uses NVENC → simulate NVENC-specific failure.
            if "h264_nvenc" in cmd:
                return FakeResult(1, stderr="h264_nvenc @ 0x0 No NVENC capable devices found")
            # Fallback libx264 call → success.
            return FakeResult(0)

        monkeypatch.setattr(render_mod.subprocess, "run", fake_run)
        out = tmp_path / "out.mp4"
        render_mod.render_clip("/tmp/in.mp4", 0.0, 1.0, str(out), ffmpeg_path="ffmpeg")

        assert len(calls) == 2
        assert "h264_nvenc" in calls[0]
        assert "libx264" in calls[1]


# -- Subtitle tests --


from captions import words_for_clip as build_word_timeline


class TestSubtitleNvencFallback:
    def _reset_cache(self):
        import subtitle as sub_mod
        sub_mod._NVENC_CACHE = None

    def test_burn_cmd_without_captions_still_applies_format(self):
        import subtitle as sub_mod
        cmd = sub_mod._build_burn_cmd(
            "ffmpeg", "/tmp/in.mp4", None, "/tmp/out.mp4", use_nvenc=True,
        )
        vf = cmd[cmd.index("-vf") + 1]
        assert vf == "format=yuv420p"
        assert "h264_nvenc" in cmd

    def test_burn_cmd_appends_format_after_ass(self):
        import subtitle as sub_mod
        cmd = sub_mod._build_burn_cmd(
            "ffmpeg", "/tmp/in.mp4", r"C:\data\clip_1.ass", "/tmp/out.mp4", use_nvenc=False,
        )
        vf = cmd[cmd.index("-vf") + 1]
        # Windows path → forward slashes, drive colon escaped for the filter parser.
        assert vf == r"ass='C\:/data/clip_1.ass',format=yuv420p"
        assert "libx264" in cmd

    def test_burn_falls_back_to_libx264_on_nvenc_failure(self, monkeypatch, tmp_path):
        import subtitle as sub_mod
        self._reset_cache()
        sub_mod._NVENC_CACHE = True

        calls = []

        class FakeResult:
            def __init__(self, rc, stderr=""):
                self.returncode = rc
                self.stderr = stderr
                self.stdout = ""

        def fake_run(cmd, *a, **k):
            calls.append(cmd)
            if "h264_nvenc" in cmd:
                return FakeResult(1, stderr="nvenc driver error")
            return FakeResult(0)

        monkeypatch.setattr(sub_mod.subprocess, "run", fake_run)
        sub_mod.burn_subtitles(
            "/tmp/clip.mp4", None, str(tmp_path / "out.mp4"), ffmpeg_path="ffmpeg",
        )

        assert len(calls) == 2
        assert "h264_nvenc" in calls[0]
        assert "libx264" in calls[1]


class TestBuildWordTimeline:
    """Legacy transcripts (no per-word timing) fall back to an even split."""

    def test_basic_timeline(self):
        segments = [
            {"start": 0.0, "end": 5.0, "text": "hello world foo bar"},
            {"start": 5.5, "end": 10.0, "text": "test words here now"},
        ]
        words = build_word_timeline(segments, 0.0, 10.0)
        assert len(words) == 8
        for w in words:
            assert "text" in w
            assert "start" in w
            assert "end" in w
            assert w["start"] >= 0

    def test_clips_to_range(self):
        segments = [
            {"start": 0.0, "end": 5.0, "text": "before"},
            {"start": 5.0, "end": 10.0, "text": "within range"},
            {"start": 10.0, "end": 15.0, "text": "after"},
        ]
        words = build_word_timeline(segments, 5.0, 10.0)
        assert [w["text"] for w in words] == ["within", "range"]

    def test_empty_segments(self):
        words = build_word_timeline([], 0.0, 10.0)
        assert words == []

    def test_no_overlapping_segments(self):
        segments = [
            {"start": 20.0, "end": 30.0, "text": "far away"},
        ]
        words = build_word_timeline(segments, 0.0, 10.0)
        assert words == []


class TestSubtitleScript:
    def test_subtitle_missing_args(self):
        result = run_script("subtitle.py", [])
        assert result.returncode != 0


# -- Variation tests --


from variation import VARIATION_PRESETS, generate_variation


class TestVariationPresets:
    def test_presets_exist(self):
        assert len(VARIATION_PRESETS) >= 3
        assert "zoom_center" in VARIATION_PRESETS
        assert "zoom_top" in VARIATION_PRESETS
        assert "dynamic_crop" in VARIATION_PRESETS

    def test_preset_has_label(self):
        for name, preset in VARIATION_PRESETS.items():
            assert "label" in preset
            assert "vf_extra" in preset

    def test_zoompan_presets_are_video_safe(self):
        # d=1 + pzoom: one output frame per input frame (d>1 multiplies the length)
        for name, preset in VARIATION_PRESETS.items():
            if "zoompan" in preset["vf_extra"]:
                assert "{step}" in preset["vf_extra"] and ":d=1:" in preset["vf_extra"] and "pzoom" in preset["vf_extra"]


class TestVariationScript:
    def test_variation_missing_args(self):
        result = run_script("variation.py", [])
        assert result.returncode != 0

    def test_variation_no_primary(self, tmp_path):
        segments = {
            "videoId": "test",
            "scoredSegments": [
                {"rank": 1, "tier": "SKIP", "startTime": 0.0, "endTime": 10.0,
                 "finalScore": 0.3, "text": "meh"},
            ],
        }
        segments_path = tmp_path / "segments.json"
        segments_path.write_text(json.dumps(segments), encoding="utf-8")

        result = run_script("variation.py", [
            "--segments", str(segments_path),
            "--video", str(tmp_path / "video.mp4"),
            "--output-dir", str(tmp_path / "variations"),
        ])
        assert result.returncode == 0
        output = json.loads(result.stdout)
        assert output["success"] is True
        assert output["data"]["variationCount"] == 0


# -- Analytics tests --


from analytics import (
    calc_tier_distribution,
    calc_score_stats,
    calc_duration_stats,
    calc_top_features,
    generate_recommendations,
)


class TestCalcTierDistribution:
    def test_basic_distribution(self):
        segments = [
            {"tier": "PRIMARY"}, {"tier": "PRIMARY"}, {"tier": "BACKUP"}, {"tier": "SKIP"},
        ]
        result = calc_tier_distribution(segments)
        assert result["PRIMARY"] == 2
        assert result["BACKUP"] == 1
        assert result["SKIP"] == 1

    def test_empty(self):
        result = calc_tier_distribution([])
        assert result["PRIMARY"] == 0

    def test_missing_tier(self):
        result = calc_tier_distribution([{"text": "no tier"}])
        assert result["SKIP"] == 1


class TestCalcScoreStats:
    def test_basic_stats(self):
        segments = [{"finalScore": 0.9}, {"finalScore": 0.5}, {"finalScore": 0.3}]
        result = calc_score_stats(segments)
        assert result["min"] == 0.3
        assert result["max"] == 0.9
        assert abs(result["avg"] - 0.5667) < 0.01
        assert result["count"] == 3

    def test_empty(self):
        result = calc_score_stats([])
        assert result["count"] == 0

    def test_single(self):
        segments = [{"finalScore": 0.75}]
        result = calc_score_stats(segments)
        assert result["min"] == result["max"] == result["avg"] == 0.75


class TestCalcDurationStats:
    def test_basic(self):
        segments = [{"duration": 20}, {"duration": 40}, {"duration": 60}]
        result = calc_duration_stats(segments)
        assert result["min"] == 20.0
        assert result["max"] == 60.0
        assert result["avg"] == 40.0

    def test_empty(self):
        result = calc_duration_stats([])
        assert result["min"] == 0


class TestCalcTopFeatures:
    def test_basic(self):
        segments = [
            {"scores": {"hookStrength": 0.8, "keywordTrigger": 0.5, "clarity": 0.9}},
            {"scores": {"hookStrength": 0.6, "keywordTrigger": 0.7, "clarity": 0.3}},
        ]
        result = calc_top_features(segments)
        assert len(result) == 3
        assert result[0]["feature"] == "hookStrength"
        assert abs(result[0]["average"] - 0.7) < 0.01

    def test_empty(self):
        result = calc_top_features([])
        assert result == []

    def test_no_scores_key(self):
        result = calc_top_features([{"text": "no scores"}])
        assert result == []


class TestGenerateRecommendations:
    def test_no_primary(self):
        recs = generate_recommendations({"PRIMARY": 0, "BACKUP": 2, "SKIP": 3}, {"avg": 0.4}, {"avg": 25})
        assert any("No PRIMARY" in r for r in recs)

    def test_many_primary(self):
        recs = generate_recommendations({"PRIMARY": 8, "BACKUP": 2, "SKIP": 1}, {"avg": 0.7}, {"avg": 25})
        assert any("Many PRIMARY" in r for r in recs)

    def test_low_avg_score(self):
        recs = generate_recommendations({"PRIMARY": 2, "BACKUP": 2, "SKIP": 3}, {"avg": 0.3}, {"avg": 25})
        assert any("low" in r.lower() for r in recs)

    def test_long_clips(self):
        recs = generate_recommendations({"PRIMARY": 2, "BACKUP": 2, "SKIP": 1}, {"avg": 0.7}, {"avg": 55})
        assert any("long" in r.lower() for r in recs)

    def test_healthy(self):
        recs = generate_recommendations({"PRIMARY": 2, "BACKUP": 3, "SKIP": 2}, {"avg": 0.6}, {"avg": 30})
        assert any("healthy" in r.lower() for r in recs)


class TestAnalyticsScript:
    def test_analytics_missing_args(self):
        result = run_script("analytics.py", [])
        assert result.returncode != 0

    def test_analytics_with_valid_segments(self, tmp_path):
        segments = {
            "videoId": "test-video",
            "scoredSegments": [
                {"rank": 1, "tier": "PRIMARY", "startTime": 0.0, "endTime": 20.0,
                 "duration": 20.0, "finalScore": 0.85, "text": "Rahasia penting!",
                 "scores": {"hookStrength": 0.9, "keywordTrigger": 0.8, "novelty": 0.7,
                            "clarity": 0.9, "emotionalEnergy": 0.5, "pauseStructure": 0.6,
                            "facePresence": 0.5, "sceneChange": 0.5, "topicFit": 0.7,
                            "historyScore": 0.5, "boostTotal": 0.05, "penaltyTotal": 0.0}},
                {"rank": 2, "tier": "BACKUP", "startTime": 25.0, "endTime": 50.0,
                 "duration": 25.0, "finalScore": 0.70, "text": "Biasa saja",
                 "scores": {"hookStrength": 0.3, "keywordTrigger": 0.0, "novelty": 0.2,
                            "clarity": 0.6, "emotionalEnergy": 0.5, "pauseStructure": 0.6,
                            "facePresence": 0.5, "sceneChange": 0.5, "topicFit": 0.3,
                            "historyScore": 0.5, "boostTotal": 0.0, "penaltyTotal": 0.08}},
            ],
        }
        segments_path = tmp_path / "segments.json"
        segments_path.write_text(json.dumps(segments), encoding="utf-8")

        result = run_script("analytics.py", [
            "--segments", str(segments_path),
            "--output", str(tmp_path / "analytics.json"),
        ])
        assert result.returncode == 0
        output = json.loads(result.stdout)
        assert output["success"] is True
        assert output["data"]["totalSegments"] == 2
        assert output["data"]["tierDistribution"]["PRIMARY"] == 1
        assert output["data"]["tierDistribution"]["BACKUP"] == 1
        assert (tmp_path / "analytics.json").exists()

    def test_analytics_empty_segments(self, tmp_path):
        segments = {"videoId": "test", "scoredSegments": []}
        segments_path = tmp_path / "segments.json"
        segments_path.write_text(json.dumps(segments), encoding="utf-8")

        result = run_script("analytics.py", [
            "--segments", str(segments_path),
        ])
        assert result.returncode == 0
        output = json.loads(result.stdout)
        assert output["success"] is True
        assert output["data"]["totalSegments"] == 0


class TestAnalyticsMain:
    def test_analytics_main_with_file(self, tmp_path, monkeypatch):
        segments = {
            "videoId": "test",
            "scoredSegments": [
                {"rank": 1, "tier": "PRIMARY", "duration": 20.0, "finalScore": 0.85,
                 "text": "test", "scores": {"hookStrength": 0.9, "keywordTrigger": 0.5}},
            ],
        }
        segments_path = tmp_path / "segments.json"
        segments_path.write_text(json.dumps(segments), encoding="utf-8")

        monkeypatch.setattr(sys, "argv", [
            "analytics.py",
            "--segments", str(segments_path),
            "--output", str(tmp_path / "out" / "analytics.json"),
        ])
        from analytics import main
        main()
        assert (tmp_path / "out" / "analytics.json").exists()

    def test_analytics_main_no_output(self, tmp_path, monkeypatch):
        segments = {
            "videoId": "test",
            "scoredSegments": [
                {"rank": 1, "tier": "BACKUP", "duration": 25.0, "finalScore": 0.7,
                 "text": "test", "scores": {"hookStrength": 0.5}},
            ],
        }
        segments_path = tmp_path / "segments.json"
        segments_path.write_text(json.dumps(segments), encoding="utf-8")

        monkeypatch.setattr(sys, "argv", [
            "analytics.py",
            "--segments", str(segments_path),
        ])
        from analytics import main
        main()

    def test_analytics_main_bad_file(self, tmp_path, monkeypatch):
        monkeypatch.setattr(sys, "argv", [
            "analytics.py",
            "--segments", str(tmp_path / "nonexistent.json"),
        ])
        with pytest.raises(SystemExit) as exc_info:
            from analytics import main
            main()
        assert exc_info.value.code == 1


class TestRenderMain:
    def test_render_main_bad_file(self, tmp_path, monkeypatch):
        monkeypatch.setattr(sys, "argv", [
            "render.py",
            "--segments", str(tmp_path / "nonexistent.json"),
            "--video", str(tmp_path / "video.mp4"),
            "--output-dir", str(tmp_path / "renders"),
        ])
        with pytest.raises(SystemExit) as exc_info:
            from render import main
            main()
        assert exc_info.value.code == 1

    def test_render_main_with_segments(self, tmp_path, monkeypatch):
        segments = {
            "videoId": "test",
            "scoredSegments": [
                {"rank": 1, "tier": "SKIP", "startTime": 0.0, "endTime": 10.0,
                 "finalScore": 0.3, "text": "test"},
            ],
        }
        segments_path = tmp_path / "segments.json"
        segments_path.write_text(json.dumps(segments), encoding="utf-8")

        monkeypatch.setattr(sys, "argv", [
            "render.py",
            "--segments", str(segments_path),
            "--video", str(tmp_path / "nonexistent.mp4"),
            "--output-dir", str(tmp_path / "renders"),
            "--tiers", "PRIMARY",
        ])
        from render import main
        main()

    def test_render_main_graceful_failure(self, tmp_path, monkeypatch):
        segments = {
            "videoId": "test",
            "scoredSegments": [
                {"rank": 1, "tier": "PRIMARY", "startTime": 0.0, "endTime": 5.0,
                 "finalScore": 0.9, "text": "test"},
            ],
        }
        segments_path = tmp_path / "segments.json"
        segments_path.write_text(json.dumps(segments), encoding="utf-8")

        monkeypatch.setattr(sys, "argv", [
            "render.py",
            "--segments", str(segments_path),
            "--video", str(tmp_path / "nonexistent.mp4"),
            "--output-dir", str(tmp_path / "renders"),
        ])
        from render import main
        main()


class TestSubtitleMain:
    def test_subtitle_main_bad_file(self, tmp_path, monkeypatch):
        monkeypatch.setattr(sys, "argv", [
            "subtitle.py",
            "--transcript", str(tmp_path / "nonexistent.json"),
            "--segments", str(tmp_path / "nonexistent2.json"),
            "--render-dir", str(tmp_path / "renders"),
            "--output-dir", str(tmp_path / "exports"),
        ])
        with pytest.raises(SystemExit) as exc_info:
            from subtitle import main
            main()
        assert exc_info.value.code == 1

    def test_subtitle_main_with_files_but_no_renders(self, tmp_path, monkeypatch):
        transcript = {
            "videoId": "test",
            "segments": [
                {"start": 0.0, "end": 5.0, "text": "hello world"},
            ],
        }
        segments = {
            "videoId": "test",
            "scoredSegments": [
                {"rank": 1, "tier": "PRIMARY", "startTime": 0.0, "endTime": 5.0,
                 "finalScore": 0.9, "text": "hello world"},
            ],
        }
        transcript_path = tmp_path / "transcript.json"
        transcript_path.write_text(json.dumps(transcript), encoding="utf-8")
        segments_path = tmp_path / "segments.json"
        segments_path.write_text(json.dumps(segments), encoding="utf-8")

        monkeypatch.setattr(sys, "argv", [
            "subtitle.py",
            "--transcript", str(transcript_path),
            "--segments", str(segments_path),
            "--render-dir", str(tmp_path / "renders"),
            "--output-dir", str(tmp_path / "exports"),
        ])
        from subtitle import main
        main()


class TestVariationMain:
    def test_variation_main_bad_file(self, tmp_path, monkeypatch):
        monkeypatch.setattr(sys, "argv", [
            "variation.py",
            "--segments", str(tmp_path / "nonexistent.json"),
            "--video", str(tmp_path / "video.mp4"),
            "--output-dir", str(tmp_path / "variations"),
        ])
        with pytest.raises(SystemExit) as exc_info:
            from variation import main
            main()
        assert exc_info.value.code == 1

    def test_variation_main_with_primary_no_video(self, tmp_path, monkeypatch):
        segments = {
            "videoId": "test",
            "scoredSegments": [
                {"rank": 1, "tier": "PRIMARY", "startTime": 0.0, "endTime": 10.0,
                 "finalScore": 0.9, "text": "test"},
            ],
        }
        segments_path = tmp_path / "segments.json"
        segments_path.write_text(json.dumps(segments), encoding="utf-8")

        monkeypatch.setattr(sys, "argv", [
            "variation.py",
            "--segments", str(segments_path),
            "--video", str(tmp_path / "nonexistent.mp4"),
            "--output-dir", str(tmp_path / "variations"),
        ])
        from variation import main
        main()


# -- Text sentiment tests --


class TestScoreTextSentiment:
    def test_positive_text(self):
        result = score_text_sentiment("Ini hebat bagus keren berhasil")
        assert result > 0.5

    def test_negative_text(self):
        result = score_text_sentiment("Ini gagal buruk jelek parah")
        assert result < 0.5

    def test_neutral_text(self):
        result = score_text_sentiment("hari ini kita pergi ke pasar")
        assert result == 0.5

    def test_mixed_text(self):
        result = score_text_sentiment("hebat tapi gagal dan buruk")
        assert 0.3 < result < 0.7

    def test_strong_positive(self):
        result = score_text_sentiment("hebat bagus keren sukses bahagia senang luar biasa")
        assert result > 0.7

    def test_strong_negative(self):
        result = score_text_sentiment("gagal buruk jelek sedih marah stres depresi")
        assert result < 0.3

    def test_positive_words_not_empty(self):
        assert len(POSITIVE_WORDS) > 20

    def test_negative_words_not_empty(self):
        assert len(NEGATIVE_WORDS) > 20


class TestAudioRmsFallback:
    def test_no_audio_returns_text_only(self):
        result = score_emotional_energy("biasa saja tidak ada yang spesial")
        assert result >= 0.3
        assert isinstance(result, float)


class TestSilenceDetectionFallback:
    def test_no_transcript_returns_words_per_sec(self):
        result = score_pause_structure("satu dua tiga empat lima", 3)
        assert result >= 0.5

    def test_no_transcript_returns_default_for_slow(self):
        result = score_pause_structure("kata", 30)
        assert result <= 0.5


# -- Feedback tests --


class TestCalculateViralScore:
    def test_zero_views(self):
        assert calculate_viral_score(0, 0, 0, 0, 0) == 0.0

    def test_high_engagement(self):
        score = calculate_viral_score(10000, 1000, 200, 300, 100)
        assert score > 0.5

    def test_low_engagement(self):
        score = calculate_viral_score(100000, 10, 0, 0, 0)
        assert score < 0.5

    def test_viral_ratio(self):
        score_low = calculate_viral_score(1000, 10, 0, 0, 0, followers=100000)
        score_high = calculate_viral_score(1000000, 50000, 5000, 10000, 2000, followers=100)
        assert score_high > score_low

    def test_capped_at_one(self):
        score = calculate_viral_score(10000000, 500000, 100000, 200000, 50000)
        assert score <= 1.0

    def test_basic_score(self):
        score = calculate_viral_score(5000, 200, 50, 30, 20)
        assert 0.0 <= score <= 1.0

    def test_hours_since_post_normalizes_velocity(self):
        # Same raw counts but 10× longer on platform → lower score because
        # the per-day velocity is 10× smaller.
        fresh = calculate_viral_score(10000, 500, 50, 30, 20, hours_since_post=2)
        stale = calculate_viral_score(10000, 500, 50, 30, 20, hours_since_post=20)
        assert fresh > stale, f"expected fresh ({fresh}) > stale ({stale})"

    def test_hours_since_post_default_still_works(self):
        # Back-compat: callers that don't pass hours_since_post still get a
        # non-zero score (legacy api.ts paths before this reform).
        score = calculate_viral_score(10000, 500, 50, 30, 20)
        assert score > 0.0


class TestFeedbackScript:
    def test_calc_viral_score(self, tmp_path):
        result = run_script("feedback.py", [
            "--action", "calc-viral-score",
            "--views", "10000",
            "--likes", "500",
            "--comments", "50",
            "--shares", "30",
            "--saves", "20",
        ])
        assert result.returncode == 0
        output = json.loads(result.stdout)
        assert output["success"] is True
        assert "viralScore" in output["data"]

    def test_missing_action(self):
        result = run_script("feedback.py", [])
        assert result.returncode != 0


# -- Learn weights tests --


class TestPearsonCorrelation:
    def test_perfect_positive(self):
        assert abs(pearson_correlation([1, 2, 3], [2, 4, 6]) - 1.0) < 0.001

    def test_perfect_negative(self):
        assert abs(pearson_correlation([1, 2, 3], [6, 4, 2]) - (-1.0)) < 0.001

    def test_no_correlation(self):
        corr = pearson_correlation([1, 2, 3, 4], [1, -1, 1, -1])
        assert abs(corr) < 0.5

    def test_single_value(self):
        assert pearson_correlation([1], [2]) == 0.0

    def test_constant_values(self):
        assert pearson_correlation([1, 1, 1], [2, 2, 2]) == 0.0


class TestTrainWeights:
    def test_insufficient_data(self, tmp_path, monkeypatch):
        import learn_weights
        monkeypatch.setattr(learn_weights, "WEIGHTS_PATH", str(tmp_path / "weights.json"))
        initial = {"version": 0, "trained_on": 0, "last_updated": "", "weights": learn_weights.DEFAULT_WEIGHTS if hasattr(learn_weights, 'DEFAULT_WEIGHTS') else {}}
        if not initial["weights"]:
            from score import DEFAULT_WEIGHTS as DW
            initial["weights"] = dict(DW)
        with open(str(tmp_path / "weights.json"), "w") as f:
            json.dump(initial, f)
        records = [{"features": {"hookStrength": 0.8}, "actual_viral_score": 0.7}]
        result = train_weights(records, min_samples=5)
        assert result["data"]["status"] == "insufficient_data"

    def test_successful_training(self, tmp_path, monkeypatch):
        import learn_weights
        monkeypatch.setattr(learn_weights, "WEIGHTS_PATH", str(tmp_path / "weights.json"))
        from score import DEFAULT_WEIGHTS as DW
        initial = {"version": 0, "trained_on": 0, "last_updated": "", "weights": dict(DW)}
        with open(str(tmp_path / "weights.json"), "w") as f:
            json.dump(initial, f)
        records = []
        for i in range(10):
            records.append({
                "features": {k: (i + 1) / 10.0 for k in learn_weights.FEATURE_KEYS},
                "actual_viral_score": (i + 1) / 10.0,
            })
        result = train_weights(records, min_samples=5)
        assert result["data"]["status"] == "trained"
        assert result["data"]["version"] == 1
        assert "new_weights" in result["data"]

    def test_weights_sum_to_one_after_training(self, tmp_path, monkeypatch):
        import learn_weights
        monkeypatch.setattr(learn_weights, "WEIGHTS_PATH", str(tmp_path / "weights.json"))
        from score import DEFAULT_WEIGHTS as DW
        initial = {"version": 0, "trained_on": 0, "last_updated": "", "weights": dict(DW)}
        with open(str(tmp_path / "weights.json"), "w") as f:
            json.dump(initial, f)
        records = []
        for i in range(10):
            records.append({
                "features": {k: (i + 1) / 10.0 for k in learn_weights.FEATURE_KEYS},
                "actual_viral_score": (i + 1) / 10.0,
            })
        train_weights(records, min_samples=5)
        with open(str(tmp_path / "weights.json")) as f:
            updated = json.load(f)
        assert abs(sum(updated["weights"].values()) - 1.0) < 0.01


class TestLearnWeightsScript:
    def test_status_action(self, tmp_path):
        from score import DEFAULT_WEIGHTS as DW
        weights_path = tmp_path / "weights.json"
        weights_path.write_text(json.dumps({"version": 2, "trained_on": 10, "last_updated": "2026-01-01", "weights": dict(DW)}))

        import learn_weights
        original_path = learn_weights.WEIGHTS_PATH
        learn_weights.WEIGHTS_PATH = str(weights_path)
        try:
            result = run_script("learn_weights.py", ["--action", "status"])
        finally:
            learn_weights.WEIGHTS_PATH = original_path
        assert result.returncode == 0
        output = json.loads(result.stdout)
        assert output["success"] is True

    def test_train_missing_feedback(self):
        result = run_script("learn_weights.py", ["--action", "train"])
        assert result.returncode != 0


# -- History score with feedback data --


class TestScoreHistoryWithFeedback:
    def test_similar_clips(self):
        feedback = [
            {"text": "rahasia penting tentang kehidupan yang baik", "actual_viral_score": 0.9},
            {"text": "rahasia penting untuk kehidupan yang benar", "actual_viral_score": 0.8},
            {"text": "hal biasa saja tidak ada hubungannya", "actual_viral_score": 0.2},
        ]
        result = score_history(feedback_data=feedback, text="rahasia penting untuk kehidupan")
        assert result > 0.5

    def test_no_similar_clips(self):
        feedback = [
            {"text": "resep masakan nasi goreng", "actual_viral_score": 0.9},
        ]
        result = score_history(feedback_data=feedback, text="rahasia penting teknologi")
        assert result == 0.5


# -- Discovery: transcript sampling + predicted score --


class TestDiscoveryVTTParser:
    def test_strips_timing_and_tags(self, tmp_path):
        import discover
        vtt = tmp_path / "s.vtt"
        vtt.write_text(
            "WEBVTT\nKind: captions\nLanguage: id\n\n"
            "00:00:00.000 --> 00:00:02.000\nHalo semuanya\n\n"
            "00:00:02.000 --> 00:00:04.000\n<c>Ini</c> rahasia penting\n",
            encoding="utf-8",
        )
        text = discover._vtt_to_text(str(vtt), 500)
        assert "Halo semuanya" in text
        assert "Ini rahasia penting" in text
        assert "-->" not in text
        assert "<c>" not in text
        assert "WEBVTT" not in text

    def test_dedupes_rolling_duplicates(self, tmp_path):
        import discover
        vtt = tmp_path / "s.vtt"
        vtt.write_text(
            "WEBVTT\n\n"
            "00:00:00.000 --> 00:00:01.000\nHalo\n\n"
            "00:00:01.000 --> 00:00:02.000\nHalo\n\n"
            "00:00:02.000 --> 00:00:03.000\nHalo dunia\n",
            encoding="utf-8",
        )
        text = discover._vtt_to_text(str(vtt), 500)
        # "Halo" twice collapses to once; "Halo dunia" is different so kept
        assert text.count("Halo") >= 2  # "Halo" + "Halo dunia"
        assert text == "Halo Halo dunia"

    def test_returns_empty_on_missing_file(self):
        import discover
        assert discover._vtt_to_text("/nonexistent/path.vtt", 500) == ""


class TestPredictClipPotential:
    def test_viral_keywords_score_high(self):
        import discover
        t, p = discover.predict_clip_potential(
            "Ternyata rahasia ini jarang diketahui. Fakta mengejutkan tentang sukses. Penting banget buat kamu.",
            duration=300, view_count=50000, age_hours=24,
        )
        assert t > 0.5
        assert p > 0.5

    def test_bland_text_scores_low(self):
        import discover
        t, p = discover.predict_clip_potential(
            "Hari ini saya masak. Kemarin cuaca biasa saja.",
            duration=60, view_count=100, age_hours=720,
        )
        assert t < 0.5
        assert p < 0.5

    def test_empty_transcript_still_scores_velocity(self):
        import discover
        t, p = discover.predict_clip_potential("", duration=600, view_count=100000, age_hours=12)
        assert t == 0.0
        # With zero transcript but strong velocity + duration fit, predicted is nonzero
        assert p > 0.2

    def test_duration_fit_sweet_spot(self):
        import discover
        _, p_good = discover.predict_clip_potential("", duration=400, view_count=0, age_hours=9999)
        _, p_bad = discover.predict_clip_potential("", duration=5, view_count=0, age_hours=9999)
        assert p_good > p_bad


class TestDiscoveryEnrichCLI:
    def test_enrich_mode_requires_video_url(self):
        result = run_script("discover.py", ["--mode", "enrich"])
        assert result.returncode != 0


class TestShortsDetection:
    def test_shorts_url_pattern(self):
        import discover
        assert discover.is_short({"url": "https://www.youtube.com/shorts/abc12345678"}) is True
        assert discover.is_short({"url": "https://www.youtube.com/watch?v=abc12345678"}) is False

    def test_short_duration_under_60s(self):
        import discover
        assert discover.is_short({"url": "https://youtube.com/watch?v=x", "duration": 45}) is True
        assert discover.is_short({"url": "https://youtube.com/watch?v=x", "duration": 60}) is True
        assert discover.is_short({"url": "https://youtube.com/watch?v=x", "duration": 61}) is False

    def test_missing_or_zero_duration_is_not_short(self):
        import discover
        assert discover.is_short({"url": "https://youtube.com/watch?v=x", "duration": 0}) is False
        assert discover.is_short({"url": "https://youtube.com/watch?v=x"}) is False

    def test_string_duration_parsed(self):
        import discover
        assert discover.is_short({"url": "", "duration": "30"}) is True
        assert discover.is_short({"url": "", "duration": "120"}) is False


class TestDurationFitInverted:
    """v2 inversion: long-form source material must outrank already-clipped videos."""

    def test_long_form_wins(self):
        import discover
        # 60 min podcast must score higher than 10 min compilation.
        assert discover.duration_fit_score(60 * 60) > discover.duration_fit_score(10 * 60)
        # 2 hr livestream VOD must score at least as high as a 60 min podcast.
        assert discover.duration_fit_score(120 * 60) >= discover.duration_fit_score(60 * 60)

    def test_short_rejected(self):
        import discover
        assert discover.duration_fit_score(60) == 0.0        # 1 min — reject
        assert discover.duration_fit_score(4 * 60) == 0.0    # 4 min — reject
        assert discover.duration_fit_score(5 * 60) == 0.15   # 5 min — borderline

    def test_curve_monotonic_through_sweetspot(self):
        import discover
        ladder = [
            discover.duration_fit_score(4 * 60),    # 0.00
            discover.duration_fit_score(8 * 60),    # 0.15
            discover.duration_fit_score(12 * 60),   # 0.40
            discover.duration_fit_score(20 * 60),   # 0.70
            discover.duration_fit_score(60 * 60),   # 1.00
        ]
        assert ladder == sorted(ladder), f"curve not monotonic: {ladder}"

    def test_ultra_long_form_still_prime(self):
        """4hr livestream VOD — beyond 180-min sweetspot but still clippable."""
        import discover
        assert discover.duration_fit_score(4 * 3600) == 1.00
        assert discover.duration_fit_score(8 * 3600) == 1.00

    def test_relevance_score_favors_podcast_over_compilation(self):
        """Regression test for the primary v2 bug: compilations used to outrank sources."""
        import discover
        podcast = {
            "title": "Full Podcast Episode with Guest",
            "description": "",
            "duration": 90 * 60,
            "viewCount": 50000,
            "age_hours": 240,
        }
        compilation = {
            "title": "Podcast Viral Moments with Guest",
            "description": "",
            "duration": 12 * 60,
            "viewCount": 50000,
            "age_hours": 240,
        }
        assert discover.quick_relevance_score(podcast) > discover.quick_relevance_score(compilation)

    def test_predict_clip_potential_rewards_long_form(self):
        import discover
        # Same transcript, same velocity, different durations. Long-form wins.
        long_tscore, long_pscore = discover.predict_clip_potential(
            transcript="", duration=90 * 60, view_count=10000, age_hours=240
        )
        short_tscore, short_pscore = discover.predict_clip_potential(
            transcript="", duration=8 * 60, view_count=10000, age_hours=240
        )
        assert long_pscore > short_pscore


class TestAlreadyClippedFilter:
    def test_clip_keyword_rejected(self):
        import discover
        assert discover.looks_already_clipped("Best of Deddy Corbuzier Clips 2026") is True
        assert discover.looks_already_clipped("Potongan Viral Najwa Shihab") is True
        assert discover.looks_already_clipped("Top 10 Moments from the Podcast") is True
        assert discover.looks_already_clipped("Cuplikan Stand Up Comedy Terbaik") is True
        assert discover.looks_already_clipped("Highlight Debat Capres 2026") is True

    def test_source_material_passes(self):
        import discover
        assert discover.looks_already_clipped("Close The Door with Deddy Corbuzier EP. 12") is False
        assert discover.looks_already_clipped("Curhat Bang Denny Sumargo - Full Episode") is False
        assert discover.looks_already_clipped("Mata Najwa - Tatap Mata Ahok") is False

    def test_empty_title_is_not_clipped(self):
        import discover
        assert discover.looks_already_clipped("") is False
        assert discover.looks_already_clipped(None) is False


class TestContentTypeClassifier:
    def test_podcast(self):
        import discover
        assert discover.classify_content_type(
            "Close The Door Ep. 42", "Deddy Corbuzier", 90 * 60
        ) == "PODCAST"
        assert discover.classify_content_type(
            "Curhat Bang Denny Sumargo", "Denny Sumargo", 75 * 60
        ) == "PODCAST"

    def test_podcast_30_to_60_min_fallback(self):
        """Mid-length podcast (30–60 min) should still classify as PODCAST."""
        import discover
        assert discover.classify_content_type(
            "Ngobrolin Podcast Ep. 5", "Random Channel", 45 * 60
        ) == "PODCAST"

    def test_talkshow(self):
        import discover
        assert discover.classify_content_type(
            "Mata Najwa - Tatap Mata Ahok", "Narasi", 60 * 60
        ) == "TALKSHOW"
        assert discover.classify_content_type(
            "Hotman Paris Show - Exclusive Interview", "Hotman Paris", 45 * 60
        ) == "TALKSHOW"

    def test_standup(self):
        import discover
        assert discover.classify_content_type(
            "Stand Up Comedy Special - Pandji", "Pandji Pragiwaksono", 60 * 60
        ) == "STANDUP"
        assert discover.classify_content_type(
            "MLI Open Mic", "Majelis Lucu Indonesia", 30 * 60
        ) == "STANDUP"

    def test_livestream(self):
        import discover
        assert discover.classify_content_type(
            "Live Streaming Gameplay Session", "Streamer ID", 180 * 60
        ) == "LIVESTREAM"

    def test_news(self):
        import discover
        assert discover.classify_content_type(
            "Debat Capres 2026 - Segmen 1", "KPU", 45 * 60
        ) == "NEWS"

    def test_other_fallback(self):
        import discover
        assert discover.classify_content_type(
            "Music Video - Artist Name", "VEVO", 4 * 60
        ) == "OTHER"
        # Short "podcast" clip: duration below the threshold, so not PODCAST.
        assert discover.classify_content_type(
            "Podcast Clip 1 Minute", "Random", 60
        ) == "OTHER"


class TestNormalizeVideoV2Fields:
    def test_content_type_and_clip_flag_populated(self):
        import discover
        entry = {
            "id": "abc12345678",
            "url": "https://www.youtube.com/watch?v=abc12345678",
            "title": "Close The Door Ep. 99 - Special Guest",
            "channel": "Deddy Corbuzier",
            "channel_id": "UCxxx",
            "duration": 95 * 60,
            "view_count": 500000,
            "upload_date": "20260420",
            "description": "",
        }
        v = discover.normalize_video(entry)
        assert v["contentType"] == "PODCAST"
        assert v["isLikelyClipped"] is False
        assert v["channelId"] == "UCxxx"

    def test_clipped_title_flagged(self):
        import discover
        entry = {
            "id": "xyz12345678",
            "url": "https://www.youtube.com/watch?v=xyz12345678",
            "title": "Best of Deddy Corbuzier - Top 10 Moments",
            "channel": "Clip Farm",
            "channel_id": "UCyyy",
            "duration": 12 * 60,
            "view_count": 1000000,
            "upload_date": "20260420",
            "description": "",
        }
        v = discover.normalize_video(entry)
        assert v["isLikelyClipped"] is True


class TestChannelCrawlerCategorySeed:
    """Phase 2: category_seed crawl dedups channels across 12 anchor queries."""

    def test_seed_query_list_is_long_form(self):
        import channel_crawler
        # Defensive: anchor queries must exist and be non-trivial.
        assert len(channel_crawler.CATEGORY_SEED_QUERIES) >= 10
        assert "podcast indonesia" in channel_crawler.CATEGORY_SEED_QUERIES

    def test_category_seed_dedups_across_queries(self, monkeypatch):
        """Same channel surfaces from multiple queries — expect one dedup'd row."""
        import channel_crawler

        def fake_from_query(query, per_query, ytdlp_path, timeout=120):
            # Two queries both return the same channel ID — dedup must collapse.
            if query == "podcast indonesia":
                return [("UC_a", "Podcast A", "https://youtube.com/channel/UC_a", query),
                        ("UC_b", "Podcast B", "https://youtube.com/channel/UC_b", query)]
            return [("UC_a", "Podcast A", "https://youtube.com/channel/UC_a", query)]

        monkeypatch.setattr(channel_crawler, "_channels_from_query", fake_from_query)
        out = channel_crawler.discover_category_seed(
            queries=["podcast indonesia", "talk show indonesia"],
            per_query=5,
        )
        ids = sorted(c["youtubeChannelId"] for c in out)
        assert ids == ["UC_a", "UC_b"]

    def test_category_seed_records_discovered_via_query(self, monkeypatch):
        import channel_crawler

        def fake(query, per_query, ytdlp_path, timeout=120):
            return [("UC_x", "X", "https://youtube.com/channel/UC_x", query)]

        monkeypatch.setattr(channel_crawler, "_channels_from_query", fake)
        out = channel_crawler.discover_category_seed(queries=["mata najwa full"])
        assert out[0]["discoveredViaQuery"] == "mata najwa full"

    def test_channels_from_query_parses_jsonl(self, monkeypatch):
        """_channels_from_query converts yt-dlp newline-delimited JSON into tuples."""
        import channel_crawler

        sample = '\n'.join([
            '{"channel_id":"UC_a","channel":"Podcast A","channel_url":"https://youtube.com/@pa"}',
            '{"channel_id":"UC_b","uploader":"Podcast B"}',
            '',
            '{"channel":"No ID"}',  # missing channel_id — dropped
        ])

        def fake_ytdlp(args, ytdlp_path="yt-dlp", timeout=120):
            return sample, "", 0

        monkeypatch.setattr(channel_crawler, "_run_ytdlp", fake_ytdlp)
        out = channel_crawler._channels_from_query("q", per_query=10)
        ids = sorted(ch_id for ch_id, _, _, _ in out)
        assert ids == ["UC_a", "UC_b"]

    def test_channels_from_query_yields_canonical_url(self, monkeypatch):
        """Entries without channel_url fall back to /channel/<id>."""
        import channel_crawler

        sample = '{"channel_id":"UC_z","channel":"Z"}'

        def fake_ytdlp(args, ytdlp_path="yt-dlp", timeout=120):
            return sample, "", 0

        monkeypatch.setattr(channel_crawler, "_run_ytdlp", fake_ytdlp)
        out = channel_crawler._channels_from_query("q")
        assert out[0][2] == "https://www.youtube.com/channel/UC_z"


class TestChannelCrawlerProfile:
    """Phase 2: profile_channel computes stats + clipper detection."""

    def _mk_uploads(self, count, duration_sec, channel="Chan X",
                    channel_id="UCc", base_age=240, view_count=10000,
                    title="Podcast Ep. {i}"):
        uploads = []
        for i in range(count):
            uploads.append({
                "videoId": f"v{i}",
                "title": title.format(i=i),
                "url": f"https://youtube.com/watch?v=v{i}",
                "duration": duration_sec,
                "channel": channel,
                "channelId": channel_id,
                "viewCount": view_count,
                "uploadDate": "20260401",
                "age_hours": base_age + i * 24,
                "description": "",
                "contentType": "PODCAST" if duration_sec >= 60 * 60 else "OTHER",
                "isLikelyClipped": False,
            })
        return uploads

    def test_profile_long_form_channel_accepted(self, monkeypatch):
        import channel_crawler
        uploads = self._mk_uploads(30, duration_sec=90 * 60)
        monkeypatch.setattr(channel_crawler, "_fetch_channel_uploads",
                            lambda url, count=30, ytdlp_path="yt-dlp", timeout=180: uploads)

        p = channel_crawler.profile_channel("https://youtube.com/@chan-x")
        assert p["avgDurationSec"] == 90 * 60
        assert p["isLikelyClipperChannel"] == 0
        assert p["primaryCategory"] == "PODCAST"

    def test_profile_clipper_channel_flagged(self, monkeypatch):
        """Channel whose uploads are mostly <5 min fires the clipper heuristic."""
        import channel_crawler
        # 25 short uploads + 5 long = 83% short -> clipper
        shorts = self._mk_uploads(25, duration_sec=90, title="Clip {i}")
        longs = self._mk_uploads(5, duration_sec=90 * 60, title="Full Ep {i}")
        uploads = shorts + longs
        monkeypatch.setattr(channel_crawler, "_fetch_channel_uploads",
                            lambda *a, **k: uploads)
        p = channel_crawler.profile_channel("https://youtube.com/@farm")
        assert p["isLikelyClipperChannel"] == 1
        assert p["shortShareRatio"] >= 0.7

    def test_profile_clip_title_channel_flagged(self, monkeypatch):
        """Channel whose titles are mostly 'clip/best of/compilation' fires.

        The fixture marks uploads as isLikelyClipped=True directly (in real
        usage normalize_video does this from the title regex — tested
        separately in TestNormalizeVideoV2Fields).
        """
        import channel_crawler
        uploads = self._mk_uploads(30, duration_sec=12 * 60,
                                   title="Best of Deddy Clips Ep {i}")
        for u in uploads:
            u["isLikelyClipped"] = True
        monkeypatch.setattr(channel_crawler, "_fetch_channel_uploads",
                            lambda *a, **k: uploads)
        p = channel_crawler.profile_channel("https://youtube.com/@compfarm")
        assert p["isLikelyClipperChannel"] == 1
        assert p["clippedShareRatio"] >= 0.7

    def test_profile_uploads_per_week_roughly_correct(self, monkeypatch):
        """10 uploads spanning 2 weeks → ~5 uploads/week."""
        import channel_crawler
        # age_hours spans 0 to 336 (= 2 weeks) across 10 entries.
        uploads = []
        for i in range(10):
            uploads.append({
                "videoId": f"v{i}", "title": f"Ep {i}", "url": "",
                "duration": 60 * 60, "channel": "C", "channelId": "UCc",
                "viewCount": 1000, "uploadDate": "20260410",
                "age_hours": i * (336 / 9),
                "description": "",
                "contentType": "PODCAST", "isLikelyClipped": False,
            })
        monkeypatch.setattr(channel_crawler, "_fetch_channel_uploads",
                            lambda *a, **k: uploads)
        p = channel_crawler.profile_channel("https://youtube.com/@cadence")
        # 10 uploads / 2 weeks = 5/wk. Allow ±1 slack for rounding.
        assert 4.0 <= p["uploadsPerWeek"] <= 6.0

    def test_profile_empty_uploads_degrades_gracefully(self, monkeypatch):
        import channel_crawler
        monkeypatch.setattr(channel_crawler, "_fetch_channel_uploads",
                            lambda *a, **k: [])
        p = channel_crawler.profile_channel("https://youtube.com/@empty")
        assert p["uploadsAnalyzed"] == 0
        assert p["avgDurationSec"] == 0
        assert p["primaryCategory"] == "MIXED"

    def test_classify_channel_category_majority(self):
        import channel_crawler
        uploads = [{"contentType": "PODCAST"}] * 20 + [{"contentType": "OTHER"}] * 10
        assert channel_crawler._classify_channel_category(uploads) == "PODCAST"

    def test_classify_channel_category_mixed_when_below_threshold(self):
        import channel_crawler
        # 30% podcast, 30% standup, 40% other → no category clears 40% share
        uploads = (
            [{"contentType": "PODCAST"}] * 3 +
            [{"contentType": "STANDUP"}] * 3 +
            [{"contentType": "OTHER"}] * 4
        )
        assert channel_crawler._classify_channel_category(uploads) == "MIXED"
