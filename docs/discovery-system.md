# YouTube Video Discovery System

Finds long-form Indonesian videos worth clipping, ranks them and imports the ones
you pick. All in the Bun backend, with yt-dlp for YouTube (no API key). Endpoints
and fields: [api-spec.md → Discovery](api-spec.md#discovery).

## Problem
Manual YouTube URL input is slow and imprecise. Discovery finds videos with high clip potential: Indonesian long-form talk (podcasts, talk shows, interviews, stand-up) that matches the scorer's keywords.

## Architecture

```
Sources (youtube.ts, yt-dlp)            search · trending · channel uploads
  └─ ✨ auto (discoveryAgent.ts)          LLM agent with web + YouTube tools, or the algorithm
    │
    ├── Filters + relevanceScore         Shorts, re-clipped titles, duration, age → 0-1
    ├── Stored (discovery.ts)            discovered_video: NEW → QUEUED → IMPORTED / SKIPPED
    ├── Enrichment (captionAnalysis.ts)  whole-video captions → predictedScore
    └── Import                           queue + drain → import + job per video
```

## Sources (`youtube.ts`)

```bash
yt-dlp "ytsearch20:<query>" --dump-json --skip-download --match-filters "upload_date >=(today-90days)"
yt-dlp "https://www.youtube.com/hashtag/viralindonesia" --dump-json --skip-download --playlist-end N --match-filters …
yt-dlp "https://www.youtube.com/@channelName/videos" --flat-playlist --dump-json --skip-download --playlist-end N
```

- **Search** (`POST /api/discover/search`): the last 90 days by default (full metadata, so upload dates are known).
- **Trending** (`POST /api/discover/trending`): YouTube's hashtag feeds (`viralindonesia`, `viral`, `beritaviral`, `terbaru`, `fyp`) plus three niche searches; ≥ 5 min, last 45 days. `region` is accepted but unused: hashtag feeds aren't regional.
- **Channel** (`POST /api/discover/channel`): recent uploads, last 90 days; flat listings may lack a date, and those rows are kept.

## Relevance pre-filtering (`parseFeed`, `relevanceScore`)

Every feed drops Shorts (`/shorts/` or ≤ 60 s), re-clipped titles or descriptions (`clip`, `potongan`, `highlight`, `compilation`, `reaction`, `top N`…) and rows outside the duration/age limits, then scores what's left:

```
relevance = 0.40 × min(title keyword hits / 8.25, 1)        # 55 Indonesian KEYWORDS
          + 0.25 × durationFit                             # < 5 min 0, < 10 0.15, < 15 0.4, < 30 0.7, 30+ min 1.0
          + 0.20 if < 30 days old and > 1000 views/h (0.10 if > 100)
          + 0.15 × min(description keyword hits / 5.5, 1)
```

Each row also gets a `contentType` guess from its title and channel name (PODCAST, TALKSHOW, STANDUP, LIVESTREAM, NEWS, STORYTELLING, REVIEW, GAMING, OTHER).

## Caption analysis (`captionAnalysis.ts`)

After each search, the 10 most relevant new rows (3 at a time) get their YouTube captions (`id`, else `en`, else any; auto-captions allowed) scored as a whole video:

- 45 s windows, each scored by the clip scorer's text rules (0.35 hook + 0.3 keywords + 0.2 novelty + 0.15 sentiment strength); `transcriptScore` = mean of the 5 best; `strongMoments` = windows ≥ 0.55; speech density in words per minute.
- `predictedScore` = 0.40 transcript + 0.15 strong moments per 10 captioned minutes (2+ saturates) + 0.10 speech fit (60 → 110 wpm) + 0.20 view velocity (log views/hour, < 30 days) + 0.15 duration fit. Without captions only velocity and duration count.

## Candidates (`discovery.ts`)

Results land in `discovered_video`, one row per YouTube id. A video already in the library is marked IMPORTED, and QUEUED / SKIPPED / IMPORTED survive later searches. The default list (`GET /api/discover/candidates`) shows NEW and QUEUED rows of known age ≤ 90 days, ranked as follows:
- score: `predictedScore` (else relevance);
- +0.05 for a profiled source channel, +0.05 for a channel you've imported from;
- channels the crawler rejected are left out.

Each row carries plain-language `why` reasons. A status filter shows every age. *Make clips* queues the selected rows and drains the queue (`POST /api/discover/queue`, `/queue/drain`), which imports each video and starts its job.

## ✨ Auto-discover (`discoveryAgent.ts`)

`POST /api/discover/auto {goal, maxResults}` (default 10, at most 20) runs in the background, one run at a time.

- **With an LLM:** a tool-calling agent (12 rounds, then it must answer) with these tools:
  - `web_search` (`webSearch.ts`: Bing HTML by default, as DuckDuckGo is blocked by Indonesian ISPs; a SearXNG URL; or `WEB_SEARCH=off`);
  - `youtube_search` (≥ 10 min, last 90 days);
  - `analyze_video` (the caption analysis above);
  - `channel_videos` and `source_channels`.

  Picks come with a reason, and only videos the tools returned count. Picks from rejected channels are dropped.
- **Without an LLM, or when it fails:** the algorithm runs instead.
  - It searches the goal, then a shuffled sample of the anchor and niche queries: 3 searches, up to 6 while fewer than 2 × `maxResults` usable videos turned up.
  - It analyzes the best ≤ 16 by relevance and keeps the best predicted scores, at most 2 per channel.

Picks are stored like any search (`sourceMode` "auto", `pickedBy` = the model or "algorithm").

## Source channels (`channels.ts`)

`POST /api/discover/channels/reseed` runs 12 long-form anchor queries (podcasts, talk shows, stand-up, interviews, livestreams) and stores channels it hasn't seen. It then profiles each one in the background from its last 30 uploads: average length, median views, uploads per week and main content type.
- A channel is stored as `REJECTED` when ≥ 70 % of its uploads are under 5 min or clip-titled (a clip farm), or when its uploads average under 15 min.
- `/channels/{id}/refresh` re-profiles a channel; `/channels/{id}/status` sets ACTIVE, PAUSED or REJECTED.

## UI and CLI

The studio's *Discover* window has Auto / Search / Trending / Channel tabs. Its *Candidates* list shows each row's predicted (or relevance) score and reasons, with *Make clips* and *Skip*. CLI: `sorot discover search | trending | channel | auto | candidates | queue | skip | drain`.

Not built: trust-score updates from clip feedback, and polling channels on their `pollCadenceHours` (the columns exist; trust stays 0.5).
