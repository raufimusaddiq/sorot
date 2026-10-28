"""Word-timed captions: clip word extraction, ASS generation with an
active-word highlight, and silence trimming.

Library module shared by render.py (silence trim) and subtitle.py (ASS burn).
Both derive the same keep-intervals from the transcript, so the trimmed video
and its captions always line up.

Design notes (several learned from nouverse/nouclip's ASS fixes):
- One Dialogue event per word; the active word only changes *colour*. Scaling
  the active word ("pop") makes libass recompute line height and the whole
  line jitters, so it is not used.
- Standalone punctuation tokens are folded into the previous word, and a
  trailing quote/bracket after . ? ! still counts as a sentence end.
- Braces and backslashes are stripped from words so transcript text can never
  inject ASS override tags.
"""

import os
import re

PLAY_RES = (1080, 1920)  # matches render.py's 9:16 output

_PUNCT_ONLY = re.compile(r"^[\.,\?!;:\-–—…\"'“”‘’()\[\]]+$")
_TERMINAL = re.compile(r"[\.\?!…][\"'”’)\]]*$")

MIN_WORD_SEC = 0.05
MIN_EVENT_SEC = 0.3
MAX_WORD_HOLD_SEC = 1.0

# Colours are #RRGGBB. Every preset uses DejaVu Sans because it is the font
# guaranteed to exist in the Docker image (libass would otherwise substitute).
PRESETS = {
    "default": {
        "font": "DejaVu Sans", "size": 76, "bold": True, "uppercase": True,
        "primary": "#FFFFFF", "highlight": "#FFE600", "outline_color": "#000000",
        "outline": 6, "shadow": 2, "spacing": 1, "margin_v": 440,
        "max_words": 3, "max_chars": 18, "gap": 0.5,
    },
    "hormozi": {
        "font": "DejaVu Sans", "size": 86, "bold": True, "uppercase": True,
        "primary": "#FFFFFF", "highlight": "#39FF14", "outline_color": "#000000",
        "outline": 7, "shadow": 3, "spacing": 1, "margin_v": 460,
        "max_words": 2, "max_chars": 14, "gap": 0.4,
    },
    "storyteller": {
        "font": "DejaVu Sans", "size": 66, "bold": True, "uppercase": False,
        "primary": "#F5F5F5", "highlight": "#5EEAD4", "outline_color": "#1F1F1F",
        "outline": 4, "shadow": 1, "spacing": 0, "margin_v": 400,
        "max_words": 4, "max_chars": 24, "gap": 0.5,
    },
    "cinematic": {
        "font": "DejaVu Sans", "size": 64, "bold": True, "uppercase": True,
        "primary": "#FFFFFF", "highlight": "#FFB000", "outline_color": "#000000",
        "outline": 4, "shadow": 2, "spacing": 4, "margin_v": 420,
        "max_words": 3, "max_chars": 20, "gap": 0.5,
    },
}
DEFAULT_PRESET = "default"


def get_preset(name):
    return PRESETS.get((name or "").strip().lower(), PRESETS[DEFAULT_PRESET])


# --- words ------------------------------------------------------------------

def _even_split(seg):
    """Legacy transcripts (no per-word timing): spread words evenly over the segment."""
    text = (seg.get("text") or "").strip()
    tokens = text.split()
    if not tokens:
        return []
    start, end = float(seg.get("start", 0.0)), float(seg.get("end", 0.0))
    step = (end - start) / len(tokens)
    return [{"text": t, "start": start + i * step, "end": start + (i + 1) * step}
            for i, t in enumerate(tokens)]


def words_for_clip(segments, clip_start, clip_end):
    """Words overlapping [clip_start, clip_end], clip-relative and sanitized.

    Uses the per-word timestamps transcribe.py stores in ``segment["words"]``;
    segments without them (older transcripts) fall back to an even split.
    """
    out = []
    for seg in segments:
        if seg.get("end", 0.0) < clip_start or seg.get("start", 0.0) > clip_end:
            continue
        raw = seg.get("words") or _even_split(seg)
        for w in raw:
            ws, we = float(w.get("start", 0.0)), float(w.get("end", 0.0))
            if we <= clip_start or ws >= clip_end:
                continue
            out.append({
                "text": w.get("text", w.get("word", "")),
                "start": max(ws, clip_start) - clip_start,
                "end": min(we, clip_end) - clip_start,
            })
    return sanitize_words(out)


