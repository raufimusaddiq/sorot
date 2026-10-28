"""captions.py — word extraction, grouping, ASS output, silence trimming —
plus real-ffmpeg integration: a silence-trimmed render and a libass burn."""

import json
import os
import shutil
import subprocess
import sys
import types

import pytest

import captions
import render
import subtitle

HAS_FFMPEG = shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


def w(text, start, end):
    return {"text": text, "start": start, "end": end}


# --- words --------------------------------------------------------------------

class TestWordsForClip:
    def test_uses_real_word_timing_clipped_to_range(self):
        segs = [{"start": 9.0, "end": 14.0, "text": "satu dua tiga", "words": [
            {"text": "satu", "start": 9.0, "end": 10.5},     # straddles clip start
            {"text": "dua", "start": 11.0, "end": 11.4},
            {"text": "tiga", "start": 13.5, "end": 14.0},    # after clip end
        ]}]
        out = captions.words_for_clip(segs, 10.0, 12.0)
        assert out == [w("satu", 0.0, 0.5), w("dua", pytest.approx(1.0), pytest.approx(1.4))]

    def test_legacy_segments_without_words_are_split_evenly(self):
        out = captions.words_for_clip([{"start": 0, "end": 4, "text": "a b c d"}], 0, 4)
        assert [x["start"] for x in out] == [0, 1, 2, 3]
        assert captions.words_for_clip([{"start": 0, "end": 4, "text": "   "}], 0, 4) == []
        assert captions.words_for_clip([{"start": 0, "end": 4, "words": [{"word": "alias", "start": 0, "end": 1}]}],
                                       0, 4)[0]["text"] == "alias"


class TestSanitize:
    def test_punctuation_folding_escaping_and_monotonic_timing(self):
        out = captions.sanitize_words([
            w("\u201c", 0.0, 0.1),          # leading punctuation, nothing to attach to → dropped
            w(" Halo{\\b1} ", 0.2, 0.5),    # braces/backslash stripped
            w(",", 0.5, 0.6),               # folded into previous word, end extended
            w("dunia", 0.4, 0.4),           # zero length → minimum length
            w("", 1.0, 1.1),
            w("?”", 1.0, 1.2),
            w("lagi", 0.1, 0.3),            # starts before previous word → clamped to it
        ])
        assert [x["text"] for x in out] == ["Halob1,", "dunia?”", "lagi"]
        assert out[0]["end"] == 0.6
        assert out[1]["start"] == 0.4 and out[1]["end"] == 1.2
        assert out[2]["start"] == 0.4 and out[2]["end"] == pytest.approx(0.45)


    def test_rejoins_indonesian_reduplication(self):
        # Real Whisper output for "gedung-gedung" (buildings).
        out = captions.sanitize_words([w("gedung", 6.22, 6.52), w("-gedung", 6.52, 6.8),
                                       w("-", 7.0, 7.1), w("lain", 7.2, 7.4), w("-nya", 9.0, 9.2)])
        assert [x["text"] for x in out] == ["gedung-gedung-", "lain", "-nya"]
        assert out[0]["end"] == 7.1      # "-" punctuation also folded in
        assert out[2]["start"] == 9.0    # "-nya" after a long pause stays separate


class TestGrouping:
    def test_breaks_on_count_chars_pause_and_sentence_end(self):
        words = [w("satu", 0, 0.3), w("dua", 0.3, 0.6), w("tiga", 0.6, 0.9), w("empat", 0.9, 1.2),
                 w("lima", 2.5, 2.8),                       # long pause before
                 w("selesai.\u201d", 2.8, 3.0), w("baru", 3.0, 3.2),
                 w("supercalifragilistik", 3.2, 3.5)]
        groups = captions.group_words(words, max_words=3, max_chars=18, gap=0.5)
        assert [[x["text"] for x in g] for g in groups] == [
            ["satu", "dua", "tiga"], ["empat"], ["lima", "selesai.\u201d"], ["baru"], ["supercalifragilistik"],
        ]
        assert captions.group_words([]) == []


