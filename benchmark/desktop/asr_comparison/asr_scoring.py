#!/usr/bin/env python3
"""Versioned lexical/display scoring shared by every ASR comparison adapter."""

from __future__ import annotations

import math
import re
import unicodedata
from collections import Counter
from typing import Any, Sequence


class ScoringError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ScoringError(message)


def normalize_lexical(text: str) -> str:
    """NFKC + casefold + punctuation exclusion + collapsed whitespace."""
    normalized = unicodedata.normalize("NFKC", str(text)).casefold()
    without_punctuation = "".join(
        " " if unicodedata.category(character).startswith("P") else character
        for character in normalized
    )
    return " ".join(without_punctuation.split())


def lexical_characters(text: str) -> list[str]:
    return [character for character in normalize_lexical(text) if not character.isspace()]


def mixed_tokens(text: str) -> list[str]:
    """Tokenize Latin/digit runs while retaining each CJK character as a token."""
    tokens: list[str] = []
    latin: list[str] = []

    def flush() -> None:
        if latin:
            tokens.append("".join(latin))
            latin.clear()

    for character in normalize_lexical(text):
        if character.isspace():
            flush()
        elif character.isascii() and character.isalnum():
            latin.append(character)
        else:
            flush()
            if character.isalnum():
                tokens.append(character)
    flush()
    return tokens


def edit_statistics(
    reference: Sequence[str], hypothesis: Sequence[str]
) -> dict[str, Any]:
    rows = len(reference) + 1
    columns = len(hypothesis) + 1
    costs = [[0] * columns for _ in range(rows)]
    for row in range(rows):
        costs[row][0] = row
    for column in range(columns):
        costs[0][column] = column
    for row in range(1, rows):
        for column in range(1, columns):
            costs[row][column] = min(
                costs[row - 1][column] + 1,
                costs[row][column - 1] + 1,
                costs[row - 1][column - 1]
                + (reference[row - 1] != hypothesis[column - 1]),
            )

    substitutions = 0
    deletions = 0
    insertions = 0
    correct = 0
    hypothesis_correct = [False] * len(hypothesis)
    row = len(reference)
    column = len(hypothesis)
    while row > 0 or column > 0:
        if (
            row > 0
            and column > 0
            and costs[row][column]
            == costs[row - 1][column - 1]
            + (reference[row - 1] != hypothesis[column - 1])
        ):
            if reference[row - 1] == hypothesis[column - 1]:
                correct += 1
                hypothesis_correct[column - 1] = True
            else:
                substitutions += 1
            row -= 1
            column -= 1
        elif column > 0 and costs[row][column] == costs[row][column - 1] + 1:
            insertions += 1
            column -= 1
        else:
            deletions += 1
            row -= 1
    return {
        "distance": costs[-1][-1],
        "substitutions": substitutions,
        "deletions": deletions,
        "insertions": insertions,
        "correct": correct,
        "referenceUnits": len(reference),
        "hypothesisUnits": len(hypothesis),
        "hypothesisCorrect": hypothesis_correct,
    }


def alignment_labels(reference: str, hypothesis: str) -> tuple[int, list[bool]]:
    stats = edit_statistics(list(reference), list(hypothesis))
    return int(stats["distance"]), list(stats["hypothesisCorrect"])


def _rate(numerator: int, denominator: int) -> float | None:
    return numerator / denominator if denominator else None


def _event_accuracy(
    events: Any,
    *,
    hypothesis: str,
    alternatives_key: str,
) -> float | None:
    if events is None:
        return None
    require(isinstance(events, list), f"{alternatives_key} events must be a list")
    if not events:
        return None
    normalized_hypothesis = "".join(lexical_characters(hypothesis))
    hits = 0
    for event in events:
        require(isinstance(event, dict), "event annotation must be an object")
        alternatives = event.get(alternatives_key)
        require(
            isinstance(alternatives, list) and alternatives,
            f"event {alternatives_key} must be non-empty",
        )
        normalized = [
            "".join(lexical_characters(str(alternative)))
            for alternative in alternatives
        ]
        hits += any(value and value in normalized_hypothesis for value in normalized)
    return hits / len(events)


def _itn_accuracy(events: Any, hypothesis: str) -> float | None:
    if events is None:
        return None
    require(isinstance(events, list), "numericEvents must be a list")
    if not events:
        return None
    display = unicodedata.normalize("NFKC", hypothesis).casefold()
    hits = 0
    for event in events:
        require(isinstance(event, dict), "numeric event must be an object")
        expected = event.get("expectedDisplay")
        require(isinstance(expected, str) and expected, "expectedDisplay required")
        hits += unicodedata.normalize("NFKC", expected).casefold() in display
    return hits / len(events)


