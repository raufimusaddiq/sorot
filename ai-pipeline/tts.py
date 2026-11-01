#!/usr/bin/env python3
"""Local text-to-speech on a GPU install: a script in, a wav out. Uses KittenTTS 2 (KittenML).

Install the extra packages with requirements-tts.txt (the CUDA image does it; the CPU image does
not). Prints the usual JSON envelope; progress goes to stderr as "PROGRESS n".

KittenTTS speaks 20 languages, but Indonesian is not one of them. The voice carries the language:
English text takes an English voice (Bruno by default), a language with its own voice takes that
one, and anything else needs ``--voice <reference.wav>``: a 5 to 30 second recording of one
speaker, which the model clones. The Settings voice for a language is that value.
"""

import argparse
import json
import os
import re
import sys

MODEL = os.environ.get("KITTEN_TTS_MODEL", "KittenML/kitten-tts-2")
# "emb4" halves the download (492 MB instead of 954 MB) at a small cost in quality.
WEIGHTS = os.environ.get("KITTEN_TTS_WEIGHTS", "")
ENGLISH_VOICE = "Bruno"
# Languages the model ships a built-in voice for, named after the language.
LANGUAGE_VOICES = {
    "ar": "Arabic", "zh": "Chinese", "fr": "French", "de": "German", "hi": "Hindi",
    "it": "Italian", "pt": "Portuguese", "ru": "Russian", "es": "Spanish",
}
SENTENCE = re.compile(r"(?<=[.!?…])\s+")
# A pause between sentences, in seconds.
GAP_SEC = 0.25


def split_sentences(text):
    """The script as sentences, so progress can be reported."""
    parts = [p.strip() for p in SENTENCE.split(text.strip()) if p.strip()]
    return parts or [text.strip()]


def pick_voice(language, voice):
    """('voice', name) or ('reference', path). Raises ValueError when the language has nothing to speak it with."""
    if voice:
        return ("reference", voice) if os.path.isfile(voice) else ("voice", voice)
    if language == "en":
        return ("voice", ENGLISH_VOICE)
    if language in LANGUAGE_VOICES:
        return ("voice", LANGUAGE_VOICES[language])
    raise ValueError(
        f"KittenTTS has no built-in voice for '{language}'. Set this language's voice in Settings to a "
        "reference recording (a 5 to 30 s .wav of one speaker, which is cloned), or use an online voice engine."
    )


def synthesize(text, language, voice, device):
    """(samples as a float list, sample rate). Imports are lazy: the CPU image has no kittenml."""
    from kittenml import KittenTTS

    kind, who = pick_voice(language, voice)
    model = KittenTTS(MODEL, device=device, **({"weights": WEIGHTS} if WEIGHTS else {}))
    rate = model.sample_rate
    out = []
    sentences = split_sentences(text)
    for i, sentence in enumerate(sentences):
        audio = model.generate(sentence, normalize=(language == "en"), **{kind: who})
        out.extend(float(x) for x in audio)
        out.extend([0.0] * int(rate * GAP_SEC))
        print(f"PROGRESS {int((i + 1) / len(sentences) * 100)}", file=sys.stderr, flush=True)
    return out, rate


def write_wav(path, samples, rate):
    import numpy as np
    import soundfile as sf

    sf.write(path, np.clip(np.asarray(samples, dtype="float32"), -1, 1), rate)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--text", required=True)
    p.add_argument("--language", default="en")
    p.add_argument("--output", required=True)
    p.add_argument("--voice", default="")
    args = p.parse_args()
    try:
        pick_voice(args.language, args.voice)      # fail before loading a model the language cannot use
        import torch

        device = "cuda" if torch.cuda.is_available() else "cpu"
        if device == "cpu":
            raise RuntimeError("the local voice needs a GPU install")
        samples, rate = synthesize(args.text, args.language, args.voice, device)
        write_wav(args.output, samples, rate)
        print(json.dumps({"success": True, "data": {"path": args.output, "durationSec": round(len(samples) / rate, 3), "model": MODEL}}))
    except Exception as e:  # the envelope is the contract: never a traceback on stdout
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
