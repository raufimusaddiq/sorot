"""Visual feature extraction: GPU-decoded keyframe dump, batch face + scene
analysis via MediaPipe (preferred) or Haar cascades (fallback), plus the
legacy per-segment ``score_face_presence`` / ``score_scene_change`` helpers
that still back unit tests.

Heavy models are hoisted to module-level singletons so a 20-candidate video
does not reload TF Lite or Haar XML 20 times.
"""

import os
import threading as _threading


_FACE_DETECTOR = None
_FACE_DETECTOR_LOCK = _threading.Lock()
_FACE_CASCADE = None
_SMILE_CASCADE = None
_CASCADE_LOCK = _threading.Lock()


def _get_mediapipe_face_detector():
    global _FACE_DETECTOR
    if _FACE_DETECTOR is not None:
        return _FACE_DETECTOR
    with _FACE_DETECTOR_LOCK:
        if _FACE_DETECTOR is None:
            import mediapipe as mp
            _FACE_DETECTOR = mp.solutions.face_detection.FaceDetection(
                model_selection=1, min_detection_confidence=0.5,
            )
    return _FACE_DETECTOR


def _get_haar_cascades():
    """Return (face_cascade, smile_cascade_or_None). Cached."""
    global _FACE_CASCADE, _SMILE_CASCADE
    if _FACE_CASCADE is not None:
        return _FACE_CASCADE, _SMILE_CASCADE
    with _CASCADE_LOCK:
        if _FACE_CASCADE is None:
            import cv2
            _FACE_CASCADE = cv2.CascadeClassifier(
                cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
            )
            smile_path = os.path.join(cv2.data.haarcascades, "haarcascade_smile.xml")
            if os.path.exists(smile_path):
                _SMILE_CASCADE = cv2.CascadeClassifier(smile_path)
    return _FACE_CASCADE, _SMILE_CASCADE


def _calc_motion_from_grays(grays):
    """Mean optical-flow magnitude across consecutive grayscale frames.

    Derived once per segment from frames we already have in hand — no extra
    ffmpeg pass. Flat/static shots score low (boring); busy cuts or fast
    motion score high.
    """
    if not grays or len(grays) < 2:
        return 0.5
    try:
        import cv2
        import numpy as np
        mags = []
        for i in range(1, len(grays)):
            prev = grays[i - 1]
            curr = grays[i]
            if prev.shape != curr.shape:
                h = min(prev.shape[0], curr.shape[0])
                w = min(prev.shape[1], curr.shape[1])
                prev = prev[:h, :w]
                curr = curr[:h, :w]
            flow = cv2.calcOpticalFlowFarneback(prev, curr, None, 0.5, 2, 15, 2, 5, 1.2, 0)
            mag = np.sqrt(flow[..., 0] ** 2 + flow[..., 1] ** 2)
            mags.append(float(mag.mean()))
        if not mags:
            return 0.5
        avg = sum(mags) / len(mags)
        # Calibrated for our 224-px downsampled frames:
        # <0.2 = near-static, 0.2–0.8 = talking head, 0.8–2 = some movement,
        # 2–4 = cuts/action, >4 = busy.
        if avg < 0.2:
            return 0.2
        if avg < 0.8:
            return 0.5
        if avg < 2.0:
            return 0.7
        if avg < 4.0:
            return 0.9
        return 1.0
    except Exception:
        return 0.5


# Scene/motion features are calibrated on 224-px-wide frames. Face detection
# needs more pixels: at 224 px a podcast face is ~20 px and Haar misses it, so
# frames are decoded at FACE_WIDTH and a full-size copy is kept only for the
# few timestamps used for face checks (memory stays at the 224-px level).
ANALYSIS_WIDTH = 224
FACE_WIDTH = 640
# Haar fires on busy textures (measured: 3-13 of 30 no-face frames), so a
# segment only counts as "has a face" when a majority of its samples agree.
FACE_FRACTIONS = (0.1, 0.3, 0.5, 0.7, 0.9)
FACE_MIN_HITS = 3
HAAR_PARAMS = {"scaleFactor": 1.1, "minNeighbors": 8, "minSize": (40, 40)}


def _face_times(start, dur):
    return [start + dur * f for f in FACE_FRACTIONS]


