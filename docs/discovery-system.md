# YouTube Video Discovery System

## Problem
Manual YouTube URL input is slow and imprecise. We need an automated discovery system that finds videos with high viral clip potential — specifically Indonesian content that matches our scoring keywords.

## Architecture

```
Discovery Engine (Python CLI)
    │
    ├── Source 1: YouTube Search API (yt-dlp search)
    ├── Source 2: Trending feeds (yt-dlp trending)
    ├── Source 3: Channel monitoring (subscription-based)
    │
    ├── Relevance Pre-filter
    │   ├── Duration filter (5-30 min optimal)
    │   ├── Language filter (Indonesian audio)
    │   └── Keyword density quick-check
    │
    └── Auto-queue → Backend API POST /api/import
```

## Implementation Plan

### Stage 1: yt-dlp Search Discovery (local-only, no API key)

yt-dlp supports YouTube search natively. No API key needed.

```bash
# Search Indonesian viral content
yt-dlp "ytsearch30:rahasia penting indonesia" --flat-playlist --dump-json

# Trending videos in Indonesia
yt-dlp "https://www.youtube.com/feed/trending" --flat-playlist --dump-json

# Channel latest videos
yt-dlp "https://www.youtube.com/@channelName/videos" --flat-playlist --dump-json
```

**New script: `ai-pipeline/discover.py`**

```
Input:  --mode search|trending|channel
        --query "indonesian viral keywords"
        --max-results 20
        --min-duration 120 --max-duration 1800
        --lang id
Output: JSON envelope { success, data: { videos: [...] } }
```

Each discovered video returns:
```json
{
  "videoId": "yt-abc123",
  "title": "Rahasia Penting Yang Jarang Diketahui...",
  "url": "https://youtube.com/watch?v=abc123",
  "duration": 480,
  "channel": "Channel Name",
  "viewCount": 150000,
  "relevanceScore": 0.82
}
```

### Stage 2: Relevance Pre-filtering

Before downloading full video, do a quick relevance check:

1. **Title keyword match** — count viral keywords in title
2. **Duration check** — 3-20 min is sweet spot for clips
3. **View count ratio** — newer videos with high views = trending
4. **Description scan** — look for niche keywords

```python
def quick_relevance_score(video_meta, keywords):
    score = 0.0
    title_lower = video_meta["title"].lower()
    desc_lower = video_meta.get("description", "").lower()
    
    # Keyword density in title (weighted 3x)
    title_hits = sum(1 for kw in keywords if kw in title_lower)
    score += min(title_hits / max(len(keywords) * 0.3, 1), 1.0) * 0.4
    
    # Duration sweet spot (3-20 min)
    dur = video_meta.get("duration", 0)
    if 180 <= dur <= 1200: score += 0.25
    elif 120 <= dur <= 1800: score += 0.15
    
    # View velocity (views per hour since publish)
    age_hours = video_meta.get("age_hours", 999)
    if age_hours < 720:  # less than 30 days
        vph = video_meta.get("viewCount", 0) / max(age_hours, 1)
        if vph > 1000: score += 0.2
        elif vph > 100: score += 0.1
    
    # Description keyword match
    desc_hits = sum(1 for kw in keywords if kw in desc_lower)
    score += min(desc_hits / max(len(keywords) * 0.2, 1), 1.0) * 0.15
    
    return min(score, 1.0)
```

### Stage 3: Auto-queue to Pipeline

Discovered videos above a relevance threshold (default 0.6) auto-queue:

1. Script outputs ranked video list
2. Backend new endpoint: `POST /api/discover/queue` — accepts list of URLs
3. Backend processes them sequentially (avoid GPU overload)
4. Frontend shows discovery results in a "Discovery" tab

### Stage 4: Frontend Discovery UI

New section in the UI:

- **Search tab**: Enter keywords → discover.py runs → show ranked results
- **Trending tab**: One-click fetch Indonesian trending → show results
- **Channel tab**: Enter channel URL → fetch recent videos → rank them
- Each result has an **Import** button and a **relevance score** badge
- **Import All Top N** button to batch-queue the best videos

## New Files

| File | Purpose |
|------|---------|
| `ai-pipeline/discover.py` | YouTube search/trending discovery + relevance scoring |
| `backend/.../DiscoveryController.java` | Discovery API endpoints |
| `backend/.../DiscoveryService.java` | Orchestrate discovery → queue → process |
| `frontend src/app/page.tsx` | Discovery tab UI |

## New API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | /api/discover/search | Search YouTube by keywords |
| POST | /api/discover/trending | Get trending Indonesian videos |
| POST | /api/discover/channel | Get latest from a channel |
| GET | /api/discover/queue | List queued discovery items |
| POST | /api/discover/queue/{id}/process | Process a queued discovery item |

## Dependency
- **yt-dlp** (already installed in Docker container)
- No external API keys needed — yt-dlp handles YouTube scraping

## Execution Order
1. Build `discover.py` with search + trending + relevance scoring
2. Add backend controller + service
3. Add frontend Discovery tab
4. Add auto-queue with batch processing
5. Test E2E: discover → queue → process → clips

## Discovery v2 (implemented)

- The duration curve now favours long-form source material (30–180 min = full
  fit) and re-clipped titles are filtered before scoring.
- Search/channel default to the last 90 days; the default candidates view hides
  rows of unknown or older age.
- Source channels: `channel_crawler.py` seeds channels from anchor queries and
  profiles them; clip farms and short-form channels are stored as `REJECTED`.
  Endpoints: `/api/discover/channels*` in [api-spec.md](api-spec.md#source-channels).
- Not built yet: trust-score updates from clip feedback and polling channels on
  their `pollCadenceHours`.
