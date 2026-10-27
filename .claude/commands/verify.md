---
description: Verify a specific pipeline step works end-to-end with full test suite
argument-hint: <pipeline step number or name>
---

# Verify Pipeline Step

Run focused verification on a specific pipeline step — integration tests must pass 100% with ≥95% coverage.

## Steps:

1. **Identify the step**: Which pipeline step to verify (1-9 per AGENTS.md build order)
2. **Check prerequisites**: Ensure earlier steps in the build order work
3. **Run integration tests for the step**:
   - Backend: `cd backend && bun test -t "StepName"`
   - AI Pipeline: `cd ai-pipeline && pytest tests/test_<step>.py --cov=. --cov-fail-under=95 -v`
4. **Run the step manually**: Execute with sample input if possible
5. **Validate output**: Check that output matches expected format
6. **Test error handling**: Verify failure cases produce useful errors
7. **Check coverage**: Must be ≥95% on the tested module

## Pipeline steps for reference:
1. Video input (yt-dlp / local file)
2. Audio extraction (ffmpeg)
3. Transcription (faster-whisper + CUDA, model=medium)
4. Segment finding (10-60s candidates)
5. Scoring engine (weighted formula)
6. Vertical render (1080x1920)
7. Subtitle burn-in
8. Variation engine (clip variations)
9. Analytics (engagement predictions)
10. Preview UI (Next.js)
11. Export

## For Python scripts, verify:
- Script exits 0 on success
- Output is valid JSON with `{"success": true, "data": {...}}` envelope
- Error cases produce `{"success": false, "error": "..."}` and non-zero exit
- No non-JSON output on stdout

## Gate Criteria:
- Test pass rate: **100%**
- Coverage: **≥95%** on tested module
- No failures, no skips
- **Write verification results to journal** — do NOT expand memory blocks

$ARGUMENTS