def _frame_entry(img, keep_face):
    """gray/hsv at ANALYSIS_WIDTH (+ full-size face_gray when requested)."""
    import cv2
    h, w = img.shape[:2]
    full_gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    if w > ANALYSIS_WIDTH:
        small = cv2.resize(img, (ANALYSIS_WIDTH, max(2, round(h * ANALYSIS_WIDTH / w))), interpolation=cv2.INTER_AREA)
    else:
        small = img
    entry = {"gray": cv2.cvtColor(small, cv2.COLOR_BGR2GRAY), "hsv": cv2.cvtColor(small, cv2.COLOR_BGR2HSV)}
    if keep_face:
        entry["face_gray"] = full_gray
    return entry


def _near_any(t, targets, tol=0.6):
    return any(abs(t - x) <= tol for x in targets)


def _extract_frames_ffmpeg(video_path, timestamps, face_timestamps=None):
    """Frames at 1 fps across the timestamps' span, keyed by time. When
    ``face_timestamps`` is given, frames near those times also carry a
    full-size ``face_gray`` for detection."""
    import subprocess
    import tempfile
    frames = {}
    face_ts = sorted(set(face_timestamps or []))
    width = FACE_WIDTH if face_ts else ANALYSIS_WIDTH
    tmpdir = tempfile.mkdtemp(prefix="vc_frames_")
    try:
        ts_list = sorted(set(timestamps))
        if not ts_list:
            return frames
        start = max(0, ts_list[0] - 0.5)
        end = ts_list[-1] + 0.5
        out_pattern = os.path.join(tmpdir, "f_%06d.jpg")
        cmd = [
            "ffmpeg", "-y",
            "-ss", f"{start:.3f}", "-to", f"{end:.3f}",
            "-i", video_path,
            "-vf", f"fps=1,scale={width}:-2",
            "-q:v", "5",
            out_pattern
        ]
        result = subprocess.run(cmd, capture_output=True, timeout=120)
        if result.returncode == 0:
            import cv2
            import glob as _glob
            extracted = sorted(_glob.glob(os.path.join(tmpdir, "f_*.jpg")))
            for img_path in extracted:
                img = cv2.imread(img_path)
                if img is not None:
                    frame_num = int(os.path.basename(img_path).replace("f_", "").replace(".jpg", ""))
                    t = start + (frame_num - 1)
                    frames[t] = _frame_entry(img, _near_any(t, face_ts))
                try:
                    os.remove(img_path)
                except Exception:
                    pass
        else:
            for t in ts_list:
                out_path = os.path.join(tmpdir, f"s_{int(t * 1000)}.jpg")
                cmd2 = [
                    "ffmpeg", "-y", "-ss", f"{t:.3f}", "-i", video_path,
                    "-vframes", "1", "-q:v", "5", "-vf", f"scale={width}:-2",
                    out_path
                ]
                r = subprocess.run(cmd2, capture_output=True, timeout=15)
                if r.returncode == 0 and os.path.exists(out_path):
                    import cv2
                    img = cv2.imread(out_path)
                    if img is not None:
                        frames[t] = _frame_entry(img, _near_any(t, face_ts))
                    try:
                        os.remove(out_path)
                    except Exception:
                        pass
    except Exception:
        pass
    finally:
        try:
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)
        except Exception:
            pass
    return frames


def _batch_analyze_video(video_path, segments):
    if not video_path or not os.path.exists(video_path):
        return {i: {"faces": 0.5, "scene": 0.5, "motion": 0.5} for i in range(len(segments))}
    try:
        import mediapipe as mp
        mp.solutions.face_detection
        return _batch_analyze_video_mediapipe(video_path, segments)
    except ImportError:
        pass
    return _batch_analyze_video_haar(video_path, segments)


