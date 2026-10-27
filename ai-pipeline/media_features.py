#!/usr/bin/env python3
"""Media features per candidate segment, for the Bun clip scorer
(backend/src/scoring.ts), which combines them with its text rules.

- rmsRatio: segment loudness ÷ whole-video loudness (None without audio)
- onsetDensity: audio onset peaks per second, mapped to 0-1
- facePresence: faces in 3 of 5 full-resolution frames (Haar / MediaPipe)
- sceneChange, motion: frame histogram / pixel differences

    python media_features.py --segments S.json --video V.mp4 [--audio A.wav]

stdout: {"success": true, "data": {"videoId": ..., "segments": [{index, ...}]}}
"""

import argparse
import json
import sys
from concurrent.futures import ThreadPoolExecutor

from features.audio import _extract_audio_rms_ratio, _load_audio_cache, score_onset_density
from features.visual import _batch_analyze_video


def measure(segments, video_path, audio_path=None):
    with ThreadPoolExecutor(max_workers=2) as pool:
        audio_future = pool.submit(_load_audio_cache, audio_path)
        video_future = pool.submit(_batch_analyze_video, video_path, segments)
        audio_cache = audio_future.result()
        video_data = video_future.result() or {}
    out = []
    for s in segments:
        idx = s.get("index", 0)
        start, end = s.get("startTime", 0), s.get("endTime", 0)
        v = video_data.get(idx, {})
        out.append({
            "index": idx,
            "rmsRatio": _extract_audio_rms_ratio(audio_path, start, end, audio_cache=audio_cache),
            "onsetDensity": score_onset_density(audio_cache, start, end),
            "facePresence": v.get("faces", 0.5),
            "sceneChange": v.get("scene", 0.5),
            "motion": v.get("motion", 0.5),
        })
    return out


def main():
    parser = argparse.ArgumentParser(description="Measure audio/visual features of candidate segments")
    parser.add_argument("--segments", required=True, help="Segments JSON from segment stage")
    parser.add_argument("--video", required=True, help="Source video")
    parser.add_argument("--audio", default="", help="Extracted WAV (optional)")
    args = parser.parse_args()
    try:
        with open(args.segments, "r", encoding="utf-8") as f:
            data = json.load(f)
        segments = data.get("segments") or data.get("scoredSegments") or []
        result = {"videoId": data.get("videoId", ""),
                  "segments": measure(segments, args.video, args.audio or None)}
        print(json.dumps({"success": True, "data": result}, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}, ensure_ascii=False))
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
