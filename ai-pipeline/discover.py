#!/usr/bin/env python3
"""YouTube video discovery via yt-dlp — search, trending, channel monitoring, enrichment.

Discovery modes:
- ``search`` / ``trending`` / ``channel``: yt-dlp metadata lookup with a cheap
  title+duration+velocity heuristic (``quick_relevance_score``).
- ``enrich``: given one video's URL + metadata, pull YouTube auto-captions and
  re-use the pipeline's ``features.text`` scorer on a transcript sample to
  produce a ``predictedScore`` — the real "how clippable is this?" signal.
"""

import argparse
import json
import subprocess
import sys
import os
import re
import glob
import tempfile
import shutil
from datetime import datetime, timezone


KEYWORDS = [
    "rahasia", "penting", "tidak banyak orang tahu", "kesalahan", "ternyata",
    "wajib", "harus", "jangan", "bahaya", "untung", "sayangnya", "fakta",
    "curhat", "jebakan", "trik", "hack", "tip", "solusi",
    "bohong", "benar", "buktinya", "nyata", "gue", "lu", "lo",
    "banget", "parah", "gila", "serius", "beneran",
    "unik", "aneh", "langka", "jarang", "mustahil",
    "mengubah", "menginspirasi", "membuktikan", "membongkar",
    "viral", "heboh", "kontroversi", "skandal", "terbaru", "update",
    "kocak", "lucu", "ngakak", "bikin kaget", "bikin nangis",
    "motivasi", "inspirasi", "kehidupan", "sukses", "gagal",
]

SEARCH_QUERIES = {
    "viral_id": [
        "viral indonesia terbaru",
        "heboh indonesia",
        "rahasia penting indonesia",
        "fakta mengejutkan indonesia",
        "tips trik indonesia viral",
        "kisah inspiratif indonesia",
        "kontroversi indonesia",
        "curhat viral indonesia",
    ],
    # Secondary source for trending: niche content types we can clip. Used to
    # supplement hashtag feeds, not replace them.
    "trending_niche_id": [
        "streamer indonesia viral moments",
        "podcast indonesia bahas viral",
        "influencer indonesia drama viral",
    ],
}

# Real Indonesian trending signal: YouTube's own hashtag feeds. Curated for
# viral-clipper fit — breaking news + celebrity + drama + reactions are the
# categories that actually produce clippable hooks. Ordered roughly by how
# often they surface new content.
TRENDING_HASHTAGS_ID = [
    "viralindonesia",
    "viral",
    "beritaviral",
    "terbaru",
    "fyp",
]


# Titles that almost always mark re-clipped / compilation content rather than
# original source material. Filtered out before scoring so a "Best of X Clips"
# video can't rank above the original 2-hour X podcast it was cut from.
CLIP_SOURCE_KEYWORDS = re.compile(
    r"\b(clips?|klip|potongan|highlight|highlights?|"
    r"best\s*of|compilation|moments?|cuplikan|rangkuman|"
    r"funniest|top\s*\d+|react(?:ion|ions)?|"
    r"full\s*episode\s*(?:below|di\s*bawah))\b",
    re.IGNORECASE,
)


