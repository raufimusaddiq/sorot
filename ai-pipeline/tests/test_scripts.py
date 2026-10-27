"""Stage scripts run in-process: transcribe, render, subtitle, variation,
analytics and score. ffmpeg/ffprobe and faster-whisper are faked so every
branch (NVENC probe, fallbacks, per-clip failures, CLI envelopes) is hit
without a GPU."""

import json
import os
import subprocess
import sys
import types

import pytest

import render
import subtitle
import transcribe
import variation


def run_main(module, monkeypatch, capsys, *argv):
    monkeypatch.setattr(sys, "argv", [f"{module.__name__}.py", *argv])
    code = 0
    try:
        module.main()
    except SystemExit as e:
        code = e.code
    out = capsys.readouterr().out.strip().splitlines()
    return code, json.loads(out[-1]) if out else None


def proc(returncode=0, stdout="", stderr=""):
    return types.SimpleNamespace(returncode=returncode, stdout=stdout, stderr=stderr)


# --- transcribe ----------------------------------------------------------------

class FakeWhisper:
    created = []

    def __init__(self, model, device, compute_type):
        FakeWhisper.created.append((model, device, compute_type))

    def transcribe(self, audio, language, word_timestamps, vad_filter):
        assert word_timestamps and vad_filter
        segs = [types.SimpleNamespace(start=0.0, end=1.234, text=" halo ", avg_logprob=-0.123),
                types.SimpleNamespace(start=1.5, end=2.0, text="dunia", avg_logprob=None)]
        return iter(segs), types.SimpleNamespace(language=language)


class TestTranscribe:
    @pytest.fixture(autouse=True)
    def whisper(self, monkeypatch):
        FakeWhisper.created = []
        monkeypatch.setitem(sys.modules, "faster_whisper", types.SimpleNamespace(WhisperModel=FakeWhisper))
        for var in ("WHISPER_MODEL", "WHISPER_DEVICE", "WHISPER_COMPUTE_TYPE"):
            monkeypatch.delenv(var, raising=False)

    def test_writes_transcript_and_envelope(self, monkeypatch, capsys, tmp_path):
        out = tmp_path / "t" / "vid.json"
        code, env = run_main(transcribe, monkeypatch, capsys, "--audio", str(tmp_path / "vid.wav"),
                             "--output", str(out), "--device", "cpu")
        assert code == 0
        assert FakeWhisper.created == [("large-v3-turbo", "cpu", "int8")]
        data = env["data"]
        assert data["videoId"] == "vid" and data["language"] == "id"
        assert data["segments"][0] == {"index": 0, "start": 0.0, "end": 1.23, "text": "halo", "confidence": -0.12,
                                         "words": []}
        assert data["segments"][1]["confidence"] is None
        assert json.loads(out.read_text(encoding="utf-8")) == data

    def test_compute_type_selection(self, monkeypatch, capsys, tmp_path):
        run_main(transcribe, monkeypatch, capsys, "--audio", "a.wav")
        run_main(transcribe, monkeypatch, capsys, "--audio", "a.wav", "--compute-type", "int8_float16")
        assert [c[2] for c in FakeWhisper.created] == ["float16", "int8_float16"]

    def test_model_failure(self, monkeypatch, capsys):
        def boom(*a, **k):
            raise RuntimeError("CUDA OOM")
        monkeypatch.setitem(sys.modules, "faster_whisper", types.SimpleNamespace(WhisperModel=boom))
        code, env = run_main(transcribe, monkeypatch, capsys, "--audio", "a.wav")
        assert code == 1 and env == {"success": False, "error": "CUDA OOM"}


# --- NVENC probe (render + subtitle share the implementation) ----------------------

