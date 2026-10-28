"""reframe.py — face track planning, crop expressions, framing filters — and
render.py's integration, including real ffmpeg runs of each mode."""

import json
import shutil
import subprocess
import sys
import types

import cv2
import numpy as np
import pytest

import reframe
import render

HAS_FFMPEG = shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


# --- pure planning --------------------------------------------------------------

class TestFrameTarget:
    def test_none_group_and_largest(self):
        assert reframe.frame_target([], 0.3) is None
        # Two faces that fit in the window → centre on the pair.
        assert reframe.frame_target([(0.40, 0.05), (0.55, 0.05)], 0.3) == pytest.approx(0.475)
        # Too far apart → follow the biggest face.
        assert reframe.frame_target([(0.1, 0.05), (0.8, 0.12)], 0.3) == 0.8


class TestPlanTrack:
    def test_no_faces(self):
        assert reframe.plan_track([(0, None), (1, None)]) == []

    def test_holds_through_gaps_and_jitter_then_cuts(self):
        samples = [(0.0, 0.30), (0.5, None), (1.0, 0.33), (1.5, 0.70), (2.0, 0.71), (2.5, 0.72)]
        assert reframe.plan_track(samples, threshold=0.08, hold=2) == [(0.0, 0.30), (1.5, pytest.approx(0.705))]

    def test_single_outlier_is_ignored_and_moving_target_restarts(self):
        assert reframe.plan_track([(0, 0.5), (1, 0.9), (2, 0.5), (3, 0.5)]) == [(0.0, 0.5)]
        track = reframe.plan_track([(0, 0.2), (1, 0.5), (2, 0.8), (3, 0.8)], hold=2)
        assert track == [(0.0, 0.2), (2, 0.8)]

    def test_move_snaps_to_the_scene_cut(self):
        # wide shot (face at 0.7) until a cut at 2.16, then a close-up at 0.47
        samples = [(0.0, 0.7), (0.5, 0.7), (1.0, None), (1.5, 0.7), (2.0, 0.5), (2.5, 0.47)]
        assert reframe.plan_track(samples)[1][0] == 2.0
        assert reframe.plan_track(samples, cuts=[2.16]) == [(0.0, 0.7), (2.16, pytest.approx(0.485))]
        # nearest cut inside the window wins; cuts outside it are ignored
        assert reframe.plan_track(samples, cuts=[0.4, 1.7, 2.4, 2.9])[1][0] == 1.7
        assert reframe.plan_track(samples, cuts=[1.2, 3.0])[1][0] == 2.0

    def test_downsample_merges_closest_neighbours(self):
        track = [(0, 0.1), (1, 0.5), (2, 0.52), (3, 0.9)]
        assert reframe.downsample_track(track, limit=3) == [(0, 0.1), (1, 0.5), (3, 0.9)]
        assert reframe.downsample_track(track) == track


class TestExpressions:
    def test_crop_width(self):
        assert reframe.crop_width(1920, 1080) == 608             # 607.5 → nearest even, in source pixels
        assert reframe.crop_width(1280, 720) == 406              # 405 → 406
        assert reframe.crop_width(607, 1080) is None             # not wider than 9:16 (607.5)
        assert reframe.crop_width(609, 1080) == 608              # never wider than the (even) frame
        assert reframe.crop_width(1080, 1920) is None            # already 9:16
        assert reframe.crop_width(720, 1600) is None             # narrower than 9:16

    def test_crop_expression_is_piecewise_and_clamped(self):
        assert reframe.crop_x_expr([(0.0, 0.5)], 1920, 606) == "657"
        expr = reframe.crop_x_expr([(0.0, 0.0), (2.0, 0.5), (4.5, 1.0)], 1920, 606)
        assert expr == "if(lt(t,2.000),0,if(lt(t,4.500),657,1314))"

    def test_remap_track_onto_trimmed_timeline(self):
        keep = [(1.0, 3.0), (6.0, 8.0)]
        assert reframe.timeline_track([(0.0, 0.2), (2.0, 0.6), (7.0, 0.9)], keep) == [(0.0, 0.2), (1.0, 0.6), (3.0, 0.9)]
        # A switch inside a cut collapses onto the previous switch point.
        assert reframe.timeline_track([(0.0, 0.2), (0.5, 0.6)], keep) == [(0.0, 0.6)]

    def test_video_filters(self):
        assert reframe.video_filter("center") == ("vf", reframe.CENTER_VF)
        kind, graph = reframe.video_filter("blur")
        assert kind == "complex" and graph.startswith("[in]split=2") and graph.endswith("[v]")
        kind, vf = reframe.video_filter("face", (1920, 1080), [(0.0, 0.25)])
        assert vf == "crop=608:1080:x='176':y=0,scale=1080:1920,format=yuv420p"   # crop first, then scale
        assert reframe.video_filter("face", (1080, 1920), [(0.0, 0.25)]) == ("vf", reframe.CENTER_VF)
        assert reframe.video_filter("face", None, None) == ("vf", reframe.CENTER_VF)


