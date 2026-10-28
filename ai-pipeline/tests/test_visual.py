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


def make_video(tmp_path_factory, name, seconds, gop):
    if not HAS_FFMPEG:
        pytest.skip("ffmpeg not on PATH")
    out = tmp_path_factory.mktemp("vid") / name
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi",
         "-i", f"testsrc=size=160x120:rate=10:duration={seconds}", "-g", str(gop), "-pix_fmt", "yuv420p", str(out)],
        check=True, capture_output=True,
    )
    return str(out)


@pytest.fixture(scope="module")
def real_video(tmp_path_factory):
    """4 s, a keyframe every second (like a YouTube download, only denser)."""
    return make_video(tmp_path_factory, "testsrc.mp4", 4, 10)


@pytest.fixture(scope="module")
def sparse_video(tmp_path_factory):
    """12 s with a single keyframe (like a screen recording)."""
    return make_video(tmp_path_factory, "sparse.mp4", 12, 1000)


def spy_ffmpeg(monkeypatch, fail=(), quiet=()):
    """Record each ffmpeg command. Commands containing a string in ``fail``
    exit 1; those containing one in ``quiet`` run but lose their log."""
    calls = []
    real_run = subprocess.run

    def run(cmd, **kw):
        calls.append(" ".join(map(str, cmd)))
        if any(f in calls[-1] for f in fail):
            return types.SimpleNamespace(returncode=1, stderr=b"")
        res = real_run(cmd, **kw)
        if any(q in calls[-1] for q in quiet):
            res.stderr = b""
        return res
    monkeypatch.setattr(subprocess, "run", run)
    return calls


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

    def test_keyframes_only_nearest_one_per_time(self, real_video, monkeypatch):
        calls = spy_ffmpeg(monkeypatch)
        frames = visual._extract_frames_ffmpeg(real_video, [1.1, 1.2, 2.9])
        assert len(calls) == 1 and "-skip_frame nokey" in calls[0]
        # 1.1 and 1.2 share the keyframe at 1 s; 2.9 takes the one at 3 s
        assert sorted(round(t, 2) for t in frames) == [1.0, 3.0]

    def test_sparse_keyframes_decode_every_frame(self, sparse_video, monkeypatch):
        calls = spy_ffmpeg(monkeypatch)
        # Only 0.4 is near the one keyframe (0 s): too many far → every frame at 1 fps
        frames = visual._extract_frames_ffmpeg(sparse_video, [0.4, 5.0, 10.0])
        assert len(calls) == 2 and "fps=1" in calls[1]
        assert len(frames) == 3 and all(any(abs(k - t) <= 0.5 for k in frames) for t in (0.4, 5.0, 10.0))

    @pytest.mark.parametrize("how", ["fail", "quiet"])
    def test_keyframe_pass_failure_falls_back(self, real_video, monkeypatch, how):
        # quiet: frames written but no showinfo times to match them with
        calls = spy_ffmpeg(monkeypatch, **{how: ["nokey"]})
        assert visual._extract_frames_ffmpeg(real_video, [1.0, 2.5])
        assert len(calls) == 2 and "fps=1" in calls[1]

    def test_both_passes_failing_gives_nothing(self, real_video, monkeypatch):
        spy_ffmpeg(monkeypatch, fail=["ffmpeg"])
        assert visual._extract_frames_ffmpeg(real_video, [1.0]) == {}

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


