"""channel_crawler.py edge paths + the clip/age filters discover.py gained
with it. yt-dlp is never run: ``_run_ytdlp`` / ``run_ytdlp`` return canned
output. The happy paths live in test_pipeline.py (TestChannelCrawler*)."""

import json
import sys
from datetime import datetime, timedelta, timezone

import pytest

import channel_crawler
import discover


def days_ago(n):
    return (datetime.now(timezone.utc) - timedelta(days=n)).strftime("%Y%m%d")


def jl(*entries):
    return "\n".join(json.dumps(e) for e in entries) + "\n\nnot json\n"


@pytest.fixture
def ytdlp(monkeypatch):
    state = {"replies": [], "calls": []}

    def fake(args, ytdlp_path="yt-dlp", timeout=120):
        state["calls"].append(args)
        return state["replies"].pop(0) if state["replies"] else ("", "", 0)

    monkeypatch.setattr(channel_crawler, "_run_ytdlp", fake)
    monkeypatch.setattr(discover, "run_ytdlp", fake)
    return state


class TestChannelsFromQuery:
    def test_failed_search_and_unusable_entries(self, ytdlp):
        ytdlp["replies"] = [("", "429", 1)]
        assert channel_crawler._channels_from_query("q") == []
        ytdlp["replies"] = [(jl({"channel": "no id"}, {"channel_id": "UC1"},
                                {"uploader_id": "UC2", "uploader": "Two"}), "", 0)]
        assert channel_crawler._channels_from_query("q") == [
            ("UC2", "Two", "https://www.youtube.com/channel/UC2", "q"),
        ]


class TestFetchUploads:
    def test_falls_back_to_bare_channel_url(self, ytdlp):
        ytdlp["replies"] = [("not json\n", "no /videos tab", 1),
                            (jl({"id": "abcdefghijk", "duration": 3600, "channel": "C"}), "", 1)]
        uploads = channel_crawler._fetch_channel_uploads("https://yt/c/x/", count=5)
        assert [u["videoId"] for u in uploads] == ["abcdefghijk"]
        assert ytdlp["calls"][0][0] == "https://yt/c/x/videos"
        assert ytdlp["calls"][1][0] == "https://yt/c/x"
        assert ytdlp["calls"][1][-1] == "5"

    def test_both_targets_fail(self, ytdlp):
        ytdlp["replies"] = [("", "first", 1), ("", "gone", 1)]
        with pytest.raises(RuntimeError, match="gone"):
            channel_crawler._fetch_channel_uploads("https://yt/c/x")


class TestCategory:
    def test_empty_and_all_other_are_mixed(self):
        assert channel_crawler._classify_channel_category([]) == "MIXED"
        assert channel_crawler._classify_channel_category([{"contentType": "OTHER"}, {}]) == "MIXED"


class TestMain:
    def run(self, monkeypatch, capsys, *argv):
        monkeypatch.setattr(sys, "argv", ["channel_crawler.py", *argv])
        with pytest.raises(SystemExit) as exc:
            channel_crawler.main()
        return exc.value.code, json.loads(capsys.readouterr().out)

    def test_category_seed(self, monkeypatch, capsys):
        monkeypatch.setattr(channel_crawler, "discover_category_seed",
                            lambda per_query, ytdlp_path: [{"youtubeChannelId": "UC1"}])
        code, out = self.run(monkeypatch, capsys, "--mode", "category_seed", "--per-query", "3")
        assert code == 0 and out["data"] == {"count": 1, "channels": [{"youtubeChannelId": "UC1"}]}

    def test_profile(self, monkeypatch, capsys):
        monkeypatch.setattr(channel_crawler, "profile_channel",
                            lambda url, count, ytdlp_path: {"channelUrl": url, "count": count})
        code, out = self.run(monkeypatch, capsys, "--mode", "profile", "--channel-url", "u", "--count", "7")
        assert code == 0 and out["data"] == {"channelUrl": "u", "count": 7}

    def test_profile_needs_url_and_errors_are_enveloped(self, monkeypatch, capsys):
        code, out = self.run(monkeypatch, capsys, "--mode", "profile")
        assert code == 1 and out == {"success": False, "error": "--channel-url required for profile mode"}


class TestDiscoverFilters:
    def test_search_and_hashtag_drop_clips(self, ytdlp):
        rows = jl({"id": "aaaaaaaaaaa", "title": "Podcast lengkap", "duration": 3600, "upload_date": days_ago(2)},
                  {"id": "bbbbbbbbbbb", "title": "Best of podcast clips", "duration": 900, "upload_date": days_ago(2)})
        ytdlp["replies"] = [(rows, "", 0)]
        assert [v["videoId"] for v in discover.discover_search("q", 5)] == ["aaaaaaaaaaa"]
        ytdlp["replies"] = [(rows, "", 0)]
        assert [v["videoId"] for v in discover.discover_hashtag("tag", 5)] == ["aaaaaaaaaaa"]

    def test_channel_drops_clips_and_known_old_but_keeps_unknown_age(self, ytdlp):
        ytdlp["replies"] = [(jl(
            {"id": "aaaaaaaaaaa", "title": "Ep 1", "duration": 3600, "upload_date": days_ago(5)},
            {"id": "bbbbbbbbbbb", "title": "Ep 2", "duration": 3600},                         # no date
            {"id": "ccccccccccc", "title": "Ep 0", "duration": 3600, "upload_date": days_ago(400)},
            {"id": "ddddddddddd", "title": "Highlight ep 1", "duration": 3600, "upload_date": days_ago(5)},
        ), "", 0)]
        vids = discover.discover_channel("https://yt/c/x", max_results=1)
        assert len(vids) == 1                                   # trimmed back to max_results
        assert ytdlp["calls"][0][-1] == "3"                     # over-fetched ×3 for the age filter
        ytdlp["replies"] = [(jl(
            {"id": "bbbbbbbbbbb", "title": "Ep 2", "duration": 3600},
            {"id": "ccccccccccc", "title": "Ep 0", "duration": 3600, "upload_date": days_ago(400)},
        ), "", 0)]
        assert [v["videoId"] for v in discover.discover_channel("https://yt/c/x")] == ["bbbbbbbbbbb"]
