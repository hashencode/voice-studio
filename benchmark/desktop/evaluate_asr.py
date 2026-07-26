#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path


def distance(left: str, right: str) -> int:
    previous = list(range(len(right) + 1))
    for row, lhs in enumerate(left, 1):
        current = [row]
        for column, rhs in enumerate(right, 1):
            current.append(
                min(
                    current[-1] + 1,
                    previous[column] + 1,
                    previous[column - 1] + (lhs != rhs),
                )
            )
        previous = current
    return previous[-1]


def normalize(text: str) -> str:
    return "".join(character for character in text.lower() if character.isalnum())


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--reference", required=True, type=Path)
    parser.add_argument("--hypothesis", required=True)
    args = parser.parse_args()
    reference = normalize(args.reference.read_text())
    hypothesis = normalize(args.hypothesis)
    if not reference:
        raise SystemExit("reference is empty after normalization")
    print(json.dumps({"cer": distance(reference, hypothesis) / len(reference)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
