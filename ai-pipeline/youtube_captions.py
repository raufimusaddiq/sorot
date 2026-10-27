#!/usr/bin/env python3
"""Use a YouTube video's own captions instead of running Whisper.

Uploaded (human) captions spell names and slang right, which is exactly
where Whisper slips; auto-captions are only used when ``--allow-auto`` is set
(for Indonesian they are usually weaker than Whisper large-v3-turbo).
Captions are fetched as YouTube ``json3``: auto-captions carry per-word
offsets, uploaded ones per-cue timing (words are then split evenly by
``captions.words_for_clip``).

Output matches transcribe.py (``segments`` with optional ``words``) so every
later stage works unchanged. ``data.found`` is false when no usable track
exists — the backend then falls back to Whisper.
"""

import argparse
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile


def fetch_json3(url, lang, allow_auto, ytdlp_path="yt-dlp", timeout=120):
    """(path_to_json3, kind) for the best track, or (None, None)."""
    tmp = tempfile.mkdtemp(prefix="yt_json3_")
    attempts = [("uploaded", ["--write-subs"])]
    if allow_auto:
        attempts.append(("auto", ["--write-auto-subs"]))
    try:
        for kind, flag in attempts:
            cmd = [ytdlp_path, url, "--skip-download", *flag, "--sub-langs", lang,
                   "--sub-format", "json3", "-o", os.path.join(tmp, "%(id)s.%(ext)s"),
                   "--no-warnings"]
            try:
                subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
            except (subprocess.TimeoutExpired, FileNotFoundError):
                continue
            found = sorted(glob.glob(os.path.join(tmp, "*.json3")))
            if found:
                keep = tempfile.NamedTemporaryFile(suffix=".json3", delete=False)
                keep.close()
                shutil.copyfile(found[0], keep.name)
                return keep.name, kind
        return None, None
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# Non-speech tags in YouTube captions: [tertawa], [Musik], [Applause] …
_ANNOTATION = re.compile(r"\[[^\]]*\]")
# A caption event stays on screen long after its last word is spoken; cap the
# last word so it doesn't "last" into the next sentence (or a range window).
LAST_WORD_MAX_SEC = 1.0


def parse_json3(data):
    """json3 events → transcript segments (seconds), with per-word timing when
    the track has word offsets. Non-speech tags are dropped."""
    segments = []
    for ev in data.get("events", []):
        segs = ev.get("segs") or []
        start = ev.get("tStartMs", 0) / 1000.0
        end = start + ev.get("dDurationMs", 0) / 1000.0
        timed = [s for s in segs if s.get("utf8", "").strip()]
        words = []
        if len(timed) > 1 or any("tOffsetMs" in s for s in timed):
            for i, s in enumerate(timed):
                w_start = start + s.get("tOffsetMs", 0) / 1000.0
                w_end = (start + timed[i + 1].get("tOffsetMs", 0) / 1000.0 if i + 1 < len(timed)
                         else min(end, w_start + LAST_WORD_MAX_SEC))
                text = _ANNOTATION.sub("", s["utf8"]).strip()
                if text:
                    words.append({"text": text, "start": round(w_start, 3),
                                  "end": round(max(w_end, w_start + 0.05), 3)})
            if not words:
                continue
            text = " ".join(w["text"] for w in words)
        else:
            text = _ANNOTATION.sub("", "".join(s.get("utf8", "") for s in segs)).replace("\n", " ")
            text = " ".join(text.split())
            if not text:
                continue
        seg = {"index": len(segments), "start": round(start, 2), "end": round(end, 2), "text": text}
        if words:
            seg["words"] = words
        segments.append(seg)
    return segments


def window(segments, start=None, end=None):
    """Keep segments inside [start, end] and shift times so ``start`` is 0
    (matches a section download of the same range)."""
    if start is None and end is None:
        return segments
    lo = start or 0.0
    hi = end if end is not None else float("inf")
    out = []
    for seg in segments:
        if "words" in seg:
            # Word-timed track: keep words *spoken* in the window; the segment
            # is rebuilt from them (event display time overhangs the speech).
            words = [{**w, "start": round(w["start"] - lo, 3), "end": round(min(w["end"], hi) - lo, 3)}
                     for w in seg["words"] if lo - 0.05 <= w["start"] < hi]
            if not words:
                continue
            out.append({**seg, "index": len(out), "start": round(max(words[0]["start"], 0.0), 2),
                        "end": round(words[-1]["end"], 2), "text": " ".join(w["text"] for w in words),
                        "words": words})
            continue
        if seg["end"] <= lo or seg["start"] >= hi:
            continue
        out.append({**seg, "index": len(out),
                    "start": round(max(seg["start"], lo) - lo, 2), "end": round(min(seg["end"], hi) - lo, 2)})
    return out


def main():
    parser = argparse.ArgumentParser(description="Transcript from YouTube captions")
    parser.add_argument("--url", required=True)
    parser.add_argument("--output", required=True, help="Transcript JSON to write when captions exist")
    parser.add_argument("--language", default="id")
    parser.add_argument("--allow-auto", action="store_true", help="Fall back to YouTube auto-captions")
    parser.add_argument("--start", type=float, default=None, help="Section start (s) when only a range was downloaded")
    parser.add_argument("--end", type=float, default=None)
    parser.add_argument("--ytdlp-path", default=os.environ.get("YTDLP_PATH", "yt-dlp"))
    args = parser.parse_args()

    try:
        path, kind = fetch_json3(args.url, args.language, args.allow_auto, args.ytdlp_path)
        if not path:
            print(json.dumps({"success": True, "data": {"found": False}}))
            return
        try:
            with open(path, "r", encoding="utf-8") as f:
                segments = window(parse_json3(json.load(f)), args.start, args.end)
        finally:
            os.remove(path)
        if not segments:
            print(json.dumps({"success": True, "data": {"found": False}}))
            return
        result = {
            "found": True,
            "videoId": os.path.splitext(os.path.basename(args.output))[0],
            "language": args.language,
            "model": f"youtube-{kind}",
            "source": f"youtube-{kind}",
            "segments": segments,
        }
        os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
        with open(args.output, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
        print(json.dumps({"success": True, "data": result}, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}, ensure_ascii=False))
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
