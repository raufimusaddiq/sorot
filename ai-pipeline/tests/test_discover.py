import json
import os
import sys
import subprocess
from unittest.mock import patch, MagicMock

import pytest

SCRIPTS_DIR = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, os.path.abspath(SCRIPTS_DIR))

from discover import (
    quick_relevance_score,
    normalize_video,
    parse_duration,
    extract_video_id,
    discover_trending,
    discover_search,
    KEYWORDS,
)


class TestParseDuration:
    def test_hms_format(self):
        assert parse_duration("1:30:45") == 5445

    def test_ms_format(self):
        assert parse_duration("5:30") == 330

    def test_seconds_only(self):
        assert parse_duration("120") == 120

    def test_none(self):
        assert parse_duration(None) == 0

    def test_empty_string(self):
        assert parse_duration("") == 0

    def test_int_input(self):
        assert parse_duration(300) == 300

    def test_float_input(self):
        assert parse_duration(300.5) == 300

    def test_invalid_format(self):
        assert parse_duration("abc") == 0


class TestExtractVideoId:
    def test_standard_url(self):
        assert extract_video_id("https://www.youtube.com/watch?v=dQw4w9WgXcQ") == "dQw4w9WgXcQ"

    def test_short_url(self):
        assert extract_video_id("https://youtu.be/dQw4w9WgXcQ") == "dQw4w9WgXcQ"

    def test_shorts_url(self):
        assert extract_video_id("https://www.youtube.com/shorts/abc12345678") == "abc12345678"

    def test_no_match(self):
        assert extract_video_id("https://example.com") is None

    def test_embed_url(self):
        assert extract_video_id("https://www.youtube.com/v/dQw4w9WgXcQ") == "dQw4w9WgXcQ"


class TestNormalizeVideo:
    def test_basic_entry(self):
        # Relative date: a hardcoded one ages past the < 999 h bound below.
        from datetime import datetime, timedelta, timezone
        upload = (datetime.now(timezone.utc) - timedelta(days=2)).strftime("%Y%m%d")
        entry = {
            "id": "abc123",
            "title": "Test Video Title",
            "url": "https://www.youtube.com/watch?v=abc123",
            "duration": 300,
            "channel": "TestChannel",
            "view_count": 15000,
            "upload_date": upload,
            "description": "A test description",
        }
        result = normalize_video(entry)
        assert result["videoId"] == "abc123"
        assert result["title"] == "Test Video Title"
        assert result["duration"] == 300
        assert result["channel"] == "TestChannel"
        assert result["viewCount"] == 15000
        assert result["age_hours"] < 999

    def test_missing_fields(self):
        entry = {"id": "xyz"}
        result = normalize_video(entry)
        assert result["videoId"] == "xyz"
        assert result["title"] == ""
        assert result["duration"] == 0
        assert result["viewCount"] is None

    def test_constructs_url_from_id(self):
        entry = {"id": "abc123defgh"}
        result = normalize_video(entry)
        assert "abc123defgh" in result["url"]

    def test_description_truncated(self):
        entry = {"id": "x", "description": "x" * 1000}
        result = normalize_video(entry)
        assert len(result["description"]) <= 500

    def test_view_count_string(self):
        entry = {"id": "x", "view_count": "15,000"}
        result = normalize_video(entry)
        assert result["viewCount"] == 15000


class TestQuickRelevanceScore:
    def test_high_relevance(self):
        meta = {
            "title": "Rahasia Penting Yang Harus Kamu Tahu Fakta Viral",
            "duration": 600,
            "viewCount": 500000,
            "age_hours": 48,
            "description": "trik solusi tip hack rahasia penting",
        }
        score = quick_relevance_score(meta)
        assert score >= 0.5

    def test_low_relevance(self):
        meta = {
            "title": "Random Video About Nothing Specific",
            "duration": 30,
            "viewCount": 10,
            "age_hours": 2000,
            "description": "just a normal video",
        }
        score = quick_relevance_score(meta)
        assert score < 0.4

    def test_duration_sweet_spot(self):
        meta_in_range = {"title": "test", "duration": 600, "viewCount": 0}
        meta_out_range = {"title": "test", "duration": 50, "viewCount": 0}
        score_in = quick_relevance_score(meta_in_range)
        score_out = quick_relevance_score(meta_out_range)
        assert score_in > score_out

    def test_title_keywords_weighted_heavily(self):
        meta_kw = {"title": "rahasia penting trik solusi viral", "duration": 0, "viewCount": 0}
        meta_no = {"title": "normal title here", "duration": 0, "viewCount": 0}
        assert quick_relevance_score(meta_kw) > quick_relevance_score(meta_no)

    def test_view_velocity(self):
        meta_hot = {"title": "test", "duration": 0, "viewCount": 100000, "age_hours": 24}
        meta_cold = {"title": "test", "duration": 0, "viewCount": 100, "age_hours": 720}
        assert quick_relevance_score(meta_hot) > quick_relevance_score(meta_cold)

    def test_score_capped_at_one(self):
        meta = {
            "title": " ".join(KEYWORDS[:15]),
            "duration": 600,
            "viewCount": 10000000,
            "age_hours": 1,
            "description": " ".join(KEYWORDS[:10]),
        }
        score = quick_relevance_score(meta)
        assert score <= 1.0

    def test_custom_keywords(self):
        meta = {"title": "custom keyword match", "duration": 0, "viewCount": 0}
        score_default = quick_relevance_score(meta)
        score_custom = quick_relevance_score(meta, keywords=["custom", "keyword"])
        assert score_custom > score_default


class TestDiscoverScriptCLI:
    def test_missing_mode_exits(self):
        result = run_script("discover.py", [])
        assert result.returncode != 0

    def test_search_without_query_exits(self):
        result = run_script("discover.py", ["--mode", "search"])
        assert result.returncode != 0

    def test_channel_without_url_exits(self):
        result = run_script("discover.py", ["--mode", "channel"])
        assert result.returncode != 0

    def test_invalid_mode_exits(self):
        result = run_script("discover.py", ["--mode", "invalid"])
        assert result.returncode != 0


def run_script(script_name, args):
    cmd = [sys.executable, os.path.join(SCRIPTS_DIR, script_name)] + args
    return subprocess.run(cmd, capture_output=True, text=True, timeout=30)
