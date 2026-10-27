"""Editing features: hook-first timelines, background music with ducking,
YouTube-caption transcripts and the caption-editor CLI — unit tests plus
real ffmpeg runs of the hook-first cut and the music mix."""

import json
import os
import shutil
import subprocess
import sys
import types

import pytest

import captions
import reframe
import render
import subtitle
import youtube_captions as ytc

HAS_FFMPEG = shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


def w(text, start, end):
    return {"text": text, "start": start, "end": end}


TALK = [w("Halo", 0.0, 0.4), w("semua.", 0.5, 1.0),
        w("Ini", 4.0, 4.3), w("biasa", 4.4, 4.8), w("saja.", 4.9, 5.3),
        w("Kenapa", 6.0, 6.5), w("ini", 6.6, 6.9), w("terjadi?", 7.0, 7.8),
        w("Akhir", 9.0, 9.5)]


def hook_scorer(text):
    return 1.0 if "?" in text else 0.3


# --- timelines ---------------------------------------------------------------------

class TestHookPlanning:
    def test_sentences_split_on_punctuation_and_pauses(self):
        assert [[x["text"] for x in s] for s in captions.sentences(TALK)] == [
            ["Halo", "semua."], ["Ini", "biasa", "saja."], ["Kenapa", "ini", "terjadi?"], ["Akhir"]]
        assert captions.sentences([]) == []

    def test_finds_the_strongest_later_line(self):
        assert captions.find_hook(TALK, 10.0, scorer=hook_scorer) == (5.9, 7.95)

    def test_no_hook_when_weak_too_early_or_wrong_length(self):
        assert captions.find_hook(TALK, 10.0, scorer=lambda t: 0.5) is None
        early = [w("Kenapa", 0.5, 1.0), w("begitu?", 1.0, 2.0)]
        assert captions.find_hook(early, 10.0, scorer=hook_scorer) is None
        long = [w("Kenapa", 4.0, 4.5), w("panjang?", 4.5, 11.0)]
        assert captions.find_hook(long, 12.0, scorer=hook_scorer) is None

    def test_default_scorer_is_the_pipeline_hook_scorer(self):
        line = [w("Apa", 5.0, 5.4), w("rahasianya?", 5.5, 6.6)]
        assert captions.find_hook(line, 10.0) is not None

    def test_plan_timeline_combinations(self):
        assert captions.plan_timeline(TALK, 10.0) == [(0.0, 10.0)]
        hook = captions.plan_timeline(TALK, 10.0, hook_first=True, scorer=hook_scorer)
        assert hook == [(5.9, 7.95), (0.0, 10.0)]
        assert not captions.is_monotonic(hook)
        both = captions.plan_timeline(TALK, 10.0, silence_trim=True, hook_first=True, scorer=hook_scorer)
        assert both[0] == (5.9, 7.95) and captions.is_monotonic(both[1:])
        assert captions.plan_timeline(TALK, 10.0, hook_first=True, scorer=lambda t: 0) == [(0.0, 10.0)]
        assert captions.timeline_duration(hook) == 12.05

    def test_hook_words_play_twice(self):
        mapped = captions.map_words(TALK, [(5.9, 7.95), (0.0, 10.0)])
        texts = [x["text"] for x in mapped]
        assert texts[:3] == ["Kenapa", "ini", "terjadi?"] and texts.count("Kenapa") == 2
        assert mapped[3]["start"] == pytest.approx(2.05)          # "Halo" after the 2.05 s hook

    def test_concat_graph(self):
        g = captions.concat_graph([(1.0, 2.0), (0.0, 3.0)])
        assert g.startswith("[0:v]trim=start=1.000:end=2.000,setpts=PTS-STARTPTS[v0]")
        assert g.endswith("[v0][a0][v1][a1]concat=n=2:v=1:a=1[cv][ca]")


class TestTimelineTrack:
    def test_track_follows_hook_replay(self):
        track = [(0.0, 0.2), (6.5, 0.8)]
        out = reframe.timeline_track(track, [(5.9, 7.95), (0.0, 10.0)])
        # hook starts at 0.2 → switches to 0.8 at 0.6 s; main clip restarts at 0.2, switches at 2.05+6.5
        assert out == [(0.0, 0.2), (0.6, 0.8), (2.05, 0.2), (8.55, 0.8)]

    def test_identical_centres_collapse(self):
        assert reframe.timeline_track([(0.0, 0.5)], [(0.0, 2.0), (4.0, 5.0)]) == [(0.0, 0.5)]


