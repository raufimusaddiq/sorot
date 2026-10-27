"""discover.py — yt-dlp wrapper, search/hashtag/trending/channel flows,
caption sampling, enrichment and the CLI. yt-dlp itself is never run:
``run_ytdlp`` / ``subprocess.run`` are replaced with canned output."""

import json
import os
import subprocess
import sys
import types
from datetime import datetime, timedelta, timezone

import pytest

import discover


def recent(days=2):
    return (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y%m%d")


def entry(vid, duration=300, url=None, upload=None, title="video", views=5000, **extra):
    e = {"id": vid, "title": title, "url": url or f"https://www.youtube.com/watch?v={vid}",
         "duration": duration, "view_count": views, "upload_date": upload or recent()}
    e.update(extra)
    return json.dumps(e)


def lines(*entries):
    return "\n".join(entries) + "\n\nnot json\n"


@pytest.fixture
def ytdlp(monkeypatch):
    """Queue canned (stdout, stderr, rc) replies for run_ytdlp; record args."""
    state = {"replies": [], "calls": []}

    def fake(args, ytdlp_path="yt-dlp", timeout=120):
        state["calls"].append(args)
        return state["replies"].pop(0) if state["replies"] else ("", "", 0)

    monkeypatch.setattr(discover, "run_ytdlp", fake)
    return state


class TestRunYtdlp:
    def test_success_timeout_and_missing_binary(self, monkeypatch):
        seen = {}

        def run(cmd, **kw):
            seen["cmd"] = cmd
            return types.SimpleNamespace(stdout="out", stderr="err", returncode=0)
        monkeypatch.setattr(subprocess, "run", run)
        assert discover.run_ytdlp(["x"], ytdlp_path="ytx") == ("out", "err", 0)
        assert seen["cmd"] == ["ytx", "x", "--no-warnings", "--no-check-certificates"]

        def timeout(cmd, **kw):
            raise subprocess.TimeoutExpired(cmd, 1)
        monkeypatch.setattr(subprocess, "run", timeout)
        assert discover.run_ytdlp(["x"]) == ("", "Timeout", 1)

        def missing(cmd, **kw):
            raise FileNotFoundError()
        monkeypatch.setattr(subprocess, "run", missing)
        assert discover.run_ytdlp(["x"], ytdlp_path="/no/yt") == ("", "yt-dlp not found at /no/yt", 1)


class TestHeuristics:
    def test_relevance_duration_and_velocity_bands(self):
        base = {"title": "", "description": ""}
        assert discover.quick_relevance_score({**base, "duration": 100}) == 0.0
        assert discover.quick_relevance_score({**base, "duration": 1500}) == 0.175       # 25 min → 0.7 fit
        assert discover.quick_relevance_score({**base, "duration": 3600}) == 0.25        # long-form = full fit
        assert discover.quick_relevance_score({**base, "duration": 0, "viewCount": 200 * 24, "age_hours": 24}) == 0.10
        assert discover.quick_relevance_score({**base, "duration": 0, "view_count": 5000 * 24, "age_hours": 24}) == 0.20
        assert discover.quick_relevance_score({**base, "duration": 0, "viewCount": 50, "age_hours": 24}) == 0.0
        assert discover.quick_relevance_score({**base, "duration": 0}, keywords=["x"]) == 0.0

    def test_normalize_edge_cases(self):
        v = discover.normalize_video({"id": "abcdefghijk", "view_count": "1,234", "upload_date": "20269999",
                                      "duration_string": "1:02:03", "uploader": "Up"})
        assert v["viewCount"] == 1234
        assert v["age_hours"] == 99999        # unparseable date → unknown-age sentinel
        assert v["duration"] == 3723
        assert v["channel"] == "Up"
        assert discover.normalize_video({"id": "x", "view_count": "lots"})["viewCount"] is None
        w = discover.normalize_video({"webpage_url": "https://youtu.be/abcdefghijk"})
        assert w["videoId"] == "abcdefghijk"

    def test_is_short(self):
        assert discover.is_short({"url": "https://youtube.com/shorts/abc"})
        assert discover.is_short({"duration": 45})
        assert not discover.is_short({"duration": "n/a"})
        assert not discover.is_short({"duration": 0})


class TestSearch:
    def test_flat_search_filters_and_sorts(self, ytdlp):
        ytdlp["replies"] = [(lines(
            entry("aaaaaaaaaaa", title="rahasia viral fakta"),
            entry("bbbbbbbbbbb", title="biasa"),
            entry("ccccccccccc", duration=40),                     # short by duration
            entry("ddddddddddd", url="https://youtube.com/shorts/ddddddddddd"),
            entry("eeeeeeeeeee", duration=50000),                  # too long
            entry("fffffffffff", duration=90),                     # too short for min
        ), "", 0)]
        vids = discover.discover_search("q", 5, min_duration=100, max_duration=3600, max_age_days=0)
        assert [v["videoId"] for v in vids] == ["aaaaaaaaaaa", "bbbbbbbbbbb"]
        assert vids[0]["relevanceScore"] >= vids[1]["relevanceScore"]
        assert "--flat-playlist" in ytdlp["calls"][0]

    def test_recent_mode_age_filter_and_dateafter(self, ytdlp):
        ytdlp["replies"] = [(lines(entry("aaaaaaaaaaa"), entry("bbbbbbbbbbb", upload="20200101")), "", 0)]
        vids = discover.discover_search("q", 3, recent_only=True, max_age_days=10, dateafter="20260101")
        assert [v["videoId"] for v in vids] == ["aaaaaaaaaaa"]
        args = ytdlp["calls"][0]
        assert "--match-filters" in args and "upload_date >=(today-10days)" in args
        assert args[-2:] == ["--dateafter", "20260101"]
        assert "--flat-playlist" not in args

    def test_failure_raises(self, ytdlp):
        ytdlp["replies"] = [("", "HTTP 429", 1)]
        with pytest.raises(RuntimeError, match="HTTP 429"):
            discover.discover_search("q")


class TestHashtag:
    def test_filters(self, ytdlp):
        ytdlp["replies"] = [(lines(
            entry("aaaaaaaaaaa"), entry("bbbbbbbbbbb", duration=30),
            entry("ccccccccccc", duration=20), entry("ddddddddddd", duration=99999),
            entry("eeeeeeeeeee", upload="20200101"),
        ), "", 0)]
        vids = discover.discover_hashtag("viral", 5, min_duration=60, max_duration=3600, max_age_days=30)
        assert [v["videoId"] for v in vids] == ["aaaaaaaaaaa"]
        assert ytdlp["calls"][0][0] == "https://www.youtube.com/hashtag/viral"

    def test_minimum_duration_without_shorts_filter(self, ytdlp):
        ytdlp["replies"] = [(lines(entry("aaaaaaaaaaa", duration=70)), "", 0)]
        assert discover.discover_hashtag("x", min_duration=100, exclude_shorts=False) == []

    def test_failure_raises(self, ytdlp):
        ytdlp["replies"] = [("", "blocked", 1)]
        with pytest.raises(RuntimeError, match="hashtag fetch failed"):
            discover.discover_hashtag("x")


class TestTrending:
    def test_merges_hashtags_and_niche_searches(self, monkeypatch):
        def hashtag(tag, n, path, **kw):
            if tag == "fyp":
                raise RuntimeError("feed down")
            return [{"videoId": f"{tag}-1", "relevanceScore": 0.5}, {"videoId": "dup", "relevanceScore": 0.9}]

        calls = []

        def search(q, n, path, **kw):
            calls.append(kw)
            if "podcast" in q:
                raise RuntimeError("search down")
            return [{"videoId": "dup", "relevanceScore": 0.1}, {"videoId": f"s-{len(calls)}", "relevanceScore": 0.7}]

        monkeypatch.setattr(discover, "discover_hashtag", hashtag)
        monkeypatch.setattr(discover, "discover_search", search)
        vids = discover.discover_trending(max_results=50)
        ids = [v["videoId"] for v in vids]
        assert ids.count("dup") == 1
        assert "fyp-1" not in ids
        assert any(i.startswith("s-") for i in ids)
        assert all(kw["recent_only"] for kw in calls)
        assert vids == sorted(vids, key=lambda v: v["relevanceScore"], reverse=True)
        assert len(discover.discover_trending(max_results=2)) == 2


class TestChannel:
    def test_falls_back_to_channel_root(self, ytdlp):
        ytdlp["replies"] = [("", "no /videos tab", 1), (lines(
            entry("aaaaaaaaaaa"), entry("bbbbbbbbbbb", duration=30),
            entry("ccccccccccc", duration=80), entry("ddddddddddd", duration=99999)), "", 0)]
        vids = discover.discover_channel("https://youtube.com/@x/", 5, min_duration=100, max_duration=3600)
        assert [v["videoId"] for v in vids] == ["aaaaaaaaaaa"]
        assert ytdlp["calls"][0][0] == "https://youtube.com/@x/videos"
        assert ytdlp["calls"][1][0] == "https://youtube.com/@x/"

    def test_both_attempts_fail(self, ytdlp):
        ytdlp["replies"] = [("", "a", 1), ("", "gone", 1)]
        with pytest.raises(RuntimeError, match="gone"):
            discover.discover_channel("https://youtube.com/@x")


class TestCaptions:
    def test_falls_back_through_languages(self, ytdlp, monkeypatch):
        attempts = []

        def fake(args, ytdlp_path="yt-dlp", timeout=120):
            lang = args[args.index("--sub-lang") + 1]
            attempts.append(lang)
            if lang == "en":
                outdir = os.path.dirname(args[args.index("-o") + 1])
                with open(os.path.join(outdir, "abc.en.vtt"), "w", encoding="utf-8") as f:
                    f.write("WEBVTT\n\n00:00.000 --> 00:01.000\nhalo <c>dunia</c>\nhalo dunia\n")
            return "", "", 0
        monkeypatch.setattr(discover, "run_ytdlp", fake)
        assert discover.sample_transcript("https://youtu.be/abc", max_chars=50) == "halo dunia"
        assert attempts == ["id", "en"]

    def test_no_captions(self, ytdlp):
        assert discover.sample_transcript("https://youtu.be/abc") == ""
        assert len(ytdlp["calls"]) == 3

    def test_unreadable_vtt(self, tmp_path):
        assert discover._vtt_to_text(str(tmp_path / "missing.vtt"), 100) == ""


class TestPrediction:
    def test_duration_bands_and_scorer_failure(self, monkeypatch):
        assert discover.predict_clip_potential("", duration=1300)[1] == round(0.7 * 0.2, 4)   # 15–30 min
        assert discover.predict_clip_potential("", duration=700)[1] == round(0.4 * 0.2, 4)    # 10–15 min
        assert discover.predict_clip_potential("", duration=10)[1] == 0.0
        from features import text as text_features

        def boom(t):
            raise RuntimeError("scorer")
        monkeypatch.setattr(text_features, "score_hook_strength", boom)
        assert discover.predict_clip_potential("x" * 100)[0] == 0.0

    def test_enrich_combines_transcript_and_metadata(self, monkeypatch):
        monkeypatch.setattr(discover, "sample_transcript", lambda url, ytdlp_path="yt-dlp": "kata " * 200)
        out = discover.discover_enrich("u", duration=300, age_hours=10, view_count=10000)
        assert out["transcriptLength"] == 1000
        assert len(out["transcriptSample"]) == 500
        assert 0 < out["predictedScore"] <= 1


class TestMain:
    def run(self, monkeypatch, capsys, *argv):
        monkeypatch.setattr(sys, "argv", ["discover.py", *argv])
        with pytest.raises(SystemExit) as exc:
            discover.main()
        return exc.value.code, json.loads(capsys.readouterr().out.strip().splitlines()[-1])

    def test_modes(self, monkeypatch, capsys):
        monkeypatch.setattr(discover, "discover_search", lambda *a: [{"videoId": "s"}])
        monkeypatch.setattr(discover, "discover_trending", lambda *a: [{"videoId": "t"}])
        monkeypatch.setattr(discover, "discover_channel", lambda *a: [{"videoId": "c"}])
        monkeypatch.setattr(discover, "discover_enrich", lambda url, **kw: {"predictedScore": 0.5, **kw})

        code, out = self.run(monkeypatch, capsys, "--mode", "search", "--query", "viral")
        assert code == 0 and out["data"]["videos"] == [{"videoId": "s"}] and out["data"]["count"] == 1
        code, out = self.run(monkeypatch, capsys, "--mode", "trending")
        assert out["data"]["mode"] == "trending"
        code, out = self.run(monkeypatch, capsys, "--mode", "channel", "--channel-url", "https://youtube.com/@x")
        assert out["data"]["videos"][0]["videoId"] == "c"
        code, out = self.run(monkeypatch, capsys, "--mode", "enrich", "--video-url", "u", "--duration", "300",
                             "--age-hours", "5", "--view-count", "9")
        assert code == 0 and out["data"] == {"predictedScore": 0.5, "duration": 300, "age_hours": 5.0,
                                             "view_count": 9, "ytdlp_path": "yt-dlp"}

    @pytest.mark.parametrize("argv,msg", [
        (["--mode", "search"], "--query is required"),
        (["--mode", "channel"], "--channel-url is required"),
        (["--mode", "enrich"], "--video-url is required"),
    ])
    def test_missing_arguments(self, monkeypatch, capsys, argv, msg):
        code, out = self.run(monkeypatch, capsys, *argv)
        assert code == 1 and out["success"] is False and msg in out["error"]
