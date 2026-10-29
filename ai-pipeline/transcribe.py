#!/usr/bin/env python3
"""Transcribe audio with faster-whisper, on CUDA or the CPU."""

import argparse
import json
import sys
import os
import re


def cpu_threads(device):
    """Threads for CPU inference: WHISPER_THREADS, else every core.
    faster-whisper's own default is 4, which left most of a bigger CPU idle."""
    if device != "cpu":
        return 0                      # unused on the GPU; 0 = library default
    try:
        n = int(os.environ.get("WHISPER_THREADS", "") or 0)
    except ValueError:
        n = 0
    return n if n > 0 else (os.cpu_count() or 4)


def beam_size():
    """WHISPER_BEAM_SIZE, else faster-whisper's 5. 1 (greedy) is faster on a
    CPU and somewhat less accurate: worth an A/B on your own videos."""
    try:
        n = int(os.environ.get("WHISPER_BEAM_SIZE", "") or 0)
    except ValueError:
        n = 0
    return n if n > 0 else 5


SAMPLE_RATE = 16000                   # faster_whisper.decode_audio's rate
TERMINAL = re.compile(r"[.!?…。？！][\"')\]]*$")
# Whisper conditions each 30 s window on the text before it, so once it writes
# a stretch without punctuation it can stay that way to the end of the file
# (seen from the first line of a 69 min video; no setting prevents it: see
# docs/journal/session-2026-10-28.md). Checked per DRIFT_BUCKET_SEC: a bucket
# with at least DRIFT_MIN_LINES lines of which under DRIFT_RATIO end a sentence.
DRIFT_BUCKET_SEC = 600
DRIFT_MIN_LINES = 20
DRIFT_RATIO = 0.5
# Languages Whisper doesn't punctuate: no drift check.
UNPUNCTUATED = {"th", "lo", "km", "my"}
# Shown to Whisper before every window of the re-run so it starts punctuated.
PUNCTUATED_PROMPT = {"id": "Halo, apa kabar? Baik, terima kasih. Jadi gini ceritanya, oke."}
# A re-run that drops speech (or loops on a phrase) can punctuate better and
# still be worse: it is kept only within this share of the words it replaces.
DRIFT_WORD_SLACK = 0.2
REDO_LABEL = "Re-transcribing (punctuation lost)"


def progress_printer(label=""):
    """on_progress for decode(): "PROGRESS 37" on stderr as segments arrive, or
    "PROGRESS 37 <label>" (the backend shows "<label> 37%"); never goes back."""
    reported = 0

    def progress(end, info):
        nonlocal reported
        duration = getattr(info, "duration", 0) or 0
        pct = min(99, int(end / duration * 100)) if duration > 0 else 0
        if pct > reported:
            reported = pct
            print(f"PROGRESS {pct}{' ' + label if label else ''}", file=sys.stderr, flush=True)
    return progress


def word_count(segments):
    return sum(len(s["text"].split()) for s in segments)


def punctuated(segments):
    """Share of lines that end a sentence."""
    return sum(1 for s in segments if TERMINAL.search(s["text"])) / len(segments) if segments else 1.0


