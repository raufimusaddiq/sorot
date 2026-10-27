#!/usr/bin/env python3
"""Score segments for viral potential using weighted multimodal formula.

After the P3.5-A refactor this file is a thin orchestrator: the feature
extractors live in ``features/``. Every public name (functions + constants)
that the previous monolith exposed is re-exported here for backward
compatibility with existing callers and tests.
"""

import argparse
import json
import os
import re
import sys

from features.constants import (
    DEFAULT_WEIGHTS,
    HOOK_PHRASES,
    KEYWORD_TRIGGERS,
    EMOTION_WORDS,
    POSITIVE_WORDS,
    NEGATIVE_WORDS,
    CONVERSATION_MARKERS,
    CONFLICT_WORDS,
    QUESTION_WORDS,
    BOOST_CONDITIONS,
    PENALTY_CONDITIONS,
    HASHTAG_MAP,
    GENERIC_HASHTAGS,
    CTA_PHRASES,
)
from features.text import (
    _extract_first_sentence,
    score_hook_strength,
    score_keyword_trigger,
    score_novelty,
    score_clarity,
    score_text_sentiment,
    calc_boosts,
    calc_penalties,
)
from features.audio import (
    _load_audio_cache,
    _extract_audio_rms_ratio,
    score_emotional_energy,
    score_onset_density,
)
from features.visual import (
    _get_mediapipe_face_detector,
    _get_haar_cascades,
    _extract_frames_ffmpeg,
    _batch_analyze_video,
    _batch_analyze_video_mediapipe,
    _batch_analyze_video_haar,
    score_face_presence,
    score_scene_change,
)
from features.context import (
    _calc_silence_ratio,
    score_pause_structure,
    score_topic_fit,
    score_history,
)
from features import supervised as _supervised


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
WEIGHTS_PATH = os.path.join(SCRIPT_DIR, "weights.json")


