# Performance Benchmark & Validation Plan

> **Companion Document**: [GPU-OPTIMIZATION-PLAN.md](./GPU-OPTIMIZATION-PLAN.md)
>
> **Purpose**: Benchmarking methodology, metrics collection, and validation criteria

---

## Table of Contents

1. [Benchmark Environment](#1-benchmark-environment)
2. [Metrics to Collect](#2-metrics-to-collect)
3. [Benchmark Procedure](#3-benchmark-procedure)
4. [Per-Phase Validation Criteria](#4-per-phase-validation-criteria)
5. [Scoring Quality Validation](#5-scoring-quality-validation)
6. [Expected Results Summary](#6-expected-results-summary)

---

## 1. Benchmark Environment

### 1.1 Hardware Specification

| Component | Specification |
|-----------|--------------|
| GPU | NVIDIA RTX 4060 (8 GB GDDR6) |
| GPU Architecture | Ada Lovelace (SM 8.9) |
| NVENC Encoders | 2x (8th gen) |
| Tensor Cores | 4th Gen |
| CUDA Cores | 3,072 |
| Memory Bandwidth | 272 GB/s |

### 1.2 Software Stack

| Component | Version |
|-----------|---------|
| CUDA | 12.4.1 |
| cuDNN | Runtime (bundled with CUDA image) |
| Docker | Latest (with NVIDIA Container Toolkit) |
| Python | 3.10+ (via venv) |
| Java | 17 (Spring Boot 3.2) |
| ffmpeg | System (needs NVENC support) |

### 1.3 Test Input

| Property | Value |
|----------|-------|
| Test video | YouTube video, ~10 minutes |
| Language | Indonesian |
| Expected segments | ~8-15 segments after segmentation |
| Content type | Talking head / educational (typical short-form content) |

### 1.4 GPU Monitoring

```bash
# Real-time GPU monitoring (run in separate terminal)
watch -n 1 nvidia-smi

# Or with more detail:
nvidia-smi dmon -s puc

# Log GPU stats to file for analysis
nvidia-smi --query-gpu=timestamp,utilization.gpu,utilization.memory,memory.used,memory.total \
  --format=csv -l 1 > gpu_stats.csv
```

---

## 2. Metrics to Collect

### 2.1 Pipeline Timing Metrics

Collect timestamps for each pipeline stage from the Job API:

```bash
# Get job detail with stage timings
curl -s http://localhost:8080/api/jobs/{jobId} | python -m json.tool
```

Record these timestamps:

| Metric | How to Measure |
|--------|---------------|
| `t_import_start` | Job created timestamp |
| `t_import_end` | IMPORT stage completed_at |
| `t_audio_extract_end` | AUDIO_EXTRACT stage completed_at |
| `t_transcribe_end` | TRANSCRIBE stage completed_at |
| `t_segment_end` | SEGMENT stage completed_at |
| `t_score_end` | SCORE stage completed_at |
| `t_render_end` | RENDER stage completed_at |
| `t_subtitle_end` | SUBTITLE stage completed_at |
| `t_variation_end` | VARIATION stage completed_at |
| `t_analytics_end` | ANALYTICS stage completed_at |

**Derived metrics**:

```
stage_duration = stage_completed_at - previous_stage_completed_at
total_pipeline_time = t_analytics_end - t_import_start
```

### 2.2 GPU Metrics

| Metric | Collection Method |
|--------|-------------------|
| GPU utilization (%) | `nvidia-smi --query-gpu=utilization.gpu` |
| VRAM used (MB) | `nvidia-smi --query-gpu=memory.used` |
| GPU temperature | `nvidia-smi --query-gpu=temperature.gpu` |
| GPU power draw (W) | `nvidia-smi --query-gpu=power.draw` |
| Encoder utilization (%) | `nvidia-smi dmon -s e` |

### 2.3 Output Quality Metrics

| Metric | How to Measure |
|--------|---------------|
| Number of segments scored | `scoredSegments.length` from API response |
| PRIMARY tier count | Filter `tier == "PRIMARY"` |
| BACKUP tier count | Filter `tier == "BACKUP"` |
| SKIP tier count | Filter `tier == "SKIP"` |
| Top-5 ranked clips | First 5 entries in `scoredSegments` (sorted by `finalScore`) |
| Average final score | Mean of all `finalScore` values |
| Render success rate | `rendered_count / total_clips` |
| Render file sizes | `ls -la data/renders/` |

### 2.4 Scoring Feature Distribution

Extract from the scored segments JSON for quality validation:

```python
# For each scored segment, record all 11 feature scores:
features = ["hookStrength", "keywordTrigger", "novelty", "clarity",
            "emotionalEnergy", "textSentiment", "pauseStructure",
            "facePresence", "sceneChange", "topicFit", "historyScore"]

# Record: mean, std, min, max for each feature
# Compare across optimization phases to detect regressions
```

---

## 3. Benchmark Procedure

### 3.1 Step-by-Step

```
Step 1: Prepare environment
  - Rebuild Docker images (clean build)
  - Verify GPU passthrough (nvidia-smi inside container)
  - Verify NVENC available (ffmpeg -encoders | grep nvenc)

Step 2: Run baseline benchmark
  - Import test video
  - Start processing
  - Start GPU monitoring (nvidia-smi logging)
  - Record all timestamps from Job API
  - Save scored output JSON

Step 3: Apply optimization phase
  - Rebuild if needed (dependency changes)
  - Repeat Step 2 with same test video

Step 4: Compare results
  - Stage-by-stage timing comparison
  - GPU utilization comparison
  - Scoring output comparison
  - Render quality spot-check
```

### 3.2 Benchmark Recording Template

```
========================================
BENCHMARK: [BASELINE / P0 / P1 / P2 / P3]
Date: YYYY-MM-DD HH:MM
Test video: [URL or filename]
Duration: XX:XX
========================================

STAGE TIMINGS:
  IMPORT:        XX.Xs
  AUDIO_EXTRACT: XX.Xs
  TRANSCRIBE:    XX.Xs
  SEGMENT:       XX.Xs
  SCORE:         XX.Xs
  RENDER:        XX.Xs
  SUBTITLE:      XX.Xs
  VARIATION:     XX.Xs
  ANALYTICS:     XX.Xs
  ----------------------
  TOTAL:         XX.Xs

GPU METRICS (peak):
  Utilization:   XX%
  VRAM used:     XXXX MB
  Temperature:   XX C
  Power:         XX W

OUTPUT:
  Segments:      XX
  PRIMARY:       XX
  BACKUP:        XX
  SKIP:          XX
  Avg score:     0.XX
  Render OK:     XX/XX

TOP-5 RANKED:
  1. score=0.XX "title..." [PRIMARY]
  2. score=0.XX "title..." [PRIMARY]
  3. score=0.XX "title..." [BACKUP]
  4. score=0.XX "title..." [BACKUP]
  5. score=0.XX "title..." [BACKUP]
```

### 3.3 Important Notes

- **Use the same test video** for all benchmarks to ensure comparability
- **Run each benchmark 3 times** and report the median (not average) to eliminate outliers
- **Cold start vs warm start**: Report both. First run (model loading) vs subsequent runs
- **Stop other GPU processes** before benchmarking (close browsers, other apps)

---

## 4. Per-Phase Validation Criteria

### 4.1 Phase 0 — Quick Wins

**PASS criteria** (ALL must be met):

| Criterion | Threshold |
|-----------|-----------|
| Total pipeline time | Reduced by >= 50% vs baseline |
| Render stage time | Reduced by >= 5x vs baseline |
| GPU utilization during render | >= 40% |
| VRAM usage during transcribe | >= 2.5 GB |
| Scoring output | Top-5 ranked clips match baseline (same order) |
| PRIMARY tier clips | Same count as baseline |
| Render file integrity | All clips playable, no corruption |
| Fallback | `libx264` fallback works when NVENC unavailable |

**FAIL indicators**:
- Pipeline crashes or hangs
- Scored clip order differs significantly from baseline
- Rendered clips have visual artifacts
- NVENC not detected in Docker container

### 4.2 Phase 1 — Parallel Pipeline

**PASS criteria** (ALL must be met):

| Criterion | Threshold |
|-----------|-----------|
| SCORE stage time | Reduced by >= 30% vs Phase 0 |
| RENDER stage time | Reduced by >= 30% vs Phase 0 (dual NVENC) |
| Concurrent render processes | 2 `render.py` processes visible during render |
| Job cancellation | Still works during parallel renders |
| File integrity | No race conditions, all files complete |
| Output | Identical to Phase 0 output (same video, same results) |

**FAIL indicators**:
- Race condition on file writes (incomplete files)
- Deadlock or hang during parallel execution
- Job cancellation does not stop parallel renders
- Increased memory usage causes OOM

### 4.3 Phase 2 — GPU-Accelerated Vision

**PASS criteria** (ALL must be met):

| Criterion | Threshold |
|-----------|-----------|
| Face detection time | Reduced by >= 2x vs Haar baseline |
| GPU utilization during SCORE | >= 60% |
| VRAM usage peak | <= 6 GB (leave 2 GB headroom) |
| Face detection accuracy | PRIMARY/BACKUP counts within +/-1 of baseline |
| MediaPipe import | Succeeds in Docker container |
| Fallback | Haar cascade works when MediaPipe unavailable |
| CuPy import | Succeeds (if installed) |
| Output | Top-5 ranked clips same or better than baseline |

**FAIL indicators**:
- MediaPipe face detection produces no results (all face_score = 0)
- Segmentation faults or CUDA errors
- VRAM exceeds 7.5 GB (risk of OOM)
- CuPy causes crashes on import

### 4.4 Phase 3 — Advanced (Future)

**PASS criteria**:

| Criterion | Threshold |
|-----------|-----------|
| Neural model inference time | < 100ms per segment |
| Ranking quality | Top-3 clips correlate with actual post performance |
| VRAM usage | <= 7 GB |
| Fallback | Heuristic formula used when model unavailable |

---

## 5. Scoring Quality Validation

### 5.1 Methodology

The scoring engine produces 11 feature scores + final score per segment. To validate that optimizations don't degrade quality:

**Step 1**: Save baseline output
```bash
# After baseline run, save the scored segments
cp data/segments/{videoId}.json baseline_scores.json
```

**Step 2**: After each optimization, compare
```python
import json

with open("baseline_scores.json") as f:
    baseline = json.load(f)

with open("optimized_scores.json") as f:
    optimized = json.load(f)

baseline_segments = {s["rank"]: s for s in baseline["scoredSegments"]}
optimized_segments = {s["rank"]: s for s in optimized["scoredSegments"]}

# Compare top-5 ranks
print("=== Rank Comparison ===")
for rank in range(1, 6):
    b = baseline_segments.get(rank, {})
    o = optimized_segments.get(rank, {})
    match = "MATCH" if b.get("text", "") == o.get("text", "") else "DIFF"
    print(f"  Rank {rank}: baseline={b.get('finalScore', 0):.3f} "
          f"optimized={o.get('finalScore', 0):.3f} [{match}]")

# Compare feature distributions
print("\n=== Feature Distribution (mean) ===")
for feature in ["hookStrength", "keywordTrigger", "facePresence", "sceneChange"]:
    b_vals = [s["scores"][feature] for s in baseline["scoredSegments"]]
    o_vals = [s["scores"][feature] for s in optimized["scoredSegments"]]
    b_mean = sum(b_vals) / len(b_vals)
    o_mean = sum(o_vals) / len(o_vals)
    delta = abs(b_mean - o_mean)
    status = "OK" if delta < 0.05 else "CHECK"
    print(f"  {feature}: baseline={b_mean:.3f} optimized={o_mean:.3f} delta={delta:.3f} [{status}]")
```

### 5.2 Acceptable Tolerance

| Metric | Acceptable Delta |
|--------|-----------------|
| Individual feature score | +/- 0.05 |
| Final score (per segment) | +/- 0.03 |
| Rank position (per segment) | +/- 2 positions |
| PRIMARY tier count | 0 change |
| BACKUP tier count | +/- 1 |
| Total segments scored | 0 change |

### 5.3 Known Acceptable Changes

Some optimizations will produce slightly different results — this is expected and acceptable:

- **MediaPipe vs Haar**: Face detection scores may differ slightly (MediaPipe is generally more accurate, so this is an improvement)
- **Frame resolution change** (320 → 224): Scene change and face detection scores may shift slightly, but within tolerance
- **Whisper model upgrade** (medium → large-v3-turbo): Transcription text may differ slightly, affecting text-based features (hookStrength, keywordTrigger, etc.)

These changes are acceptable as long as the **overall ranking order** remains consistent.

---

## 6. Expected Results Summary

### 6.1 Consolidated Projections

| Metric | Baseline | After P0 | After P1 | After P2 |
|--------|----------|----------|----------|----------|
| Total time (10 min video) | 10–15 min | 3–5 min | 2–3 min | 1.5–2.5 min |
| IMPORT | 1–2 min | 1–2 min | 1–2 min | 1–2 min |
| AUDIO_EXTRACT | 15–30s | 15–30s | 15–30s | 15–30s |
| TRANSCRIBE | 30–45s | 15–25s | 15–25s | 15–25s |
| SEGMENT | <5s | <5s | <5s | <5s |
| SCORE | 2–3 min | 2–3 min | 1–1.5 min | 30–60s |
| RENDER | 5–8 min | 30s–1min | 15–30s | 15–30s |
| SUBTITLE | 1–2 min | 15–30s | 15–30s | 15–30s |
| VARIATION | 30s | 10–15s | 10–15s | 10–15s |
| ANALYTICS | <5s | <5s | <5s | <5s |
| GPU utilization (peak) | ~25% | ~50% | ~65% | ~75% |
| VRAM usage (peak) | ~2 GB | ~2.5 GB | ~2.5 GB | ~3.5 GB |

### 6.2 Effort vs Impact Summary

| Phase | Effort | Total Time Reduction | GPU Utilization |
|-------|--------|---------------------|-----------------|
| P0: Quick Wins | ~30 min | 50–70% | ~50% |
| P1: Parallel | ~2–3 hours | Additional 15–20% | ~65% |
| P2: GPU Vision | ~1–2 days | Additional 5–10% | ~75% |
| P3: Advanced | ~2–5 days | Additional 5% | ~80% |

### 6.3 Decision Matrix

**Should I implement Phase X?**

| Question | Answer → Action |
|----------|-----------------|
| "Is 3–5 min acceptable?" | Yes → Stop after P0 |
| "Need under 3 min?" | Implement P1 |
| "Need under 2 min?" | Implement P2 |
| "Need maximum performance?" | Implement P3 (neural scoring) |

---

## Appendix: Quick Benchmark Script

Save as `benchmark.sh`:

```bash
#!/bin/bash
# Quick benchmark for Sorot pipeline

VIDEO_URL="${1:?Usage: benchmark.sh <youtube_url>}"

echo "=== BENCHMARK START ==="
echo "Video: $VIDEO_URL"
START_TIME=$(date +%s)

# Import video
echo "[1/3] Importing video..."
IMPORT_RESULT=$(curl -s -X POST http://localhost:8080/api/import \
  -H "Content-Type: application/json" \
  -d "{\"url\": \"$VIDEO_URL\"}")
VIDEO_ID=$(echo $IMPORT_RESULT | python3 -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('videoId',''))")
echo "Video ID: $VIDEO_ID"

# Start processing
echo "[2/3] Starting pipeline..."
PROCESS_START=$(date +%s)
PROCESS_RESULT=$(curl -s -X POST http://localhost:8080/api/process \
  -H "Content-Type: application/json" \
  -d "{\"videoId\": \"$VIDEO_ID\"}")
JOB_ID=$(echo $PROCESS_RESULT | python3 -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('jobId',''))")
echo "Job ID: $JOB_ID"

# Poll until complete
echo "[3/3] Waiting for completion..."
while true; do
  STATUS=$(curl -s http://localhost:8080/api/jobs/$JOB_ID | \
    python3 -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('status',''))")
  if [ "$STATUS" = "COMPLETED" ] || [ "$STATUS" = "FAILED" ]; then
    break
  fi
  sleep 5
done

PROCESS_END=$(date +%s)
TOTAL_TIME=$((PROCESS_END - START_TIME))
PIPELINE_TIME=$((PROCESS_END - PROCESS_START))

echo ""
echo "=== RESULTS ==="
echo "Status: $STATUS"
echo "Total time: ${TOTAL_TIME}s"
echo "Pipeline time: ${PIPELINE_TIME}s"

# Get stage details
curl -s http://localhost:8080/api/jobs/$JOB_ID | python3 -c "
import sys, json
data = json.load(sys.stdin).get('data', {})
stages = data.get('stageStatuses', [])
for s in sorted(stages, key=lambda x: x.get('startedAt', '')):
    name = s.get('stage', '?')
    status = s.get('status', '?')
    output = s.get('outputPath', '')
    print(f'  {name:20s} {status:15s} {output}')
"

echo ""
echo "GPU Stats:"
nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader

echo ""
echo "=== BENCHMARK END ==="
```