# --- detection / sampling -----------------------------------------------------------

class TestDetectors:
    def test_haar_detector(self, monkeypatch):
        monkeypatch.setitem(sys.modules, "mediapipe", None)
        cascade = types.SimpleNamespace(detectMultiScale=lambda g, **kw: [(100, 10, 64, 64)])
        import features.visual as visual
        monkeypatch.setattr(visual, "_get_haar_cascades", lambda: (cascade, None))
        monkeypatch.setattr(cv2, "CascadeClassifier", lambda path: types.SimpleNamespace(detectMultiScale=lambda g, **kw: []))
        detect = reframe.make_detector()
        out = detect(np.zeros((360, 640), np.uint8))
        assert out == [(pytest.approx(132 / 640), pytest.approx(0.1))]
        assert all(type(v) is float for v in out[0])

    def test_haar_falls_back_to_profiles_both_ways(self, monkeypatch):
        monkeypatch.setitem(sys.modules, "mediapipe", None)
        frontal_hits = {"faces": []}
        frontal = types.SimpleNamespace(detectMultiScale=lambda g, **kw: frontal_hits["faces"])
        import features.visual as visual
        monkeypatch.setattr(visual, "_get_haar_cascades", lambda: (frontal, None))
        calls = []

        def profile_detect(g, **kw):
            calls.append(1)
            # x=104 and x=440 facing one way; the mirrored pass finds x=616-ish (1 - 132/640, a repeat of 104) and x=40
            return [(444, 10, 64, 64), (40, 10, 64, 64)] if g[0, 0] == 1 else [(104, 10, 64, 64), (440, 10, 50, 50)]
        monkeypatch.setattr(cv2, "CascadeClassifier", lambda path: types.SimpleNamespace(detectMultiScale=profile_detect))
        gray = np.zeros((360, 640), np.uint8)
        gray[0, -1] = 1                                   # only the mirrored frame starts with 1
        detect = reframe.make_detector()
        assert detect(gray) == [(pytest.approx(136 / 640), pytest.approx(0.1)),
                                (pytest.approx(465 / 640), pytest.approx(50 / 640)),
                                (pytest.approx(1 - 72 / 640), pytest.approx(0.1))]
        assert len(calls) == 2
        frontal_hits["faces"] = [(100, 10, 64, 64)]       # a frontal face → no profile passes
        assert detect(gray) == [(pytest.approx(132 / 640), pytest.approx(0.1))]
        assert len(calls) == 2

    def test_mediapipe_detector_when_installed(self, monkeypatch):
        box = types.SimpleNamespace(xmin=0.2, width=0.1)
        det = types.SimpleNamespace(process=lambda rgb: types.SimpleNamespace(
            detections=[types.SimpleNamespace(location_data=types.SimpleNamespace(relative_bounding_box=box))]))
        mp = types.SimpleNamespace(solutions=types.SimpleNamespace(face_detection=types.SimpleNamespace(
            FaceDetection=lambda **kw: det)))
        monkeypatch.setitem(sys.modules, "mediapipe", mp)
        assert reframe.make_detector()(np.zeros((10, 10), np.uint8)) == [(pytest.approx(0.25), pytest.approx(0.1))]

    def test_plan_face_track_with_stub_detector(self, monkeypatch):
        frames = [(t * 0.5, np.zeros((360, 640), np.uint8)) for t in range(6)]
        monkeypatch.setattr(reframe, "sample_frames", lambda *a, **k: frames)
        seq = iter([[(0.3, 0.05)]] * 3 + [[(0.75, 0.05)]] * 3)
        track = reframe.plan_face_track("v.mp4", 0, 3, detect=lambda g: next(seq))
        assert track == [(0.0, 0.3), (1.5, pytest.approx(0.75))]

        def with_cut(*a, cuts=None, **k):                 # the sampling pass reports a cut at 1.2
            cuts.append(1.2)
            return frames
        monkeypatch.setattr(reframe, "sample_frames", with_cut)
        seq = iter([[(0.3, 0.05)]] * 3 + [[(0.75, 0.05)]] * 3)
        assert reframe.plan_face_track("v.mp4", 0, 3, detect=lambda g: next(seq))[1][0] == 1.2
        monkeypatch.setattr(reframe, "sample_frames", lambda *a, **k: [])
        assert reframe.plan_face_track("v.mp4", 0, 3) == []

    def test_probe_failure(self, monkeypatch):
        monkeypatch.setattr(subprocess, "run", lambda *a, **k: types.SimpleNamespace(returncode=1, stdout=""))
        assert reframe.probe_size("x.mp4") is None

        def boom(*a, **k):
            raise OSError("no ffprobe")
        monkeypatch.setattr(subprocess, "run", boom)
        assert reframe.probe_size("x.mp4") is None

    def test_sample_frames_collects_cuts_from_the_same_decode(self, monkeypatch):
        seen = {}

        def run(cmd, **kw):
            seen["cmd"] = cmd
            return types.SimpleNamespace(returncode=0, stderr=b"[Parsed_showinfo_4] n:0 pts:54 pts_time:2.16 \n"
                                                              b"[Parsed_showinfo_4] n:1 pts:140 pts_time:5.6 \n")
        monkeypatch.setattr(subprocess, "run", run)
        cuts = []
        assert reframe.sample_frames("x.mp4", 10, 20, cuts=cuts) == []
        assert cuts == [2.16, 5.6]
        graph = seen["cmd"][seen["cmd"].index("-filter_complex") + 1]
        assert "split" in graph and "select='gt(scene,0.3)'" in graph and "showinfo" in graph

    def test_sample_frames_failure(self, monkeypatch):
        monkeypatch.setattr(subprocess, "run", lambda *a, **k: types.SimpleNamespace(returncode=1))
        assert reframe.sample_frames("x.mp4", 0, 1) == []


