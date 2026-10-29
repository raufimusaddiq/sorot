#!/usr/bin/env python3
"""
End-to-end check of the Python media side on this machine.
Checks dependencies and ffmpeg, runs transcribe.py on synthetic audio (JSON
envelope + output file), imports the features package, and checks render.py's
command shape and train_scorer's 200-row guard. Segmenting and scoring are
Bun (backend tests).
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import wave
import struct

SCRIPTS_DIR = os.path.join(os.path.dirname(__file__), "..", "ai-pipeline")
VENV_PYTHON = os.path.join(os.path.dirname(__file__), "..", "ai-pipeline", ".venv", "Scripts", "python.exe")

if not os.path.exists(VENV_PYTHON):
    VENV_PYTHON = sys.executable


def find_cmd(name):
    path = shutil.which(name)
    if path:
        return path
    winget_base = os.path.expandvars(
        r"%LOCALAPPDATA%\Microsoft\WinGet\Packages"
    )
    if os.path.isdir(winget_base):
        for d in os.listdir(winget_base):
            dpath = os.path.join(winget_base, d)
            if os.path.isdir(dpath):
                for root, dirs, files in os.walk(dpath):
                    for f in files:
                        low = f.lower()
                        if low == f"{name}.exe" or low == f"{name}.cmd":
                            return os.path.join(root, f)
    return name


def run_cmd(cmd, timeout=120):
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    return result


def generate_tone_wav(path, duration_sec=15, freq=440, sample_rate=16000):
    with wave.open(path, "w") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        frames = int(duration_sec * sample_rate)
        samples = []
        for i in range(frames):
            val = int(16000 * (0.3 * (i % sample_rate < sample_rate // 2)))
            samples.append(max(-32768, min(32767, val)))
        data = struct.pack(f"<{frames}h", *samples)
        w.writeframes(data)


class TestSystemDependencies(unittest.TestCase):
    def test_ffmpeg_available(self):
        path = find_cmd("ffmpeg")
        result = run_cmd([path, "-version"])
        self.assertEqual(result.returncode, 0, f"ffmpeg not found at {path}")

    def test_ytdlp_available(self):
        path = find_cmd("yt-dlp")
        result = run_cmd([path, "--version"])
        self.assertEqual(result.returncode, 0, f"yt-dlp not found at {path}")

    def test_python_venv_exists(self):
        self.assertTrue(
            os.path.exists(VENV_PYTHON),
            f"Venv Python not found at {VENV_PYTHON}"
        )

    def test_faster_whisper_importable(self):
        result = run_cmd([VENV_PYTHON, "-c", "import faster_whisper; print('ok')"])
        self.assertIn("ok", result.stdout, "faster_whisper not importable")

    def test_opencv_importable(self):
        result = run_cmd([VENV_PYTHON, "-c", "import cv2; print('ok')"])
        self.assertIn("ok", result.stdout, "cv2 not importable")


class TestTranscribeStage(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmpdir = tempfile.mkdtemp()
        cls.audio_path = os.path.join(cls.tmpdir, "test.wav")
        generate_tone_wav(cls.audio_path, duration_sec=15)
        cls.output_path = os.path.join(cls.tmpdir, "transcript.json")
        cls.ffmpeg = find_cmd("ffmpeg")

        result = run_cmd([
            VENV_PYTHON,
            os.path.join(SCRIPTS_DIR, "transcribe.py"),
            "--audio", cls.audio_path,
            "--output", cls.output_path,
            "--model", "tiny",
            "--device", "cpu",
        ], timeout=180)
        cls.transcribe_result = result

    def test_transcribe_exits_zero(self):
        self.assertEqual(
            self.transcribe_result.returncode, 0,
            f"Transcribe failed: {self.transcribe_result.stderr}"
        )

    def test_transcribe_json_envelope(self):
        output = json.loads(self.transcribe_result.stdout)
        self.assertTrue(output["success"])
        self.assertIn("data", output)
        self.assertIn("segments", output["data"])

    def test_transcribe_writes_output_file(self):
        self.assertTrue(os.path.exists(self.output_path), "Output file not created")

    def test_transcribe_output_schema(self):
        with open(self.output_path) as f:
            data = json.load(f)
        self.assertIn("segments", data)
        for seg in data.get("segments", []):
            self.assertIn("start", seg)
            self.assertIn("end", seg)
            self.assertIn("text", seg)


class TestFFmpegOperations(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmpdir = tempfile.mkdtemp()
        cls.ffmpeg = find_cmd("ffmpeg")
        cls.audio_path = os.path.join(cls.tmpdir, "input.wav")
        generate_tone_wav(cls.audio_path, duration_sec=5)

    def test_ffmpeg_can_extract_audio(self):
        output_path = os.path.join(self.tmpdir, "extracted.wav")
        result = run_cmd([
            self.ffmpeg, "-y", "-i", self.audio_path,
            "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
            output_path,
        ])
        self.assertEqual(result.returncode, 0)
        self.assertTrue(os.path.exists(output_path))

    def test_ffmpeg_can_trim(self):
        output_path = os.path.join(self.tmpdir, "trimmed.wav")
        result = run_cmd([
            self.ffmpeg, "-y", "-i", self.audio_path,
            "-ss", "0", "-to", "2",
            output_path,
        ])
        self.assertEqual(result.returncode, 0)
        self.assertTrue(os.path.exists(output_path))


class TestFeaturesPackageImports(unittest.TestCase):
    """P3.5-A verification: every features/ submodule must import cleanly."""

    def _venv_import(self, module):
        r = run_cmd([
            VENV_PYTHON, "-c",
            f"import sys; sys.path.insert(0, r'{SCRIPTS_DIR}'); import {module}; print('ok')",
        ])
        return r

    def test_features_constants_importable(self):
        r = self._venv_import("features.constants")
        self.assertIn("ok", r.stdout, f"constants import failed: {r.stderr}")

    def test_features_text_importable(self):
        r = self._venv_import("features.text")
        self.assertIn("ok", r.stdout, f"text import failed: {r.stderr}")

    def test_features_audio_importable(self):
        r = self._venv_import("features.audio")
        self.assertIn("ok", r.stdout, f"audio import failed: {r.stderr}")

    def test_features_visual_importable(self):
        r = self._venv_import("features.visual")
        self.assertIn("ok", r.stdout, f"visual import failed: {r.stderr}")

    def test_features_supervised_importable(self):
        r = self._venv_import("features.supervised")
        self.assertIn("ok", r.stdout, f"supervised import failed: {r.stderr}")


class TestP3_5C_SupervisedGuard(unittest.TestCase):
    """P3.5-C verification: train_scorer.evaluate refuses to write a model
    when fewer than 200 labeled rows exist."""

    def test_train_scorer_refuses_below_threshold(self):
        result = run_cmd([
            VENV_PYTHON, "-c",
            f"import sys; sys.path.insert(0, r'{SCRIPTS_DIR}'); "
            "from train_scorer import evaluate; "
            "print(evaluate([{'features': {'a': 0.1}, 'actual_viral_score': 0.5}] * 5, "
            "min_rows=200, write_model=True)['status'])",
        ])
        self.assertEqual(result.returncode, 0, f"stderr: {result.stderr}")
        self.assertIn("insufficient_data", result.stdout)


class TestP0_NvencProbe(unittest.TestCase):
    """P0 verification: render.py exposes a cached NVENC probe and the
    command builder puts -ss/-to before -i (fast seek) + format=yuv420p in vf."""

    def test_render_build_cmd_shape(self):
        result = run_cmd([
            VENV_PYTHON, "-c",
            f"import sys; sys.path.insert(0, r'{SCRIPTS_DIR}'); "
            "import render; "
            "cmd = render._build_render_cmd('ffmpeg', '/tmp/x.mp4', 1.0, 2.0, '/tmp/y.mp4', use_nvenc=False); "
            "i = cmd.index('-i'); ss = cmd.index('-ss'); to = cmd.index('-to'); "
            "vf = cmd[cmd.index('-vf')+1]; "
            "print('OK' if ss < i and to < i and 'format=yuv420p' in vf else 'BAD')",
        ])
        self.assertIn("OK", result.stdout,
                      f"render command shape regression: {result.stdout} {result.stderr}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
