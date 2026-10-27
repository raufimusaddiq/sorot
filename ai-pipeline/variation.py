#!/usr/bin/env python3
"""Generate clip variations: different crops, zoom levels, subtitle styles."""

import argparse
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def find_ffmpeg():
    return os.environ.get("FFMPEG_PATH", "ffmpeg")


def _detect_nvenc(ffmpeg_path):
    """render.py's probe-encode: a build that lists h264_nvenc can still fail
    to open it (no GPU video capability), which left 0-byte variations."""
    import render
    return render._probe_nvenc(ffmpeg_path)


VARIATION_PRESETS = {
    "zoom_center": {
        "label": "Zoom Center",
        "vf_extra": "zoompan=z='min(pzoom+{step},1.3)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1080x1920:fps=30",
    },
    "zoom_top": {
        "label": "Zoom Top (Face Focus)",
        "vf_extra": "zoompan=z='min(pzoom+{step},1.3)':x='iw/2-(iw/zoom/2)':y=0:d=1:s=1080x1920:fps=30",
    },
    "dynamic_crop": {
        "label": "Dynamic Crop",
        "vf_extra": "crop=ih*9/16:ih,scale=1080:1920",
    },
}


def get_video_duration(video_path, ffmpeg_path=None):
    if ffmpeg_path is None:
        ffmpeg_path = find_ffmpeg()
    cmd = [
        ffmpeg_path.replace("ffmpeg", "ffprobe"),
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "json",
        video_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        return 30.0
    info = json.loads(result.stdout)
    return float(info["format"]["duration"])


def generate_variation(video_path, start, end, output_path, preset_name, ffmpeg_path=None):
    if ffmpeg_path is None:
        ffmpeg_path = find_ffmpeg()
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    preset = VARIATION_PRESETS.get(preset_name, VARIATION_PRESETS["zoom_center"])
    duration = end - start
    # On video, zoompan must emit one frame per input frame (d=1) and grow
    # from the previous frame's zoom; this spreads the 1.0 → 1.3 zoom over the clip.
    step = f"{0.3 / max(duration * 30, 1):.6f}"
    vf_extra = preset["vf_extra"].format(step=step)
    vf = f"scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,{vf_extra}"

    use_nvenc = _detect_nvenc(ffmpeg_path)

    cmd = [
        ffmpeg_path,
        "-ss", str(start),                       # input seek: no decoding up to the clip
        "-i", video_path,
        "-t", f"{duration:.3f}",
        "-vf", vf,
        "-c:v", "h264_nvenc" if use_nvenc else "libx264",
    ]

    if use_nvenc:
        cmd.extend(["-preset", "p4", "-rc", "vbr", "-cq", "23"])
    else:
        cmd.extend(["-preset", "fast", "-crf", "23"])

    cmd.extend(["-c:a", "aac", "-y", output_path])
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg variation failed: {result.stderr[-500:]}")
    if not os.path.exists(output_path) or os.path.getsize(output_path) == 0:
        raise RuntimeError("ffmpeg variation produced an empty file")
    return output_path


def main():
    parser = argparse.ArgumentParser(description="Generate clip variations")
    parser.add_argument("--segments", required=True, help="Path to scored segments JSON")
    parser.add_argument("--video", required=True, help="Path to source video")
    parser.add_argument("--output-dir", required=True, help="Directory for variation clips")
    parser.add_argument("--max-primary", type=int, default=3, help="Max PRIMARY clips to vary")
    parser.add_argument("--presets", default="zoom_center,zoom_top,dynamic_crop", help="Variation presets")
    args = parser.parse_args()

    try:
        with open(args.segments, "r", encoding="utf-8") as f:
            data = json.load(f)

        presets = [p.strip() for p in args.presets.split(",")]
        segments = data.get("scoredSegments", [])
        primary = [s for s in segments if s.get("tier") == "PRIMARY"][:args.max_primary]

        os.makedirs(args.output_dir, exist_ok=True)
        variations = []

        for seg in primary:
            clip_id = seg.get("rank", seg.get("index", 0))
            for preset_name in presets:
                output_path = os.path.join(
                    args.output_dir, f"clip_{clip_id}_{preset_name}.mp4"
                )
                try:
                    generate_variation(
                        args.video,
                        seg["startTime"],
                        seg["endTime"],
                        output_path,
                        preset_name,
                    )
                    variations.append({
                        "sourceRank": clip_id,
                        "preset": preset_name,
                        "path": output_path,
                        "status": "COMPLETED",
                    })
                except Exception as e:
                    variations.append({
                        "sourceRank": clip_id,
                        "preset": preset_name,
                        "path": output_path,
                        "status": "FAILED",
                        "error": str(e),
                    })

        result = {
            "videoId": data.get("videoId", ""),
            "variationCount": len([v for v in variations if v["status"] == "COMPLETED"]),
            "failedCount": len([v for v in variations if v["status"] == "FAILED"]),
            "variations": variations,
        }

        output = {"success": True, "data": result}
        print(json.dumps(output, ensure_ascii=False))

    except Exception as e:
        error_output = {"success": False, "error": str(e)}
        print(json.dumps(error_output, ensure_ascii=False), file=sys.stdout)
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
