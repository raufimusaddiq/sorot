#!/usr/bin/env python3
"""Local text-to-speech on a GPU install: a script in, a wav out.

The default models are Meta's MMS-TTS (one small VITS model per language). Install the extra
packages with requirements-tts.txt (the CUDA image does it; the CPU image does not). Prints the
usual JSON envelope; progress goes to stderr as "PROGRESS n".
"""

import argparse
import json
import re
import sys

# Language → model. --voice picks another Hugging Face model id (any VITS/MMS-TTS model).
MODELS = {
    "id": "facebook/mms-tts-ind",
    "en": "facebook/mms-tts-eng",
}
SENTENCE = re.compile(r"(?<=[.!?…])\s+")
# A pause between sentences, in seconds.
GAP_SEC = 0.25


def split_sentences(text):
    """The script as sentences, so progress can be reported and long texts stay within the model's limit."""
    parts = [p.strip() for p in SENTENCE.split(text.strip()) if p.strip()]
    return parts or [text.strip()]


def synthesize(text, model_id, device):
    """(samples as a float list, sample rate). Imports are lazy: the CPU image has no torch."""
    import torch
    from transformers import AutoTokenizer, VitsModel

    tokenizer = AutoTokenizer.from_pretrained(model_id)
    model = VitsModel.from_pretrained(model_id).to(device)
    rate = model.config.sampling_rate
    out = []
    sentences = split_sentences(text)
    for i, sentence in enumerate(sentences):
        inputs = tokenizer(sentence, return_tensors="pt").to(device)
        with torch.no_grad():
            wave = model(**inputs).waveform[0].cpu().tolist()
        out.extend(wave)
        out.extend([0.0] * int(rate * GAP_SEC))
        print(f"PROGRESS {int((i + 1) / len(sentences) * 100)}", file=sys.stderr, flush=True)
    return out, rate


def write_wav(path, samples, rate):
    import numpy as np
    from scipy.io import wavfile

    wavfile.write(path, rate, (np.clip(np.asarray(samples, dtype="float32"), -1, 1) * 32767).astype("int16"))


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--text", required=True)
    p.add_argument("--language", default="id")
    p.add_argument("--output", required=True)
    p.add_argument("--voice", default="")
    args = p.parse_args()
    try:
        model_id = args.voice or MODELS.get(args.language)
        if not model_id:
            raise ValueError(f"no local voice for language '{args.language}': pass --voice <model id>")
        import torch

        device = "cuda" if torch.cuda.is_available() else "cpu"
        if device == "cpu":
            raise RuntimeError("the local voice needs a GPU install")
        samples, rate = synthesize(args.text, model_id, device)
        write_wav(args.output, samples, rate)
        print(json.dumps({"success": True, "data": {"path": args.output, "durationSec": round(len(samples) / rate, 3), "model": model_id}}))
    except Exception as e:  # the envelope is the contract: never a traceback on stdout
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