class TestRenderHookFirst:
    def test_non_monotonic_timeline_uses_concat(self):
        cmd = render._build_render_cmd("ffmpeg", "in.mp4", 0, 10, "o.mp4", False,
                                       timeline=[(5.9, 7.95), (0.0, 10.0)])
        graph = cmd[cmd.index("-filter_complex") + 1]
        assert "concat=n=2:v=1:a=1[cv][ca]" in graph and graph.endswith("format=yuv420p[v]")
        assert cmd[cmd.index("-map") + 1] == "[v]" and "[ca]" in cmd and "-af" not in cmd

    def test_concat_with_blur(self):
        cmd = render._build_render_cmd("ffmpeg", "in.mp4", 0, 10, "o.mp4", False,
                                       timeline=[(5.0, 6.0), (0.0, 10.0)], reframe=reframe.video_filter("blur"))
        assert ";[cv]null[in];[in]split=2" in cmd[cmd.index("-filter_complex") + 1]

    def test_main_reports_hook(self, monkeypatch, capsys, tmp_path):
        seg = tmp_path / "s.json"
        seg.write_text(json.dumps({"scoredSegments": [{"rank": 1, "tier": "PRIMARY", "startTime": 0, "endTime": 10}]}))
        tr = tmp_path / "t.json"
        tr.write_text(json.dumps({"segments": [{"start": 0, "end": 10, "text": "x", "words": TALK}]}))
        seen = {}

        def fake_render(video, start, end, out, timeline=None, reframe=None):
            seen["timeline"] = timeline
            open(out, "wb").write(b"x")
        monkeypatch.setattr(render, "render_clip", fake_render)
        monkeypatch.setattr(captions, "find_hook", lambda words, d, scorer=None: (5.9, 7.95))
        monkeypatch.setattr(sys, "argv", ["render.py", "--segments", str(seg), "--video", "v", "--output-dir",
                                          str(tmp_path / "r"), "--transcript", str(tr), "--hook-first",
                                          "--reframe", "center"])
        render.main()
        clip = json.loads(capsys.readouterr().out)["data"]["clips"][0]
        assert seen["timeline"] == [(5.9, 7.95), (0.0, 10.0)]
        assert clip["hookFirst"] is True and clip["trimmedDuration"] == 12.05


# --- subtitle: hook-first words, music -------------------------------------------------

class TestSubtitleEditing:
    def test_clip_words_follow_hook_timeline(self, monkeypatch):
        monkeypatch.setattr(captions, "find_hook", lambda words, d, scorer=None: (5.9, 7.95))
        segs = [{"start": 0, "end": 10, "words": TALK}]
        words = subtitle.clip_words(segs, {"startTime": 0, "endTime": 10}, hook_first=True)
        assert words[0]["text"] == "Kenapa" and words[0]["start"] == pytest.approx(0.1)

    def test_burn_cmd_with_music_ducking(self):
        cmd = subtitle._build_burn_cmd("ffmpeg", "r.mp4", "c.ass", "o.mp4", False, bgm="song.mp3", bgm_volume=0.2)
        assert cmd[cmd.index("-stream_loop") + 1] == "-1" and "song.mp3" in cmd
        graph = cmd[cmd.index("-filter_complex") + 1]
        assert graph.startswith("[0:v]ass='c.ass',format=yuv420p[vout];[0:a]asplit=2[voice][sc]")
        assert "[1:a]volume=0.200[bg]" in graph and "sidechaincompress" in graph and "amix=inputs=2" in graph
        assert cmd[cmd.index("-c:a") + 1] == "aac" and "-vf" not in cmd
        plain = subtitle._build_burn_cmd("ffmpeg", "r.mp4", None, "o.mp4", False)
        assert plain[plain.index("-c:a") + 1] == "copy"

    def test_main_rejects_missing_music(self, monkeypatch, capsys, tmp_path):
        monkeypatch.setattr(sys, "argv", ["subtitle.py", "--transcript", "t", "--segments", "s", "--render-dir", "r",
                                          "--output-dir", str(tmp_path), "--bgm", str(tmp_path / "nope.mp3")])
        with pytest.raises(SystemExit):
            subtitle.main()
        out = json.loads(capsys.readouterr().out)
        assert out["success"] is False and "background music not found" in out["error"]

    def test_main_passes_music_through(self, monkeypatch, capsys, tmp_path):
        (tmp_path / "r").mkdir()
        (tmp_path / "r" / "clip_1.mp4").write_bytes(b"x")
        song = tmp_path / "song.mp3"
        song.write_bytes(b"x")
        seg = tmp_path / "s.json"
        seg.write_text(json.dumps({"scoredSegments": [{"rank": 1, "tier": "PRIMARY", "startTime": 0, "endTime": 5}]}))
        tr = tmp_path / "t.json"
        tr.write_text(json.dumps({"segments": []}))
        got = {}

        def burn(render_path, ass, out, bgm=None, bgm_volume=None):
            got.update(bgm=bgm, vol=bgm_volume)
            open(out, "wb").write(b"x")
        monkeypatch.setattr(subtitle, "burn_subtitles", burn)
        monkeypatch.setattr(sys, "argv", ["subtitle.py", "--transcript", str(tr), "--segments", str(seg),
                                          "--render-dir", str(tmp_path / "r"), "--output-dir", str(tmp_path / "e"),
                                          "--bgm", str(song), "--bgm-volume", "0.3"])
        subtitle.main()
        assert got == {"bgm": str(song), "vol": 0.3}