def sanitize_words(words):
    """Strip/escape text, fold standalone punctuation into the previous word,
    and make timings monotonic with a minimum length."""
    out = []
    for w in words:
        text = str(w.get("text", "")).strip().replace("{", "").replace("}", "").replace("\\", "")
        if not text:
            continue
        start, end = float(w["start"]), float(w["end"])
        # Fold into the previous word: standalone punctuation, and the second
        # half of Indonesian reduplication, which Whisper emits as a separate
        # "-gedung" token after "gedung" (→ "gedung-gedung").
        rejoin = text.startswith("-") and len(text) > 1 and out and start - out[-1]["end"] < 0.3
        if _PUNCT_ONLY.match(text) or rejoin:
            if out:
                out[-1]["text"] += text
                out[-1]["end"] = max(out[-1]["end"], end)
            continue
        if out:
            start = max(start, out[-1]["start"])
        out.append({"text": text, "start": start, "end": max(end, start + MIN_WORD_SEC)})
    return out


def group_words(words, max_words=3, max_chars=18, gap=0.5):
    """Split words into on-screen groups. A group ends at max_words, when the
    next word would exceed max_chars, at a pause longer than ``gap``, or after
    sentence-ending punctuation."""
    groups, cur = [], []
    for w in words:
        if cur:
            chars = sum(len(x["text"]) + 1 for x in cur) + len(w["text"])
            if (len(cur) >= max_words or chars > max_chars
                    or w["start"] - cur[-1]["end"] > gap or _TERMINAL.search(cur[-1]["text"])):
                groups.append(cur)
                cur = []
        cur.append(w)
    if cur:
        groups.append(cur)
    return groups


# --- ASS --------------------------------------------------------------------

def ass_color(hex_rgb, alpha=0):
    """#RRGGBB → ASS &HAABBGGRR."""
    h = hex_rgb.lstrip("#")
    r, g, b = h[0:2], h[2:4], h[4:6]
    return f"&H{alpha:02X}{b}{g}{r}".upper()


def ass_time(seconds):
    cs = max(0, int(round(seconds * 100)))
    h, cs = divmod(cs, 360000)
    m, cs = divmod(cs, 6000)
    s, cs = divmod(cs, 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def _header(p):
    bold = -1 if p["bold"] else 0
    style = (
        f"Style: Caption,{p['font']},{p['size']},{ass_color(p['primary'])},{ass_color(p['highlight'])},"
        f"{ass_color(p['outline_color'])},{ass_color('#000000', 0x80)},{bold},0,0,0,100,100,"
        f"{p['spacing']},0,1,{p['outline']},{p['shadow']},2,60,60,{p['margin_v']},1"
    )
    return "\n".join([
        "[Script Info]",
        "ScriptType: v4.00+",
        f"PlayResX: {PLAY_RES[0]}",
        f"PlayResY: {PLAY_RES[1]}",
        "WrapStyle: 0",
        "ScaledBorderAndShadow: yes",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
        "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, "
        "Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        style,
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ])


def build_ass(words, preset=DEFAULT_PRESET):
    """Full ASS document: each group stays on screen while its words play, the
    word being spoken is drawn in the highlight colour."""
    p = get_preset(preset) if isinstance(preset, str) else preset
    hl = ass_color(p["highlight"])
    case = (lambda s: s.upper()) if p["uppercase"] else (lambda s: s)
    events = []
    for group in group_words(words, p["max_words"], p["max_chars"], p["gap"]):
        for i, w in enumerate(group):
            start = w["start"]
            end = group[i + 1]["start"] if i + 1 < len(group) else min(w["end"], start + MAX_WORD_HOLD_SEC)
            text = " ".join(
                f"{{\\c{hl}}}{case(x['text'])}{{\\r}}" if j == i else case(x["text"])
                for j, x in enumerate(group)
            )
            events.append([start, max(end, start + MIN_EVENT_SEC), text])
    # The minimum hold must never run into the next event: libass stacks
    # overlapping events, which showed the caption line twice.
    for ev, nxt in zip(events, events[1:]):
        ev[1] = min(ev[1], nxt[0])
    lines = [_header(p)]
    lines += [f"Dialogue: 0,{ass_time(s)},{ass_time(e)},Caption,,0,0,0,,{t}"
              for s, e, t in events if round(e * 100) > round(s * 100)]   # drop events < 1 cs
    return "\n".join(lines) + "\n"


def ffmpeg_filter_path(path):
    """Quote a file path for use inside an ffmpeg filter argument
    (``ass='…'``): forward slashes, escaped drive colon and quotes."""
    p = str(path).replace("\\", "/").replace(":", "\\:").replace("'", "\\'")
    return f"'{p}'"


# --- silence trimming ---------------------------------------------------------

def keep_intervals(words, duration, min_gap=0.6, pad=0.15):
    """Spans of speech to keep (clip-relative), cutting pauses longer than
    ``min_gap`` (and leading/trailing silence). ``pad`` keeps a little air
    around each span so cuts don't clip syllables. Returns
    ``[(0, duration)]`` when there is nothing worth cutting."""
    full = [(0.0, round(duration, 3))]
    if not words or duration <= 0:
        return full
    spans = []
    span_start, span_end = words[0]["start"], words[0]["end"]
    for w in words[1:]:
        if w["start"] - span_end > min_gap:
            spans.append((span_start, span_end))
            span_start = w["start"]
        span_end = max(span_end, w["end"])
    spans.append((span_start, span_end))

    merged = []
    for a, b in spans:
        a, b = max(0.0, a - pad), min(duration, b + pad)
        if merged and a <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], b))
        else:
            merged.append((a, b))
    kept = sum(b - a for a, b in merged)
    if kept >= duration - 0.05:
        return full
    return [(round(a, 3), round(b, 3)) for a, b in merged]


