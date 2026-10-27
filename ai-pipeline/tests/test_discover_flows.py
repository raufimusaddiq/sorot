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
        assert discover.fetch_caption_lines("https://youtu.be/abc") == [(0.0, "halo dunia")]
        assert attempts == ["id", "en"]

    def test_no_captions(self, ytdlp):
        assert discover.fetch_caption_lines("https://youtu.be/abc") == []
        assert len(ytdlp["calls"]) == 3

    def test_unreadable_vtt(self, tmp_path):
        assert discover.parse_vtt_lines(str(tmp_path / "missing.vtt")) == []

    def test_rolling_auto_captions_keep_only_new_speech(self, tmp_path):
        vtt = tmp_path / "a.vtt"
        vtt.write_text('WEBVTT\nKind: captions\nLanguage: id\n\n00:00:00.480 --> 00:00:01.550 align:start position:0%\n \nDi<00:00:00.560><c> ruangan</c><00:00:00.840><c> tuh</c>\n\n00:00:01.550 --> 00:00:01.560 align:start position:0%\nDi ruangan tuh\n \n\n00:00:01.560 --> 00:00:03.189 align:start position:0%\nDi ruangan tuh\nenggak<00:00:01.680><c> ada</c><00:00:01.920><c> orang.</c>\n\n01:00:03.189 --> 01:00:03.199 align:start position:0%\nenggak ada orang.\n \n', encoding="utf-8")
        assert discover.parse_vtt_lines(str(vtt)) == [(0.48, "Di ruangan tuh"), (1.56, "enggak ada orang.")]

    def test_uploaded_captions_dedupe_repeats_and_read_hours(self, tmp_path):
        vtt = tmp_path / "u.vtt"
        vtt.write_bytes(b"WEBVTT\r\n\r\n1:02:03.5 --> 1:02:04.0\r\nHalo\r\n\r\n"   # bytes: exact CRLF
                        b"1:02:04.000 --> 1:02:05.000\r\nHalo\r\n\r\n1:02:05.000 --> 1:02:06.000\r\nHalo dunia\r\n")
        assert discover.parse_vtt_lines(str(vtt)) == [(3723.5, "Halo"), (3725.0, "Halo dunia")]


def lines_every(seconds, texts):
    return [(i * seconds, t) for i, t in enumerate(texts)]


class TestWindows:
    def test_windows_split_by_time(self):
        lines = lines_every(20, ["a", "b", "c", "d", "e"])          # 0, 20, 40, 60, 80
        assert discover.caption_windows(lines) == [(0, "a b c"), (60, "d e")]
        assert discover.caption_windows([]) == []

    def test_window_score_short_text_and_scorer_failure(self, monkeypatch):
        assert discover.window_score("terlalu pendek") == 0.0
        viral = "Ternyata rahasia ini jarang diketahui orang. Fakta mengejutkan! Kenapa bisa begitu? Penting banget."
        assert discover.window_score(viral) > discover.window_score("Hari ini saya masak nasi goreng biasa saja di rumah sendiri.")
        from features import text as text_features

        def boom(t):
            raise RuntimeError("scorer")
        monkeypatch.setattr(text_features, "score_hook_strength", boom)
        assert discover.window_score("x" * 100) == 0.0

    def test_analyze_finds_moments_anywhere_in_the_video(self):
        bland = "Kami lanjut ngobrol soal cuaca hari ini yang cukup cerah dan sejuk di kota ini."
        viral = "Ternyata rahasia ini jarang diketahui orang. Fakta mengejutkan! Kenapa bisa begitu? Penting banget."
        # 30 minutes: a bland intro and body, two strong moments deep in the video
        texts = [bland] * 40
        texts[25] = viral
        texts[33] = viral
        a = discover.analyze_captions(lines_every(45, texts))
        assert a["windows"] == 40 and a["captionMinutes"] == 29.2
        assert a["strongMoments"] == 2
        assert [m["start"] for m in a["topMoments"][:2]] == [1125, 1485]
        assert len(a["topMoments"]) == 5
        assert a["speechWpm"] == round(sum(len(t.split()) for t in texts) / 29.25)
        assert discover.analyze_captions([]) is None
        assert discover.analyze_captions([(0, "satu dua tiga empat lima enam tujuh delapan sembilan sepuluh")])["speechWpm"] is None


class TestPrediction:
    def test_speech_fit_and_velocity(self):
        assert discover.speech_fit(None) == 0.0
        assert discover.speech_fit(40) == 0.0
        assert discover.speech_fit(85) == 0.5
        assert discover.speech_fit(160) == 1.0
        assert discover.velocity_score(0, 10) == 0.0
        assert discover.velocity_score(1000, 99999) == 0.0
        assert discover.velocity_score(10 ** 6, 10) == 1.0

    def test_without_captions_only_metadata_counts(self):
        assert discover.predict_score(None, duration=1300) == round(0.7 * 0.15, 4)     # 15–30 min
        assert discover.predict_score(None, duration=10) == 0.0
        assert discover.predict_score(None, duration=3600, view_count=10 ** 6, age_hours=10) == round(0.20 + 0.15, 4)

    def test_moments_and_talk_outrank_intro_heavy_or_music(self):
        talk = {"transcriptScore": 0.62, "strongMoments": 8, "captionMinutes": 40, "speechWpm": 150}
        music = {"transcriptScore": 0.62, "strongMoments": 8, "captionMinutes": 40, "speechWpm": 30}
        few = {"transcriptScore": 0.62, "strongMoments": 1, "captionMinutes": 40, "speechWpm": 150}
        p = lambda a: discover.predict_score(a, duration=2400)
        assert p(talk) > p(few) > p(None)
        assert p(talk) > p(music)
        assert p(talk) == round(0.62 * 0.40 + 1.0 * 0.15 + 1.0 * 0.10 + 1.0 * 0.15, 4)

    def test_enrich_reports_moments(self, monkeypatch):
        viral = "Ternyata rahasia ini jarang diketahui orang. Fakta mengejutkan! Kenapa bisa begitu? Penting banget."
        monkeypatch.setattr(discover, "fetch_caption_lines", lambda url, ytdlp_path="yt-dlp": lines_every(45, [viral] * 20))
        out = discover.discover_enrich("u", duration=900, age_hours=10, view_count=10000)
        assert out["hasCaptions"] is True and out["strongMoments"] >= 1
        assert out["topMoments"][0]["text"] == out["transcriptSample"]
        assert out["speechDensityWpm"] > 0 and 0 < out["predictedScore"] <= 1
        monkeypatch.setattr(discover, "fetch_caption_lines", lambda url, ytdlp_path="yt-dlp": [])
        out = discover.discover_enrich("u", duration=700)                 # 10-15 min band: 0.4
        assert out == {"predictedScore": round(0.4 * 0.15, 4), "transcriptScore": 0.0, "hasCaptions": False}


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