@pytest.mark.parametrize("mod", [render, subtitle])
class TestNvencProbe:
    def probe(self, mod, monkeypatch, listing, probe_rc=0, raise_on=None):
        monkeypatch.setattr(mod, "_NVENC_CACHE", None)
        calls = []

        def run(cmd, **kw):
            calls.append(cmd)
            if raise_on and raise_on in cmd:
                raise OSError("no ffmpeg")
            if "-encoders" in cmd:
                return proc(stdout=listing)
            return proc(returncode=probe_rc)
        monkeypatch.setattr(subprocess, "run", run)
        return mod._probe_nvenc("ffmpeg"), calls

    def test_no_encoder_listed(self, mod, monkeypatch):
        ok, calls = self.probe(mod, monkeypatch, "libx264")
        assert ok is False and len(calls) == 1

    def test_probe_encode_decides_and_is_cached(self, mod, monkeypatch):
        ok, calls = self.probe(mod, monkeypatch, "V..... h264_nvenc", probe_rc=0)
        assert ok is True and len(calls) == 2
        assert mod._detect_nvenc("ffmpeg") is True  # cached, alias
        ok, _ = self.probe(mod, monkeypatch, "h264_nvenc", probe_rc=1)
        assert ok is False

    def test_probe_frame_is_big_enough_for_nvenc(self, mod, monkeypatch):
        # NVENC refuses frames below its minimum (128x128 fails on Ada GPUs),
        # which made the probe report "no NVENC" on machines that have it.
        _, calls = self.probe(mod, monkeypatch, "h264_nvenc")
        src = next(a for a in calls[1] if a.startswith("testsrc="))
        w, h = (int(v) for v in src.split("size=")[1].split(":")[0].split("x"))
        assert w >= 256 and h >= 256

    def test_errors_mean_no_nvenc(self, mod, monkeypatch):
        ok, _ = self.probe(mod, monkeypatch, "", raise_on="-encoders")
        assert ok is False

    def test_find_ffmpeg_env(self, mod, monkeypatch):
        monkeypatch.setenv("FFMPEG_PATH", "/opt/ffmpeg")
        assert mod.find_ffmpeg() == "/opt/ffmpeg"


# --- render ------------------------------------------------------------------

def scored(tmp_path, n=3):
    data = {"videoId": "v", "scoredSegments": [
        {"rank": i + 1, "tier": t, "startTime": i * 10.0, "endTime": i * 10.0 + 8}
        for i, t in enumerate(["PRIMARY", "BACKUP", "SKIP"][:n])]}
    p = tmp_path / "scored.json"
    p.write_text(json.dumps(data), encoding="utf-8")
    return str(p)


class TestRender:
    def test_render_clip_resolves_ffmpeg_and_raises_after_fallback(self, monkeypatch, tmp_path):
        monkeypatch.setattr(render, "_probe_nvenc", lambda p: False)
        monkeypatch.setenv("FFMPEG_PATH", "ffx")
        seen = []
        monkeypatch.setattr(subprocess, "run", lambda cmd, **kw: (seen.append(cmd), proc(1, stderr="bad"))[1])
        with pytest.raises(RuntimeError, match="ffmpeg render failed"):
            render.render_clip("in.mp4", 0, 5, str(tmp_path / "o" / "c.mp4"))
        assert seen[0][0] == "ffx" and len(seen) == 1   # no NVENC → no retry

    def test_main_reports_per_clip_outcomes(self, monkeypatch, capsys, tmp_path):
        out_dir = tmp_path / "renders"

        def fake_render(video, start, end, output_path, timeline=None, reframe=None):
            if start == 0:
                open(output_path, "wb").write(b"mp4")
            elif start == 10:
                open(output_path, "wb").close()         # empty file
        monkeypatch.setattr(render, "render_clip", fake_render)
        code, env = run_main(render, monkeypatch, capsys, "--segments", scored(tmp_path), "--video", "v.mp4",
                             "--output-dir", str(out_dir))
        assert code == 0
        clips = env["data"]["clips"]
        assert [c["status"] for c in clips] == ["COMPLETED", "FAILED"]
        assert clips[1]["error"] == "Render produced empty file"
        assert env["data"]["renderedCount"] == 1 and env["data"]["failedCount"] == 1

    def test_main_clip_index_and_exception_cleanup(self, monkeypatch, capsys, tmp_path):
        out_dir = tmp_path / "renders"

        def fake_render(video, start, end, output_path, timeline=None, reframe=None):
            open(output_path, "wb").close()
            raise RuntimeError("nvenc died")
        monkeypatch.setattr(render, "render_clip", fake_render)
        code, env = run_main(render, monkeypatch, capsys, "--segments", scored(tmp_path), "--video", "v.mp4",
                             "--output-dir", str(out_dir), "--clip-index", "1")
        assert env["data"]["clips"] == [{"rank": 2, "tier": "BACKUP", "status": "FAILED", "error": "nvenc died"}]
        assert not (out_dir / "clip_2.mp4").exists()     # empty partial removed

        code, env = run_main(render, monkeypatch, capsys, "--segments", scored(tmp_path), "--video", "v.mp4",
                             "--output-dir", str(out_dir), "--clip-index", "9")
        assert env["data"]["clips"] == []

    def test_main_bad_segments_file(self, monkeypatch, capsys, tmp_path):
        code, env = run_main(render, monkeypatch, capsys, "--segments", str(tmp_path / "x.json"),
                             "--video", "v", "--output-dir", str(tmp_path))
        assert code == 1 and env["success"] is False


