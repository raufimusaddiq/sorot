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
    lines = [_header(p)]
    for group in group_words(words, p["max_words"], p["max_chars"], p["gap"]):
        for i, w in enumerate(group):
            start = w["start"]
            end = group[i + 1]["start"] if i + 1 < len(group) else min(w["end"], start + MAX_WORD_HOLD_SEC)
            end = max(end, start + MIN_EVENT_SEC)
            text = " ".join(
                f"{{\\c{hl}}}{case(x['text'])}{{\\r}}" if j == i else case(x["text"])
                for j, x in enumerate(group)
            )
            lines.append(f"Dialogue: 0,{ass_time(start)},{ass_time(end)},Caption,,0,0,0,,{text}")
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


def remap_time(t, intervals):
    """Position of source time ``t`` on the trimmed timeline. Times inside a
    cut snap to the start of the next kept span."""
    acc = 0.0
    for a, b in intervals:
        if t < a:
            return acc
        if t <= b:
            return acc + (t - a)
        acc += b - a
    return acc


def remap_words(words, intervals):
    out = []
    for w in words:
        start, end = remap_time(w["start"], intervals), remap_time(w["end"], intervals)
        if end - start < MIN_WORD_SEC:
            end = start + MIN_WORD_SEC
        out.append({**w, "start": round(start, 3), "end": round(end, 3)})
    return out


def select_expr(intervals):
    """ffmpeg select/aselect expression keeping only ``intervals``."""
    return "+".join(f"between(t,{a:.3f},{b:.3f})" for a, b in intervals)


def is_trimmed(intervals, duration):
    return not (len(intervals) == 1 and intervals[0][0] <= 0.001 and intervals[0][1] >= duration - 0.001)
