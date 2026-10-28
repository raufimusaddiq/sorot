#!/usr/bin/env python3
"""Render 9:16 vertical clips from scored segments using ffmpeg.

With ``--export-dir`` the karaoke captions and background music go into the
same encode, writing the finished clip: one decode + encode per clip instead
of a render and a second full re-encode just to burn captions (subtitle.py,
which still re-burns clips rendered the old way). On a CPU that halved the
time per clip, and one generation of compression loss beats two.

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

from captions import (
    DEFAULT_PRESET, PRESETS, build_ass, clip_words, concat_graph, ffmpeg_filter_path, is_monotonic, music_graph,
    plan_timeline, select_expr, timeline_duration, words_for_clip, x264_preset,
)
import reframe as reframe_mod


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


# Back-compat alias — older callers/tests import this name.
def _detect_nvenc(ffmpeg_path):
    return _probe_nvenc(ffmpeg_path)


def _build_render_cmd(ffmpeg_path, video_path, start, end, output_path, use_nvenc, timeline=None, reframe=None,
                      burn=None):
    # Seek before -i so ffmpeg jumps to the nearest keyframe instead of
    # decoding the whole upstream video — this is the single biggest win on
    # long YouTube sources.
    # ``format=yuv420p`` at the tail of the filter chain is the fix for
    # 10-bit / yuv444p sources that NVENC H.264 rejects.
    # ``reframe`` is (kind, filter) from reframe.video_filter: a simple scale/
    # crop chain ("vf") or a filter_complex reading [in] → [v] ("complex").
    # ``burn`` = (ass_path or None, bgm or None, bgm_volume): captions and
    # music in this same pass (see _burn_args).
    kind, frame_filter = reframe or ("vf", reframe_mod.CENTER_VF)
    cmd = [
        ffmpeg_path, "-hide_banner", "-loglevel", "error",
        "-ss", str(start), "-to", str(end),
        "-i", video_path,
    ]
    if burn is not None:
        return _encoder_args(cmd + _burn_args(timeline, kind, frame_filter, *burn), output_path, use_nvenc)
    if timeline and not is_monotonic(timeline):
        # Hook-first: ranges jump back, so cut each range and concatenate.
        graph = concat_graph(timeline, "[cv]", "[ca]")
        if kind == "complex":
            graph += ";[cv]null[in];" + frame_filter
        else:
            graph += f";[cv]{frame_filter}[v]"
        cmd.extend(["-filter_complex", graph, "-map", "[v]", "-map", "[ca]"])
        return _encoder_args(cmd, output_path, use_nvenc)

    select = ""
    if timeline:
        # Silence trim: keep only the speech spans (clip-relative; input-side
        # -ss resets timestamps to 0) and re-time both streams gaplessly.
        expr = select_expr(timeline)
        select = f"select='{expr}',setpts=N/FRAME_RATE/TB"
        cmd.extend(["-af", f"aselect='{expr}',asetpts=N/SR/TB"])
    if kind == "complex":
        head = f"[0:v]{select or 'null'}[in];"
        cmd.extend(["-filter_complex", head + frame_filter, "-map", "[v]", "-map", "0:a?"])
    else:
        cmd.extend(["-vf", f"{select},{frame_filter}" if select else frame_filter])
    return _encoder_args(cmd, output_path, use_nvenc)


def _burn_args(timeline, kind, frame_filter, ass_path, bgm, bgm_volume):
    """One filter graph: timeline cut, 9:16 framing, captions, music."""
    parts = []
    if timeline and not is_monotonic(timeline):
        parts.append(concat_graph(timeline, "[cv]", "[ca]"))      # hook first: cut + concatenate
        video, audio = "[cv]", "[ca]"
    elif timeline:
        expr = select_expr(timeline)                              # silence trim
        parts += [f"[0:v]select='{expr}',setpts=N/FRAME_RATE/TB[sv]", f"[0:a]aselect='{expr}',asetpts=N/SR/TB[sa]"]
        video, audio = "[sv]", "[sa]"
    else:
        video, audio = "[0:v]", "0:a?"
    parts.append(f"{video}null[in];{frame_filter}" if kind == "complex" else f"{video}{frame_filter}[v]")
    captions = f"ass={ffmpeg_filter_path(ass_path)}," if ass_path else ""
    parts.append(f"[v]{captions}format=yuv420p[vout]")
    args = []
    if bgm:
        args += ["-stream_loop", "-1", "-i", bgm]                 # input 1, looped under the clip
        parts += music_graph(audio if audio.startswith("[") else "[0:a]", bgm_volume)
        audio = "[aout]"
    return args + ["-filter_complex", ";".join(parts), "-map", "[vout]", "-map", audio]


def _encoder_args(cmd, output_path, use_nvenc):
    if use_nvenc:
        cmd.extend([
            "-c:v", "h264_nvenc",
            "-preset", "p4", "-tune", "hq",
            "-rc", "vbr", "-cq", "23", "-b:v", "0",
            "-spatial-aq", "1",
        ])
    else:
        cmd.extend(["-c:v", "libx264", "-preset", x264_preset(), "-crf", "23"])
    cmd.extend(["-c:a", "aac", "-y", output_path])
    return cmd


def render_clip(video_path, start, end, output_path, ffmpeg_path=None, timeline=None, reframe=None, burn=None):
    if ffmpeg_path is None:
        ffmpeg_path = find_ffmpeg()
    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    use_nvenc = _probe_nvenc(ffmpeg_path)
    cmd = _build_render_cmd(ffmpeg_path, video_path, start, end, output_path, use_nvenc, timeline, reframe, burn)
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
            ffmpeg_path, video_path, start, end, output_path, use_nvenc=False, timeline=timeline, reframe=reframe,
            burn=burn,
        )
        result = subprocess.run(cmd, capture_output=True, text=True)

    if result.returncode != 0:
        raise RuntimeError(
            f"ffmpeg render failed (cmd={' '.join(cmd)}): {result.stderr[-500:]}"
        )
    return output_path


def plan_framing(mode, video_path, start, end, timeline=None):
    """(kind, filter) for this clip plus the number of crop segments used.
    Face tracking failures degrade to the centre crop, never to a failed clip."""
    if mode != "face":
        return reframe_mod.video_filter(mode), 0
    try:
        ffmpeg_path = find_ffmpeg()
        size = reframe_mod.probe_size(video_path, ffprobe=ffmpeg_path.replace("ffmpeg", "ffprobe"))
        track = reframe_mod.plan_face_track(video_path, start, end, ffmpeg=ffmpeg_path) if size else []
        if track and timeline:
            track = reframe_mod.timeline_track(track, timeline)
        framing = reframe_mod.video_filter("face", size, track)
        return framing, (len(track) if framing[1] != reframe_mod.CENTER_VF else 0)
    except Exception as e:
        print(f"WARN: face reframe failed ({e}); using centre crop", file=sys.stderr)
        return reframe_mod.video_filter("center"), 0


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
    parser.add_argument("--hook-first", action="store_true",
                        help="Replay the clip's strongest line before it starts (needs --transcript)")
    parser.add_argument("--reframe", default=os.environ.get("REFRAME_MODE", reframe_mod.DEFAULT_MODE),
                        choices=reframe_mod.MODES, help="9:16 framing: follow faces, centre crop, or blurred fill")
    parser.add_argument("--export-dir", default="",
                        help="Burn captions (and music) in this pass; the finished clip and its .ass go here")
    parser.add_argument("--style", default=os.environ.get("SUBTITLE_STYLE", DEFAULT_PRESET),
                        help=f"Caption preset with --export-dir: {', '.join(PRESETS)}")
    parser.add_argument("--bgm", default="", help="Background music with --export-dir (looped, ducked)")
    parser.add_argument("--bgm-volume", type=float, default=0.12, help="Music level before ducking (0-1)")
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
        if (args.silence_trim or args.hook_first) and not args.transcript:
            raise ValueError("--silence-trim/--hook-first require --transcript")
        if args.transcript and (args.silence_trim or args.hook_first or args.export_dir):
            with open(args.transcript, "r", encoding="utf-8") as f:
                transcript_segments = json.load(f).get("segments", [])
        if args.bgm and not os.path.exists(args.bgm):
            raise ValueError(f"background music not found: {args.bgm}")

        os.makedirs(args.output_dir, exist_ok=True)
        if args.export_dir:
            os.makedirs(args.export_dir, exist_ok=True)
        rendered = []

        for seg in to_render:
            clip_id = seg.get("rank", seg.get("index", 0))
            output_path = os.path.join(args.output_dir, f"clip_{clip_id}.mp4")
            burn, words, ass_path = None, [], None
            if args.export_dir:
                output_path = os.path.join(args.export_dir, f"clip_{clip_id}_subtitled.mp4")
                words = clip_words(transcript_segments, seg, args.silence_trim, args.silence_gap, args.hook_first)
                if words:
                    ass_path = os.path.join(args.export_dir, f"clip_{clip_id}.ass")
                    with open(ass_path, "w", encoding="utf-8") as f:
                        f.write(build_ass(words, args.style))
                burn = (ass_path, args.bgm or None, args.bgm_volume)
            timeline = None
            if args.silence_trim or args.hook_first:
                # subtitle.py plans the same timeline from the same inputs, so
                # captions stay in sync with the cut video.
                duration = seg["endTime"] - seg["startTime"]
                words = words_for_clip(transcript_segments, seg["startTime"], seg["endTime"])
                planned = plan_timeline(words, duration, args.silence_trim, args.silence_gap, args.hook_first)
                timeline = None if planned == [(0.0, round(duration, 3))] else planned
            framing, crop_segments = plan_framing(args.reframe, args.video, seg["startTime"], seg["endTime"], timeline)
            try:
                render_clip(
                    args.video,
                    seg["startTime"],
                    seg["endTime"],
                    output_path,
                    timeline=timeline,
                    reframe=framing,
                    burn=burn,
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
                    "trimmedDuration": timeline_duration(timeline) if timeline else None,
                    "hookFirst": bool(timeline) and not is_monotonic(timeline),
                    "reframe": "blur" if framing[0] == "complex"
                    else ("face" if framing[1] != reframe_mod.CENTER_VF else "center"),
                    "cropSegments": crop_segments,
                    **({"captioned": True, "assPath": ass_path, "wordCount": len(words)} if burn else {}),
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
