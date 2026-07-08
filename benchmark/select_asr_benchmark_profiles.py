#!/usr/bin/env python3
"""Select ASR benchmark profiles for focused or physical-device reruns."""

from __future__ import annotations

import argparse
import csv
import json
import math
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BENCHMARK_DIR = Path(__file__).resolve().parent
DEFAULT_PROFILES_FILE = BENCHMARK_DIR / "asr_benchmark_profiles.json"
DEFAULT_OUTPUT = ROOT / "build" / "asr_benchmark" / "diagnostics" / "asr-selected-profiles.json"

sys.path.insert(0, str(BENCHMARK_DIR))
from generate_asr_benchmark_visual_report import (  # noqa: E402
    ResultRow,
    latest_by_profile,
    load_active_manifest_ids,
    load_rows,
)


Profile = dict[str, object]


def display_path(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def resolve_path(path: Path) -> Path:
    return path if path.is_absolute() else (ROOT / path)


def read_result_list(path: Path) -> list[Path]:
    result_paths: list[Path] = []
    with path.open(newline="") as handle:
        reader = csv.DictReader(handle, delimiter="\t")
        if "result" not in (reader.fieldnames or []):
            raise SystemExit(f"Missing 'result' column in {path}")
        for row in reader:
            result = row.get("result", "").strip()
            if result:
                result_paths.append(resolve_path(Path(result)).resolve())
    return result_paths


def unique_paths(paths: list[Path]) -> list[Path]:
    selected: list[Path] = []
    seen: set[Path] = set()
    for path in paths:
        resolved = path.resolve()
        if resolved in seen:
            continue
        selected.append(resolved)
        seen.add(resolved)
    return selected


def load_result_paths(result_files: list[Path], result_lists: list[Path]) -> list[Path]:
    paths = [resolve_path(path).resolve() for path in result_files]
    for result_list in result_lists:
        paths.extend(read_result_list(resolve_path(result_list)))
    paths = unique_paths(paths)
    if not paths:
        raise SystemExit("Pass at least one --result-file or --result-list-tsv")
    missing = [display_path(path) for path in paths if not path.is_file()]
    if missing:
        raise SystemExit(f"Missing result file(s): {', '.join(missing)}")
    return paths


def load_profiles_file(path: Path) -> tuple[list[str], dict[str, Profile]]:
    data = json.loads(path.read_text())
    profiles = {
        str(item["id"]): item
        for item in data.get("profiles", [])
        if isinstance(item, dict) and "id" in item
    }
    default_ids = [str(item) for item in data.get("defaultProfileIds", [])]
    return default_ids, profiles


def load_default_profiles(path: Path) -> list[Profile]:
    default_ids, profiles = load_profiles_file(path)
    missing = [profile_id for profile_id in default_ids if profile_id not in profiles]
    if missing:
        raise SystemExit(f"Missing default profile id(s) in {path}: {', '.join(missing)}")
    return [profiles[profile_id] for profile_id in default_ids]


def profile_group(profile: Profile) -> tuple[str, str]:
    route = str(profile.get("route", ""))
    if route == "standard":
        mode = str(profile.get("mode", ""))
        if mode == "offline":
            return (route, "whole")
        if mode == "vad_segmented_offline":
            return (route, "silero")
        return (route, mode)
    return (route, str(profile.get("mode", "")))


def profile_features(profile: Profile) -> dict[str, float]:
    features: dict[str, float] = {}
    for key in (
        "numThreads",
        "maxSegmentMs",
    ):
        value = profile.get(key)
        if isinstance(value, (int, float)):
            features[key] = float(value)
    vad = profile.get("vad")
    if isinstance(vad, dict):
        for key in (
            "threshold",
            "minSilenceDurationSec",
            "minSpeechDurationSec",
            "maxSpeechDurationSec",
        ):
            value = vad.get(key)
            if isinstance(value, (int, float)):
                features[f"vad.{key}"] = float(value)
    return features


def feature_ranges(profiles: list[Profile]) -> dict[tuple[str, str], dict[str, tuple[float, float]]]:
    grouped_values: dict[tuple[str, str], dict[str, list[float]]] = {}
    for profile in profiles:
        group = profile_group(profile)
        grouped_values.setdefault(group, {})
        for key, value in profile_features(profile).items():
            grouped_values[group].setdefault(key, []).append(value)

    ranges: dict[tuple[str, str], dict[str, tuple[float, float]]] = {}
    for group, values_by_key in grouped_values.items():
        ranges[group] = {
            key: (min(values), max(values))
            for key, values in values_by_key.items()
            if values
        }
    return ranges


def profile_distance(
    left: Profile,
    right: Profile,
    ranges: dict[str, tuple[float, float]],
) -> float:
    left_features = profile_features(left)
    right_features = profile_features(right)
    keys = sorted(set(left_features) | set(right_features))
    distance = 0.0
    for key in keys:
        if key not in left_features or key not in right_features:
            distance += 2.0
            continue
        min_value, max_value = ranges.get(key, (0.0, 1.0))
        span = max(max_value - min_value, 1.0)
        distance += abs(left_features[key] - right_features[key]) / span
    return distance


def row_allowed(row: ResultRow, run_class: str) -> bool:
    return run_class == "any" or row.run_class == run_class


def finite(value: float) -> float:
    return value if math.isfinite(value) else float("inf")


def row_sort_key(row: ResultRow) -> tuple[float, float, float, int, float, str]:
    empty_rate = 0.0
    if row.segment_count > 0:
        empty_rate = max(0, row.segment_count - row.non_empty_segments) / row.segment_count
    return (
        finite(row.error_rate),
        finite(row.operation_rtf),
        finite(empty_rate),
        row.p95_segment_decode_ms,
        finite(row.native_heap_after_mb),
        row.profile_id,
    )


def improvement_key(row: ResultRow) -> tuple[str, str, str]:
    return (row.route, row.language, row.model_id)


def detect_improvement_candidates(
    rows: list[ResultRow],
    baseline_profile_ids: set[str],
    selected_profile_ids: set[str],
    run_class: str,
    routes: set[str],
    min_error_delta: float,
    min_rtf_improvement: float,
    max_tied_error_delta: float,
) -> list[dict[str, object]]:
    if not baseline_profile_ids:
        return []

    eligible = [
        row
        for row in rows
        if row_allowed(row, run_class)
        and (not routes or row.route in routes)
    ]
    baselines: dict[tuple[str, str, str], ResultRow] = {}
    for row in eligible:
        if row.profile_id not in baseline_profile_ids:
            continue
        key = improvement_key(row)
        current = baselines.get(key)
        if current is None or row_sort_key(row) < row_sort_key(current):
            baselines[key] = row

    candidates: list[dict[str, object]] = []
    for row in eligible:
        if row.profile_id not in selected_profile_ids or row.profile_id in baseline_profile_ids:
            continue
        baseline = baselines.get(improvement_key(row))
        if baseline is None:
            continue
        error_delta = baseline.error_rate - row.error_rate
        rtf_delta = baseline.operation_rtf - row.operation_rtf
        rtf_improvement = rtf_delta / baseline.operation_rtf if baseline.operation_rtf else 0.0
        accuracy_better = error_delta >= min_error_delta
        speed_better = (
            row.error_rate <= baseline.error_rate + max_tied_error_delta
            and rtf_improvement >= min_rtf_improvement
        )
        if not accuracy_better and not speed_better:
            continue
        candidates.append(
            {
                "profileId": row.profile_id,
                "baselineProfileId": baseline.profile_id,
                "route": row.route,
                "language": row.language,
                "modelId": row.model_id,
                "candidateErrorRate": row.error_rate,
                "baselineErrorRate": baseline.error_rate,
                "absoluteErrorDelta": error_delta,
                "candidateOperationRtf": row.operation_rtf,
                "baselineOperationRtf": baseline.operation_rtf,
                "relativeRtfImprovement": rtf_improvement,
                "reason": "accuracy" if accuracy_better else "speed_at_tied_accuracy",
            }
        )
    return sorted(
        candidates,
        key=lambda item: (
            str(item["route"]),
            str(item["language"]),
            -float(item["absoluteErrorDelta"]),
            -float(item["relativeRtfImprovement"]),
            str(item["profileId"]),
        ),
    )


def add_profile(
    selected: list[Profile],
    seen: set[str],
    profile: Profile,
    reasons: list[dict[str, object]],
    reason: str,
) -> bool:
    profile_id = str(profile["id"])
    if profile_id in seen:
        return False
    selected.append(profile)
    seen.add(profile_id)
    reasons.append({"profileId": profile_id, "reason": reason})
    return True


def select_ranked_profiles(
    rows: list[ResultRow],
    top_per_route_language: int,
    top_overall: int,
    run_class: str,
    routes: set[str],
    selected: list[Profile],
    seen: set[str],
    reasons: list[dict[str, object]],
) -> int:
    eligible = [
        row
        for row in rows
        if row_allowed(row, run_class)
        and (not routes or row.route in routes)
        and row.profile
        and "id" in row.profile
    ]
    if not eligible:
        raise SystemExit(f"No eligible benchmark rows for runClass={run_class}")

    added = 0
    grouped: dict[tuple[str, str], list[ResultRow]] = {}
    for row in eligible:
        grouped.setdefault((row.route, row.language), []).append(row)

    if top_per_route_language > 0:
        for key in sorted(grouped):
            route, language = key
            count = 0
            for row in sorted(grouped[key], key=row_sort_key):
                if count >= top_per_route_language:
                    break
                if add_profile(
                    selected,
                    seen,
                    row.profile,
                    reasons,
                    (
                        f"top-{count + 1} {route}/{language}: "
                        f"error={row.error_rate:.4f}, operationRtf={row.operation_rtf:.4f}"
                    ),
                ):
                    added += 1
                count += 1

    if top_overall > 0:
        count = 0
        for row in sorted(eligible, key=row_sort_key):
            if count >= top_overall:
                break
            if add_profile(
                selected,
                seen,
                row.profile,
                reasons,
                f"top-overall-{count + 1}: error={row.error_rate:.4f}, operationRtf={row.operation_rtf:.4f}",
            ):
                added += 1
            count += 1

    return added


def expand_neighbors(
    selected: list[Profile],
    seen: set[str],
    reasons: list[dict[str, object]],
    source_file: Path,
    neighbors_per_profile: int,
) -> int:
    if neighbors_per_profile <= 0:
        return 0
    _, source_by_id = load_profiles_file(source_file)
    source_profiles = list(source_by_id.values())
    ranges_by_group = feature_ranges(source_profiles)
    source_by_group: dict[tuple[str, str], list[Profile]] = {}
    for profile in source_profiles:
        source_by_group.setdefault(profile_group(profile), []).append(profile)

    added = 0
    anchors = list(selected)
    for anchor in anchors:
        group = profile_group(anchor)
        ranges = ranges_by_group.get(group, {})
        candidates = sorted(
            source_by_group.get(group, []),
            key=lambda candidate: (
                profile_distance(anchor, candidate, ranges),
                str(candidate["id"]),
            ),
        )
        count = 0
        for candidate in candidates:
            if str(candidate["id"]) in seen:
                continue
            if add_profile(
                selected,
                seen,
                candidate,
                reasons,
                f"nearest-neighbor for {anchor['id']} from {display_path(source_file)}",
            ):
                added += 1
                count += 1
            if count >= neighbors_per_profile:
                break
    return added


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--result-file",
        action="append",
        type=Path,
        default=[],
        help="Benchmark result JSON. Can be repeated.",
    )
    parser.add_argument(
        "--result-list-tsv",
        action="append",
        type=Path,
        default=[],
        help="TSV produced by batch runners, with a result column. Can be repeated.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT,
        help="Output profile JSON for BENCHMARK_PROFILES_FILE.",
    )
    parser.add_argument(
        "--top-per-route-language",
        type=int,
        default=3,
        help="Profiles to keep for each route/language slice.",
    )
    parser.add_argument(
        "--top-overall",
        type=int,
        default=0,
        help="Additional globally ranked profiles to keep.",
    )
    parser.add_argument(
        "--run-class",
        choices=["warm", "current", "cold", "any"],
        default="warm",
        help="Run class to rank.",
    )
    parser.add_argument(
        "--route",
        action="append",
        choices=["standard"],
        default=[],
        help="Restrict to one route. Can be repeated.",
    )
    parser.add_argument(
        "--include-default-baselines",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Include default smoke baselines before selected winners.",
    )
    parser.add_argument(
        "--baseline-profiles-file",
        type=Path,
        default=DEFAULT_PROFILES_FILE,
        help="Profiles file used when including default baselines.",
    )
    parser.add_argument(
        "--neighbor-source",
        type=Path,
        help="Existing matrix JSON used to add nearest-neighbor profiles.",
    )
    parser.add_argument(
        "--neighbors-per-profile",
        type=int,
        default=0,
        help="Nearest neighbors to add per selected profile.",
    )
    parser.add_argument(
        "--improvement-baseline-profile-id",
        action="append",
        default=[],
        help="Prior winner profile id used to decide whether another focused sweep is warranted.",
    )
    parser.add_argument(
        "--min-error-delta",
        type=float,
        default=0.005,
        help="Minimum absolute error-rate improvement required to flag a candidate.",
    )
    parser.add_argument(
        "--min-rtf-improvement",
        type=float,
        default=0.10,
        help="Minimum relative operation RTF improvement when accuracy is tied.",
    )
    parser.add_argument(
        "--max-tied-error-delta",
        type=float,
        default=0.001,
        help="Maximum absolute error-rate regression still considered tied for speed improvement.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    result_paths = load_result_paths(args.result_file, args.result_list_tsv)
    active_model_ids, active_audio_case_ids = load_active_manifest_ids()
    rows = latest_by_profile(load_rows(active_model_ids, active_audio_case_ids, result_paths))

    selected: list[Profile] = []
    seen: set[str] = set()
    reasons: list[dict[str, object]] = []

    default_count = 0
    if args.include_default_baselines:
        for profile in load_default_profiles(resolve_path(args.baseline_profiles_file)):
            if add_profile(selected, seen, profile, reasons, "default baseline"):
                default_count += 1

    ranked_count = select_ranked_profiles(
        rows=rows,
        top_per_route_language=args.top_per_route_language,
        top_overall=args.top_overall,
        run_class=args.run_class,
        routes=set(args.route),
        selected=selected,
        seen=seen,
        reasons=reasons,
    )

    neighbor_count = 0
    neighbor_source = resolve_path(args.neighbor_source) if args.neighbor_source else None
    if neighbor_source:
        if not neighbor_source.is_file():
            raise SystemExit(f"Missing neighbor source: {display_path(neighbor_source)}")
        neighbor_count = expand_neighbors(
            selected,
            seen,
            reasons,
            neighbor_source,
            args.neighbors_per_profile,
        )

    improvement_candidates = detect_improvement_candidates(
        rows=rows,
        baseline_profile_ids=set(args.improvement_baseline_profile_id),
        selected_profile_ids=seen,
        run_class=args.run_class,
        routes=set(args.route),
        min_error_delta=args.min_error_delta,
        min_rtf_improvement=args.min_rtf_improvement,
        max_tied_error_delta=args.max_tied_error_delta,
    )

    output = resolve_path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": 1,
        "preset": "selected",
        "defaultProfileIds": [profile["id"] for profile in selected],
        "profiles": selected,
        "selection": {
            "resultFiles": [display_path(path) for path in result_paths],
            "runClass": args.run_class,
            "routes": args.route or ["standard"],
            "topPerRouteLanguage": args.top_per_route_language,
            "topOverall": args.top_overall,
            "includeDefaultBaselines": args.include_default_baselines,
            "neighborSource": display_path(neighbor_source) if neighbor_source else None,
            "neighborsPerProfile": args.neighbors_per_profile,
            "improvementBaselines": args.improvement_baseline_profile_id,
            "minErrorDelta": args.min_error_delta,
            "minRtfImprovement": args.min_rtf_improvement,
            "maxTiedErrorDelta": args.max_tied_error_delta,
            "continueFocusedSweep": bool(improvement_candidates),
            "improvementCandidates": improvement_candidates,
            "reasons": reasons,
        },
    }
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")

    route_counts: dict[str, int] = {}
    for profile in selected:
        route = str(profile["route"])
        route_counts[route] = route_counts.get(route, 0) + 1

    print(f"Wrote {display_path(output)}")
    print(f"Profiles: {len(selected)}")
    print(f"Default baselines: {default_count}")
    print(f"Ranked selections: {ranked_count}")
    print(f"Neighbor additions: {neighbor_count}")
    print(f"Improvement candidates: {len(improvement_candidates)}")
    if improvement_candidates:
        print("Continue focused sweep: yes")
    for route, count in sorted(route_counts.items()):
        print(f"{route}: {count}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