def select_expr(intervals):
    """ffmpeg select/aselect expression keeping only ``intervals``."""
    return "+".join(f"between(t,{a:.3f},{b:.3f})" for a, b in intervals)


# --- timelines (silence trim + hook-first) ---------------------------------------
# A timeline is the ordered list of clip-relative source ranges that make up
# the output. Silence trim yields monotonic ranges; hook-first prepends the
# clip's strongest line, so the list can jump backwards. render.py cuts the
# video from it and subtitle.py maps caption words through the same list.

HOOK_MIN_SEC = 1.2
HOOK_MAX_SEC = 6.0
HOOK_MIN_SCORE = 0.7
HOOK_SKIP_LEAD_SEC = 3.0   # a hook already in the first seconds needs no replay


def sentences(words, gap=0.6):
    """Split words into sentences at terminal punctuation or pauses."""
    out, cur = [], []
    for w in words:
        if cur and (w["start"] - cur[-1]["end"] > gap or _TERMINAL.search(cur[-1]["text"])):
            out.append(cur)
            cur = []
        cur.append(w)
    if cur:
        out.append(cur)
    return out


def find_hook(words, duration, scorer=None):
    """The clip's strongest stand-alone line as a (start, end) range, or None.

    Candidates are sentences of 1.2–6 s that start after the opening
    seconds; the best one by ``features.text.score_hook_strength`` wins if it
    scores at least 0.7 (a question or a hook phrase).
    """
    if scorer is None:
        from features.text import score_hook_strength as scorer
    best = None
    for sent in sentences(words):
        start, end = sent[0]["start"], sent[-1]["end"]
        if start < HOOK_SKIP_LEAD_SEC or not (HOOK_MIN_SEC <= end - start <= HOOK_MAX_SEC):
            continue
        score = scorer(" ".join(w["text"] for w in sent))
        if score >= HOOK_MIN_SCORE and (best is None or score > best[0]):
            best = (score, start, end)
    if best is None:
        return None
    return (round(max(0.0, best[1] - 0.1), 3), round(min(duration, best[2] + 0.15), 3))


def seg_hook(seg):
    """The hook the backend chose for this clip (absolute ``hookStart`` /
    ``hookEnd`` on the segment: the LLM's line or the rules') as a
    clip-relative range to replay.

    False when the backend decided there is none (null), or sent one that
    can't be replayed (inside the opening seconds, outside the clip, longer
    than a hook). None only for segments files without the keys (written
    before the backend chose hooks): then find_hook picks here.
    """
    if "hookStart" not in seg:
        return None
    a, b = seg.get("hookStart"), seg.get("hookEnd")
    if not isinstance(a, (int, float)) or not isinstance(b, (int, float)):
        return False
    start = seg["startTime"]
    duration = seg["endTime"] - start
    a, b = a - start, b - start
    if a < HOOK_SKIP_LEAD_SEC or b > duration + 0.05 or not (0.5 <= b - a <= HOOK_MAX_SEC + 0.5):
        return False
    return (round(max(0.0, a - 0.1), 3), round(min(duration, b + 0.15), 3))


