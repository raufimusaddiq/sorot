"""Hook strength of a clip's opening line — the one text rule that stays in
Python, because captions.py uses it to pick a hook-first opening while it
builds caption timing. Every other text rule (keywords, novelty, clarity,
sentiment, boosts, penalties) is scored in Bun: backend/src/textRules.ts.
"""

from .constants import HOOK_PHRASES, QUESTION_WORDS


def _extract_first_sentence(text):
    for delim in [".", "?", "!"]:
        idx = text.find(delim)
        if idx > 0:
            return text[:idx + 1]
    if "," in text:
        return text.split(",")[0]
    return text


def score_hook_strength(text):
    first_sentence = _extract_first_sentence(text)
    lower = first_sentence.lower()
    is_question = "?" in first_sentence
    has_hook = any(p in lower for p in HOOK_PHRASES)
    has_question_word = any(w in lower.split() for w in QUESTION_WORDS[:5])
    is_short = len(first_sentence.split()) < 10

    if is_question and has_hook:
        return 1.0
    if has_hook and is_short:
        return 0.9
    if is_question or has_hook:
        return 0.7
    if has_question_word:
        return 0.6
    if is_short:
        return 0.4
    return 0.2
