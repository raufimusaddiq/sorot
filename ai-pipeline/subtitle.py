#!/usr/bin/env python3
"""Burn word-timed karaoke captions into rendered clips.

Captions are generated as an ASS file (``captions.build_ass``) from Whisper's
per-word timestamps and burned in with ffmpeg's libass ``ass`` filter. The
``.ass`` file is kept next to the export so captions can be reviewed or
hand-edited (names, slang) and re-burned.

NVENC-first with libx264 fallback, same pattern as render.py. libass is
CPU-only so decode stays CPU-side (no -hwaccel); the encode is GPU.
``format=yuv420p`` is appended so NVENC H.264 never sees 10-bit / 4:4:4.
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile

from captions import (
    DEFAULT_PRESET, PRESETS, build_ass, ffmpeg_filter_path, map_words, plan_timeline, words_for_clip,
)

# Background music: looped under the clip and ducked whenever the voice is
# present (sidechain compression keyed on the speech), then mixed in.
DUCK = "sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400"


_NVENC_CACHE = None


def find_ffmpeg():
    return os.environ.get("FFMPEG_PATH", "ffmpeg")


def _probe_nvenc(ffmpeg_path):
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
                    "-i", "testsrc=size=256x256:rate=1:duration=1",   # NVENC minimum is above 128x128
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


def _detect_nvenc(ffmpeg_path):
    return _probe_nvenc(ffmpeg_path)


def clip_words(transcript_segments, seg, silence_trim=False, silence_gap=0.6, hook_first=False):
    """Clip words on the output timeline: render.py plans the same timeline
    (silence trim, hook replay) from the same inputs, so they line up."""
    words = words_for_clip(transcript_segments, seg["startTime"], seg["endTime"])
    if silence_trim or hook_first:
        duration = seg["endTime"] - seg["startTime"]
        words = map_words(words, plan_timeline(words, duration, silence_trim, silence_gap, hook_first))
    return words


def _build_burn_cmd(ffmpeg_path, render_path, ass_path, output_path, use_nvenc, bgm=None, bgm_volume=0.12):
    vf = f"ass={ffmpeg_filter_path(ass_path)},format=yuv420p" if ass_path else "format=yuv420p"
    cmd = [ffmpeg_path, "-hide_banner", "-loglevel", "error", "-i", render_path]
    if bgm:
        cmd.extend(["-stream_loop", "-1", "-i", bgm])
        graph = (
            f"[0:v]{vf}[vout];"
            "[0:a]asplit=2[voice][sc];"
            f"[1:a]volume={bgm_volume:.3f}[bg];"
            f"[bg][sc]{DUCK}[duck];"
            "[voice][duck]amix=inputs=2:duration=first:normalize=0[aout]"
        )
        cmd.extend(["-filter_complex", graph, "-map", "[vout]", "-map", "[aout]"])
    else:
        cmd.extend(["-vf", vf])
    if use_nvenc:
        cmd.extend([
            "-c:v", "h264_nvenc",
            "-preset", "p4", "-tune", "hq",
            "-rc", "vbr", "-cq", "23", "-b:v", "0",
        ])
    else:
        cmd.extend(["-c:v", "libx264", "-preset", "fast", "-crf", "23"])
    cmd.extend(["-c:a", "aac" if bgm else "copy", "-y", output_path])
    return cmd


def burn_subtitles(render_path, ass_path, output_path, ffmpeg_path=None, bgm=None, bgm_volume=0.12):
    """Burn ``ass_path`` onto ``render_path`` (``None`` = no captions, e.g. a
    clip with no speech) and optionally mix ducked background music."""
    if ffmpeg_path is None:
        ffmpeg_path = find_ffmpeg()
    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    use_nvenc = _probe_nvenc(ffmpeg_path)
    cmd = _build_burn_cmd(ffmpeg_path, render_path, ass_path, output_path, use_nvenc, bgm, bgm_volume)
    result = subprocess.run(cmd, capture_output=True, text=True)

    if result.returncode != 0 and use_nvenc:
        print(
            f"WARN: h264_nvenc failed burning {output_path}, falling back to libx264. "
            f"stderr={result.stderr[-400:]}",
            file=sys.stderr,
        )
        cmd = _build_burn_cmd(ffmpeg_path, render_path, ass_path, output_path, False, bgm, bgm_volume)
        result = subprocess.run(cmd, capture_output=True, text=True)

    if result.returncode != 0:
        raise RuntimeError(
            f"ffmpeg subtitle burn failed (cmd={' '.join(cmd)}): {result.stderr[-500:]}"
        )
    return output_path


def main():
    parser = argparse.ArgumentParser(description="Burn karaoke captions into rendered clips")
    parser.add_argument("--transcript", required=True, help="Path to transcript JSON")
    parser.add_argument("--segments", required=True, help="Path to scored segments JSON")
    parser.add_argument("--render-dir", required=True, help="Directory with rendered clips")
    parser.add_argument("--output-dir", required=True, help="Directory for exported clips with subtitles")
    parser.add_argument("--tiers", default="PRIMARY,BACKUP", help="Comma-separated tiers to subtitle")
    parser.add_argument("--clip-index", type=int, default=-1, help="Subtitle only this clip index (0-based)")
    parser.add_argument("--style", default=os.environ.get("SUBTITLE_STYLE", DEFAULT_PRESET),
                        help=f"Caption preset: {', '.join(PRESETS)}")
    parser.add_argument("--silence-trim", action="store_true",
                        help="Clips were rendered with --silence-trim; re-time captions to match")
    parser.add_argument("--silence-gap", type=float, default=0.6, help="Must match render.py --silence-gap")
    parser.add_argument("--hook-first", action="store_true", help="Must match render.py --hook-first")
    parser.add_argument("--bgm", default="", help="Background music file (looped, ducked under speech)")
    parser.add_argument("--bgm-volume", type=float, default=0.12, help="Music level before ducking (0-1)")
    args = parser.parse_args()

    try:
        if args.bgm and not os.path.exists(args.bgm):
            raise ValueError(f"background music not found: {args.bgm}")
        with open(args.transcript, "r", encoding="utf-8") as f:
            transcript = json.load(f)
        with open(args.segments, "r", encoding="utf-8") as f:
            segments_data = json.load(f)

        tiers = [t.strip() for t in args.tiers.split(",")]
        word_segments = transcript.get("segments", [])
        scored_segments = segments_data.get("scoredSegments", [])
        to_subtitle = [s for s in scored_segments if s.get("tier") in tiers]

        if args.clip_index >= 0:
            if args.clip_index < len(to_subtitle):
                to_subtitle = [to_subtitle[args.clip_index]]
            else:
                to_subtitle = []

        os.makedirs(args.output_dir, exist_ok=True)
        exported = []

        for seg in to_subtitle:
            clip_id = seg.get("rank", seg.get("index", 0))
            render_path = os.path.join(args.render_dir, f"clip_{clip_id}.mp4")
            output_path = os.path.join(args.output_dir, f"clip_{clip_id}_subtitled.mp4")
            ass_path = os.path.join(args.output_dir, f"clip_{clip_id}.ass")

            if not os.path.exists(render_path):
                exported.append({
                    "rank": clip_id,
                    "status": "SKIPPED",
                    "error": "render not found",
                })
                continue

            words = clip_words(word_segments, seg, args.silence_trim, args.silence_gap, args.hook_first)
            if words:
                with open(ass_path, "w", encoding="utf-8") as f:
                    f.write(build_ass(words, args.style))

            try:
                burn_subtitles(render_path, ass_path if words else None, output_path,
                               bgm=args.bgm or None, bgm_volume=args.bgm_volume)
                if not os.path.exists(output_path) or os.path.getsize(output_path) == 0:
                    exported.append({
                        "rank": clip_id,
                        "status": "FAILED",
                        "error": "Subtitle burn produced empty file",
                    })
                    continue
                exported.append({
                    "rank": clip_id,
                    "path": output_path,
                    "assPath": ass_path if words else None,
                    "status": "COMPLETED",
                    "wordCount": len(words),
                })
            except Exception as e:
                if os.path.exists(output_path) and os.path.getsize(output_path) == 0:
                    os.remove(output_path)
                exported.append({
                    "rank": clip_id,
                    "status": "FAILED",
                    "error": str(e),
                })

        result = {
            "videoId": segments_data.get("videoId", ""),
            "style": args.style,
            "exportedCount": len([e for e in exported if e["status"] == "COMPLETED"]),
            "failedCount": len([e for e in exported if e["status"] == "FAILED"]),
            "clips": exported,
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