class TestAss:
    def test_colors_times_and_presets(self):
        assert captions.ass_color("#FFE600") == "&H0000E6FF"
        assert captions.ass_color("#000000", 0x80) == "&H80000000"
        assert captions.ass_time(3725.456) == "1:02:05.46"
        assert captions.ass_time(-1) == "0:00:00.00"
        assert captions.get_preset("HORMOZI")["highlight"] == "#39FF14"
        assert captions.get_preset("nope") is captions.PRESETS["default"]
        assert captions.get_preset(None) is captions.PRESETS["default"]

    def test_one_event_per_word_with_active_highlight(self):
        doc = captions.build_ass([w("halo", 0.0, 0.4), w("dunia!", 0.5, 0.6), w("lagi", 3.0, 3.1)], "default")
        assert "PlayResX: 1080" in doc and "PlayResY: 1920" in doc
        events = [l for l in doc.splitlines() if l.startswith("Dialogue:")]
        assert len(events) == 3
        hl = captions.ass_color("#FFE600")
        assert events[0] == f"Dialogue: 0,0:00:00.00,0:00:00.50,Caption,,0,0,0,,{{\\c{hl}}}HALO{{\\r}} DUNIA!"
        assert events[1].endswith(f"HALO {{\\c{hl}}}DUNIA!{{\\r}}")
        assert events[1].split(",")[2] == "0:00:00.80"        # held to the minimum event length
        assert "LAGI" in events[2] and "HALO" not in events[2]  # sentence end + pause → new group
        assert "\\fscx" not in doc                             # no scale pop → no line jitter

    def test_events_never_overlap(self):
        # quick words (< MIN_EVENT_SEC apart) inside a group and across groups —
        # overlapping events are stacked by libass and the line shows twice
        words = [w("kayak", 2.36, 2.50), w("un", 2.50, 2.68), w("milk", 2.68, 2.92), w("gitu.", 2.92, 3.08),
                 w("malem", 3.24, 3.88), w("gue", 3.88, 4.00), w("suka", 4.00, 4.10), w("x", 4.10, 4.10), w("lagi", 4.10, 4.5)]
        events = [l.split(",", 3) for l in captions.build_ass(words).splitlines() if l.startswith("Dialogue:")]
        times = [(e[1], e[2]) for e in events]
        for (s1, e1), (s2, _) in zip(times, times[1:]):
            assert e1 <= s2 and s1 < e1
        assert times[0] == ("0:00:02.36", "0:00:02.50")
        assert times[-1][1] == "0:00:04.50"          # last word keeps its own end
        assert len(events) == len(words) - 1          # "x" starts with "lagi": zero length, dropped

    def test_mixed_case_preset_and_custom_dict(self):
        doc = captions.build_ass([w("Halo", 0, 1)], "storyteller")
        assert "Halo{\\r}" in doc and "HALO" not in doc
        custom = {**captions.PRESETS["default"], "highlight": "#FF0000"}
        assert "&H000000FF" in captions.build_ass([w("x", 0, 1)], custom)

    def test_filter_path_escaping(self):
        assert captions.ffmpeg_filter_path(r"C:\a\b'c.ass") == r"'C\:/a/b\'c.ass'"
        assert captions.ffmpeg_filter_path("/data/x.ass") == "'/data/x.ass'"


# --- silence trimming ------------------------------------------------------------

class TestKeepIntervals:
    def test_cuts_long_pauses_and_edges_with_padding(self):
        words = [w("a", 1.0, 2.0), w("b", 2.2, 3.0), w("c", 6.0, 7.0)]
        assert captions.keep_intervals(words, 10.0, min_gap=0.6, pad=0.15) == [(0.85, 3.15), (5.85, 7.15)]

    def test_padding_merges_close_spans_and_noop_cases(self):
        assert captions.keep_intervals([w("a", 0.1, 1.0), w("b", 1.7, 2.0)], 2.0, min_gap=0.6, pad=0.4) == [(0.0, 2.0)]
        assert captions.keep_intervals([], 5.0) == [(0.0, 5.0)]
        assert captions.keep_intervals([w("a", 0, 1)], 0) == [(0.0, 0)]
        assert captions.keep_intervals([w("a", 0.0, 4.98)], 5.0) == [(0.0, 5.0)]

    def test_timeline_mapping_and_select_expr(self):
        keep = [(1.0, 2.0), (5.0, 6.0)]
        words = [w("a", 0.2, 0.6), w("b", 1.2, 1.6), w("c", 5.5, 5.9), w("d", 5.9, 5.9)]
        mapped = captions.map_words(words, keep)
        assert [(x["text"], x["start"]) for x in mapped] == [("b", 0.2), ("c", 1.5), ("d", 1.9)]
        assert mapped[-1]["end"] == pytest.approx(1.95)              # minimum word length kept
        assert captions.select_expr(keep) == "between(t,1.000,2.000)+between(t,5.000,6.000)"