# Content-type heuristics. Kept regex-based (no ML) — v0 is only expected to
# get ~80% right and feed the channel-trust EMA; real content-type labeling
# is Phase 4 (supervised) scope.
_PODCAST_RE = re.compile(
    r"\b(podcast|ep\.?\s*\d|episode\s*\d|close\s*the\s*door|curhat\s*bang|"
    r"ngobrol(?:in)?|bocor\s*alus|vindes|deddy\s*corbuzier)\b",
    re.IGNORECASE,
)
_TALKSHOW_RE = re.compile(
    r"\b(mata\s*najwa|rossy|hotman|talk\s*show|bincang(?:[-\s]*bincang)?)\b",
    re.IGNORECASE,
)
_STANDUP_RE = re.compile(
    r"\b(stand[-\s]*up|standup|open\s*mic|comedy\s*special|majelis\s*lucu|"
    r"\bmli\b|\bsui\b)\b",
    re.IGNORECASE,
)
_LIVESTREAM_RE = re.compile(
    r"\b(live(?:\s*streaming)?|livestream|\bstream\b|\bvod\b|playthrough|gameplay)\b",
    re.IGNORECASE,
)
_NEWS_RE = re.compile(
    r"\b(debat|debate|politik|pemilu|berita\s*debat|news\s*debate)\b",
    re.IGNORECASE,
)
# Added after real discovery runs labeled every result OTHER: horror /
# storytelling series, gadget reviews and news clips are what searches return.
_STORY_RE = re.compile(
    r"\b(cerita|kisah|horor|horror|misteri|mistis|seram|angker|creepy|khw|malam\s*jumat)\b",
    re.IGNORECASE,
)
_REVIEW_RE = re.compile(
    r"\b(review|unboxing|rekomendasi|cobain|nyobain|bedah|hands[-\s]*on)\b",
    re.IGNORECASE,
)
_NEWS_WORDS_RE = re.compile(
    r"\b(berita|terkini|breaking|kronologi|dugaan|sidang|kasus)\b",
    re.IGNORECASE,
)
_GAMING_RE = re.compile(
    r"\b(gameplay|mabar|mobile\s*legends|minecraft|roblox|free\s*fire|valorant|pubg|playthrough)\b",
    re.IGNORECASE,
)


def duration_fit_score(duration_sec):
    """Clipper-source duration fit curve, inverted from the pre-v2 default.

    Clippers harvest long-form, speech-dense source material (1–3 hr podcasts,
    30–90 min talk shows, livestream VODs). The previous curve peaked at
    3–15 min and zeroed >30 min — which rewarded already-cut compilations and
    penalized the actual source content. This curve is the fix.
    """
    d = int(duration_sec or 0)
    if d < 5 * 60:
        return 0.0      # too short — already a clip or a Short
    if d < 10 * 60:
        return 0.15     # borderline; often a clip-of-a-clip
    if d < 15 * 60:
        return 0.40
    if d < 30 * 60:
        return 0.70     # short podcast / news segment — decent
    if d <= 180 * 60:
        return 1.00     # sweet spot: 30–180 min talk / podcast / stand-up
    return 1.00         # >3hr = livestream VOD, still prime source


def looks_already_clipped(title, description=""):
    """Heuristic pre-filter: title/description matches a clip/compilation pattern."""
    if not title:
        return False
    haystack = f"{title} {description or ''}"
    return bool(CLIP_SOURCE_KEYWORDS.search(haystack))


def classify_content_type(title, channel_name="", duration_sec=0, description=""):
    """Regex-based v0 classifier.

    Returns one of PODCAST / TALKSHOW / STANDUP / LIVESTREAM / NEWS /
    STORYTELLING / REVIEW / GAMING / OTHER.
    Order matters — first matching rule wins. Most duration thresholds exist
    to avoid mis-labeling a 3-min clip that happens to mention "podcast".
    """
    hay = f"{(title or '').lower()} {(channel_name or '').lower()}"
    d = int(duration_sec or 0)

    if _TALKSHOW_RE.search(hay):
        return "TALKSHOW"
    if _STANDUP_RE.search(hay):
        return "STANDUP"
    if d >= 60 * 60 and _PODCAST_RE.search(hay):
        return "PODCAST"
    if d >= 30 * 60 and _PODCAST_RE.search(hay):
        return "PODCAST"
    if d >= 120 * 60 and _LIVESTREAM_RE.search(hay):
        return "LIVESTREAM"
    if d >= 30 * 60 and _NEWS_RE.search(hay):
        return "NEWS"
    if d >= 10 * 60 and _STORY_RE.search(hay):
        return "STORYTELLING"
    if d >= 10 * 60 and _GAMING_RE.search(hay):
        return "GAMING"
    if _REVIEW_RE.search(hay):
        return "REVIEW"
    if _NEWS_WORDS_RE.search(hay):
        return "NEWS"
    return "OTHER"


