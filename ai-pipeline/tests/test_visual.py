"""features/visual.py — frame extraction, MediaPipe/Haar batch analysis and
the per-segment helpers. Real cv2/numpy on synthetic frames; MediaPipe and
the Haar cascades are stubbed so results are deterministic."""

import os
import shutil
import subprocess
import sys
import types

import cv2
import numpy as np
import pytest

from features import visual

HAS_FFMPEG = shutil.which("ffmpeg") is not None
DEFAULTS = {"faces": 0.5, "scene": 0.5, "motion": 0.5}


def frame(gray_level=128, v=200, s=150, size=(32, 32)):
    gray = np.full(size, gray_level, dtype=np.uint8)
    hsv = np.zeros(size + (3,), dtype=np.uint8)
    hsv[:, :, 1] = s
    hsv[:, :, 2] = v
    return {"gray": gray, "hsv": hsv}


@pytest.fixture
def video_file(tmp_path):
    p = tmp_path / "v.mp4"
    p.write_bytes(b"not really a video")
    return str(p)


@pytest.fixture(scope="module")
def real_video(tmp_path_factory):
    if not HAS_FFMPEG:
        pytest.skip("ffmpeg not on PATH")
    out = tmp_path_factory.mktemp("vid") / "testsrc.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi",
         "-i", "testsrc=size=160x120:rate=10:duration=4", "-pix_fmt", "yuv420p", str(out)],
        check=True, capture_output=True,
    )
    return str(out)


# --- singletons --------------------------------------------------------------

class TestSingletons:
    def test_mediapipe_detector_is_built_once(self, monkeypatch):
        built = []

        class FaceDetection:
            def __init__(self, **kw):
                built.append(kw)

        mp = types.SimpleNamespace(solutions=types.SimpleNamespace(
            face_detection=types.SimpleNamespace(FaceDetection=FaceDetection)))
        monkeypatch.setitem(sys.modules, "mediapipe", mp)
        monkeypatch.setattr(visual, "_FACE_DETECTOR", None)
        a = visual._get_mediapipe_face_detector()
        b = visual._get_mediapipe_face_detector()
        assert a is b
        assert built == [{"model_selection": 1, "min_detection_confidence": 0.5}]

    def test_haar_cascades_are_cached(self, monkeypatch):
        monkeypatch.setattr(visual, "_FACE_CASCADE", None)
        monkeypatch.setattr(visual, "_SMILE_CASCADE", None)
        face, smile = visual._get_haar_cascades()
        assert face is not None and not face.empty()
        assert smile is not None
        assert visual._get_haar_cascades() == (face, smile)


# --- motion ------------------------------------------------------------------

class TestMotion:
    def test_too_few_frames(self):
        assert visual._calc_motion_from_grays(None) == 0.5
        assert visual._calc_motion_from_grays([np.zeros((8, 8), np.uint8)]) == 0.5

    @pytest.mark.parametrize("magnitude,expected", [
        (0.1, 0.2), (0.5, 0.5), (1.0, 0.7), (3.0, 0.9), (5.0, 1.0),
    ])
    def test_magnitude_bands(self, monkeypatch, magnitude, expected):
        def flow(prev, curr, *a):
            assert prev.shape == curr.shape  # mismatched shapes are cropped first
            return np.full(prev.shape + (2,), magnitude / np.sqrt(2), dtype=np.float32)

        monkeypatch.setattr(cv2, "calcOpticalFlowFarneback", flow)
        grays = [np.zeros((20, 30), np.uint8), np.zeros((24, 26), np.uint8)]
        assert visual._calc_motion_from_grays(grays) == expected

    def test_real_optical_flow_and_errors(self, monkeypatch):
        rng = np.random.default_rng(1)
        grays = [rng.integers(0, 255, (48, 48), dtype=np.uint8) for _ in range(3)]
        assert visual._calc_motion_from_grays(grays) in {0.2, 0.5, 0.7, 0.9, 1.0}

        def boom(*a):
            raise RuntimeError("flow")
        monkeypatch.setattr(cv2, "calcOpticalFlowFarneback", boom)
        assert visual._calc_motion_from_grays(grays) == 0.5


# --- frame extraction (real ffmpeg) -------------------------------------------