def _punctuation_metrics(reference: str, hypothesis: str) -> dict[str, float]:
    reference_marks = Counter(
        character
        for character in unicodedata.normalize("NFKC", reference)
        if unicodedata.category(character).startswith("P")
    )
    hypothesis_marks = Counter(
        character
        for character in unicodedata.normalize("NFKC", hypothesis)
        if unicodedata.category(character).startswith("P")
    )
    matches = sum(
        min(count, hypothesis_marks.get(mark, 0))
        for mark, count in reference_marks.items()
    )
    reference_count = sum(reference_marks.values())
    hypothesis_count = sum(hypothesis_marks.values())
    precision = (
        matches / hypothesis_count
        if hypothesis_count
        else 1.0 if reference_count == 0 else 0.0
    )
    recall = (
        matches / reference_count
        if reference_count
        else 1.0 if hypothesis_count == 0 else 0.0
    )
    f1 = (
        2 * precision * recall / (precision + recall)
        if precision + recall
        else 0.0
    )
    return {
        "punctuationPrecision": precision,
        "punctuationRecall": recall,
        "punctuationF1": f1,
        "referencePunctuationEvents": reference_count,
        "hypothesisPunctuationEvents": hypothesis_count,
    }


def _code_switch_scores(
    reference: str, hypothesis: str, enabled: bool
) -> tuple[float | None, float | None]:
    if not enabled:
        return None, None
    reference_normalized = normalize_lexical(reference)
    hypothesis_normalized = normalize_lexical(hypothesis)
    reference_zh = [
        character
        for character in reference_normalized
        if not character.isascii() and character.isalnum()
    ]
    hypothesis_zh = [
        character
        for character in hypothesis_normalized
        if not character.isascii() and character.isalnum()
    ]
    reference_en = re.findall(r"[a-z0-9]+", reference_normalized)
    hypothesis_en = re.findall(r"[a-z0-9]+", hypothesis_normalized)
    zh_stats = edit_statistics(reference_zh, hypothesis_zh)
    en_stats = edit_statistics(reference_en, hypothesis_en)
    return (
        _rate(zh_stats["distance"], len(reference_zh)),
        _rate(en_stats["distance"], len(reference_en)),
    )


def score_text(
    reference: str,
    hypothesis: str,
    *,
    duration_seconds: float,
    annotations: dict[str, Any] | None = None,
) -> dict[str, Any]:
    require(
        isinstance(duration_seconds, (int, float))
        and math.isfinite(duration_seconds)
        and duration_seconds >= 0,
        "duration must be finite and non-negative",
    )
    annotations = annotations or {}
    require(isinstance(annotations, dict), "annotations must be an object")
    reference_characters = lexical_characters(reference)
    hypothesis_characters = lexical_characters(hypothesis)
    reference_tokens = mixed_tokens(reference)
    hypothesis_tokens = mixed_tokens(hypothesis)
    character_edits = edit_statistics(reference_characters, hypothesis_characters)
    token_edits = edit_statistics(reference_tokens, hypothesis_tokens)
    numeric_events = annotations.get("numericEvents")
    terminology = annotations.get("terminology")
    code_switch_zh_cer, code_switch_en_wer = _code_switch_scores(
        reference, hypothesis, bool(annotations.get("codeSwitch", False))
    )
    non_speech = len(reference_characters) == 0
    if non_speech:
        require(duration_seconds > 0, "non-speech duration must be greater than zero")
        hallucination = len(hypothesis_characters) / (duration_seconds / 60.0)
    else:
        hallucination = None
    lexical = {
        "cer": _rate(character_edits["distance"], len(reference_characters)),
        "wer": _rate(token_edits["distance"], len(reference_tokens)),
        "substitutions": character_edits["substitutions"],
        "deletions": character_edits["deletions"],
        "insertions": character_edits["insertions"],
        "referenceCharacters": len(reference_characters),
        "hypothesisCharacters": len(hypothesis_characters),
        "referenceTokens": len(reference_tokens),
        "hypothesisTokens": len(hypothesis_tokens),
        "exactUtterance": reference_characters == hypothesis_characters,
        "terminologyRecall": _event_accuracy(
            terminology,
            hypothesis=hypothesis,
            alternatives_key="expectedAlternatives",
        ),
        "numericEventAccuracy": _event_accuracy(
            numeric_events,
            hypothesis=hypothesis,
            alternatives_key="expectedLexicalAlternatives",
        ),
        "codeSwitchZhCer": code_switch_zh_cer,
        "codeSwitchEnWer": code_switch_en_wer,
    }
    display = {
        **_punctuation_metrics(reference, hypothesis),
        "itnEventAccuracy": _itn_accuracy(numeric_events, hypothesis),
    }
    result = {
        "schemaVersion": 2,
        "scoringContractId": "desktop-processing/macos-asr-scoring-v2",
        "lexical": lexical,
        "display": display,
        "nonSpeech": {
            "hallucinationLexicalCharactersPerMinute": hallucination,
        },
    }
    _reject_non_finite(result)
    return result


def _reject_non_finite(value: Any, location: str = "$") -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            _reject_non_finite(child, f"{location}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _reject_non_finite(child, f"{location}[{index}]")
    elif isinstance(value, float):
        require(math.isfinite(value), f"{location}: non-finite metric")
