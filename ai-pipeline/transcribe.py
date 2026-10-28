#!/usr/bin/env python3
"""Transcribe audio using faster-whisper with CUDA support."""

import argparse
import json
import sys
import os


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


def main():
    # Env overrides let the user A/B models without touching Java code. CLI args
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

        segments_gen, info = model.transcribe(
            args.audio,
            language=args.language,
            word_timestamps=True,
            vad_filter=True,
            beam_size=beam_size(),
        )

        # Segments arrive as Whisper decodes, so their end times give progress
        # ("PROGRESS 37" on stderr; the backend shows "Transcribing 37%").
        duration = getattr(info, "duration", 0) or 0
        reported = 0
        segments = []
        for i, seg in enumerate(segments_gen):
            pct = min(99, int(seg.end / duration * 100)) if duration > 0 else 0
            if pct > reported:
                reported = pct
                print(f"PROGRESS {pct}", file=sys.stderr, flush=True)
            # Per-word timing drives karaoke captions and silence trimming
            # (captions.py). Older transcripts lack "words" and fall back to
            # an even split of the segment text.
            words = [
                {
                    "text": w.word.strip(),
                    "start": round(w.start, 3),
                    "end": round(w.end, 3),
                    "prob": round(w.probability, 3),
                }
                for w in (getattr(seg, "words", None) or [])
                if w.word.strip()
            ]
            segments.append({
                "index": i,
                "start": round(seg.start, 2),
                "end": round(seg.end, 2),
                "text": seg.text.strip(),
                "confidence": round(seg.avg_logprob, 2) if seg.avg_logprob else None,
                "words": words,
            })

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