def run_ytdlp(args, ytdlp_path="yt-dlp", timeout=120):
    cmd = [ytdlp_path] + args + ["--no-warnings", "--no-check-certificates"]
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout,
        )
        return result.stdout, result.stderr, result.returncode
    except subprocess.TimeoutExpired:
        return "", "Timeout", 1
    except FileNotFoundError:
        return "", f"yt-dlp not found at {ytdlp_path}", 1


def parse_duration(duration_str):
    if not duration_str:
        return 0
    if isinstance(duration_str, (int, float)):
        return int(duration_str)
    parts = str(duration_str).split(":")
    try:
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
        elif len(parts) == 2:
            return int(parts[0]) * 60 + int(parts[1])
        return int(parts[0])
    except (ValueError, IndexError):
        return 0


def extract_video_id(url):
    patterns = [
        r"(?:v=|/v/|youtu\.be/)([a-zA-Z0-9_-]{11})",
        r"/shorts/([a-zA-Z0-9_-]{11})",
    ]
    for pattern in patterns:
        match = re.search(pattern, url)
        if match:
            return match.group(1)
    return None


def quick_relevance_score(video_meta, keywords=None):
    if keywords is None:
        keywords = KEYWORDS

    score = 0.0
    title = (video_meta.get("title") or "").lower()
    desc = (video_meta.get("description") or "").lower()
    duration = video_meta.get("duration", 0)

    title_hits = sum(1 for kw in keywords if kw in title)
    max_title = max(len(keywords) * 0.15, 1)
    score += min(title_hits / max_title, 1.0) * 0.40

    # Long-form source material > already-clipped compilation. See
    # duration_fit_score docstring for the full curve rationale.
    score += duration_fit_score(duration) * 0.25

    view_count = video_meta.get("viewCount") or video_meta.get("view_count") or 0
    age_hours = video_meta.get("age_hours", 99999)
    if isinstance(age_hours, (int, float)) and age_hours < 720 and view_count > 0:
        vph = view_count / max(age_hours, 1)
        if vph > 1000:
            score += 0.20
        elif vph > 100:
            score += 0.10

    desc_hits = sum(1 for kw in keywords if kw in desc)
    max_desc = max(len(keywords) * 0.1, 1)
    score += min(desc_hits / max_desc, 1.0) * 0.15

    return round(min(score, 1.0), 4)


def normalize_video(entry):
    url = entry.get("url") or entry.get("webpage_url") or ""
    if not url and entry.get("id"):
        url = f"https://www.youtube.com/watch?v={entry['id']}"

    duration = entry.get("duration")
    if duration is None:
        duration = parse_duration(entry.get("duration_string", ""))

    view_count = entry.get("view_count") or entry.get("viewCount")
    if isinstance(view_count, str):
        try:
            view_count = int(view_count.replace(",", ""))
        except ValueError:
            view_count = None

    upload_date = entry.get("upload_date") or ""
    # 99999 = "unknown age" sentinel (beyond any realistic filter threshold).
    # --flat-playlist strips upload_date on most channel/hashtag feeds; in those
    # cases a row whose real age is 6 years old would show as 99999 rather than
    # masquerade as 999 hours (~41 days) and sneak past the recency filter.
    age_hours = 99999
    if upload_date and len(upload_date) >= 8:
        try:
            upload_dt = datetime.strptime(upload_date[:8], "%Y%m%d").replace(
                tzinfo=timezone.utc
            )
            age_hours = (datetime.now(timezone.utc) - upload_dt).total_seconds() / 3600
        except ValueError:
            pass

    channel = entry.get("channel") or entry.get("uploader") or ""
    channel_id = entry.get("channel_id") or entry.get("uploader_id") or ""
    title = entry.get("title", "")
    description = (entry.get("description") or "")[:500]
    dur_int = int(duration) if duration else 0

    return {
        "videoId": extract_video_id(url) or entry.get("id", ""),
        "title": title,
        "url": url,
        "duration": dur_int,
        "channel": channel,
        "channelId": channel_id,
        "viewCount": view_count,
        "uploadDate": upload_date,
        "age_hours": round(age_hours, 1),
        "description": description,
        "contentType": classify_content_type(title, channel, dur_int, description),
        "isLikelyClipped": looks_already_clipped(title, description),
    }