def load_weights():
    try:
        with open(WEIGHTS_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        w = data.get("weights", {})
        missing = set(DEFAULT_WEIGHTS.keys()) - set(w.keys())
        for k in missing:
            w[k] = DEFAULT_WEIGHTS[k]
        return w
    except Exception:
        return dict(DEFAULT_WEIGHTS)


WEIGHTS = load_weights()


def determine_tier(score):
    if score >= 0.80:
        return "PRIMARY"
    if score >= 0.65:
        return "BACKUP"
    return "SKIP"


def generate_clip_title(text, tier, scores):
    title = ""
    sentences = re.split(r'[.?!,]', text)
    for s in sentences:
        s = s.strip()
        if not s:
            continue
        sl = s.lower()
        if "?" in text[:len(s) + 1]:
            title = s.strip()
            if not title.endswith("?"):
                title += "?"
            break
        if any(p in sl for p in HOOK_PHRASES):
            title = s.strip()
            break
    if not title:
        # First non-empty fragment: Whisper text often opens with "..." or ",",
        # which would make sentences[0] empty and the title just hashtags.
        title = next((s.strip() for s in sentences if s.strip()), text.strip())
    if len(title) > 80:
        title = title[:77] + "..."
    hashtags = _select_hashtags(text, tier, count=2)
    if hashtags:
        title = title + " " + " ".join(hashtags)
    if len(title) > 100:
        title = title[:97] + "..."
    return title


def generate_clip_description(text, tier, scores):
    lines = []
    hook_line = _generate_hook_line(text, tier)
    if hook_line:
        lines.append(hook_line)
    clean_text = text.strip()
    if len(clean_text) > 150:
        clean_text = clean_text[:147] + "..."
    lines.append(clean_text)
    hashtags = _select_hashtags(text, tier, count=7)
    if hashtags:
        lines.append(" ".join(hashtags))
    cta = CTA_PHRASES[hash(text) % len(CTA_PHRASES)]
    lines.append(cta)
    return "\n".join(lines)


def _select_hashtags(text, tier, count=5):
    lower = text.lower()
    matched = []
    for kw, tags in HASHTAG_MAP.items():
        if kw in lower:
            matched.extend(tags)
    matched = list(dict.fromkeys(matched))
    base = list(GENERIC_HASHTAGS)
    combined = matched + [t for t in base if t not in matched]
    if tier == "PRIMARY":
        if "#viral" not in combined:
            combined.insert(0, "#viral")
    return combined[:count]


def _generate_hook_line(text, tier):
    lower = text.lower()
    if "?" in _extract_first_sentence(text):
        return None
    if any(w in lower for w in ["rahasia", "penting", "wajib"]):
        return "Rahasia yang wajib kamu tahu!"
    if any(w in lower for w in ["ternyata", "faktanya", "nyatanya"]):
        return "Ternyata faktanya begini!"
    if any(w in lower for w in ["trik", "hack", "tip", "solusi"]):
        return "Trik yang harus kamu coba!"
    if tier == "PRIMARY":
        return "Wajib tahu ini!"
    return None


def score_segment(segment, niche_keywords=None, video_path=None,
                  audio_path=None, transcript_path=None, feedback_data=None,
                  audio_cache=None, video_data=None):
    text = segment.get("text", "")
    duration = segment.get("duration", 30)
    start_time = segment.get("startTime", 0)
    end_time = segment.get("endTime", start_time + duration)
    seg_idx = segment.get("index", 0)

    face_score = 0.5
    scene_score_val = 0.5
    motion_score = 0.5
    if video_data and seg_idx in video_data:
        face_score = video_data[seg_idx]["faces"]
        scene_score_val = video_data[seg_idx]["scene"]
        motion_score = video_data[seg_idx].get("motion", 0.5)

    scores = {
        "hookStrength": score_hook_strength(text),
        "keywordTrigger": score_keyword_trigger(text),
        "novelty": score_novelty(text),
        "clarity": score_clarity(duration, text),
        "emotionalEnergy": score_emotional_energy(text, audio_path, start_time, end_time, audio_cache=audio_cache),
        "textSentiment": score_text_sentiment(text),
        "pauseStructure": score_pause_structure(text, duration, transcript_path, start_time, end_time),
        "facePresence": face_score,
        "sceneChange": scene_score_val,
        "topicFit": score_topic_fit(text, niche_keywords),
        "historyScore": score_history(feedback_data, text),
        # P3.5-B new features — see features/visual.py:_calc_motion_from_grays
        # and features/audio.py:score_onset_density for calibration.
        "motion": motion_score,
        "onsetDensity": score_onset_density(audio_cache, start_time, end_time),
    }

    base_score = sum(WEIGHTS.get(k, 0) * v for k, v in scores.items())
    boosts = calc_boosts(text)
    penalties = calc_penalties(text, duration, scores)

    # P3.5-C: if a trained supervised model exists, use its prediction as the
    # base (boosts/penalties still apply as human-readable nudges). If no
    # model, ``predict`` returns None and we keep the linear weighted sum.
    supervised_pred = _supervised.predict(scores)
    if supervised_pred is not None:
        base_score = supervised_pred

    final_score = round(min(base_score + boosts - penalties, 1.0), 4)
    tier = determine_tier(final_score)

    title = generate_clip_title(text, tier, scores)
    description = generate_clip_description(text, tier, scores)

    return {
        **segment,
        "scores": {**scores, "boostTotal": boosts, "penaltyTotal": penalties},
        "finalScore": final_score,
        "tier": tier,
        "title": title,
        "description": description,
    }


def main():
    parser = argparse.ArgumentParser(description="Score segments for viral potential")
    parser.add_argument("--segments", required=True, help="Path to segments JSON")
    parser.add_argument("--video", required=True, help="Path to raw video file")
    parser.add_argument("--audio", default="", help="Path to extracted audio WAV file")
    parser.add_argument("--transcript", default="", help="Path to transcript JSON")
    parser.add_argument("--niche-keywords", default="", help="Comma-separated niche keywords")
    args = parser.parse_args()

    try:
        with open(args.segments, "r", encoding="utf-8") as f:
            data = json.load(f)

        niche_keywords = [k.strip() for k in args.niche_keywords.split(",") if k.strip()] if args.niche_keywords else None
        segments = data.get("segments", [])
        audio_path = args.audio if args.audio and os.path.exists(args.audio) else None
        transcript_path = args.transcript if args.transcript and os.path.exists(args.transcript) else None

        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=2) as pool:
            audio_future = pool.submit(_load_audio_cache, audio_path)
            video_future = pool.submit(_batch_analyze_video, args.video, segments)
            audio_cache = audio_future.result()
            video_data = video_future.result()

        scored = [score_segment(s, niche_keywords, video_path=args.video,
                                audio_path=audio_path, transcript_path=transcript_path,
                                audio_cache=audio_cache, video_data=video_data)
                  for s in segments]
        scored.sort(key=lambda x: x["finalScore"], reverse=True)

        for i, s in enumerate(scored):
            s["rank"] = i + 1

        result = {
            "videoId": data.get("videoId", ""),
            "scoredSegments": scored,
        }

        with open(args.segments, "w", encoding="utf-8") as f:
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