# --- render integration -------------------------------------------------------------

class TestRenderIntegration:
    def test_plan_framing_modes_and_fallbacks(self, monkeypatch):
        assert render.plan_framing("center", "v", 0, 5) == (("vf", reframe.CENTER_VF), 0)
        assert render.plan_framing("blur", "v", 0, 5)[0][0] == "complex"

        monkeypatch.setattr(reframe, "probe_size", lambda *a, **k: (1920, 1080))
        monkeypatch.setattr(reframe, "plan_face_track", lambda *a, **k: [(0.0, 0.3), (2.0, 0.7)])
        framing, n = render.plan_framing("face", "v", 0, 5, timeline=[(1.0, 4.0)])
        assert n == 2 and "if(lt(t,1.000)" in framing[1]          # switch re-timed for the trim

        monkeypatch.setattr(reframe, "plan_face_track", lambda *a, **k: [])
        assert render.plan_framing("face", "v", 0, 5) == (("vf", reframe.CENTER_VF), 0)

        def boom(*a, **k):
            raise RuntimeError("decoder")
        monkeypatch.setattr(reframe, "probe_size", boom)
        assert render.plan_framing("face", "v", 0, 5) == (("vf", reframe.CENTER_VF), 0)

    def test_blur_command_uses_filter_complex_with_trim(self):
        cmd = render._build_render_cmd("ffmpeg", "in.mp4", 0, 5, "o.mp4", False, timeline=[(0.5, 1.5)],
                                       reframe=reframe.video_filter("blur"))
        graph = cmd[cmd.index("-filter_complex") + 1]
        assert graph.startswith("[0:v]select='between(t,0.500,1.500)',setpts=N/FRAME_RATE/TB[in];[in]split")
        assert cmd[cmd.index("-map") + 1] == "[v]" and "0:a?" in cmd and "-vf" not in cmd
        plain = render._build_render_cmd("ffmpeg", "in.mp4", 0, 5, "o.mp4", False, reframe=reframe.video_filter("blur"))
        assert plain[plain.index("-filter_complex") + 1].startswith("[0:v]null[in];")

    def test_main_reports_framing(self, monkeypatch, capsys, tmp_path):
        seg = tmp_path / "s.json"
        seg.write_text(json.dumps({"scoredSegments": [{"rank": 1, "tier": "PRIMARY", "startTime": 0, "endTime": 5}]}))
        monkeypatch.setattr(render, "render_clip", lambda *a, **k: open(a[3], "wb").write(b"x"))
        for mode, expected in [("blur", "blur"), ("center", "center")]:
            monkeypatch.setattr(sys, "argv", ["render.py", "--segments", str(seg), "--video", "v",
                                              "--output-dir", str(tmp_path / "r"), "--reframe", mode])
            render.main()
            clip = json.loads(capsys.readouterr().out)["data"]["clips"][0]
            assert clip["reframe"] == expected and clip["cropSegments"] == 0
        monkeypatch.setattr(render, "plan_framing",
                            lambda *a, **k: (reframe.video_filter("face", (1920, 1080), [(0.0, 0.4)]), 1))
        monkeypatch.setattr(sys, "argv", ["render.py", "--segments", str(seg), "--video", "v",
                                          "--output-dir", str(tmp_path / "r")])
        render.main()
        clip = json.loads(capsys.readouterr().out)["data"]["clips"][0]
        assert clip["reframe"] == "face" and clip["cropSegments"] == 1