def discover_search(query, max_results=20, ytdlp_path="yt-dlp", min_duration=0, max_duration=0,
                    dateafter=None, recent_only=False, max_age_days=90, timeout=180,
                    exclude_shorts=True):
    """Search yt-dlp for videos matching ``query``.

    When ``recent_only=True`` or ``max_age_days>0``, drop ``--flat-playlist``
    so yt-dlp returns full metadata (upload_date, view_count, duration). Flat
    mode strips those, which is why pre-fix trending surfaced 6-year-old
    videos: ``age_hours`` defaulted to 999 and the velocity filter ignored it.
    Also use ``ytsearchdate`` (YouTube sort-by-date) and ``--match-filters``
    to push the age cutoff to the server so we don't pay for stale results.
    """
    # Note: yt-dlp's `ytsearchdate:` prefix isn't available in all versions
    # (absent in 2026.03.17) — we rely on YouTube's own recency bias plus
    # --match-filters for a hard server-side cutoff.
    search_term = f"ytsearch{max_results}:{query}"

    args = [search_term, "--dump-json", "--skip-download"]
    if recent_only or max_age_days:
        # Full metadata mode — ~2-3x slower but upload_date is populated.
        # Without this, --flat-playlist strips upload_date and age_hours
        # defaults to 999, which means the "is this recent?" filter is a no-op
        # and trending returns 6-year-old videos with viral-y titles.
        days = max_age_days or 30
        args += ["--match-filters", f"upload_date >=(today-{days}days)"]
    else:
        args.append("--flat-playlist")
    if dateafter:
        args += ["--dateafter", dateafter]

    stdout, stderr, rc = run_ytdlp(args, ytdlp_path=ytdlp_path, timeout=timeout)
    if rc != 0:
        raise RuntimeError(f"yt-dlp search failed: {stderr}")

    videos = []
    for line in stdout.strip().split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
            vid = normalize_video(entry)
            if exclude_shorts and is_short(vid):
                continue
            if vid.get("isLikelyClipped"):
                continue
            if min_duration and vid["duration"] < min_duration:
                continue
            if max_duration and vid["duration"] > max_duration:
                continue
            # Belt-and-suspenders age filter in case yt-dlp returned something
            # the --match-filters missed (e.g. missing upload_date).
            if max_age_days and vid.get("age_hours", 9999) > max_age_days * 24:
                continue
            vid["relevanceScore"] = quick_relevance_score(vid)
            videos.append(vid)
        except json.JSONDecodeError:
            continue

    videos.sort(key=lambda v: v["relevanceScore"], reverse=True)
    return videos


def is_short(entry_or_vid):
    """Detect a YouTube Short by URL pattern or duration.

    Shorts are already clipped content — not useful as a clipping source. We
    filter by two signals: the ``/shorts/`` URL fragment (unambiguous) and
    duration ≤ 60s (the YouTube Short cap). Either one is enough.
    """
    url = entry_or_vid.get("url") or entry_or_vid.get("webpage_url") or ""
    if "/shorts/" in url:
        return True
    dur = entry_or_vid.get("duration") or 0
    try:
        dur = int(dur)
    except (TypeError, ValueError):
        dur = 0
    return 0 < dur <= 60