class TestStageWiring:
    def test_render_cmd_adds_select_filters_only_when_trimming(self):
        plain = render._build_render_cmd("ffmpeg", "in.mp4", 0, 5, "o.mp4", False)
        assert "-af" not in plain and plain[plain.index("-vf") + 1].startswith("crop=")
        trimmed = render._build_render_cmd("ffmpeg", "in.mp4", 0, 5, "o.mp4", False, timeline=[(0.5, 1.5)])
        assert trimmed[trimmed.index("-vf") + 1].startswith("select='between(t,0.500,1.500)',setpts=")
        assert trimmed[trimmed.index("-af") + 1] == "aselect='between(t,0.500,1.500)',asetpts=N/SR/TB"

    def test_render_main_trims_and_requires_transcript(self, monkeypatch, capsys, tmp_path):
        seg = tmp_path / "s.json"
        seg.write_text(json.dumps({"scoredSegments": [{"rank": 1, "tier": "PRIMARY", "startTime": 10, "endTime": 20}]}))
        tr = tmp_path / "t.json"
        tr.write_text(json.dumps({"segments": [{"start": 10, "end": 20, "text": "a b", "words": [
            {"text": "a", "start": 11, "end": 12}, {"text": "b", "start": 17, "end": 18}]}]}))
        seen = {}

        def fake_render(video, start, end, out, timeline=None, reframe=None, burn=None):
            seen["keep"] = timeline
            open(out, "wb").write(b"x")
        monkeypatch.setattr(render, "render_clip", fake_render)

        def run(*extra):
            monkeypatch.setattr(sys, "argv", ["render.py", "--segments", str(seg), "--video", "v",
                                              "--output-dir", str(tmp_path / "r"), *extra])
            try:
                render.main()
            except SystemExit as e:
                assert e.code == 1
            return json.loads(capsys.readouterr().out.strip().splitlines()[-1])

        env = run("--silence-trim", "--transcript", str(tr))
        assert seen["keep"] == [(0.85, 2.15), (6.85, 8.15)]
        assert env["data"]["clips"][0]["trimmedDuration"] == 2.6
        env = run()
        assert seen["keep"] is None and env["data"]["clips"][0]["trimmedDuration"] is None
        env = run("--silence-trim")
        assert env == {"success": False, "error": "--silence-trim/--hook-first require --transcript"}

    def test_subtitle_words_follow_the_trimmed_timeline(self):
        segs = [{"start": 0, "end": 10, "words": [{"text": "a", "start": 1, "end": 2}, {"text": "b", "start": 7, "end": 8}]}]
        seg = {"startTime": 0, "endTime": 10}
        assert [x["start"] for x in subtitle.clip_words(segs, seg)] == [1, 7]
        assert [x["start"] for x in subtitle.clip_words(segs, seg, silence_trim=True)] == [0.15, 1.45]
        one = [{"start": 0, "end": 1, "words": [{"text": "a", "start": 0, "end": 1}]}]
        assert subtitle.clip_words(one, {"startTime": 0, "endTime": 1}, silence_trim=True)[0]["start"] == 0

    def test_subtitle_main_without_speech_skips_ass(self, monkeypatch, capsys, tmp_path):
        (tmp_path / "r").mkdir()
        (tmp_path / "r" / "clip_1.mp4").write_bytes(b"x")
        seg = tmp_path / "s.json"
        seg.write_text(json.dumps({"scoredSegments": [{"rank": 1, "tier": "PRIMARY", "startTime": 0, "endTime": 5}]}))
        tr = tmp_path / "t.json"
        tr.write_text(json.dumps({"segments": []}))
        burned = {}

        def burn(render_path, ass_path, out, **kw):
            burned["ass"] = ass_path
            open(out, "wb").write(b"x")
        monkeypatch.setattr(subtitle, "burn_subtitles", burn)
        monkeypatch.setattr(sys, "argv", ["subtitle.py", "--transcript", str(tr), "--segments", str(seg),
                                          "--render-dir", str(tmp_path / "r"), "--output-dir", str(tmp_path / "e"),
                                          "--style", "hormozi", "--silence-trim"])
        subtitle.main()
        env = json.loads(capsys.readouterr().out)
        assert burned["ass"] is None
        assert env["data"]["style"] == "hormozi"
        assert env["data"]["clips"][0] == {"rank": 1, "path": str(tmp_path / "e" / "clip_1_subtitled.mp4"),
                                           "assPath": None, "status": "COMPLETED", "wordCount": 0}


