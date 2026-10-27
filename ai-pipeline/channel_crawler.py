#!/usr/bin/env python3
"""Channel-level discovery for Viral Clipper v2.

Two modes:

- ``category_seed`` — runs a hardcoded set of long-form content queries against
  YouTube and returns unique channels surfaced by the results. The queries
  anchor on the four source categories successful TikTok clippers actually
  harvest from (podcasts, talk shows, stand-up, livestream VODs).

- ``profile`` — given a channel URL, fetches the last N uploads' metadata and
  computes a profile: avg duration, median view count, uploads per week,
  subscriber count, clipper-farm heuristic, primary content category.

Both modes emit the project-standard JSON envelope (``{"success":..., "data":...}``)
on stdout and exit 0 / non-zero.

Designed to be cheap: uses ``yt-dlp --flat-playlist`` where possible (fast, no
per-video fetch) and only falls back to non-flat when we need ``upload_date``.
"""

import argparse
import json
import statistics
import subprocess
import sys
import os
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

# Reuse discover.py helpers so the two stay aligned. Discovery v2 shares the
# content-type classifier + clip-farm detection.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import discover  # noqa: E402


# The 12 long-form anchor queries. Each targets one of the four source
# categories clippers actually harvest from. Strings are intentionally
# Indonesian-heavy — this is a local-only Indonesian-content tool.
CATEGORY_SEED_QUERIES = [
    # Podcasts / interviews
    "podcast indonesia",
    "podcast full episode indonesia",
    "close the door deddy corbuzier",
    "curhat bang denny sumargo",
    # Talk shows / political debates
    "talk show indonesia",
    "mata najwa full",
    "rossy kompas tv",
    # Stand-up / comedy
    "stand up comedy indonesia special",
    "majelis lucu indonesia",
    # Long-form interviews / bincang
    "wawancara eksklusif",
    "bincang bincang podcast",
    # Livestream VODs (kept small — noisiest category)
    "live streaming indonesia full",
]


def _run_ytdlp(args, ytdlp_path="yt-dlp", timeout=120):
    """Thin wrapper matching ``discover.run_ytdlp`` return shape."""
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


# -- mode: category_seed -----------------------------------------------------

def _channels_from_query(query, per_query=15, ytdlp_path="yt-dlp", timeout=120):
    """Run one search query, return list of (youtube_channel_id, name, url) tuples.

    Uses ``--flat-playlist`` so we skip per-video metadata — we only need the
    channel id/name/url anchor. Profiling happens separately in ``--mode profile``.
    """
    search_term = f"ytsearch{per_query}:{query}"
    args = [search_term, "--dump-json", "--skip-download", "--flat-playlist"]
    stdout, stderr, rc = _run_ytdlp(args, ytdlp_path=ytdlp_path, timeout=timeout)
    if rc != 0:
        return []

    channels = []
    for line in stdout.strip().split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        ch_id = entry.get("channel_id") or entry.get("uploader_id") or ""
        ch_name = entry.get("channel") or entry.get("uploader") or ""
        if not ch_id or not ch_name:
            continue
        # Canonical channel URL. yt-dlp exposes channel_url on most entries;
        # fall back to /channel/<id> form.
        ch_url = entry.get("channel_url") or f"https://www.youtube.com/channel/{ch_id}"
        channels.append((ch_id, ch_name, ch_url, query))
    return channels


def discover_category_seed(queries=None, per_query=15, ytdlp_path="yt-dlp", parallel=6):
    """Run all category-seed queries in parallel, return deduped channels.

    Each channel record carries the ``discoveredViaQuery`` field so downstream
    trust/expansion code can tell which anchor query surfaced it.
    """
    if queries is None:
        queries = CATEGORY_SEED_QUERIES

    seen = {}  # channel_id -> dict

    def fetch(q):
        return q, _channels_from_query(q, per_query=per_query, ytdlp_path=ytdlp_path)

    with ThreadPoolExecutor(max_workers=min(parallel, len(queries))) as pool:
        for fut in as_completed([pool.submit(fetch, q) for q in queries]):
            _q, batch = fut.result()
            for ch_id, name, url, query in batch:
                if ch_id not in seen:
                    seen[ch_id] = {
                        "youtubeChannelId": ch_id,
                        "channelName": name,
                        "channelUrl": url,
                        "discoveredViaQuery": query,
                    }
    return list(seen.values())


# -- mode: profile -----------------------------------------------------------

CLIPPER_DURATION_CAP = 5 * 60   # treat <5 min as "Shorts-scale"
CLIPPER_THRESHOLD_RATIO = 0.70  # >70% of uploads short -> clipper channel


def _fetch_channel_uploads(channel_url, count=30, ytdlp_path="yt-dlp", timeout=180):
    """Pull metadata for the channel's most recent ``count`` uploads.

    Uses ``--flat-playlist`` so we skip per-video fetches — channel feeds with
    even one age-gated / private video would otherwise fail the whole batch.
    Flat mode still gives us title, duration (via duration_string), view_count,
    and channel info on most entries, which is everything profiling needs.
    ``--ignore-errors`` keeps yt-dlp going past individual bad entries.
    """
    tried = [channel_url.rstrip("/") + "/videos", channel_url.rstrip("/")]
    last_err = ""
    base_args = [
        "--dump-json", "--skip-download",
        "--flat-playlist", "--ignore-errors",
        "--playlist-end", str(count),
    ]
    for target in tried:
        stdout, stderr, rc = _run_ytdlp(
            [target] + base_args,
            ytdlp_path=ytdlp_path,
            timeout=timeout,
        )
        # --ignore-errors can produce rc=1 with partial stdout. Treat any
        # stdout as usable.
        if stdout.strip():
            uploads = []
            for line in stdout.strip().split("\n"):
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                uploads.append(discover.normalize_video(entry))
            if uploads:
                return uploads
        last_err = stderr
    raise RuntimeError(f"yt-dlp channel fetch failed: {last_err}")