# --- YouTube captions ------------------------------------------------------------------

AUTO = {"events": [
    {"tStartMs": 1000, "dDurationMs": 2000, "segs": [
        {"utf8": "halo", "tOffsetMs": 0}, {"utf8": " semua", "tOffsetMs": 600}]},
    {"tStartMs": 3000, "dDurationMs": 1000, "segs": [{"utf8": "\n"}]},
    {"tStartMs": 5000, "dDurationMs": 1500, "segs": [{"utf8": "apa kabar"}]},
]}


class TestYoutubeCaptions:
    def test_parse_auto_and_uploaded_tracks(self):
        segs = ytc.parse_json3(AUTO)
        assert [s["text"] for s in segs] == ["halo semua", "apa kabar"]
        # last word capped at 1 s, not stretched to the event's display end (3.0)
        assert segs[0]["words"] == [w("halo", 1.0, 1.6), w("semua", 1.6, 2.6)]
        assert "words" not in segs[1] and segs[1]["start"] == 5.0 and segs[1]["end"] == 6.5
        assert ytc.parse_json3({}) == []

    def test_window_shifts_to_section(self):
        segs = ytc.parse_json3(AUTO)
        out = ytc.window(segs, 1.5, 6.0)
        # "halo" was spoken before the window → dropped; the segment is rebuilt from "semua"
        assert out[0] == {"index": 0, "start": 0.1, "end": 1.1, "text": "semua", "words": [w("semua", 0.1, 1.1)]}
        assert out[1]["start"] == 3.5 and out[1]["end"] == 4.5
        assert ytc.window(segs) is segs
        assert ytc.window(segs, 10.0, None) == []

    def test_non_speech_tags_are_dropped(self):
        data = {"events": [
            {"tStartMs": 0, "dDurationMs": 1000, "segs": [{"utf8": "[tertawa]"}]},
            {"tStartMs": 1000, "dDurationMs": 2000, "segs": [{"utf8": "[Musik]", "tOffsetMs": 0}, {"utf8": " ayo", "tOffsetMs": 500}]},
            {"tStartMs": 3000, "dDurationMs": 1000, "segs": [{"utf8": "[Musik]", "tOffsetMs": 0}, {"utf8": " [Tepuk tangan]", "tOffsetMs": 200}]},
            {"tStartMs": 5000, "dDurationMs": 1000, "segs": [{"utf8": "[Musik] halo  semua"}]},
        ]}
        segs = ytc.parse_json3(data)
        assert [s["text"] for s in segs] == ["ayo", "halo semua"]
        assert segs[0]["words"] == [w("ayo", 1.5, 2.5)]

    def test_fetch_prefers_uploaded_then_auto(self, monkeypatch):
        calls = []

        def run(cmd, **kw):
            calls.append(cmd)
            if "--write-auto-subs" in cmd:
                out = cmd[cmd.index("-o") + 1].replace("%(id)s.%(ext)s", "abc.id.json3")
                with open(out, "w", encoding="utf-8") as f:
                    json.dump(AUTO, f)
            return types.SimpleNamespace(returncode=0)
        monkeypatch.setattr(subprocess, "run", run)
        assert ytc.fetch_json3("u", "id", allow_auto=False) == (None, None)
        path, kind = ytc.fetch_json3("u", "id", allow_auto=True)
        assert kind == "auto" and json.load(open(path, encoding="utf-8")) == AUTO
        os.remove(path)

        def missing(cmd, **kw):
            raise FileNotFoundError()
        monkeypatch.setattr(subprocess, "run", missing)
        assert ytc.fetch_json3("u", "id", allow_auto=True) == (None, None)

    def run_main(self, monkeypatch, capsys, *argv):
        monkeypatch.setattr(sys, "argv", ["youtube_captions.py", *argv])
        code = 0
        try:
            ytc.main()
        except SystemExit as e:
            code = e.code
        return code, json.loads(capsys.readouterr().out.strip().splitlines()[-1])

    def test_main(self, monkeypatch, capsys, tmp_path):
        out = tmp_path / "t" / "vid.json"
        monkeypatch.setattr(ytc, "fetch_json3", lambda *a, **k: (None, None))
        code, env = self.run_main(monkeypatch, capsys, "--url", "u", "--output", str(out))
        assert env == {"success": True, "data": {"found": False}} and not out.exists()

        def fetched(*a, **k):
            p = tmp_path / "x.json3"
            p.write_text(json.dumps(AUTO), encoding="utf-8")
            return str(p), "uploaded"
        monkeypatch.setattr(ytc, "fetch_json3", fetched)
        code, env = self.run_main(monkeypatch, capsys, "--url", "u", "--output", str(out))
        assert env["data"]["found"] is True and env["data"]["source"] == "youtube-uploaded"
        assert json.loads(out.read_text(encoding="utf-8"))["videoId"] == "vid"

        code, env = self.run_main(monkeypatch, capsys, "--url", "u", "--output", str(out), "--start", "100")
        assert env == {"success": True, "data": {"found": False}}           # nothing inside the section

        def boom(*a, **k):
            raise RuntimeError("yt down")
        monkeypatch.setattr(ytc, "fetch_json3", boom)
        code, env = self.run_main(monkeypatch, capsys, "--url", "u", "--output", str(out))
        assert code == 1 and env == {"success": False, "error": "yt down"}


