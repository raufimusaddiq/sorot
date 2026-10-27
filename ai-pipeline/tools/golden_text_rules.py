"""Write backend/tests/fixtures/text-rules.json: outputs of the Python text
rules on real transcript segments and edge cases. The Bun port of these rules
(backend/src/textRules.ts) must reproduce every value exactly.

    python tools/golden_text_rules.py <data_dir>...
"""

import glob
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from features import text as T  # noqa: E402
from features import context as C  # noqa: E402
from features.audio import score_emotional_energy  # noqa: E402
import score  # noqa: E402

EDGE = [
    "", " ", "?", "Kenapa?", "Rahasia!", "TERNYATA INI GILA BANGET!!", "1 2 3",
    "Apa yang terjadi kalau kamu tahu rahasia ini?", "Jadi intinya gini, pertama kita harus jujur.",
    "Pak Budi dan Bu Siti datang ke Jakarta tahun 2024.", "ya kan dong sih nih tuh deh",
    "Hari ini saya masak.", "Dia sedih, marah, kecewa, takut sekali!", "salah benar tapi justru",
    "bagus hebat keren gagal rusak", "word " * 80, "Ini penting. Kenapa? Karena faktanya beda.",
    "tolol sampah buang waktu penipuan", "Kok bisa sih? Gimana caranya?", "café ÉLAN Über naïve",
]


def corpus(data_dirs):
    texts = list(EDGE)
    for d in data_dirs:
        for f in sorted(glob.glob(os.path.join(d, "segments", "*.json")))[:4]:
            data = json.load(open(f, encoding="utf-8"))
            segs = data.get("scoredSegments") or data.get("segments") or []
            texts += [s.get("text", "") for s in segs[:40]]
    return texts


def main():
    texts = corpus(sys.argv[1:])
    durations = [5, 14.9, 15, 29.9, 30, 44, 45, 59.9, 60, 90]
    niche = ["rahasia", "penting", "trik", "solusi", "tip"]
    rows = []
    for i, t in enumerate(texts):
        d = durations[i % len(durations)]
        scores = {"pauseStructure": [0.2, 0.9][i % 2], "facePresence": [0.0, 0.5, 1.0][i % 3]}
        rows.append({
            "text": t, "duration": d,
            "hook": T.score_hook_strength(t),
            "keyword": T.score_keyword_trigger(t),
            "novelty": T.score_novelty(t),
            "clarity": T.score_clarity(d, t),
            "sentiment": T.score_text_sentiment(t),
            "boosts": T.calc_boosts(t),
            "penalties": T.calc_penalties(t, d, scores), "penaltyScores": scores,
            "pause": C.score_pause_structure(t, d),
            "topic": C.score_topic_fit(t, niche),
            "topicNone": C.score_topic_fit(t, None),
            "energyText": score_emotional_energy(t),
            "title": score.generate_clip_title(t, ["PRIMARY", "BACKUP", "SKIP"][i % 3], {}),
            "description": score.generate_clip_description(t, ["PRIMARY", "BACKUP", "SKIP"][i % 3], {}),
            "firstSentence": T._extract_first_sentence(t),
        })
    out = os.path.join(os.path.dirname(__file__), "..", "..", "backend", "tests", "fixtures", "text-rules.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump({"niche": niche, "rows": rows}, f, ensure_ascii=False, indent=1)
    print(f"{len(rows)} rows -> {os.path.normpath(out)}")


if __name__ == "__main__":
    main()
