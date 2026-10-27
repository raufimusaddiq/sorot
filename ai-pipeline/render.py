#!/usr/bin/env python3
"""Render 9:16 vertical clips from scored segments using ffmpeg.

GPU path: h264_nvenc with a runtime probe-encode (not just a string sniff of
``-encoders``) so a non-functional NVENC (driver mismatch, busy session, etc.)
falls back to libx264 for the affected clip instead of failing the whole stage.
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile

from captions import is_trimmed, keep_intervals, select_expr, words_for_clip


_NVENC_CACHE = None


def find_ffmpeg():
    return os.environ.get("FFMPEG_PATH", "ffmpeg")


def _probe_nvenc(ffmpeg_path):
    """Return True iff ``h264_nvenc`` is actually usable on this machine.

    Caches the answer for the lifetime of the process. Cheaper than the old
    string-sniff to fail, but only runs once per script invocation.
    """
    global _NVENC_CACHE
    if _NVENC_CACHE is not None:
        return _NVENC_CACHE
    try:
        listing = subprocess.run(
            [ffmpeg_path, "-hide_banner", "-encoders"],
            capture_output=True, text=True, timeout=5,
        )
        if "h264_nvenc" not in listing.stdout:
            _NVENC_CACHE = False
            return False
        with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tmp:
            probe_out = tmp.name
        try:
            probe = subprocess.run(
                [
                    ffmpeg_path, "-hide_banner", "-loglevel", "error",
                    "-f", "lavfi",
                    "-i", "testsrc=size=128x128:rate=1:duration=1",
                    "-vf", "format=yuv420p",
                    "-c:v", "h264_nvenc", "-preset", "p4",
                    "-frames:v", "1", "-y", probe_out,
                ],
                capture_output=True, text=True, timeout=10,
            )
            _NVENC_CACHE = probe.returncode == 0
        finally:
            try:
                os.remove(probe_out)
            except OSError:
                pass
        return _NVENC_CACHE
    except Exception:
        _NVENC_CACHE = False
        return False


# Back-compat alias — older callers/tests import this name.
def _detect_nvenc(ffmpeg_path):
    return _probe_nvenc(ffmpeg_path)


def _build_render_cmd(ffmpeg_path, video_path, start, end, output_path, use_nvenc, keep=None):
    # Seek before -i so ffmpeg jumps to the nearest keyframe instead of
    # decoding the whole upstream video — this is the single biggest win on
    # long YouTube sources.
    # ``format=yuv420p`` at the tail of the filter chain is the fix for
    # 10-bit / yuv444p sources that NVENC H.264 rejects.
    vf = "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,format=yuv420p"
    cmd = [
        ffmpeg_path, "-hide_banner", "-loglevel", "error",
        "-ss", str(start), "-to", str(end),
        "-i", video_path,
    ]
    if keep:
        # Silence trim: keep only the speech spans (clip-relative; input-side
        # -ss resets timestamps to 0) and re-time both streams gaplessly.
        expr = select_expr(keep)
        vf = f"select='{expr}',setpts=N/FRAME_RATE/TB," + vf
        cmd.extend(["-af", f"aselect='{expr}',asetpts=N/SR/TB"])
    cmd.extend(["-vf", vf])
    if use_nvenc:
        cmd.extend([
            "-c:v", "h264_nvenc",
            "-preset", "p4", "-tune", "hq",
            "-rc", "vbr", "-cq", "23", "-b:v", "0",
            "-spatial-aq", "1",
        ])
    else:
        cmd.extend(["-c:v", "libx264", "-preset", "fast", "-crf", "23"])
    cmd.extend(["-c:a", "aac", "-y", output_path])
    return cmd


def render_clip(video_path, start, end, output_path, ffmpeg_path=None, keep=None):
    if ffmpeg_path is None:
        ffmpeg_path = find_ffmpeg()
    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    use_nvenc = _probe_nvenc(ffmpeg_path)
    cmd = _build_render_cmd(ffmpeg_path, video_path, start, end, output_path, use_nvenc, keep)
    result = subprocess.run(cmd, capture_output=True, text=True)

    # Per-clip NVENC failure → retry once on libx264 so a driver hiccup or an
    # unsupported source pixel format doesn't kill the whole stage.
    if result.returncode != 0 and use_nvenc:
        print(
            f"WARN: h264_nvenc failed for {output_path}, falling back to libx264. "
            f"stderr={result.stderr[-400:]}",
            file=sys.stderr,
        )
        cmd = _build_render_cmd(
            ffmpeg_path, video_path, start, end, output_path, use_nvenc=False, keep=keep,
        )
        result = subprocess.run(cmd, capture_output=True, text=True)

    if result.returncode != 0:
        raise RuntimeError(
            f"ffmpeg render failed (cmd={' '.join(cmd)}): {result.stderr[-500:]}"
        )
    return output_path


def main():
    parser = argparse.ArgumentParser(description="Render 9:16 vertical clips")
    parser.add_argument("--segments", required=True, help="Path to scored segments JSON")
    parser.add_argument("--video", required=True, help="Path to source video file")
    parser.add_argument("--output-dir", required=True, help="Directory for rendered clips")
    parser.add_argument("--tiers", default="PRIMARY,BACKUP", help="Comma-separated tiers to render")
    parser.add_argument("--clip-index", type=int, default=-1, help="Render only this clip index (0-based)")
    parser.add_argument("--transcript", default="", help="Transcript JSON (needed for --silence-trim)")
    parser.add_argument("--silence-trim", action="store_true", help="Cut pauses longer than --silence-gap")
    parser.add_argument("--silence-gap", type=float, default=0.6, help="Pause length (s) that gets cut")
    args = parser.parse_args()

    try:
        with open(args.segments, "r", encoding="utf-8") as f:
            data = json.load(f)

        tiers = [t.strip() for t in args.tiers.split(",")]
        segments = data.get("scoredSegments", [])
        to_render = [s for s in segments if s.get("tier") in tiers]

        if args.clip_index >= 0:
            if args.clip_index < len(to_render):
                to_render = [to_render[args.clip_index]]
            else:
                to_render = []

        transcript_segments = []
        if args.silence_trim:
            if not args.transcript:
                raise ValueError("--silence-trim requires --transcript")
            with open(args.transcript, "r", encoding="utf-8") as f:
                transcript_segments = json.load(f).get("segments", [])

        os.makedirs(args.output_dir, exist_ok=True)
        rendered = []

        for seg in to_render:
            clip_id = seg.get("rank", seg.get("index", 0))
            output_path = os.path.join(args.output_dir, f"clip_{clip_id}.mp4")
            keep = None
            if args.silence_trim:
                # subtitle.py derives the same intervals from the same inputs,
                # so captions stay in sync with the cut video.
                duration = seg["endTime"] - seg["startTime"]
                words = words_for_clip(transcript_segments, seg["startTime"], seg["endTime"])
                intervals = keep_intervals(words, duration, min_gap=args.silence_gap)
                keep = intervals if is_trimmed(intervals, duration) else None
            try:
                render_clip(
                    args.video,
                    seg["startTime"],
                    seg["endTime"],
                    output_path,
                    keep=keep,
                )
                if not os.path.exists(output_path) or os.path.getsize(output_path) == 0:
                    rendered.append({
                        "rank": clip_id,
                        "tier": seg.get("tier"),
                        "status": "FAILED",
                        "error": "Render produced empty file",
                    })
                    continue
                rendered.append({
                    "rank": clip_id,
                    "tier": seg.get("tier"),
                    "path": output_path,
                    "status": "COMPLETED",
                    "startTime": seg["startTime"],
                    "endTime": seg["endTime"],
                    "trimmedDuration": round(sum(b - a for a, b in keep), 3) if keep else None,
                })
            except Exception as e:
                if os.path.exists(output_path) and os.path.getsize(output_path) == 0:
                    os.remove(output_path)
                rendered.append({
                    "rank": clip_id,
                    "tier": seg.get("tier"),
                    "status": "FAILED",
                    "error": str(e),
                })

        result = {
            "videoId": data.get("videoId", ""),
            "renderedCount": len([r for r in rendered if r["status"] == "COMPLETED"]),
            "failedCount": len([r for r in rendered if r["status"] == "FAILED"]),
            "clips": rendered,
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