class TestExtractFrames:
    def test_batch_extraction(self, real_video):
        frames = visual._extract_frames_ffmpeg(real_video, [1.0, 2.0, 2.0, 3.0])
        assert frames
        any_frame = next(iter(frames.values()))
        assert any_frame["gray"].ndim == 2
        assert any_frame["hsv"].shape[2] == 3

    def test_no_timestamps(self, real_video):
        assert visual._extract_frames_ffmpeg(real_video, []) == {}

    def test_per_frame_fallback_when_batch_fails(self, real_video, monkeypatch):
        real_run = subprocess.run

        def run(cmd, **kw):
            if any("fps=1" in str(c) for c in cmd):
                return types.SimpleNamespace(returncode=1)
            return real_run(cmd, **kw)

        monkeypatch.setattr(subprocess, "run", run)
        frames = visual._extract_frames_ffmpeg(real_video, [1.0, 2.5])
        assert set(frames) == {1.0, 2.5}

    def test_missing_video_and_crash_return_empty(self, tmp_path, monkeypatch):
        if HAS_FFMPEG:
            assert visual._extract_frames_ffmpeg(str(tmp_path / "nope.mp4"), [1.0]) == {}

        def boom(*a, **k):
            raise OSError("no ffmpeg")
        monkeypatch.setattr(subprocess, "run", boom)
        assert visual._extract_frames_ffmpeg("x.mp4", [1.0]) == {}


# --- batch analysis ----------------------------------------------------------

def segs(n=2, dur=10):
    return [{"startTime": i * 20, "duration": dur, "endTime": i * 20 + dur} for i in range(n)]


class FakeDetector:
    def __init__(self, results):
        self.results = list(results)
        self.closed = False

    def process(self, rgb):
        r = self.results.pop(0) if self.results else None
        if isinstance(r, Exception):
            raise r
        return types.SimpleNamespace(detections=r)

    def close(self):
        self.closed = True


class TestBatchDispatch:
    def test_missing_video_gives_neutral_defaults(self):
        for fn in (visual._batch_analyze_video, visual._batch_analyze_video_mediapipe,
                   visual._batch_analyze_video_haar):
            assert fn(None, segs(2)) == {0: DEFAULTS, 1: DEFAULTS}
            assert fn("/no/such/file.mp4", segs(1)) == {0: DEFAULTS}

    def test_prefers_mediapipe_and_falls_back_to_haar(self, video_file, monkeypatch):
        monkeypatch.setattr(visual, "_batch_analyze_video_mediapipe", lambda v, s: "mp")
        monkeypatch.setattr(visual, "_batch_analyze_video_haar", lambda v, s: "haar")
        mp = types.SimpleNamespace(solutions=types.SimpleNamespace(face_detection=object()))
        monkeypatch.setitem(sys.modules, "mediapipe", mp)
        assert visual._batch_analyze_video(video_file, segs()) == "mp"
        monkeypatch.setitem(sys.modules, "mediapipe", None)  # import → ImportError
        assert visual._batch_analyze_video(video_file, segs()) == "haar"


class TestMediapipeBatch:
    def test_faces_scene_motion_per_segment(self, video_file, monkeypatch):
        # seg0 frames at 0/5/10 (exact keys), seg1 at 20/25/30 → nearest-frame lookup
        data = {0.0: frame(10), 5.0: frame(240), 10.0: frame(10), 22.0: frame(128, v=50, s=20)}
        monkeypatch.setattr(visual, "_extract_frames_ffmpeg", lambda v, ts: data)
        det = FakeDetector([["face"], []])
        monkeypatch.setattr(visual, "_get_mediapipe_face_detector", lambda: det)

        res = visual._batch_analyze_video_mediapipe(video_file, segs(2))
        assert res[0]["faces"] == 0.7
        assert res[1]["faces"] == 0.0
        assert res[0]["scene"] == 1.0          # big histogram change + bright, saturated
        assert res[1]["scene"] == 0.3          # identical dull frames
        assert 0.0 <= res[0]["motion"] <= 1.0
        assert det.closed

    @pytest.mark.parametrize("corr,base", [(0.4, 0.9), (0.6, 0.7), (0.8, 0.5), (0.95, 0.3)])
    def test_scene_change_bands(self, video_file, monkeypatch, corr, base):
        dull = {t: frame(100, v=50, s=20) for t in (0.0, 5.0, 10.0)}
        monkeypatch.setattr(visual, "_extract_frames_ffmpeg", lambda v, ts: dull)
        monkeypatch.setattr(visual, "_get_mediapipe_face_detector", lambda: FakeDetector([[]]))
        monkeypatch.setattr(cv2, "compareHist", lambda *a: corr)
        assert visual._batch_analyze_video_mediapipe(video_file, segs(1))[0]["scene"] == base

    def test_no_frames_detector_errors_and_many_timestamps(self, video_file, monkeypatch):
        seen = {}

        def extract(v, ts):
            seen["n"] = len(ts)
            return {}
        monkeypatch.setattr(visual, "_extract_frames_ffmpeg", extract)
        monkeypatch.setattr(visual, "_get_mediapipe_face_detector", lambda: FakeDetector([]))
        res = visual._batch_analyze_video_mediapipe(video_file, segs(25))
        assert seen["n"] == 60                      # 75 unique timestamps capped at 60
        assert res[0] == {"faces": 0.0, "scene": 0.5, "motion": 0.5}

        monkeypatch.setattr(visual, "_extract_frames_ffmpeg", lambda v, ts: {0.0: frame(), 5.0: frame()})
        monkeypatch.setattr(visual, "_get_mediapipe_face_detector",
                            lambda: FakeDetector([RuntimeError("tflite")]))
        assert visual._batch_analyze_video_mediapipe(video_file, segs(1))[0]["faces"] == 0.0

    def test_unexpected_error_gives_defaults(self, video_file, monkeypatch):
        def boom(v, ts):
            raise RuntimeError("decode")
        monkeypatch.setattr(visual, "_get_mediapipe_face_detector", lambda: FakeDetector([]))
        monkeypatch.setattr(visual, "_extract_frames_ffmpeg", boom)
        assert visual._batch_analyze_video_mediapipe(video_file, segs(2)) == {0: DEFAULTS, 1: DEFAULTS}


