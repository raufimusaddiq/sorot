"""tts.py with torch, transformers and scipy faked: no GPU, no model download."""

import json
import sys
import types

import pytest

import tts


class Tensor:
    def __init__(self, values):
        self.values = values

    def cpu(self):
        return self

    def tolist(self):
        return list(self.values)


class Inputs(dict):
    def to(self, device):
        return self


def install_fakes(monkeypatch, cuda=True, rate=100):
    """torch + transformers + scipy.io.wavfile, recording what was asked of them."""
    seen = {"models": [], "sentences": [], "wavs": []}

    torch = types.ModuleType("torch")
    torch.cuda = types.SimpleNamespace(is_available=lambda: cuda)

    class NoGrad:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    torch.no_grad = NoGrad

    class Tokenizer:
        @staticmethod
        def from_pretrained(model_id):
            seen["models"].append(model_id)
            return lambda sentence, return_tensors=None: (seen["sentences"].append(sentence) or Inputs(text=sentence))

    class Model:
        config = types.SimpleNamespace(sampling_rate=rate)

        @classmethod
        def from_pretrained(cls, model_id):
            return cls()

        def to(self, device):
            return self

        def __call__(self, **inputs):
            return types.SimpleNamespace(waveform=[Tensor([0.5] * 10)])

    transformers = types.ModuleType("transformers")
    transformers.AutoTokenizer = Tokenizer
    transformers.VitsModel = Model

    scipy = types.ModuleType("scipy")
    scipy_io = types.ModuleType("scipy.io")
    wavfile = types.ModuleType("scipy.io.wavfile")
    wavfile.write = lambda path, r, data: seen["wavs"].append((path, r, data))
    scipy.io = scipy_io
    scipy_io.wavfile = wavfile
    for name, mod in {"torch": torch, "transformers": transformers, "scipy": scipy, "scipy.io": scipy_io, "scipy.io.wavfile": wavfile}.items():
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
    assert tts.split_sentences("Halo. Apa kabar? Baik!") == ["Halo.", "Apa kabar?", "Baik!"]
    assert tts.split_sentences("tanpa titik") == ["tanpa titik"]
    assert tts.split_sentences("   ") == [""]


def test_speaks_each_sentence_reports_progress_and_writes_a_wav(monkeypatch, capsys, tmp_path):
    seen = install_fakes(monkeypatch)
    out = str(tmp_path / "v.wav")
    code, envelope, err = run(monkeypatch, capsys, "--text", "Halo. Apa kabar?", "--language", "id", "--output", out)
    assert code == 0
    assert seen["models"] == ["facebook/mms-tts-ind"]
    assert seen["sentences"] == ["Halo.", "Apa kabar?"]
    assert err.split() == ["PROGRESS", "50", "PROGRESS", "100"]
    path, rate, data = seen["wavs"][0]
    assert (path, rate, str(data.dtype)) == (out, 100, "int16")
    # two sentences of 10 samples, each followed by a 0.25 s pause at 100 Hz
    assert len(data) == 2 * (10 + 25)
    assert envelope == {"success": True, "data": {"path": out, "durationSec": 0.7, "model": "facebook/mms-tts-ind"}}


def test_another_model_can_be_named_and_english_has_its_own(monkeypatch, capsys, tmp_path):
    seen = install_fakes(monkeypatch)
    run(monkeypatch, capsys, "--text", "Hi.", "--language", "en", "--output", str(tmp_path / "a.wav"))
    run(monkeypatch, capsys, "--text", "Hi.", "--language", "fr", "--voice", "me/my-vits", "--output", str(tmp_path / "b.wav"))
    assert seen["models"] == ["facebook/mms-tts-eng", "me/my-vits"]


@pytest.mark.parametrize("argv,cuda,message", [
    (["--language", "fr"], True, "no local voice for language 'fr'"),
    (["--language", "id"], False, "needs a GPU install"),
])
def test_failures_are_an_envelope_and_a_non_zero_exit(monkeypatch, capsys, tmp_path, argv, cuda, message):
    install_fakes(monkeypatch, cuda=cuda)
    code, envelope, _ = run(monkeypatch, capsys, "--text", "Halo.", "--output", str(tmp_path / "x.wav"), *argv)
    assert code == 1
    assert envelope["success"] is False and message in envelope["error"]