def _batch_analyze_video_mediapipe(video_path, segments):
    if not video_path or not os.path.exists(video_path):
        return {i: {"faces": 0.5, "scene": 0.5, "motion": 0.5} for i in range(len(segments))}
    try:
        import cv2
        import numpy as np

        face_detector = _get_mediapipe_face_detector()

        all_times = []
        unique_ts = set()
        for i, seg in enumerate(segments):
            start = seg.get("startTime", 0)
            dur = seg.get("duration", 30)
            end = seg.get("endTime", start + dur)
            mid = start + dur * 0.5
            all_times.append({"idx": i, "face_times": _face_times(start, dur), "scene_times": [start, mid, end]})
            for t in [mid, start, end]:
                unique_ts.add(round(t, 1))

        unique_ts = sorted(unique_ts)
        if len(unique_ts) > 60:
            step = len(unique_ts) / 60
            unique_ts = [unique_ts[int(i * step)] for i in range(60)]

        face_ts = [t for info in all_times for t in info["face_times"]]
        frame_data = _extract_frames_ffmpeg(video_path, unique_ts, face_ts)

        def _nearest(t):
            key = round(t, 1)
            if key in frame_data:
                return frame_data[key]
            best = None
            best_diff = float("inf")
            for k in frame_data:
                d = abs(k - t)
                if d < best_diff:
                    best_diff = d
                    best = frame_data[k]
            return best

        results = {}
        for info in all_times:
            idx = info["idx"]

            faces_found = 0
            for t in info["face_times"]:
                fd = _nearest(t)
                if fd is None:
                    continue
                try:
                    rgb = cv2.cvtColor(fd.get("face_gray", fd["gray"]), cv2.COLOR_GRAY2RGB)
                    detections = face_detector.process(rgb)
                    if detections.detections:
                        faces_found += 1
                except Exception:
                    pass

            face_score = 0.7 if faces_found >= FACE_MIN_HITS else 0.0

            scene_frames = [fd for t in info["scene_times"] if (fd := _nearest(t)) is not None]

            if len(scene_frames) >= 2:
                diffs = []
                grays = [f["gray"] for f in scene_frames]
                for i2 in range(1, len(grays)):
                    h1 = cv2.calcHist([grays[i2 - 1]], [0], None, [64], [0, 256])
                    h2 = cv2.calcHist([grays[i2]], [0], None, [64], [0, 256])
                    cv2.normalize(h1, h1)
                    cv2.normalize(h2, h2)
                    diffs.append(cv2.compareHist(h1, h2, cv2.HISTCMP_CORREL))
                avg_corr = sum(diffs) / len(diffs)
                change_score = 1.0 - avg_corr

                brightness_scores = []
                saturation_scores = []
                for f in scene_frames:
                    avg_v = np.mean(f["hsv"][:, :, 2]) / 255.0
                    avg_s = np.mean(f["hsv"][:, :, 1]) / 255.0
                    brightness_scores.append(avg_v)
                    saturation_scores.append(avg_s)
                avg_brightness = sum(brightness_scores) / len(brightness_scores) if brightness_scores else 0.5
                avg_saturation = sum(saturation_scores) / len(saturation_scores) if saturation_scores else 0.3

                visual_appeal = 0.0
                if avg_brightness > 0.5:
                    visual_appeal += 0.1
                if avg_brightness > 0.65:
                    visual_appeal += 0.1
                if avg_saturation > 0.35:
                    visual_appeal += 0.1
                if avg_saturation > 0.5:
                    visual_appeal += 0.1

                scene_score = 0.3
                if change_score > 0.5:
                    scene_score = 0.9
                elif change_score > 0.3:
                    scene_score = 0.7
                elif change_score > 0.15:
                    scene_score = 0.5
                scene_score = min(scene_score + visual_appeal, 1.0)
                motion_score = _calc_motion_from_grays(grays)
            else:
                scene_score = 0.5
                motion_score = 0.5

            results[idx] = {
                "faces": face_score,
                "scene": round(scene_score, 4),
                "motion": motion_score,
            }

        face_detector.close()
        return results
    except Exception:
        return {i: {"faces": 0.5, "scene": 0.5, "motion": 0.5} for i in range(len(segments))}