def discover_hashtag(hashtag, max_results=10, ytdlp_path="yt-dlp",
                     min_duration=0, max_duration=0, max_age_days=30, timeout=120,
                     exclude_shorts=True):
    """Fetch a YouTube hashtag feed (e.g. ``#viralindonesia``).

    YouTube deprecated ``/feed/trending`` in late 2024 — hashtag feeds are the
    closest thing to a real trending signal yt-dlp can access without an API
    key. Each feed is YouTube's own ranking of videos under that tag.
    """
    url = f"https://www.youtube.com/hashtag/{hashtag}"
    args = [
        url, "--dump-json", "--skip-download",
        "--playlist-end", str(max_results),
        "--match-filters", f"upload_date >=(today-{max_age_days}days)",
        "--no-warnings",
    ]
    stdout, stderr, rc = run_ytdlp(args, ytdlp_path=ytdlp_path, timeout=timeout)
    if rc != 0:
        raise RuntimeError(f"yt-dlp hashtag fetch failed: {stderr}")

    videos = []
    for line in stdout.strip().split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
            vid = normalize_video(entry)
            if exclude_shorts and is_short(vid):
                continue
            if vid.get("isLikelyClipped"):
                continue
            if min_duration and vid["duration"] < min_duration:
                continue
            if max_duration and vid["duration"] > max_duration:
                continue
            # Belt-and-suspenders age filter — --match-filters on playlists
            # with --skip-download sometimes lets older entries through.
            if max_age_days and vid.get("age_hours", 9999) > max_age_days * 24:
                continue
            vid["relevanceScore"] = quick_relevance_score(vid)
            videos.append(vid)
        except json.JSONDecodeError:
            continue
    return videos


def discover_trending(max_results=20, ytdlp_path="yt-dlp", region="ID",
                      max_age_days=45, min_duration=5 * 60, max_duration=0):
    """Pull from YouTube hashtag feeds (real trending) + a small niche-search
    supplement.

    v2 note: the old 90s–1800s cap excluded the long-form podcasts/talk shows
    we actually want. We now floor at 5 min (enough to exclude Shorts + most
    already-cut TikTok reposts) and lift the upper cap — ``looks_already_clipped``
    plus the inverted duration curve do the filtering that the hard caps used
    to do.

    Hashtag feeds are kept for backward compat with the existing controller
    endpoint but are no longer a primary discovery source in v2.
    """
    seen = set()
    all_videos = []

    # Phase 1 — hashtag feeds in parallel. Non-flat yt-dlp is ~4s per video,
    # and each hashtag pulls 12+ videos for filtering headroom; sequential
    # would be ~4 minutes. ThreadPoolExecutor brings it down to ~50s.
    from concurrent.futures import ThreadPoolExecutor, as_completed
    per_tag = max(max_results * 2, 12)

    def fetch(tag):
        try:
            return tag, discover_hashtag(
                tag, per_tag, ytdlp_path,
                min_duration=min_duration, max_duration=max_duration,
                max_age_days=max_age_days, timeout=90,
            )
        except RuntimeError:
            return tag, []

    with ThreadPoolExecutor(max_workers=len(TRENDING_HASHTAGS_ID)) as pool:
        futures = [pool.submit(fetch, t) for t in TRENDING_HASHTAGS_ID]
        for fut in as_completed(futures):
            tag, batch = fut.result()
            for v in batch:
                if v["videoId"] not in seen:
                    seen.add(v["videoId"])
                    v["sourceHashtag"] = tag
                    all_videos.append(v)

    # Phase 2 — niche searches that hashtag feeds typically miss (podcasts,
    # streamer clips). Capped at a few per query so it doesn't dominate.
    for q in SEARCH_QUERIES.get("trending_niche_id", []):
        try:
            batch = discover_search(
                q, 3, ytdlp_path,
                recent_only=True, max_age_days=max_age_days,
                min_duration=min_duration, max_duration=max_duration,
                timeout=90,
            )
            for v in batch:
                if v["videoId"] not in seen:
                    seen.add(v["videoId"])
                    all_videos.append(v)
        except RuntimeError:
            continue

    all_videos.sort(key=lambda v: v["relevanceScore"], reverse=True)
    return all_videos[:max_results]