def drift_start(segments, language):
    """Start (s) of the first bucket that lost its punctuation, else None."""
    if language in UNPUNCTUATED or not segments:
        return None
    buckets = {}
    for s in segments:
        buckets.setdefault(int(s["start"] // DRIFT_BUCKET_SEC), []).append(s)
    for b in sorted(buckets):
        if len(buckets[b]) >= DRIFT_MIN_LINES and punctuated(buckets[b]) < DRIFT_RATIO:
            return b * DRIFT_BUCKET_SEC
    return None


def decode(model, audio, language, offset=0.0, on_progress=None, **options):
    """Whisper segments as transcript dicts, shifted by `offset` s."""
    segments_gen, info = model.transcribe(
        audio,
        language=language,
        word_timestamps=True,
        vad_filter=True,
        beam_size=beam_size(),
        **options,
    )
    segments = []
    for seg in segments_gen:
        if on_progress:
            on_progress(seg.end, info)
        # Per-word timing drives karaoke captions and silence trimming
        # (captions.py). Older transcripts lack "words" and fall back to
        # an even split of the segment text.
        words = [
            {
                "text": w.word.strip(),
                "start": round(w.start + offset, 3),
                "end": round(w.end + offset, 3),
                "prob": round(w.probability, 3),
            }
            for w in (getattr(seg, "words", None) or [])
            if w.word.strip()
        ]
        segments.append({
            "start": round(seg.start + offset, 2),
            "end": round(seg.end + offset, 2),
            "text": seg.text.strip(),
            "confidence": round(seg.avg_logprob, 2) if seg.avg_logprob else None,
            "words": words,
        })
    return segments, info


def repair_drift(model, audio_path, language, segments):
    """Re-run Whisper from the first bucket that lost its punctuation, starting
    fresh with a punctuated prompt; keep the re-run only if it is better
    punctuated and holds about as many words as the part it replaces."""
    t0 = drift_start(segments, language)
    if t0 is None:
        return segments
    before = [s for s in segments if s["start"] < t0]
    after = [s for s in segments if s["start"] >= t0]
    # Resume where the last kept line ends, so no words are heard twice.
    cut = before[-1]["end"] if before else t0
    from faster_whisper import decode_audio
    audio = decode_audio(audio_path, sampling_rate=SAMPLE_RATE)
    prompt = PUNCTUATED_PROMPT.get(language)
    redo, _ = decode(model, audio[int(cut * SAMPLE_RATE):], language, offset=cut,
                     on_progress=progress_printer(REDO_LABEL), **({"hotwords": prompt} if prompt else {}))
    words, was = word_count(redo), word_count(after)
    better = abs(words - was) <= DRIFT_WORD_SLACK * was and punctuated(redo) > punctuated(after)
    print(f"Punctuation lost from {t0:.0f} s ({punctuated(after):.0%}); re-run: {punctuated(redo):.0%}, "
          f"{words}/{was} words, {'kept' if better else 'discarded'}", file=sys.stderr, flush=True)
    return before + redo if better else segments


def main():
    # Env overrides let the user A/B models without touching code. CLI args
    # still win when explicitly passed.
    default_model = os.environ.get("WHISPER_MODEL", "large-v3-turbo")
    default_device = os.environ.get("WHISPER_DEVICE", "cuda")
    default_compute = os.environ.get("WHISPER_COMPUTE_TYPE", "")

    parser = argparse.ArgumentParser(description="Transcribe audio file")
    parser.add_argument("--audio", required=True, help="Path to WAV audio file")
    parser.add_argument("--output", help="Path to write transcript JSON")
    parser.add_argument("--language", default="id", help="Language code")
    parser.add_argument("--model", default=default_model, help="Whisper model size")
    parser.add_argument("--device", default=default_device, help="Device: cuda or cpu")
    parser.add_argument(
        "--compute-type", default=default_compute,
        help="faster-whisper compute_type (e.g. float16, int8_float16, int8). "
             "Empty = auto (float16 on cuda, int8 on cpu).",
    )
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel

        if args.compute_type:
            compute_type = args.compute_type
        else:
            compute_type = "float16" if args.device == "cuda" else "int8"
        model = WhisperModel(args.model, device=args.device, compute_type=compute_type,
                             cpu_threads=cpu_threads(args.device))

        # Segments arrive as Whisper decodes, so their end times give progress
        # (the backend shows "Transcribing 37%").
        segments, info = decode(model, args.audio, args.language, on_progress=progress_printer())
        segments = repair_drift(model, args.audio, args.language, segments)
        segments = [{"index": i, **s} for i, s in enumerate(segments)]

        result = {
            "videoId": os.path.splitext(os.path.basename(args.audio))[0],
            "language": info.language,
            "model": args.model,
            "segments": segments,
        }

        if args.output:
            os.makedirs(os.path.dirname(args.output), exist_ok=True)
            with open(args.output, "w", encoding="utf-8") as f:
                json.dump(result, f, ensure_ascii=False, indent=2)

        output = {"success": True, "data": result}
        print(json.dumps(output, ensure_ascii=False))

    except Exception as e:
        error_output = {"success": False, "error": str(e)}
        print(json.dumps(error_output, ensure_ascii=False), file=sys.stdout)
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