# --- subtitle ------------------------------------------------------------------

class TestSubtitle:
    def test_word_timeline_skips_empty_and_out_of_range(self):
        words = subtitle.words_for_clip(
            [{"start": 0, "end": 2, "text": "  "}, {"start": 50, "end": 60, "text": "jauh"},
             {"start": 10, "end": 12, "text": "halo dunia"}], 10, 20)
        assert [w["text"] for w in words] == ["halo", "dunia"]

    def test_burn_resolves_ffmpeg_and_raises(self, monkeypatch, tmp_path):
        monkeypatch.setattr(subtitle, "_probe_nvenc", lambda p: True)
        cmds = []
        monkeypatch.setattr(subprocess, "run", lambda cmd, **kw: (cmds.append(cmd), proc(1, stderr="x"))[1])
        with pytest.raises(RuntimeError, match="subtitle burn failed"):
            subtitle.burn_subtitles("r.mp4", None, str(tmp_path / "o" / "s.mp4"))
        assert "h264_nvenc" in cmds[0] and "libx264" in cmds[1]   # NVENC then CPU retry
        assert cmds[0][cmds[0].index("-vf") + 1] == "format=yuv420p"

    def test_main_statuses(self, monkeypatch, capsys, tmp_path):
        renders = tmp_path / "renders"
        renders.mkdir()
        (renders / "clip_1.mp4").write_bytes(b"x")
        (renders / "clip_2.mp4").write_bytes(b"x")
        tr = tmp_path / "t.json"
        tr.write_text(json.dumps({"segments": [{"start": 0, "end": 8, "text": "halo semua orang"}]}))
        seg_path = scored(tmp_path)

        def burn(render_path, flt, output_path, **kw):
            if render_path.endswith("clip_1.mp4"):
                open(output_path, "wb").write(b"mp4")
            else:
                open(output_path, "wb").close()
        monkeypatch.setattr(subtitle, "burn_subtitles", burn)
        args = ["--transcript", str(tr), "--segments", seg_path, "--render-dir", str(renders),
                "--output-dir", str(tmp_path / "exports")]
        code, env = run_main(subtitle, monkeypatch, capsys, *args)
        assert [c["status"] for c in env["data"]["clips"]] == ["COMPLETED", "FAILED"]
        assert env["data"]["clips"][0]["wordCount"] == 3
        ass = (tmp_path / "exports" / "clip_1.ass").read_text(encoding="utf-8")
        assert "PlayResX: 1080" in ass and "HALO" in ass       # default preset is uppercase
        assert env["data"]["clips"][0]["assPath"].endswith("clip_1.ass")

        (renders / "clip_1.mp4").unlink()

        def boom(render_path, flt, output_path, **kw):
            open(output_path, "wb").close()
            raise RuntimeError("drawtext")
        monkeypatch.setattr(subtitle, "burn_subtitles", boom)
        code, env = run_main(subtitle, monkeypatch, capsys, *args)
        assert env["data"]["clips"][0] == {"rank": 1, "status": "SKIPPED", "error": "render not found"}
        assert env["data"]["clips"][1]["error"] == "drawtext"
        assert not (tmp_path / "exports" / "clip_2_subtitled.mp4").exists()

        code, env = run_main(subtitle, monkeypatch, capsys, *args, "--clip-index", "1")
        assert [c["rank"] for c in env["data"]["clips"]] == [2]
        code, env = run_main(subtitle, monkeypatch, capsys, *args, "--clip-index", "5")
        assert env["data"]["clips"] == []

    def test_main_bad_input(self, monkeypatch, capsys, tmp_path):
        code, env = run_main(subtitle, monkeypatch, capsys, "--transcript", "x", "--segments", "y",
                             "--render-dir", "r", "--output-dir", str(tmp_path))
        assert code == 1 and env["success"] is False