class TestTranscribeWords:
    def test_word_timestamps_are_saved(self, monkeypatch, capsys, tmp_path):
        import transcribe

        class Model:
            def __init__(self, *a, **k):
                pass

            def transcribe(self, *a, **k):
                words = [types.SimpleNamespace(word=" halo", start=0.01, end=0.4123, probability=0.987),
                         types.SimpleNamespace(word=" ", start=0.5, end=0.5, probability=0.1)]
                seg = types.SimpleNamespace(start=0, end=1, text="halo", avg_logprob=-0.1, words=words)
                return iter([seg]), types.SimpleNamespace(language="id")

        monkeypatch.setitem(sys.modules, "faster_whisper", types.SimpleNamespace(WhisperModel=Model))
        monkeypatch.setattr(sys, "argv", ["transcribe.py", "--audio", "a.wav", "--device", "cpu"])
        transcribe.main()
        seg = json.loads(capsys.readouterr().out)["data"]["segments"][0]
        assert seg["words"] == [{"text": "halo", "start": 0.01, "end": 0.412, "prob": 0.987}]

    def test_cpu_threads(self, monkeypatch):
        import transcribe
        monkeypatch.delenv("WHISPER_THREADS", raising=False)
        monkeypatch.setattr(transcribe.os, "cpu_count", lambda: 12)
        assert transcribe.cpu_threads("cpu") == 12          # every core, not faster-whisper's 4
        assert transcribe.cpu_threads("cuda") == 0          # library default on the GPU
        monkeypatch.setenv("WHISPER_THREADS", "6")
        assert transcribe.cpu_threads("cpu") == 6
        monkeypatch.setenv("WHISPER_THREADS", "lots")
        assert transcribe.cpu_threads("cpu") == 12
        monkeypatch.setattr(transcribe.os, "cpu_count", lambda: None)
        assert transcribe.cpu_threads("cpu") == 4


# --- real ffmpeg -------------------------------------------------------------------

def ffprobe_duration(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", path],
                         capture_output=True, text=True, check=True).stdout
    return float(json.loads(out)["format"]["duration"])


@pytest.fixture(scope="module")
def av_source(tmp_path_factory):
    if not HAS_FFMPEG:
        pytest.skip("ffmpeg/ffprobe not on PATH")
    out = tmp_path_factory.mktemp("av") / "src.mp4"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error",
                    "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=10",
                    "-f", "lavfi", "-i", "sine=frequency=440:duration=10",
                    "-shortest", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-c:a", "aac", str(out)],
                   check=True, capture_output=True)
    return str(out)