class FakeCascade:
    def __init__(self, results):
        self.results = list(results)

    def detectMultiScale(self, img, **kw):
        r = self.results.pop(0) if self.results else []
        if isinstance(r, Exception):
            raise r
        return r


def install_cascades(monkeypatch, face_results, smile_results, smile_exists=True):
    real_exists = os.path.exists

    def classifier(path):
        return FakeCascade(smile_results if "smile" in path else face_results)

    monkeypatch.setattr(cv2, "CascadeClassifier", classifier)
    monkeypatch.setattr(os.path, "exists",
                        lambda p: smile_exists if "haarcascade_smile" in str(p) else real_exists(p))


class TestHaarBatch:
    def test_face_and_smile_scoring(self, video_file, monkeypatch):
        face = [(2, 2, 10, 10)]
        install_cascades(monkeypatch, [face, face, []], [[(1, 1, 2, 2)], []])
        data = {0.0: frame(10), 5.0: frame(240), 10.0: frame(10)}
        monkeypatch.setattr(visual, "_extract_frames_ffmpeg", lambda v, ts: data)
        res = visual._batch_analyze_video_haar(video_file, segs(3))
        assert [res[i]["faces"] for i in range(3)] == [1.0, 0.7, 0.0]
        assert res[0]["scene"] == 1.0

    @pytest.mark.parametrize("corr,base", [(0.4, 0.9), (0.6, 0.7), (0.8, 0.5), (0.95, 0.3)])
    def test_scene_change_bands(self, video_file, monkeypatch, corr, base):
        install_cascades(monkeypatch, [], [], smile_exists=False)
        dull = {t: frame(100, v=50, s=20) for t in (0.0, 5.0, 10.0)}
        monkeypatch.setattr(visual, "_extract_frames_ffmpeg", lambda v, ts: dull)
        monkeypatch.setattr(cv2, "compareHist", lambda *a: corr)
        assert visual._batch_analyze_video_haar(video_file, segs(1))[0]["scene"] == base

    def test_nearest_frame_detector_error_and_cap(self, video_file, monkeypatch):
        install_cascades(monkeypatch, [RuntimeError("cascade")], [])
        seen = {}

        def extract(v, ts):
            seen["n"] = len(ts)
            return {3.0: frame(), 7.0: frame()}
        monkeypatch.setattr(visual, "_extract_frames_ffmpeg", extract)
        res = visual._batch_analyze_video_haar(video_file, segs(25))
        assert seen["n"] == 60
        assert res[0]["faces"] == 0.0

    def test_no_frames_and_crash(self, video_file, monkeypatch):
        install_cascades(monkeypatch, [], [])
        monkeypatch.setattr(visual, "_extract_frames_ffmpeg", lambda v, ts: {})
        assert visual._batch_analyze_video_haar(video_file, segs(1))[0] == {"faces": 0.0, "scene": 0.5, "motion": 0.5}

        def boom(v, ts):
            raise RuntimeError("x")
        monkeypatch.setattr(visual, "_extract_frames_ffmpeg", boom)
        assert visual._batch_analyze_video_haar(video_file, segs(1)) == {0: DEFAULTS}


# --- legacy per-segment helpers ----------------------------------------------

class FakeCap:
    def __init__(self, frames, opened=True, fps=10.0):
        self.frames = list(frames)
        self.opened = opened
        self.fps = fps
        self.released = False

    def isOpened(self):
        return self.opened

    def get(self, prop):
        return self.fps

    def set(self, prop, value):
        pass

    def read(self):
        f = self.frames.pop(0) if self.frames else None
        return (f is not None, f)

    def release(self):
        self.released = True