# --- caption editor CLI -------------------------------------------------------------

class TestCaptionsCli:
    def test_absolute_words_for_range(self, tmp_path, capsys):
        tr = tmp_path / "t.json"
        tr.write_text(json.dumps({"segments": [{"start": 10, "end": 14, "words": [
            w("satu", 10.0, 10.5), w(",", 10.5, 10.6), w("dua", 12.0, 12.5), w("tiga", 15.0, 15.5)]}]}))
        captions.main(["--transcript", str(tr), "--start", "10", "--end", "13"])
        assert json.loads(capsys.readouterr().out)["data"]["words"] == [w("satu,", 10.0, 10.6), w("dua", 12.0, 12.5)]

    def test_error(self, tmp_path, capsys):
        with pytest.raises(SystemExit):
            captions.main(["--transcript", str(tmp_path / "x.json"), "--start", "0", "--end", "1"])
        assert json.loads(capsys.readouterr().out)["success"] is False


# --- real ffmpeg ----------------------------------------------------------------------

def probe(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type:format=duration",
                          "-of", "json", path], capture_output=True, text=True, check=True).stdout
    data = json.loads(out)
    return float(data["format"]["duration"]), {s["codec_type"] for s in data["streams"]}


@pytest.fixture(scope="module")
def media(tmp_path_factory):
    if not HAS_FFMPEG:
        pytest.skip("ffmpeg/ffprobe not on PATH")
    d = tmp_path_factory.mktemp("edit")
    src, song = d / "src.mp4", d / "song.m4a"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=25:duration=10",
                    "-f", "lavfi", "-i", "sine=frequency=440:duration=10", "-shortest", "-pix_fmt", "yuv420p",
                    "-c:v", "libx264", "-c:a", "aac", str(src)], check=True, capture_output=True)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=220:duration=3",
                    "-c:a", "aac", str(song)], check=True, capture_output=True)
    return str(src), str(song)


class TestRealFfmpeg:
    def test_hook_first_render_is_hook_plus_clip(self, media, tmp_path, monkeypatch):
        monkeypatch.setattr(render, "_probe_nvenc", lambda p: False)
        out = str(tmp_path / "hook.mp4")
        render.render_clip(media[0], 0, 8, out, timeline=[(5.0, 7.0), (0.0, 8.0)],
                           reframe=reframe.video_filter("face", (640, 360), [(0.0, 0.3)]))
        dur, kinds = probe(out)
        assert dur == pytest.approx(10.0, abs=0.25) and kinds == {"video", "audio"}

    def test_music_mix_keeps_clip_length(self, media, tmp_path, monkeypatch):
        monkeypatch.setattr(subtitle, "_probe_nvenc", lambda p: False)
        out = str(tmp_path / "bgm.mp4")
        subtitle.burn_subtitles(media[0], None, out, bgm=media[1], bgm_volume=0.2)   # 3 s song looped under 10 s
        dur, kinds = probe(out)
        assert dur == pytest.approx(10.0, abs=0.25) and kinds == {"video", "audio"}
