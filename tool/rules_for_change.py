#!/usr/bin/env python3
"""Resolve the current project standards for paths about to change."""

from __future__ import annotations

import argparse
import fnmatch
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
INDEX_PATH = REPO_ROOT / "docs/standards/rules-index.json"


class RuleRouteError(ValueError):
    pass


def load_index(path: Path = INDEX_PATH) -> dict:
    index = json.loads(path.read_text(encoding="utf-8"))
    if index.get("version") != 1 or not isinstance(index.get("routes"), list):
        raise RuleRouteError("unsupported rules index")
    ids: set[str] = set()
    for route in index["routes"]:
        route_id = route.get("id")
        if not isinstance(route_id, str) or route_id in ids:
            raise RuleRouteError(f"missing or duplicate route id: {route_id}")
        ids.add(route_id)
        if not route.get("paths") and not route.get("tags"):
            raise RuleRouteError(f"route has no trigger: {route_id}")
        if not route.get("documents"):
            raise RuleRouteError(f"route has no documents: {route_id}")
        for document in route["documents"]:
            resolved = (REPO_ROOT / document).resolve()
            if not resolved.is_relative_to(REPO_ROOT) or not resolved.is_file():
                raise RuleRouteError(f"missing or invalid rule document: {document}")
    return index


def normalize_path(value: str) -> str:
    candidate = Path(value)
    resolved = (candidate if candidate.is_absolute() else REPO_ROOT / candidate).resolve()
    if not resolved.is_relative_to(REPO_ROOT):
        raise RuleRouteError(f"path is outside repository: {value}")
    relative = resolved.relative_to(REPO_ROOT).as_posix()
    if relative == ".":
        raise RuleRouteError("pass file paths, not the repository root")
    return relative


def resolve_rules(index: dict, files: list[str], tags: list[str]) -> list[str]:
    if not files and not tags:
        raise RuleRouteError("pass at least one file or --tag")
    documents: set[str] = set()
    for raw_file in files:
        path = normalize_path(raw_file)
        matching = [
            route for route in index["routes"]
            if any(
                ("/" in pattern or "/" not in path)
                and fnmatch.fnmatchcase(path, pattern)
                for pattern in route.get("paths", [])
            )
        ]
        if not matching:
            raise RuleRouteError(f"no rule route for file: {path}")
        for route in matching:
            documents.update(route["documents"])
    for tag in tags:
        matching = [route for route in index["routes"] if tag in route.get("tags", [])]
        if not matching:
            raise RuleRouteError(f"unknown task tag: {tag}")
        for route in matching:
            documents.update(route["documents"])
    return sorted(documents)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("files", nargs="*", help="repository-relative files to edit")
    parser.add_argument("--tag", action="append", default=[], help="task type")
    args = parser.parse_args(argv)
    try:
        documents = resolve_rules(load_index(), args.files, args.tag)
    except (OSError, json.JSONDecodeError, RuleRouteError) as error:
        print(f"rules routing failed: {error}", file=sys.stderr)
        return 2
    for document in documents:
        print(document)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