def bgr(b, g, r, size=(32, 32)):
    img = np.zeros(size + (3,), np.uint8)
    img[:] = (b, g, r)
    return img


class TestScoreFacePresence:
    def test_unusable_inputs(self, video_file, monkeypatch):
        assert visual.score_face_presence(None) == 0.5
        assert visual.score_face_presence("/missing.mp4") == 0.5
        monkeypatch.setattr(cv2, "VideoCapture", lambda p: FakeCap([], opened=False))
        assert visual.score_face_presence(video_file, 0, 10) == 0.5
        cap = FakeCap([], fps=0)
        monkeypatch.setattr(cv2, "VideoCapture", lambda p: cap)
        assert visual.score_face_presence(video_file, 0, 10) == 0.5
        assert cap.released

    @pytest.mark.parametrize("faces,smiles,expected", [
        (3, 2, 1.0), (3, 0, 0.9), (2, 1, 0.85), (2, 0, 0.7), (1, 1, 0.6), (1, 0, 0.3), (0, 0, 0.0),
    ])
    def test_bands(self, video_file, monkeypatch, faces, smiles, expected):
        face_hits = [[(1, 1, 8, 8)]] * faces + [[]] * (3 - faces)
        smile_hits = [[(1, 1, 2, 2)]] * smiles + [[]] * (3 - smiles)
        monkeypatch.setattr(cv2, "VideoCapture", lambda p: FakeCap([bgr(0, 0, 0)] * 3))
        monkeypatch.setattr(visual, "_get_haar_cascades",
                            lambda: (FakeCascade(face_hits), FakeCascade(smile_hits)))
        assert visual.score_face_presence(video_file, 0, 10) == expected

    def test_unreadable_frames_no_smile_cascade_and_errors(self, video_file, monkeypatch):
        monkeypatch.setattr(cv2, "VideoCapture", lambda p: FakeCap([bgr(0, 0, 0)]))  # 1 of 3 frames read
        monkeypatch.setattr(visual, "_get_haar_cascades", lambda: (FakeCascade([[(0, 0, 4, 4)]]), None))
        assert visual.score_face_presence(video_file, 0, 10) == 0.3

        monkeypatch.setattr(visual, "_get_haar_cascades", lambda: (_ for _ in ()).throw(RuntimeError("xml")))
        assert visual.score_face_presence(video_file, 0, 10) == 0.5


class TestScoreSceneChange:
    def test_unusable_inputs(self, video_file, monkeypatch):
        assert visual.score_scene_change(None) == 0.5
        monkeypatch.setattr(cv2, "VideoCapture", lambda p: FakeCap([], opened=False))
        assert visual.score_scene_change(video_file, 0, 10) == 0.5
        monkeypatch.setattr(cv2, "VideoCapture", lambda p: FakeCap([], fps=-1))
        assert visual.score_scene_change(video_file, 0, 10) == 0.5
        monkeypatch.setattr(cv2, "VideoCapture", lambda p: FakeCap([bgr(0, 0, 0)]))
        assert visual.score_scene_change(video_file, 0, 10) == 0.5  # <2 frames

    def test_visual_appeal_on_real_histograms(self, video_file, monkeypatch):
        # Saturated bright red vs black: large histogram change + appeal bonuses.
        monkeypatch.setattr(cv2, "VideoCapture",
                            lambda p: FakeCap([bgr(0, 0, 255), bgr(0, 0, 0), bgr(0, 0, 255)] * 3))
        assert visual.score_scene_change(video_file, 0, 10) == 1.0

    @pytest.mark.parametrize("corr,expected", [(0.4, 0.9), (0.6, 0.7), (0.8, 0.5), (0.95, 0.3)])
    def test_change_bands(self, video_file, monkeypatch, corr, expected):
        monkeypatch.setattr(cv2, "VideoCapture", lambda p: FakeCap([bgr(20, 20, 20)] * 8))
        monkeypatch.setattr(cv2, "compareHist", lambda *a: corr)
        assert visual.score_scene_change(video_file, 0, 40) == expected

    def test_error_gives_neutral(self, video_file, monkeypatch):
        def boom(p):
            raise RuntimeError("codec")
        monkeypatch.setattr(cv2, "VideoCapture", boom)
        assert visual.score_scene_change(video_file, 0, 10) == 0.5

    def test_real_video_end_to_end(self, real_video):
        assert 0.0 <= visual.score_scene_change(real_video, 0, 3) <= 1.0
        assert visual.score_face_presence(real_video, 0, 3) in {0.0, 0.3, 0.5, 0.6, 0.7, 0.85, 0.9, 1.0}