def _batch_analyze_video_haar(video_path, segments):
    if not video_path or not os.path.exists(video_path):
        return {i: {"faces": 0.5, "scene": 0.5, "motion": 0.5} for i in range(len(segments))}
    try:
        import cv2
        import numpy as np

        face_cascade = cv2.CascadeClassifier(
            cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
        )
        smile_path = os.path.join(cv2.data.haarcascades, "haarcascade_smile.xml")
        smile_cascade = None
        if os.path.exists(smile_path):
            smile_cascade = cv2.CascadeClassifier(smile_path)

        all_times = []
        unique_ts = set()
        for i, seg in enumerate(segments):
            start = seg.get("startTime", 0)
            dur = seg.get("duration", 30)
            end = seg.get("endTime", start + dur)
            mid = start + dur * 0.5
            ts = [mid, start, end]
            all_times.append({"idx": i, "face_times": _face_times(start, dur), "scene_times": [start, mid, end]})
            for t in ts:
                unique_ts.add(round(t, 1))

        unique_ts = sorted(unique_ts)
        if len(unique_ts) > 60:
            step = len(unique_ts) / 60
            unique_ts = [unique_ts[int(i * step)] for i in range(60)]

        face_ts = [t for info in all_times for t in info["face_times"]]
        frame_data = _extract_frames_ffmpeg(video_path, unique_ts, face_ts)

        def _nearest(t):
            key = round(t, 1)
            if key in frame_data:
                return frame_data[key]
            best = None
            best_diff = float("inf")
            for k in frame_data:
                d = abs(k - t)
                if d < best_diff:
                    best_diff = d
                    best = frame_data[k]
            return best

        results = {}
        for info in all_times:
            idx = info["idx"]

            faces_found = 0
            smiles_found = 0
            for t in info["face_times"]:
                fd = _nearest(t)
                if fd is None:
                    continue
                gray = fd.get("face_gray", fd["gray"])
                try:
                    faces = face_cascade.detectMultiScale(gray, **HAAR_PARAMS)
                    if len(faces) > 0:
                        faces_found += 1
                        if smile_cascade is not None:
                            for (fx, fy, fw, fh) in faces[:1]:
                                roi = gray[fy:fy + fh, fx:fx + fw]
                                smiles = smile_cascade.detectMultiScale(roi, scaleFactor=1.8, minNeighbors=15, minSize=(10, 10))
                                if len(smiles) > 0:
                                    smiles_found += 1
                except Exception:
                    pass

            if faces_found >= FACE_MIN_HITS:
                face_score = 1.0 if smiles_found >= 1 else 0.7
            else:
                face_score = 0.0

            scene_frames = [fd for t in info["scene_times"] if (fd := _nearest(t)) is not None]

            if len(scene_frames) >= 2:
                diffs = []
                grays = [f["gray"] for f in scene_frames]
                for i2 in range(1, len(grays)):
                    h1 = cv2.calcHist([grays[i2 - 1]], [0], None, [64], [0, 256])
                    h2 = cv2.calcHist([grays[i2]], [0], None, [64], [0, 256])
                    cv2.normalize(h1, h1)
                    cv2.normalize(h2, h2)
                    diffs.append(cv2.compareHist(h1, h2, cv2.HISTCMP_CORREL))
                avg_corr = sum(diffs) / len(diffs)
                change_score = 1.0 - avg_corr

                brightness_scores = []
                saturation_scores = []
                for f in scene_frames:
                    avg_v = np.mean(f["hsv"][:, :, 2]) / 255.0
                    avg_s = np.mean(f["hsv"][:, :, 1]) / 255.0
                    brightness_scores.append(avg_v)
                    saturation_scores.append(avg_s)
                avg_brightness = sum(brightness_scores) / len(brightness_scores) if brightness_scores else 0.5
                avg_saturation = sum(saturation_scores) / len(saturation_scores) if saturation_scores else 0.3

                visual_appeal = 0.0
                if avg_brightness > 0.5:
                    visual_appeal += 0.1
                if avg_brightness > 0.65:
                    visual_appeal += 0.1
                if avg_saturation > 0.35:
                    visual_appeal += 0.1
                if avg_saturation > 0.5:
                    visual_appeal += 0.1

                scene_score = 0.3
                if change_score > 0.5:
                    scene_score = 0.9
                elif change_score > 0.3:
                    scene_score = 0.7
                elif change_score > 0.15:
                    scene_score = 0.5
                scene_score = min(scene_score + visual_appeal, 1.0)
                motion_score = _calc_motion_from_grays(grays)
            else:
                scene_score = 0.5
                motion_score = 0.5

            results[idx] = {
                "faces": face_score,
                "scene": round(scene_score, 4),
                "motion": motion_score,
            }

        return results
    except Exception:
        return {i: {"faces": 0.5, "scene": 0.5, "motion": 0.5} for i in range(len(segments))}