# --- real ffmpeg ------------------------------------------------------------------

def probe(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration",
                          "-of", "json", path], capture_output=True, text=True, check=True).stdout
    data = json.loads(out)
    video = next(s for s in data["streams"] if s["codec_type"] == "video")
    has_audio = any(s["codec_type"] == "audio" for s in data["streams"])
    return video["width"], video["height"], float(data["format"]["duration"]), has_audio


@pytest.fixture(scope="module")
def wide_source(tmp_path_factory):
    if not HAS_FFMPEG:
        pytest.skip("ffmpeg/ffprobe not on PATH")
    out = tmp_path_factory.mktemp("wide") / "wide.mp4"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error",
                    "-f", "lavfi", "-i", "testsrc=size=640x360:rate=25:duration=6",
                    "-f", "lavfi", "-i", "sine=frequency=330:duration=6",
                    "-shortest", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-c:a", "aac", str(out)],
                   check=True, capture_output=True)
    return str(out)


class TestRealFfmpeg:
    def test_sampling_finds_a_hard_cut(self, tmp_path):
        if not HAS_FFMPEG:
            pytest.skip("ffmpeg not installed")
        out = str(tmp_path / "cut.mp4")
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error",
                        "-f", "lavfi", "-i", "testsrc=size=320x180:rate=25:duration=1.5",
                        "-f", "lavfi", "-i", "mandelbrot=size=320x180:rate=25",
                        "-filter_complex", "[1:v]trim=duration=1.5,setpts=PTS-STARTPTS[b];[0:v][b]concat=n=2:v=1",
                        "-pix_fmt", "yuv420p", "-c:v", "libx264", out], check=True, capture_output=True)
        cuts = []
        frames = reframe.sample_frames(out, 0, 3, fps=2, width=160, cuts=cuts)
        assert len(frames) >= 5
        assert cuts and cuts[0] == pytest.approx(1.5, abs=0.05)

    def test_probe_and_sampling(self, wide_source):
        assert reframe.probe_size(wide_source) == (640, 360)
        frames = reframe.sample_frames(wide_source, 0, 3, fps=2, width=320)
        assert len(frames) >= 5 and frames[0][0] == 0.0 and frames[0][1].shape[1] == 320

    def test_face_crop_render(self, wide_source, tmp_path, monkeypatch):
        monkeypatch.setattr(render, "_probe_nvenc", lambda p: False)
        out = str(tmp_path / "face.mp4")
        framing = reframe.video_filter("face", (640, 360), [(0.0, 0.2), (2.0, 0.8)])
        render.render_clip(wide_source, 0, 4, out, reframe=framing)
        w, h, dur, audio = probe(out)
        assert (w, h) == (1080, 1920) and dur == pytest.approx(4.0, abs=0.2) and audio

    def test_blur_render_with_silence_trim(self, wide_source, tmp_path, monkeypatch):
        monkeypatch.setattr(render, "_probe_nvenc", lambda p: False)
        out = str(tmp_path / "blur.mp4")
        render.render_clip(wide_source, 0, 6, out, timeline=[(0.5, 1.5), (3.0, 4.0)], reframe=reframe.video_filter("blur"))
        w, h, dur, audio = probe(out)
        assert (w, h) == (1080, 1920) and dur == pytest.approx(2.0, abs=0.2) and audio
