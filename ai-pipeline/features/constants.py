"""Constants the Python side still needs: default feature weights (the
supervised model's feature order) and the hook word lists captions.py's hook
score uses. The full rule tables live in Bun: backend/src/ruleConstants.ts.
"""

DEFAULT_WEIGHTS = {
    # Rebalanced in P3.5-B: every prior weight shaved ~8% to make room for
    # the two new features. Ratios between existing features are preserved.
    # Sum = 1.00.
    "hookStrength": 0.17,
    "keywordTrigger": 0.08,
    "novelty": 0.08,
    "clarity": 0.09,
    "emotionalEnergy": 0.08,
    "textSentiment": 0.05,
    "pauseStructure": 0.06,
    "facePresence": 0.09,
    "sceneChange": 0.07,
    "topicFit": 0.07,
    "historyScore": 0.06,
    # New in P3.5-B:
    "motion": 0.05,
    "onsetDensity": 0.05,
}

HOOK_PHRASES = [
    "rahasia", "penting", "perhatikan", "simak", "tahukah kamu",
    "tidak banyak orang tahu", "jangan", "wajib", "harus",
    "kamu tahu tidak", "coba bayangkan", "faktanya", "sesuatu yang",
    "gila", "luar biasa", "aneh", "mengejutkan",
]

QUESTION_WORDS = [
    "apa", "kenapa", "kok", "bagaimana", "kapan", "siapa", "dimana",
    "berapa", "mengapa", "gimana",
]