class TestRealFfmpeg:
    def test_silence_trimmed_render_has_the_kept_duration(self, av_source, tmp_path, monkeypatch):
        monkeypatch.setattr(render, "_probe_nvenc", lambda p: False)
        out = str(tmp_path / "trim.mp4")
        render.render_clip(av_source, 1, 9, out, timeline=[(0.5, 2.0), (4.0, 5.5)])   # 3 s of 8 s kept
        assert ffprobe_duration(out) == pytest.approx(3.0, abs=0.25)

    def test_burn_cmd_is_one_graph_with_preset(self, monkeypatch):
        monkeypatch.delenv("X264_PRESET", raising=False)
        cmd = render._build_render_cmd("ffmpeg", "in.mp4", 0, 5, "o.mp4", False, burn=("c.ass", "song.mp3", 0.2))
        graph = cmd[cmd.index("-filter_complex") + 1]
        assert "-vf" not in cmd and "ass='c.ass'" in graph and "sidechaincompress" in graph
        assert cmd.index("-stream_loop") > cmd.index("-i")                    # music is input 1
        assert cmd[-cmd[::-1].index("-map")] == "[aout]"
        assert cmd[cmd.index("-preset") + 1] == "veryfast"
        monkeypatch.setenv("X264_PRESET", "medium")
        plain = render._build_render_cmd("ffmpeg", "in.mp4", 0, 5, "o.mp4", False, burn=(None, None, 0.12))
        assert plain[plain.index("-preset") + 1] == "medium"
        assert plain[plain.index("-filter_complex") + 1].endswith("[v]format=yuv420p[vout]")   # no captions
        assert plain[-plain[::-1].index("-map")] == "0:a?" and "-stream_loop" not in plain

    def _one_pass(self, av_source, tmp_path, monkeypatch, capsys, *flags):
        """render.py main with --export-dir: framing + captions (+ music) in one encode."""
        monkeypatch.setattr(render, "_probe_nvenc", lambda p: False)
        transcript, segments = tmp_path / "t.json", tmp_path / "s.json"
        talk = [w("halo", 1.6, 2.0), w("semua", 2.1, 2.6), w("ini", 5.2, 5.6), w("rahasia", 5.7, 6.4)]
        transcript.write_text(json.dumps({"segments": [{"start": 1.6, "end": 6.4, "words": talk}]}), encoding="utf-8")
        segments.write_text(json.dumps({"videoId": "v", "scoredSegments": [
            {"index": 0, "rank": 1, "tier": "PRIMARY", "startTime": 1.0, "endTime": 9.0}]}), encoding="utf-8")
        export = tmp_path / "export dir"
        monkeypatch.setattr(sys, "argv", ["render.py", "--segments", str(segments), "--video", av_source,
                                          "--output-dir", str(tmp_path / "renders"), "--export-dir", str(export),
                                          "--transcript", str(transcript), "--style", "hormozi", *flags])
        render.main()
        clip = json.loads(capsys.readouterr().out)["data"]["clips"][0]
        assert clip["status"] == "COMPLETED" and clip["captioned"] is True and clip["wordCount"] == 4
        assert clip["path"] == str(export / "clip_1_subtitled.mp4")
        assert os.path.exists(export / "clip_1.ass") and not os.path.exists(tmp_path / "renders" / "clip_1.mp4")
        streams = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,width,height",
                                  "-of", "json", clip["path"]], capture_output=True, text=True, check=True).stdout
        kinds = {s["codec_type"]: s for s in json.loads(streams)["streams"]}
        assert (kinds["video"]["width"], kinds["video"]["height"]) == (1080, 1920) and "audio" in kinds
        return clip

    def test_one_pass_silence_trim_and_music(self, av_source, tmp_path, monkeypatch, capsys):
        bgm = tmp_path / "song.m4a"
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=220:duration=2",
                        "-c:a", "aac", str(bgm)], check=True, capture_output=True)
        clip = self._one_pass(av_source, tmp_path, monkeypatch, capsys, "--reframe", "center",
                              "--silence-trim", "--bgm", str(bgm), "--bgm-volume", "0.2")
        # Speech spans + padding kept; the 2 s song loops under all of it.
        assert ffprobe_duration(clip["path"]) == pytest.approx(clip["trimmedDuration"], abs=0.25)
        assert clip["trimmedDuration"] < 8

    def test_one_pass_hook_first_and_blur(self, av_source, tmp_path, monkeypatch, capsys):
        clip = self._one_pass(av_source, tmp_path, monkeypatch, capsys, "--reframe", "blur", "--hook-first")
        assert clip["hookFirst"] is True and clip["reframe"] == "blur"
        assert ffprobe_duration(clip["path"]) == pytest.approx(clip["trimmedDuration"], abs=0.25)

    def test_ass_burn_with_libass(self, av_source, tmp_path, monkeypatch):
        monkeypatch.setattr(subtitle, "_probe_nvenc", lambda p: False)
        ass = tmp_path / "dir with space" / "c.ass"
        ass.parent.mkdir()
        ass.write_text(captions.build_ass([w("halo", 0.2, 0.8), w("dunia", 0.9, 1.5)]), encoding="utf-8")
        out = str(tmp_path / "burned.mp4")
        subtitle.burn_subtitles(av_source, str(ass), out)
        assert os.path.getsize(out) > 0
        assert ffprobe_duration(out) == pytest.approx(10.0, abs=0.25)
