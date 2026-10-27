"""9:16 reframing for render.py: face-following crop, centre crop, or the
whole frame over a blurred backdrop.

``face`` mode samples the clip at a low frame rate, finds faces (MediaPipe if
installed, else OpenCV Haar — the Docker image ships Haar only), turns each
sample into a horizontal crop centre, and smooths that into a piecewise-
constant track: the crop only moves after the subject has clearly moved
(``threshold``) for ``hold`` consecutive samples. On a podcast this gives a
clean cut to the new speaker instead of a drifting or jittering crop. The
track becomes a per-frame ffmpeg ``crop`` x-expression, re-timed onto the
silence-trimmed timeline when render.py cut pauses.

Anything that goes wrong (no faces, probe failure, odd aspect) falls back to
the plain centre crop.
"""

import glob
import json
import os
import re
import shutil
import subprocess
import tempfile

OUT_W, OUT_H = 1080, 1920
MODES = ("face", "center", "blur")
# ffmpeg scene score (0-1) above which two frames are a cut.
CUT_SCENE_SCORE = 0.3
DEFAULT_MODE = "face"

CENTER_VF = f"scale={OUT_W}:{OUT_H}:force_original_aspect_ratio=increase,crop={OUT_W}:{OUT_H},format=yuv420p"
MAX_TRACK_SEGMENTS = 40


# --- probing / sampling --------------------------------------------------------

def probe_size(video_path, ffprobe="ffprobe"):
    """(width, height) of the first video stream, or None."""
    try:
        out = subprocess.run(
            [ffprobe, "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=width,height", "-of", "json", video_path],
            capture_output=True, text=True, timeout=30,
        )
        if out.returncode != 0:
            return None
        s = json.loads(out.stdout)["streams"][0]
        return int(s["width"]), int(s["height"])
    except Exception:
        return None


def scaled_width(src_w, src_h):
    """Width after scaling to cover 1080x1920 (render's scale step)."""
    if src_w * OUT_H > OUT_W * src_h:           # wider than 9:16
        w = round(src_w * OUT_H / src_h)
        return w + (w % 2)
    return OUT_W


def sample_frames(video_path, start, end, fps=2.0, width=640, ffmpeg="ffmpeg", cuts=None):
    """Grayscale frames across [start, end] as ``[(t_rel, gray), ...]``.

    Given a ``cuts`` list, the same decode also appends the scene-cut times
    (seconds from ``start``) that ffmpeg's scene score finds.
    """
    import cv2

    tmp = tempfile.mkdtemp(prefix="vc_reframe_")
    try:
        pattern = os.path.join(tmp, "f_%05d.jpg")
        cmd = [ffmpeg, "-hide_banner", "-nostats", "-loglevel", "error" if cuts is None else "info",
               "-ss", f"{start:.3f}", "-to", f"{end:.3f}", "-i", video_path]
        if cuts is None:
            cmd += ["-vf", f"fps={fps},scale={width}:-2", "-q:v", "4", pattern]
        else:
            cmd += ["-filter_complex",
                    f"[0:v]split[a][b];[a]fps={fps},scale={width}:-2[f];"
                    f"[b]scale=160:-2,select='gt(scene,{CUT_SCENE_SCORE})',showinfo[c]",
                    "-map", "[f]", "-q:v", "4", pattern, "-map", "[c]", "-f", "null", "-"]
        res = subprocess.run(cmd, capture_output=True, timeout=300)
        if res.returncode != 0:
            return []
        if cuts is not None:
            log = res.stderr.decode("utf-8", "replace") if isinstance(res.stderr, bytes) else (res.stderr or "")
            cuts.extend(float(t) for t in re.findall(r"pts_time:([0-9.]+)", log))
        frames = []
        for path in sorted(glob.glob(os.path.join(tmp, "f_*.jpg"))):
            img = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
            if img is not None:
                n = int(os.path.basename(path)[2:-4])
                frames.append(((n - 1) / fps, img))
        return frames
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# --- detection ---------------------------------------------------------------

def make_detector():
    """Return ``detect(gray) -> [(center_x_norm, width_norm), ...]``."""
    try:
        import mediapipe as mp  # optional, better recall on profiles
        import cv2
        det = mp.solutions.face_detection.FaceDetection(model_selection=1, min_detection_confidence=0.5)

        def detect(gray):
            res = det.process(cv2.cvtColor(gray, cv2.COLOR_GRAY2RGB))
            out = []
            for d in res.detections or []:
                b = d.location_data.relative_bounding_box
                out.append((float(b.xmin + b.width / 2), float(b.width)))
            return out
        return detect
    except Exception:
        pass

    import cv2
    from features.visual import _get_haar_cascades
    face_cascade, _ = _get_haar_cascades()
    # The frontal cascade misses people turned toward each other in wide
    # shots; the profile cascade (one facing direction, so also run on the
    # mirrored frame) finds them. Only run when the frontal pass found
    # nobody: three passes per frame tripled tracking time on close-ups.
    profile_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_profileface.xml")
    params = dict(scaleFactor=1.1, minNeighbors=5, minSize=(24, 24))

    def detect(gray):
        w = gray.shape[1]
        found = [((x + fw / 2) / w, fw / w) for (x, y, fw, fh) in face_cascade.detectMultiScale(gray, **params)]
        if not found:
            side = [((x + fw / 2) / w, fw / w) for (x, y, fw, fh) in profile_cascade.detectMultiScale(gray, **params)]
            side += [(1 - (x + fw / 2) / w, fw / w)
                     for (x, y, fw, fh) in profile_cascade.detectMultiScale(cv2.flip(gray, 1), **params)]
            for c, fw in side:                   # a face both passes caught counts once
                if all(abs(c - c2) > max(fw, fw2) / 2 for c2, fw2 in found):
                    found.append((c, fw))
        return [(float(c), float(fw)) for c, fw in found]
    return detect


