import json
import os
import subprocess
import sys
import tempfile

import pytest


SCRIPTS_DIR = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, os.path.abspath(SCRIPTS_DIR))


from segment import find_segments, _segment_reason
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



# -- Title and Description generation tests --


# -- Score subprocess tests --


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


# -- Constants validation --


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
            from features.constants import DEFAULT_WEIGHTS as DW
            initial["weights"] = dict(DW)
        with open(str(tmp_path / "weights.json"), "w") as f:
            json.dump(initial, f)
        records = [{"features": {"hookStrength": 0.8}, "actual_viral_score": 0.7}]
        result = train_weights(records, min_samples=5)
        assert result["data"]["status"] == "insufficient_data"

    def test_successful_training(self, tmp_path, monkeypatch):
        import learn_weights
        monkeypatch.setattr(learn_weights, "WEIGHTS_PATH", str(tmp_path / "weights.json"))
        from features.constants import DEFAULT_WEIGHTS as DW
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
        from features.constants import DEFAULT_WEIGHTS as DW
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
        from features.constants import DEFAULT_WEIGHTS as DW
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


# -- Discovery: transcript sampling + predicted score --