class TestFaceResolution:
    def test_frame_entry_keeps_full_size_only_for_faces(self):
        img = np.zeros((360, 640, 3), np.uint8)
        e = visual._frame_entry(img, keep_face=True)
        assert e["gray"].shape == (126, 224) and e["hsv"].shape == (126, 224, 3)
        assert e["face_gray"].shape == (360, 640)
        assert "face_gray" not in visual._frame_entry(img, keep_face=False)
        small = visual._frame_entry(np.zeros((100, 200, 3), np.uint8), keep_face=False)
        assert small["gray"].shape == (100, 200)        # never upscaled

    def test_face_times_and_sampling_helpers(self):
        assert visual._face_times(10, 20) == [12.0, 16.0, 20.0, 24.0, 28.0]
        # majority of the distinct frames: 3 of 5 as before, the same share of fewer
        assert [visual._face_need(n) for n in range(1, 6)] == [1, 2, 2, 3, 3]
        a, b = frame(), frame()
        assert visual._distinct([a, None, b, a]) == [a, b]
        times = [0.0, 4.0, 8.0]
        assert [visual._nearest_index(times, t) for t in (-1, 1.9, 2.1, 6.0, 9)] == [0, 0, 1, 1, 2]

    def test_detectors_get_the_full_size_frame(self, video_file, monkeypatch):
        seen = []
        big = {t: {**frame(), "face_gray": np.zeros((360, 640), np.uint8)} for t in (0.0, 1.0, 3.0, 5.0, 7.0, 9.0, 10.0)}
        monkeypatch.setattr(visual, "_extract_frames_ffmpeg", lambda v, ts, face_ts=None: big)

        class Det(FakeDetector):
            def process(self, rgb):
                seen.append(rgb.shape)
                return types.SimpleNamespace(detections=None)
        monkeypatch.setattr(visual, "_get_mediapipe_face_detector", lambda: Det([]))
        visual._batch_analyze_video_mediapipe(video_file, segs(1))
        assert seen == [(360, 640, 3)] * len(visual.FACE_FRACTIONS)

    def test_real_extraction_with_face_timestamps(self, real_video):
        frames = visual._extract_frames_ffmpeg(real_video, [0.5, 3.0], face_timestamps=[1.5])
        with_face = [t for t, f in frames.items() if "face_gray" in f]
        assert with_face and all(abs(t - 1.5) <= 0.6 for t in with_face)
        f = frames[with_face[0]]
        # 160-px source: decoded at FACE_WIDTH; analysis copy stays at the calibrated 224 px
        assert f["gray"].shape[1] == 224 and f["face_gray"].shape[1] == 640


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
        # seg0 frames at 0/5/10, seg1 at 20/25/30 (same dull picture) → nearest-frame lookup
        data = {0.0: frame(10), 5.0: frame(240), 10.0: frame(10), **{t: frame(128, v=50, s=20) for t in (20.0, 25.0, 30.0)}}
        monkeypatch.setattr(visual, "_extract_frames_ffmpeg", lambda v, ts, face_ts=None: data)
        # One check per distinct frame, majority needed: seg0's five face times
        # share 0/5/10 → 2 of 3 hits → face; seg1's share 20/25/30 → 1 of 3 → none.
        det = FakeDetector([["face"], ["face"], [], [], ["face"], []])
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
        monkeypatch.setattr(visual, "_extract_frames_ffmpeg", lambda v, ts, face_ts=None: dull)
        monkeypatch.setattr(visual, "_get_mediapipe_face_detector", lambda: FakeDetector([[]]))
        monkeypatch.setattr(cv2, "compareHist", lambda *a: corr)
        assert visual._batch_analyze_video_mediapipe(video_file, segs(1))[0]["scene"] == base

    def test_no_frames_detector_errors_and_many_timestamps(self, video_file, monkeypatch):
        seen = {}

        def extract(v, ts, face_ts=None):
            seen["n"] = len(ts)
            return {}
        monkeypatch.setattr(visual, "_extract_frames_ffmpeg", extract)
        monkeypatch.setattr(visual, "_get_mediapipe_face_detector", lambda: FakeDetector([]))
        res = visual._batch_analyze_video_mediapipe(video_file, segs(25))
        assert seen["n"] == 75                      # every scene time, no cap
        assert res[0] == {"faces": 0.0, "scene": 0.5, "motion": 0.5}

        monkeypatch.setattr(visual, "_extract_frames_ffmpeg", lambda v, ts, face_ts=None: {0.0: frame(), 5.0: frame()})
        monkeypatch.setattr(visual, "_get_mediapipe_face_detector",
                            lambda: FakeDetector([RuntimeError("tflite")]))
        assert visual._batch_analyze_video_mediapipe(video_file, segs(1))[0]["faces"] == 0.0

    def test_unexpected_error_gives_defaults(self, video_file, monkeypatch):
        def boom(v, ts, face_ts=None):
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
        # Five checks per segment, majority (3) required: seg0 4 hits + a smile,
        # seg1 3 hits no smile, seg2 2 hits → below majority (false-positive guard).
        install_cascades(monkeypatch,
                         [face, face, [], face, face,  face, [], face, face, [],  face, [], [], face, []],
                         [[(1, 1, 2, 2)]] + [[]] * 20)
        # A frame at every face time (each segment: 5 distinct frames)
        data = {float(s + o): frame(10) for s in (0, 20, 40) for o in (0, 1, 3, 7, 9, 10)}
        data.update({5.0: frame(240), 25.0: frame(240), 45.0: frame(240)})
        monkeypatch.setattr(visual, "_extract_frames_ffmpeg", lambda v, ts, face_ts=None: data)
        res = visual._batch_analyze_video_haar(video_file, segs(3))
        assert [res[i]["faces"] for i in range(3)] == [1.0, 0.7, 0.0]
        assert res[0]["scene"] == 1.0

    def test_face_majority_counts_distinct_frames(self, video_file, monkeypatch):
        # Keyframes at 0, 5, 10 s: the five face times share 3 frames, so
        # 2 hits of 3 is a majority; one frame seen 3 times is not 3 hits.
        face = [(2, 2, 10, 10)]
        install_cascades(monkeypatch, [face, face, [],  [], [], face], [], smile_exists=False)
        data = {0.0: frame(10), 5.0: frame(240), 10.0: frame(10), 20.0: frame(10), 25.0: frame(10), 30.0: frame(10)}
        monkeypatch.setattr(visual, "_extract_frames_ffmpeg", lambda v, ts, face_ts=None: data)
        res = visual._batch_analyze_video_haar(video_file, segs(2))
        assert [res[i]["faces"] for i in range(2)] == [0.7, 0.0]

    @pytest.mark.parametrize("corr,base", [(0.4, 0.9), (0.6, 0.7), (0.8, 0.5), (0.95, 0.3)])
    def test_scene_change_bands(self, video_file, monkeypatch, corr, base):
        install_cascades(monkeypatch, [], [], smile_exists=False)
        dull = {t: frame(100, v=50, s=20) for t in (0.0, 5.0, 10.0)}
        monkeypatch.setattr(visual, "_extract_frames_ffmpeg", lambda v, ts, face_ts=None: dull)
        monkeypatch.setattr(cv2, "compareHist", lambda *a: corr)
        assert visual._batch_analyze_video_haar(video_file, segs(1))[0]["scene"] == base

    def test_nearest_frame_detector_error_and_cap(self, video_file, monkeypatch):
        install_cascades(monkeypatch, [RuntimeError("cascade")], [])
        seen = {}

        def extract(v, ts, face_ts=None):
            seen["n"] = len(ts)
            return {3.0: frame(), 7.0: frame()}
        monkeypatch.setattr(visual, "_extract_frames_ffmpeg", extract)
        res = visual._batch_analyze_video_haar(video_file, segs(25))
        assert seen["n"] == 75
        assert res[0]["faces"] == 0.0

    def test_no_frames_and_crash(self, video_file, monkeypatch):
        install_cascades(monkeypatch, [], [])
        monkeypatch.setattr(visual, "_extract_frames_ffmpeg", lambda v, ts, face_ts=None: {})
        assert visual._batch_analyze_video_haar(video_file, segs(1))[0] == {"faces": 0.0, "scene": 0.5, "motion": 0.5}

        def boom(v, ts, face_ts=None):
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
