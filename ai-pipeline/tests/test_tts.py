"""tts.py with torch, kittenml and soundfile faked: no GPU, no model download."""

import json
import sys
import types

import pytest

import tts


def install_fakes(monkeypatch, cuda=True, rate=100):
    """torch + kittenml + soundfile, recording what was asked of them."""
    seen = {"models": [], "calls": [], "wavs": []}

    torch = types.ModuleType("torch")
    torch.cuda = types.SimpleNamespace(is_available=lambda: cuda)

    class Model:
        sample_rate = rate

        def __init__(self, model_id, **kwargs):
            seen["models"].append((model_id, kwargs))

        def generate(self, sentence, **kwargs):
            seen["calls"].append((sentence, kwargs))
            return [0.5] * 10

    kittenml = types.ModuleType("kittenml")
    kittenml.KittenTTS = Model

    soundfile = types.ModuleType("soundfile")
    soundfile.write = lambda path, data, r: seen["wavs"].append((path, r, data))

    for name, mod in {"torch": torch, "kittenml": kittenml, "soundfile": soundfile}.items():
        monkeypatch.setitem(sys.modules, name, mod)
    return seen


def run(monkeypatch, capsys, *argv):
    monkeypatch.setattr(sys, "argv", ["tts.py", *argv])
    code = 0
    try:
        tts.main()
    except SystemExit as e:
        code = e.code
    out = capsys.readouterr()
    return code, json.loads(out.out.strip().splitlines()[-1]), out.err


def test_splits_a_script_into_sentences():
    assert tts.split_sentences("Hello. How are you? Fine!") == ["Hello.", "How are you?", "Fine!"]
    assert tts.split_sentences("no full stop") == ["no full stop"]
    assert tts.split_sentences("   ") == [""]


def test_speaks_each_sentence_reports_progress_and_writes_a_wav(monkeypatch, capsys, tmp_path):
    seen = install_fakes(monkeypatch)
    out = str(tmp_path / "v.wav")
    code, envelope, err = run(monkeypatch, capsys, "--text", "Hello there. How are you?", "--language", "en", "--output", out)
    assert code == 0
    assert seen["models"] == [("KittenML/kitten-tts-2", {"device": "cuda"})]
    assert seen["calls"] == [("Hello there.", {"normalize": True, "voice": "Bruno"}), ("How are you?", {"normalize": True, "voice": "Bruno"})]
    assert err.split() == ["PROGRESS", "50", "PROGRESS", "100"]
    path, rate, data = seen["wavs"][0]
    assert (path, rate) == (out, 100)
    # two sentences of 10 samples, each followed by a 0.25 s pause at 100 Hz
    assert len(data) == 2 * (10 + 25)
    assert envelope == {"success": True, "data": {"path": out, "durationSec": 0.7, "model": "KittenML/kitten-tts-2"}}


def test_a_named_voice_a_language_voice_and_a_cloned_reference(monkeypatch, capsys, tmp_path):
    seen = install_fakes(monkeypatch)
    ref = tmp_path / "me.wav"
    ref.write_bytes(b"RIFF")
    run(monkeypatch, capsys, "--text", "Hi.", "--language", "en", "--voice", "Luna", "--output", str(tmp_path / "a.wav"))
    run(monkeypatch, capsys, "--text", "Guten Tag.", "--language", "de", "--output", str(tmp_path / "b.wav"))
    run(monkeypatch, capsys, "--text", "Halo semua.", "--language", "id", "--voice", str(ref), "--output", str(tmp_path / "c.wav"))
    assert [c[1] for c in seen["calls"]] == [
        {"normalize": True, "voice": "Luna"},                    # English text is normalised
        {"normalize": False, "voice": "German"},                 # other languages are not: the normaliser is English-tuned
        {"normalize": False, "reference": str(ref)},             # a recording is cloned
    ]


def test_the_weights_can_be_the_smaller_ones(monkeypatch, capsys, tmp_path):
    seen = install_fakes(monkeypatch)
    monkeypatch.setattr(tts, "WEIGHTS", "emb4")
    run(monkeypatch, capsys, "--text", "Hi.", "--output", str(tmp_path / "a.wav"))
    assert seen["models"][0][1] == {"device": "cuda", "weights": "emb4"}


@pytest.mark.parametrize("argv,cuda,message", [
    (["--language", "id"], True, "no built-in voice for 'id'"),
    (["--language", "id", "--voice", "Bruno"], False, "needs a GPU install"),
    (["--language", "en"], False, "needs a GPU install"),
])
def test_failures_are_an_envelope_and_a_non_zero_exit(monkeypatch, capsys, tmp_path, argv, cuda, message):
    seen = install_fakes(monkeypatch, cuda=cuda)
    code, envelope, _ = run(monkeypatch, capsys, "--text", "Halo.", "--output", str(tmp_path / "x.wav"), *argv)
    assert code == 1
    assert envelope["success"] is False and message in envelope["error"]
    assert seen["models"] == []                  # no model was loaded for a request that could not work