def discover_channel(channel_url, max_results=20, ytdlp_path="yt-dlp", min_duration=0, max_duration=0,
                     exclude_shorts=True, max_age_days=90):
    """Fetch a channel's recent uploads.

    Uses ``--flat-playlist`` (fast, strips upload_date on channel feeds). To
    enforce ``max_age_days``, we also apply a Python-side filter via
    ``age_hours`` which ``normalize_video`` computes when present — and pull
    more than ``max_results`` initially so after age filtering we still have
    enough rows.
    """
    videos_url = channel_url.rstrip("/") + "/videos"
    fetch_count = max_results * 3 if max_age_days else max_results
    args_tail = ["--flat-playlist", "--dump-json", "--skip-download", "--playlist-end", str(fetch_count)]
    stdout, stderr, rc = run_ytdlp(
        [videos_url] + args_tail, ytdlp_path=ytdlp_path, timeout=180,
    )
    if rc != 0:
        stdout2, stderr2, rc2 = run_ytdlp(
            [channel_url] + args_tail, ytdlp_path=ytdlp_path, timeout=180,
        )
        if rc2 != 0:
            raise RuntimeError(f"yt-dlp channel failed: {stderr2}")
        stdout = stdout2

    videos = []
    for line in stdout.strip().split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
            vid = normalize_video(entry)
            if exclude_shorts and is_short(vid):
                continue
            if vid.get("isLikelyClipped"):
                continue
            if min_duration and vid["duration"] < min_duration:
                continue
            if max_duration and vid["duration"] > max_duration:
                continue
            # Age filter. Flat-playlist strips upload_date for most channel
            # entries, so age_hours is the 99999 unknown sentinel. Only reject
            # rows where we KNOW the age is beyond the cutoff — missing dates
            # are let through rather than silently discarded.
            if max_age_days:
                age_h = vid.get("age_hours", 9999)
                if isinstance(age_h, (int, float)) and age_h < 9999 and age_h > max_age_days * 24:
                    continue
            vid["relevanceScore"] = quick_relevance_score(vid)
            videos.append(vid)
        except json.JSONDecodeError:
            continue

    videos.sort(key=lambda v: v["relevanceScore"], reverse=True)
    return videos[:max_results]


# Clip-sized windows scored across the whole video. The old enrichment scored
# the first 2000 caption characters — on a 1-hour podcast that is the greeting
# and the intro, never the moments that get clipped.
WINDOW_SEC = 45
TOP_MOMENTS = 5
# A window at or above this is a "strong moment": about the top 10% of
# 45 s windows on real Indonesian podcasts / storytelling videos (p90 ≈ 0.54).
STRONG_MOMENT = 0.55

_CUE_RE = re.compile(r"^(?:(\d+):)?(\d{1,2}):(\d{2})\.(\d{1,3})\s+-->")


def fetch_caption_lines(video_url, ytdlp_path="yt-dlp", lang="id"):
    """YouTube captions (uploaded or auto) as ``[(start_sec, text), ...]``.

    ``--skip-download``: only the caption file is fetched. Tries the requested
    language, then English, then anything. ``[]`` when the video has none.
    """
    tmp = tempfile.mkdtemp(prefix="yt_subs_")
    try:
        outtmpl = os.path.join(tmp, "%(id)s.%(ext)s")
        for sub_lang in (lang, "en", "*"):
            args = [
                video_url,
                "--skip-download",
                "--write-auto-subs",
                "--write-subs",
                "--sub-lang", sub_lang,
                "--sub-format", "vtt",
                "-o", outtmpl,
                "--no-warnings",
            ]
            run_ytdlp(args, ytdlp_path=ytdlp_path, timeout=90)
            vtts = glob.glob(os.path.join(tmp, "*.vtt"))
            if vtts:
                return parse_vtt_lines(vtts[0])
        return []
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def parse_vtt_lines(vtt_path):
    """Spoken lines with their start time from a VTT file.

    YouTube auto-captions roll: every phrase appears in two cues, and only the
    line carrying inline word timings (``<c>`` tags) is new speech. Uploaded
    captions have no such tags; there adjacent repeats are collapsed.
    """
    try:
        with open(vtt_path, "r", encoding="utf-8", errors="ignore") as f:
            raw = f.read()
    except OSError:
        return []
    cues = []
    for block in raw.replace("\r", "").split("\n\n"):
        rows = block.strip("\n").split("\n")
        for i, row in enumerate(rows):
            m = _CUE_RE.match(row.strip())
            if m:
                h, mi, sec, frac = m.groups()
                t = int(h or 0) * 3600 + int(mi) * 60 + int(sec) + int(frac.ljust(3, "0")) / 1000
                cues.append((t, rows[i + 1:]))
                break
    rolling = any("<c>" in row for _, rows in cues for row in rows)
    lines, last = [], None
    for t, rows in cues:
        for row in rows:
            if rolling and "<c>" not in row:
                continue
            text = re.sub(r"<[^>]+>", "", row).strip()
            if text and text != last:
                lines.append((round(t, 2), text))
                last = text
    return lines