def score_face_presence(video_path=None, start_time=0.0, end_time=0.0):
    if not video_path or not os.path.exists(video_path):
        return 0.5
    try:
        import cv2
        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            return 0.5
        fps = cap.get(cv2.CAP_PROP_FPS)
        if fps <= 0:
            cap.release()
            return 0.5
        duration = end_time - start_time
        sample_times = [start_time + duration * f for f in [0.0, 0.5, 1.0]]
        face_cascade, smile_cascade = _get_haar_cascades()
        faces_found = 0
        smiles_found = 0
        for t in sample_times:
            frame_idx = int(t * fps)
            cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
            ret, frame = cap.read()
            if not ret:
                continue
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            faces = face_cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=3, minSize=(30, 30))
            if len(faces) > 0:
                faces_found += 1
                if smile_cascade is not None:
                    for (fx, fy, fw, fh) in faces[:1]:
                        roi_gray = gray[fy:fy + fh, fx:fx + fw]
                        smiles = smile_cascade.detectMultiScale(roi_gray, scaleFactor=1.8, minNeighbors=15, minSize=(15, 15))
                        if len(smiles) > 0:
                            smiles_found += 1
        cap.release()
        if faces_found >= 3 and smiles_found >= 2:
            return 1.0
        if faces_found >= 3:
            return 0.9
        if faces_found == 2 and smiles_found >= 1:
            return 0.85
        if faces_found == 2:
            return 0.7
        if faces_found == 1 and smiles_found >= 1:
            return 0.6
        if faces_found == 1:
            return 0.3
        return 0.0
    except Exception:
        return 0.5


def score_scene_change(video_path=None, start_time=0.0, end_time=0.0):
    if not video_path or not os.path.exists(video_path):
        return 0.5
    try:
        import cv2
        import numpy as np
        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            return 0.5
        fps = cap.get(cv2.CAP_PROP_FPS)
        if fps <= 0:
            cap.release()
            return 0.5
        duration = end_time - start_time
        n_samples = min(max(int(duration / 5), 3), 8)
        sample_times = [start_time + duration * i / (n_samples - 1) for i in range(n_samples)]
        frames_gray = []
        frames_hsv = []
        for t in sample_times:
            cap.set(cv2.CAP_PROP_POS_FRAMES, int(t * fps))
            ret, frame = cap.read()
            if not ret:
                continue
            frames_gray.append(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY))
            frames_hsv.append(cv2.cvtColor(frame, cv2.COLOR_BGR2HSV))
        cap.release()
        if len(frames_gray) < 2:
            return 0.5

        diffs = []
        for i in range(1, len(frames_gray)):
            h1 = cv2.calcHist([frames_gray[i - 1]], [0], None, [64], [0, 256])
            h2 = cv2.calcHist([frames_gray[i]], [0], None, [64], [0, 256])
            cv2.normalize(h1, h1)
            cv2.normalize(h2, h2)
            diffs.append(cv2.compareHist(h1, h2, cv2.HISTCMP_CORREL))
        avg_corr = sum(diffs) / len(diffs)
        change_score = 1.0 - avg_corr

        brightness_scores = []
        saturation_scores = []
        for hsv in frames_hsv:
            avg_v = np.mean(hsv[:, :, 2]) / 255.0
            avg_s = np.mean(hsv[:, :, 1]) / 255.0
            brightness_scores.append(avg_v)
            saturation_scores.append(avg_s)
        avg_brightness = sum(brightness_scores) / len(brightness_scores) if brightness_scores else 0.5
        avg_saturation = sum(saturation_scores) / len(saturation_scores) if saturation_scores else 0.3

        visual_appeal = 0.0
        if avg_brightness > 0.5:
            visual_appeal += 0.1
        if avg_brightness > 0.65:
            visual_appeal += 0.1
        if avg_saturation > 0.35:
            visual_appeal += 0.1
        if avg_saturation > 0.5:
            visual_appeal += 0.1

        result = 0.3
        if change_score > 0.5:
            result = 0.9
        elif change_score > 0.3:
            result = 0.7
        elif change_score > 0.15:
            result = 0.5
        result = min(result + visual_appeal, 1.0)
        return round(result, 4)
    except Exception:
        return 0.5
