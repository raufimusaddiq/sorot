"""Audio feature extraction: RMS energy caching, per-segment RMS ratio,
the text+audio emotional-energy blend, and (P3.5-B) onset density — a
cheap proxy for "cuts / beats per second" derived from the same cached
samples.

GPU path (CuPy) is opt-in behind ``USE_CUPY=1``; default is NumPy.
"""

import os
import sys



def _load_audio_cache(audio_path):
    if not audio_path or not os.path.exists(audio_path):
        return None
    try:
        import numpy as np
        import wave
        with wave.open(audio_path, 'rb') as wf:
            framerate = wf.getframerate()
            n_channels = wf.getnchannels()
            sampwidth = wf.getsampwidth()
            total_frames = wf.getnframes()
            wf.setpos(0)
            raw = wf.readframes(total_frames)
            dtype = {1: np.int8, 2: np.int16, 4: np.int32}.get(sampwidth, np.int16)
            samples = np.frombuffer(raw, dtype=dtype).astype(np.float64)
            if n_channels > 1:
                samples = samples[::n_channels]

            use_gpu = False
            if os.environ.get("USE_CUPY", "0") == "1":
                try:
                    import cupy as cp
                    samples_gpu = cp.asarray(samples)
                    total_rms = float(cp.sqrt(cp.mean(samples_gpu ** 2)))
                    del samples_gpu
                    use_gpu = True
                except Exception as _cupy_err:
                    print(
                        f"WARN: USE_CUPY=1 but cupy unavailable ({_cupy_err}); "
                        f"falling back to NumPy.",
                        file=sys.stderr,
                    )
                    total_rms = float(np.sqrt(np.mean(samples ** 2)))
            else:
                total_rms = float(np.sqrt(np.mean(samples ** 2)))

            return {"samples": samples, "framerate": framerate, "total_rms": total_rms, "gpu": use_gpu}
    except Exception:
        return None


def _extract_audio_rms_ratio(audio_path, start_time, end_time, audio_cache=None):
    try:
        import numpy as np
        if audio_cache is None:
            audio_cache = _load_audio_cache(audio_path)
        if audio_cache is None:
            return None
        samples = audio_cache["samples"]
        framerate = audio_cache["framerate"]
        total_rms = audio_cache["total_rms"]
        if total_rms == 0:
            return None
        start_sample = max(0, min(int(start_time * framerate), len(samples)))
        end_sample = max(0, min(int(end_time * framerate), len(samples)))
        if start_sample >= end_sample:
            return None
        seg = samples[start_sample:end_sample]

        if audio_cache.get("gpu") and os.environ.get("USE_CUPY", "0") == "1":
            try:
                import cupy as cp
                seg_gpu = cp.asarray(seg)
                seg_rms = float(cp.sqrt(cp.mean(seg_gpu ** 2)))
                del seg_gpu
                return seg_rms / total_rms
            except Exception:
                pass

        seg_rms = float(np.sqrt(np.mean(seg ** 2)))
        return seg_rms / total_rms
    except Exception:
        return None


def score_onset_density(audio_cache, start_time, end_time):
    """Onset peaks per second inside the segment. High density = dynamic
    audio (music drops, scene cuts, laughter bursts), low density = flat
    narration. Derived from the cached raw samples, no librosa dependency.
    """
    if audio_cache is None:
        return 0.5
    try:
        import numpy as np
        samples = audio_cache["samples"]
        framerate = audio_cache["framerate"]
        start_sample = max(0, min(int(start_time * framerate), len(samples)))
        end_sample = max(0, min(int(end_time * framerate), len(samples)))
        if end_sample - start_sample < framerate // 2:
            return 0.5
        seg = samples[start_sample:end_sample]

        # RMS envelope over 100 ms windows.
        win = max(1, framerate // 10)
        n_wins = len(seg) // win
        if n_wins < 4:
            return 0.5
        frames = seg[:n_wins * win].reshape(n_wins, win)
        env = np.sqrt(np.mean(frames ** 2, axis=1))
        mean_env = env.mean()
        if mean_env <= 0:
            return 0.1

        # Peak = local max > 1.3× mean envelope.
        env_norm = env / mean_env
        peaks = 0
        for i in range(1, len(env_norm) - 1):
            if env_norm[i] > env_norm[i - 1] and env_norm[i] > env_norm[i + 1] and env_norm[i] > 1.3:
                peaks += 1
        duration = (end_sample - start_sample) / framerate
        density = peaks / max(duration, 1.0)
        # Map density (peaks/sec) to [0, 1]: flat → 0.2, moderate (2/s) → ~0.8.
        return round(min(0.2 + density * 0.3, 1.0), 4)
    except Exception:
        return 0.5