# --- variation -----------------------------------------------------------------

class TestVariation:
    def test_detect_nvenc_and_duration(self, monkeypatch):
        def boom(*a, **k):
            raise OSError("x")
        monkeypatch.setattr(subprocess, "run", boom)
        monkeypatch.setattr(render, "_NVENC_CACHE", None)
        assert variation._detect_nvenc("ffmpeg") is False      # render's probe, not a listing sniff

        cmds = []
        monkeypatch.setattr(subprocess, "run",
                            lambda cmd, **kw: (cmds.append(cmd), proc(stdout='{"format": {"duration": "12.5"}}'))[1])
        monkeypatch.setenv("FFMPEG_PATH", "/bin/ffmpeg")
        assert variation.get_video_duration("v.mp4") == 12.5
        assert cmds[0][0] == "/bin/ffprobe"
        monkeypatch.setattr(subprocess, "run", lambda cmd, **kw: proc(1))
        assert variation.get_video_duration("v.mp4") == 30.0

    def test_generate_cpu_path_and_failure(self, monkeypatch, tmp_path):
        monkeypatch.setattr(variation, "_detect_nvenc", lambda p: False)
        cmds = []

        def run(cmd, **kw):
            cmds.append(cmd)
            with open(cmd[-1], "wb") as f:
                f.write(b"x" if len(cmds) == 1 else b"")
            return proc(0)
        monkeypatch.setattr(subprocess, "run", run)
        out = str(tmp_path / "v" / "a.mp4")
        assert variation.generate_variation("in.mp4", 30, 32, out, "unknown-preset") == out
        cmd = cmds[0]
        assert "libx264" in cmd and "zoompan" in cmd[cmd.index("-vf") + 1]
        assert cmd.index("-ss") < cmd.index("-i") and cmd[cmd.index("-t") + 1] == "2.000"   # input seek
        assert "pzoom+0.005000" in cmd[cmd.index("-vf") + 1]                               # 0.3 over 60 frames
        with pytest.raises(RuntimeError, match="empty file"):
            variation.generate_variation("in.mp4", 0, 2, out, "zoom_top")
        monkeypatch.setattr(subprocess, "run", lambda cmd, **kw: proc(1, stderr="boom"))
        with pytest.raises(RuntimeError, match="ffmpeg variation failed"):
            variation.generate_variation("in.mp4", 0, 2, out, "zoom_top", ffmpeg_path="ffmpeg")

    def test_main_success_and_bad_input(self, monkeypatch, capsys, tmp_path):
        monkeypatch.setattr(variation, "generate_variation", lambda *a: a[3])
        code, env = run_main(variation, monkeypatch, capsys, "--segments", scored(tmp_path), "--video", "v",
                             "--output-dir", str(tmp_path / "var"), "--presets", "zoom_center")
        assert env["data"]["variationCount"] == 1
        assert env["data"]["variations"][0]["status"] == "COMPLETED"
        code, env = run_main(variation, monkeypatch, capsys, "--segments", "nope.json", "--video", "v",
                             "--output-dir", str(tmp_path))
        assert code == 1 and env["success"] is False