def plan_timeline(words, duration, silence_trim=False, silence_gap=0.6, hook_first=False, scorer=None, hook=None):
    """Ordered source ranges for the output clip. ``hook``: a range from
    seg_hook() to replay, False for no replay, None to let the rules pick."""
    timeline = keep_intervals(words, duration, min_gap=silence_gap) if silence_trim else [(0.0, round(duration, 3))]
    if hook_first:
        if hook is None:
            hook = find_hook(words, duration, scorer)
        if hook:
            timeline = [hook] + timeline
    return timeline


def is_monotonic(timeline):
    return all(timeline[i][0] >= timeline[i - 1][1] for i in range(1, len(timeline)))


def timeline_duration(timeline):
    return round(sum(b - a for a, b in timeline), 3)


def map_words(words, timeline):
    """Words placed on the output timeline. A word inside a cut is dropped; a
    word inside the replayed hook appears twice (hook, then in place)."""
    out, offset = [], 0.0
    for a, b in timeline:
        for w in words:
            if w["end"] > a and w["start"] < b:
                start = max(w["start"], a) - a + offset
                end = max(min(w["end"], b) - a + offset, start + MIN_WORD_SEC)
                out.append({**w, "start": round(start, 3), "end": round(end, 3)})
        offset += b - a
    return out


def clip_words(transcript_segments, seg, silence_trim=False, silence_gap=0.6, hook_first=False):
    """Clip words on the output timeline: the same timeline (silence trim,
    hook replay) render.py cuts the video to, so captions line up."""
    words = words_for_clip(transcript_segments, seg["startTime"], seg["endTime"])
    if silence_trim or hook_first:
        duration = seg["endTime"] - seg["startTime"]
        words = map_words(words, plan_timeline(words, duration, silence_trim, silence_gap, hook_first, hook=seg_hook(seg)))
    return words


# --- encoding ------------------------------------------------------------------

# Background music: looped under the clip and ducked whenever the voice is
# present (sidechain compression keyed on the speech), then mixed in.
DUCK = "sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400"


def x264_preset():
    """libx264 preset for the CPU encode (X264_PRESET). ``veryfast``: on a
    1080x1920 clip it encoded ~2x faster than ``fast`` at almost the same
    quality (0.4 dB PSNR); for social uploads that re-encode anyway."""
    return os.environ.get("X264_PRESET", "").strip() or "veryfast"


def music_graph(voice, bgm_volume, out="[aout]"):
    """Filter-graph parts that mix input 1 (looped music) under ``voice``."""
    return [f"{voice}asplit=2[voice][sc]", f"[1:a]volume={bgm_volume:.3f}[bg]",
            f"[bg][sc]{DUCK}[duck]", f"[voice][duck]amix=inputs=2:duration=first:normalize=0{out}"]


def concat_graph(timeline, out_video="[cv]", out_audio="[ca]"):
    """filter_complex that cuts ``timeline`` from input 0 and concatenates it."""
    parts, labels = [], ""
    for i, (a, b) in enumerate(timeline):
        parts.append(f"[0:v]trim=start={a:.3f}:end={b:.3f},setpts=PTS-STARTPTS[v{i}]")
        parts.append(f"[0:a]atrim=start={a:.3f}:end={b:.3f},asetpts=PTS-STARTPTS[a{i}]")
        labels += f"[v{i}][a{i}]"
    parts.append(f"{labels}concat=n={len(timeline)}:v=1:a=1{out_video}{out_audio}")
    return ";".join(parts)


# --- CLI: words for the caption editor ---------------------------------------------

def main(argv=None):
    """Absolute-time words for [--start, --end] — what the clip editor shows."""
    import argparse
    import json
    import sys

    parser = argparse.ArgumentParser(description="Caption words for a clip range")
    parser.add_argument("--transcript", required=True)
    parser.add_argument("--start", type=float, required=True)
    parser.add_argument("--end", type=float, required=True)
    args = parser.parse_args(argv)
    try:
        with open(args.transcript, "r", encoding="utf-8") as f:
            segments = json.load(f).get("segments", [])
        words = [{**w, "start": round(w["start"] + args.start, 3), "end": round(w["end"] + args.start, 3)}
                 for w in words_for_clip(segments, args.start, args.end)]
        print(json.dumps({"success": True, "data": {"words": words}}, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}, ensure_ascii=False))
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