def caption_windows(lines, window=WINDOW_SEC):
    """Group lines into consecutive ~``window``-second windows: ``[(start, text), ...]``."""
    windows = []
    for t, text in lines:
        if not windows or t - windows[-1][0] >= window:
            windows.append([t, []])
        windows[-1][1].append(text)
    return [(start, " ".join(parts)) for start, parts in windows]


def window_score(text):
    """Text-only clip potential of one window (same rules as the clip scorer's text features)."""
    if not text or len(text) < 40:
        return 0.0
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from features import text as text_features  # type: ignore

        hook = text_features.score_hook_strength(text)
        keyword = text_features.score_keyword_trigger(text)
        novelty = text_features.score_novelty(text)
        sentiment = text_features.score_text_sentiment(text)
        return round(hook * 0.35 + keyword * 0.30 + novelty * 0.20 + abs(sentiment - 0.5) * 2 * 0.15, 4)
    except Exception:
        return 0.0


def analyze_captions(lines):
    """Score every clip-sized window of the video.

    Returns ``None`` without captions, else ``transcriptScore`` (mean of the
    best 5 windows), ``strongMoments`` (windows ≥ STRONG_MOMENT), the best
    ``topMoments`` with their start time, ``speechWpm`` (talk vs music /
    gameplay) and ``captionMinutes``.
    """
    if not lines:
        return None
    windows = [(start, text, window_score(text)) for start, text in caption_windows(lines)]
    best = sorted(windows, key=lambda w: w[2], reverse=True)[:TOP_MOMENTS]
    words = sum(len(text.split()) for _, text in lines)
    minutes = max((lines[-1][0] - lines[0][0]) / 60, 0)
    return {
        "transcriptScore": round(sum(w[2] for w in best) / len(best), 4),
        "strongMoments": sum(1 for w in windows if w[2] >= STRONG_MOMENT),
        "topMoments": [{"start": round(t), "score": sc, "text": text[:160]} for t, text, sc in best],
        "speechWpm": round(words / minutes) if minutes >= 1 else None,
        "captionMinutes": round(minutes, 1),
        "windows": len(windows),
    }


def speech_fit(wpm):
    """0 for music / gameplay with little talk (< 60 wpm), 1 for steady talk (≥ 110)."""
    if not wpm:
        return 0.0
    return round(min(max((wpm - 60) / 50, 0.0), 1.0), 3)


def velocity_score(view_count, age_hours):
    """Views per hour, log-scaled, for uploads younger than 30 days."""
    if age_hours and age_hours < 720 and view_count and view_count > 0:
        import math
        return min(math.log10(max(view_count / max(age_hours, 1), 1)) / 5.0, 1.0)
    return 0.0


def predict_score(analysis, duration=0, view_count=0, age_hours=9999):
    """Ranking score for a candidate (0-1). Hand-set weights — a heuristic, not a trained model.

    40% best-moments text score, 15% strong moments per 10 captioned minutes
    (2+ saturates), 10% speech density, 20% view velocity, 15% duration fit.
    Without captions only velocity and duration count.
    """
    transcript = moment_rate = speech = 0.0
    if analysis:
        transcript = analysis["transcriptScore"]
        per_10min = analysis["strongMoments"] / max(analysis["captionMinutes"] / 10, 1)
        moment_rate = min(per_10min / 2, 1.0)
        speech = speech_fit(analysis["speechWpm"])
    predicted = (transcript * 0.40 + moment_rate * 0.15 + speech * 0.10
                 + velocity_score(view_count, age_hours) * 0.20 + duration_fit_score(duration) * 0.15)
    return round(min(predicted, 1.0), 4)


