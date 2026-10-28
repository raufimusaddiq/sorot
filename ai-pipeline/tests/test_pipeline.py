import json
import os
import subprocess
import sys
import tempfile

import pytest


SCRIPTS_DIR = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, os.path.abspath(SCRIPTS_DIR))


def run_script(script_name, args):
    cmd = [sys.executable, os.path.join(SCRIPTS_DIR, script_name)] + args
    return subprocess.run(cmd, capture_output=True, text=True, timeout=120)


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
        assert "zoom_center" in VARIATION_PRESETS
        assert "zoom_top" in VARIATION_PRESETS
        assert "dynamic_crop" not in VARIATION_PRESETS     # it was the centre crop again

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