def frame_target(faces, window):
    """Crop centre for one frame. ``window`` is the crop width as a fraction
    of the frame. All faces fit → centre on the group; otherwise follow the
    largest face. No faces → None."""
    if not faces:
        return None
    lo = min(c - w / 2 for c, w in faces)
    hi = max(c + w / 2 for c, w in faces)
    if hi - lo <= window * 0.9:
        return (lo + hi) / 2
    return max(faces, key=lambda f: f[1])[0]


def plan_track(samples, threshold=0.08, hold=2, cuts=()):
    """``samples``: ``[(t, target_or_None), ...]`` → ``[(t_start, centre), ...]``.

    Gaps (None) keep the current centre. A move needs ``hold`` consecutive
    samples away from the current centre by more than ``threshold``; the
    jump is placed at the first of them — or, when a scene cut (``cuts``)
    falls between the last sample on the old framing and the samples that
    confirmed the move, on that cut, so the new framing starts with the new
    shot. Returns [] when no face was seen.
    """
    seen = [(t, c) for t, c in samples if c is not None]
    if not seen:
        return []
    track = [(0.0, seen[0][1])]
    pending = []
    prev = before = seen[0][0]
    for t, c in seen[1:]:
        if abs(c - track[-1][1]) > threshold:
            if pending and abs(c - pending[-1][1]) > threshold:
                pending = []                     # moving target: restart the count
            if not pending:
                before = prev
            pending.append((t, c))
            if len(pending) >= hold:
                centre = sum(p[1] for p in pending) / len(pending)
                at = pending[0][0]
                near = [x for x in cuts if before < x <= pending[-1][0]]
                if near:
                    at = min(near, key=lambda x: abs(x - at))
                track.append((at, centre))
                pending = []
        else:
            pending = []
        prev = t
    return track


def downsample_track(track, limit=MAX_TRACK_SEGMENTS):
    """Keep the expression bounded: merge the closest neighbouring centres."""
    track = list(track)
    while len(track) > limit:
        i = min(range(1, len(track)), key=lambda k: abs(track[k][1] - track[k - 1][1]))
        del track[i]
    return track


# --- ffmpeg filters ------------------------------------------------------------

def crop_x_expr(track, scaled_w):
    """Per-frame crop x (pixels) for a centre track, clamped to the frame."""
    max_x = scaled_w - OUT_W

    def px(c):
        return int(min(max(round(c * scaled_w - OUT_W / 2), 0), max_x))

    expr = str(px(track[-1][1]))
    for i in range(len(track) - 2, -1, -1):
        expr = f"if(lt(t,{track[i + 1][0]:.3f}),{px(track[i][1])},{expr})"
    return expr


def timeline_track(track, timeline):
    """Re-time a source-time centre track onto an output timeline (ordered
    clip-relative ranges, possibly jumping back for a hook replay)."""
    def value_at(t):
        c = track[0][1]
        for ts, cc in track:
            if ts <= t:
                c = cc
        return c

    out, offset = [], 0.0
    for a, b in timeline:
        points = [(offset, value_at(a))] + [(offset + ts - a, c) for ts, c in track if a < ts < b]
        for t, c in points:
            t = round(t, 3)
            if out and t <= out[-1][0]:
                out[-1] = (out[-1][0], c)
            elif not out or c != out[-1][1]:
                out.append((t, c))
        offset += b - a
    return out


def video_filter(mode, size=None, track=None):
    """The scale/crop part of the render filter for ``mode``.

    Returns ``(kind, filter)``: kind ``"vf"`` for a simple chain, or
    ``"complex"`` for a filter_complex reading ``[in]`` and writing ``[v]``.
    """
    if mode == "blur":
        return "complex", (
            "[in]split=2[bg][fg];"
            f"[bg]scale={OUT_W}:{OUT_H}:force_original_aspect_ratio=increase,crop={OUT_W}:{OUT_H},"
            "boxblur=20:2[bgb];"
            f"[fg]scale={OUT_W}:{OUT_H}:force_original_aspect_ratio=decrease[fgs];"
            "[bgb][fgs]overlay=(W-w)/2:(H-h)/2,format=yuv420p[v]"
        )
    if mode == "face" and size and track:
        sw = scaled_width(*size)
        if sw > OUT_W:
            return "vf", (
                f"scale={sw}:{OUT_H},"
                f"crop={OUT_W}:{OUT_H}:x='{crop_x_expr(track, sw)}':y=0,format=yuv420p"
            )
    return "vf", CENTER_VF


def plan_face_track(video_path, start, end, ffmpeg="ffmpeg", detect=None, fps=2.0):
    """Sample, detect and smooth: the face-following centre track for a clip
    ([] when no faces were found)."""
    cuts = []
    size_frames = sample_frames(video_path, start, end, fps=fps, ffmpeg=ffmpeg, cuts=cuts)
    if not size_frames:
        return []
    detect = detect or make_detector()
    h, w = size_frames[0][1].shape[:2]
    window = OUT_W / (OUT_H * w / h) if w * OUT_H > OUT_W * h else 1.0
    samples = [(t, frame_target(detect(g), window)) for t, g in size_frames]
    return downsample_track(plan_track(samples, cuts=cuts))