def discover_enrich(video_url, duration=0, age_hours=9999, view_count=0, ytdlp_path="yt-dlp"):
    lines = fetch_caption_lines(video_url, ytdlp_path=ytdlp_path)
    analysis = analyze_captions(lines)
    out = {
        "predictedScore": predict_score(analysis, duration=duration, view_count=view_count, age_hours=age_hours),
        "transcriptScore": analysis["transcriptScore"] if analysis else 0.0,
        "hasCaptions": analysis is not None,
    }
    if analysis:
        out.update({
            "strongMoments": analysis["strongMoments"],
            "topMoments": analysis["topMoments"],
            "speechDensityWpm": analysis["speechWpm"],
            "captionMinutes": analysis["captionMinutes"],
            # The best moment, not the intro: what the UI shows as the sample.
            "transcriptSample": analysis["topMoments"][0]["text"],
        })
    return out


def main():
    parser = argparse.ArgumentParser(description="YouTube video discovery")
    parser.add_argument("--mode", required=True, choices=["search", "trending", "channel", "enrich"],
                        help="Discovery mode")
    parser.add_argument("--query", default="", help="Search query (for search mode)")
    parser.add_argument("--channel-url", default="", help="Channel URL (for channel mode)")
    parser.add_argument("--max-results", type=int, default=20, help="Max results to return")
    parser.add_argument("--min-duration", type=int, default=0, help="Min duration in seconds")
    parser.add_argument("--max-duration", type=int, default=0, help="Max duration in seconds (0=unlimited)")
    parser.add_argument("--region", default="ID", help="Region for trending (default: ID)")
    parser.add_argument("--ytdlp-path", default="yt-dlp", help="Path to yt-dlp binary")
    parser.add_argument("--video-url", default="", help="Video URL (for enrich mode)")
    parser.add_argument("--duration", type=int, default=0, help="Duration seconds (enrich mode)")
    parser.add_argument("--age-hours", type=float, default=9999, help="Age in hours (enrich mode)")
    parser.add_argument("--view-count", type=int, default=0, help="View count (enrich mode)")
    args = parser.parse_args()

    try:
        if args.mode == "search":
            if not args.query:
                raise ValueError("--query is required for search mode")
            videos = discover_search(
                args.query, args.max_results, args.ytdlp_path,
                args.min_duration, args.max_duration,
            )
        elif args.mode == "trending":
            videos = discover_trending(args.max_results, args.ytdlp_path, args.region)
        elif args.mode == "channel":
            if not args.channel_url:
                raise ValueError("--channel-url is required for channel mode")
            videos = discover_channel(
                args.channel_url, args.max_results, args.ytdlp_path,
                args.min_duration, args.max_duration,
            )
        elif args.mode == "enrich":
            if not args.video_url:
                raise ValueError("--video-url is required for enrich mode")
            enrich = discover_enrich(
                args.video_url, duration=args.duration,
                age_hours=args.age_hours, view_count=args.view_count,
                ytdlp_path=args.ytdlp_path,
            )
            output = {"success": True, "data": enrich}
            print(json.dumps(output, ensure_ascii=False))
            sys.exit(0)
        else:
            raise ValueError(f"Unknown mode: {args.mode}")

        result = {
            "mode": args.mode,
            "query": args.query,
            "count": len(videos),
            "videos": videos,
        }

        output = {"success": True, "data": result}
        print(json.dumps(output, ensure_ascii=False))
        sys.exit(0)

    except Exception as e:
        error_output = {"success": False, "error": str(e)}
        print(json.dumps(error_output, ensure_ascii=False), file=sys.stdout)
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