def _classify_channel_category(uploads):
    """Pick the most common content type across the channel's uploads.

    Ties go to the first category alphabetically (stable). Channels with only
    OTHER classifications return 'MIXED' to avoid overconfident labeling.
    """
    if not uploads:
        return "MIXED"
    counts = {}
    for u in uploads:
        c = u.get("contentType") or "OTHER"
        counts[c] = counts.get(c, 0) + 1
    non_other = {k: v for k, v in counts.items() if k != "OTHER"}
    if not non_other:
        return "MIXED"
    # Primary = most common non-OTHER category with >=40% share.
    total = sum(counts.values())
    top_cat, top_count = max(sorted(non_other.items()), key=lambda kv: kv[1])
    if top_count / total >= 0.40:
        return top_cat
    return "MIXED"


def profile_channel(channel_url, count=30, ytdlp_path="yt-dlp"):
    """Compute a channel profile from its last ``count`` uploads.

    Returns a dict with the fields the ``discovery_channel`` table stores,
    plus diagnostic fields for logging. Duration / view count use median to
    resist outliers (viral spikes, channel trailer videos).
    """
    uploads = _fetch_channel_uploads(channel_url, count=count, ytdlp_path=ytdlp_path)
    if not uploads:
        return {
            "channelUrl": channel_url,
            "uploadsAnalyzed": 0,
            "avgDurationSec": 0,
            "medianViewCount": 0,
            "uploadsPerWeek": 0.0,
            "subscriberCount": 0,
            "isLikelyClipperChannel": 0,
            "clippedShareRatio": 0.0,
            "shortShareRatio": 0.0,
            "primaryCategory": "MIXED",
            "channelId": "",
            "channelName": "",
        }

    durations = [int(u.get("duration") or 0) for u in uploads]
    views = [int(u.get("viewCount") or 0) for u in uploads if u.get("viewCount")]

    avg_duration = int(sum(durations) / len(durations)) if durations else 0
    median_view = int(statistics.median(views)) if views else 0

    # uploads/week from age_hours on the first vs last upload we pulled.
    ages = [u.get("age_hours") for u in uploads if isinstance(u.get("age_hours"), (int, float)) and u["age_hours"] < 9999]
    uploads_per_week = 0.0
    if len(ages) >= 2:
        span_hours = max(ages) - min(ages)
        if span_hours > 0:
            uploads_per_week = round(len(ages) / (span_hours / 168.0), 3)

    # Clipper-channel heuristic: how many uploads are short or clip-flagged?
    short_count = sum(1 for d in durations if 0 < d < CLIPPER_DURATION_CAP)
    clipped_count = sum(1 for u in uploads if u.get("isLikelyClipped"))
    short_ratio = short_count / len(uploads)
    clipped_ratio = clipped_count / len(uploads)
    # If the majority of uploads are short OR title-flagged as clips, demote.
    is_clipper = 1 if max(short_ratio, clipped_ratio) >= CLIPPER_THRESHOLD_RATIO else 0

    return {
        "channelUrl": channel_url,
        "channelId": uploads[0].get("channelId", ""),
        "channelName": uploads[0].get("channel", ""),
        "uploadsAnalyzed": len(uploads),
        "avgDurationSec": avg_duration,
        "medianViewCount": median_view,
        "uploadsPerWeek": uploads_per_week,
        # Subscriber count isn't in --flat-playlist output; left for a future
        # channel-about-page scrape. Populated as 0 for now.
        "subscriberCount": 0,
        "isLikelyClipperChannel": is_clipper,
        "clippedShareRatio": round(clipped_ratio, 3),
        "shortShareRatio": round(short_ratio, 3),
        "primaryCategory": _classify_channel_category(uploads),
    }


# -- CLI ---------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Discovery v2 channel crawler")
    parser.add_argument("--mode", required=True, choices=["category_seed", "profile"])
    parser.add_argument("--channel-url", default="", help="Channel URL (profile mode)")
    parser.add_argument("--per-query", type=int, default=15,
                        help="Results per anchor query (category_seed mode)")
    parser.add_argument("--count", type=int, default=30,
                        help="Uploads to analyze (profile mode)")
    parser.add_argument("--ytdlp-path", default="yt-dlp")
    args = parser.parse_args()

    try:
        if args.mode == "category_seed":
            channels = discover_category_seed(
                per_query=args.per_query, ytdlp_path=args.ytdlp_path,
            )
            print(json.dumps({
                "success": True,
                "data": {"count": len(channels), "channels": channels},
            }, ensure_ascii=False))
            sys.exit(0)

        if args.mode == "profile":
            if not args.channel_url:
                raise ValueError("--channel-url required for profile mode")
            profile = profile_channel(
                args.channel_url, count=args.count, ytdlp_path=args.ytdlp_path,
            )
            print(json.dumps({"success": True, "data": profile}, ensure_ascii=False))
            sys.exit(0)

    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}, ensure_ascii=False))
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
