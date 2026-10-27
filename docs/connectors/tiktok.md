# TikTok Auto-Posting System

## Problem
After clips are generated and scored, the user must manually download each clip and post to TikTok. We need one-click posting from the web UI.

## Architecture Options

### Option A: TikTok Content Posting API (Official) — RECOMMENDED

TikTok provides an official Content Posting API for direct video posting.

**Requirements:**
- Register app at [TikTok for Developers](https://developers.tiktok.com)
- Get `video.publish` scope approved
- OAuth 2.0 flow — user authorizes your app once
- Access token stored locally for repeated use

**Flow:**
```
User clicks "Post to TikTok"
    │
    ├── First time? → OAuth redirect → user authorizes → token saved
    │
    ├── Backend calls: POST /v2/post/publish/video/init/
    │   ├── source: FILE_UPLOAD (chunked upload)
    │   └── source: PULL_FROM_URL (if video is publicly accessible)
    │
    ├── If FILE_UPLOAD: upload video chunks to TikTok's upload_url
    │
    └── Poll: POST /v2/post/publish/status/fetch/ → check publish status
```

**API Details:**

1. **Query Creator Info** — check privacy options, max duration
   ```
   POST https://open.tiktokapis.com/v2/post/publish/creator_info/query/
   Authorization: Bearer {access_token}
   ```

2. **Init Video Post** — start upload
   ```
   POST https://open.tiktokapis.com/v2/post/publish/video/init/
   Body: {
     "post_info": {
       "title": "Rahasia penting! #fyp #viral #indonesia",
       "privacy_level": "PUBLIC_TO_EVERYONE",
       "disable_duet": false,
       "disable_comment": false,
       "disable_stitch": false,
       "video_cover_timestamp_ms": 1000
     },
     "source_info": {
       "source": "FILE_UPLOAD",
       "video_size": {file_size},
       "chunk_size": 10000000,
       "total_chunk_count": {chunks}
     }
   }
   ```

3. **Upload chunks** — PUT video data to returned upload_url

4. **Check status** — poll until published
   ```
   POST https://open.tiktokapis.com/v2/post/publish/status/fetch/
   Body: { "publish_id": "v_pub_file~v2-1.xxxx" }
   ```

**Pros:** Official, stable, no ToS violations
**Cons:** Requires app approval, OAuth setup, unaudited apps post as private-only initially

### Option B: Browser Automation (Playwright) — FALLBACK

Automate the TikTok web upload page via Playwright.

```python
# playwright_tiktok_post.py
from playwright.sync_api import sync_playwright

def post_to_tiktok(video_path, caption, cookies_file):
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        context = browser.new_context()
        
        # Load saved TikTok login cookies
        context.add_cookies(json.load(open(cookies_file)))
        
        page = context.new_page()
        page.goto("https://www.tiktok.com/creator#/upload")
        page.wait_for_load_state("networkidle")
        
        # Upload video file
        page.locator('input[type="file"]').set_input_files(video_path)
        
        # Set caption
        page.locator('[data-testid="caption-input"]').fill(caption)
        
        # Click post
        page.locator('[data-testid="publish-button"]').click()
        
        page.wait_for_url("**/creator**", timeout=60000)
        browser.close()
```

**Pros:** No API approval needed, works immediately
**Cons:** Fragile (TikTok UI changes break it), needs login cookies maintained, headless detection

### Option C: Hybrid (Recommended Strategy)

1. **Primary:** TikTok Content Posting API for stable production use
2. **Fallback:** Playwright automation if API is pending approval

## Implementation Plan

### Stage 1: OAuth Setup + Token Storage

**New table in SQLite:**
```sql
CREATE TABLE IF NOT EXISTS tiktok_auth (
    id TEXT PRIMARY KEY,
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    expires_at TEXT,
    scope TEXT,
    open_id TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

**New endpoints:**
| Method | Path | Purpose |
|--------|------|---------|
| GET | /api/tiktok/auth/url | Get OAuth authorization URL |
| GET | /api/tiktok/auth/callback | Handle OAuth callback, save token |
| GET | /api/tiktok/auth/status | Check if connected to TikTok |
| DELETE | /api/tiktok/auth | Disconnect TikTok |

### Stage 2: Video Upload Service

**New file: `ai-pipeline/tiktok_post.py`**

```
Input:  --video-path /path/to/clip.mp4
        --caption "Rahasia penting! #fyp #viral"
        --token-path /path/to/token.json
Output: JSON envelope { success, data: { publish_id, status } }
```

Handles:
1. Read token from file
2. Query creator info
3. Init upload (FILE_UPLOAD mode)
4. Upload video in 10MB chunks
5. Poll status until PUBLISHED or FAILED
6. Return result

### Stage 3: Backend Integration

**New file: `backend/.../TikTokController.java`**

```java
@PostMapping("/api/clips/{clipId}/post-tiktok")
public ResponseEntity<?> postToTikTok(@PathVariable String clipId) {
    // 1. Check TikTok auth exists
    // 2. Get clip export path
    // 3. Generate caption from clip text + viral hashtags
    // 4. Run tiktok_post.py via PythonRunner
    // 5. Save publish_id to clip record
    // 6. Return status
}
```

**New fields in `clip` table:**
```sql
ALTER TABLE clip ADD COLUMN tiktok_publish_id TEXT;
ALTER TABLE clip ADD COLUMN tiktok_status TEXT DEFAULT 'NOT_POSTED';
ALTER TABLE clip ADD COLUMN tiktok_posted_at TEXT;
```

### Stage 4: Frontend One-Click Post

- **"Post to TikTok"** button on each clip card (next to Preview/Download)
- TikTok connection status indicator in header
- Settings modal to connect/disconnect TikTok account
- Post status shown on clip card (NOT_POSTED → UPLOADING → PUBLISHED)

### Stage 5: Caption Generation

Auto-generate TikTok captions from clip content:

```python
def generate_caption(clip_text, tier, keywords):
    # Extract key phrases from text
    # Add relevant hashtags based on keywords and tier
    # Truncate to TikTok limit (150 chars for description)
    # Example: "Rahasia yang jarang diketahui! 🔥 #fyp #viral #indonesia #rahasia"
```

Indonesian hashtag bank:
```python
TIKTOK_HASHTAGS = {
    "general": ["#fyp", "#foryou", "#viral", "#trending"],
    "indonesian": ["#indonesia", "#fypindonesia", "#viralindonesia"],
    "niche": {
        "rahasia": "#rahasia #tips",
        "penting": "#penting #wajibtau",
        "trik": "#trik #hack #tips",
        "solusi": "#solusi #caraindo",
    }
}
```

## Execution Order
1. Register TikTok Developer app, get client_id/secret
2. Add OAuth endpoints + token storage
3. Build `tiktok_post.py` upload script
4. Add backend controller + clip table columns
5. Add frontend "Post to TikTok" button
6. Add caption auto-generation
7. Test E2E: generate clip → one-click post → verify on TikTok

## Security Notes
- TikTok tokens stored in local SQLite only — never committed to git
- OAuth callback server runs locally (localhost:8080)
- Video content posted directly from local machine, no intermediary server
