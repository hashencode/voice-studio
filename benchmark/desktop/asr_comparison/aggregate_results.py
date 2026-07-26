#!/usr/bin/env python3
"""Scenario-macro aggregation and transparent ASR comparison gate evaluation."""

from __future__ import annotations

import argparse
import json
import math
import statistics
from collections import defaultdict
from pathlib import Path
from typing import Any


class AggregationError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AggregationError(message)


def _finite_number(value: Any, location: str) -> float:
    require(
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value),
        f"{location} must be finite",
    )
    return float(value)


def _mean(values: list[float]) -> float | None:
    return statistics.fmean(values) if values else None


def _distribution(values: list[float]) -> dict[str, float | int | None]:
    if not values:
        return {"count": 0, "median": None, "p95": None, "dispersion": None}
    ordered = sorted(values)
    p95_index = max(0, math.ceil(0.95 * len(ordered)) - 1)
    return {
        "count": len(ordered),
        "median": statistics.median(ordered),
        "p95": ordered[p95_index],
        "dispersion": statistics.pstdev(ordered),
    }


def _identity(runs: list[dict[str, Any]], key: str) -> Any:
    values = {run.get(key) for run in runs}
    require(len(values) == 1, f"runs from different {key.removesuffix('Id')} values cannot be pooled")
    return values.pop()


def aggregate_candidate(runs: list[dict[str, Any]]) -> dict[str, Any]:
    require(isinstance(runs, list) and runs, "runs must be a non-empty list")
    for run in runs:
        require(isinstance(run, dict), "every run must be an object")
    candidate_id = _identity(runs, "candidateId")
    lane_id = _identity(runs, "laneId")
    profile_id = _identity(runs, "profileId")
    scorecard = _identity(runs, "scorecard")
    require(
        scorecard in {"core_asr", "end_to_end"},
        "scorecard must remain core_asr or end_to_end",
    )
    run_ids = [run.get("runId") for run in runs]
    require(
        all(isinstance(run_id, str) and run_id for run_id in run_ids)
        and len(run_ids) == len(set(run_ids)),
        "run ids must be unique",
    )
    measured = [run for run in runs if run.get("warmup") is False]
    require(measured, "at least one measured run is required")
    by_scenario: dict[str, list[dict[str, Any]]] = defaultdict(list)
    raw_hashes: set[str] = set()
    for run in measured:
        require(
            isinstance(run.get("scenario"), str)
            and isinstance(run.get("fixtureId"), str),
            "scenario and fixture identity are required",
        )
        require(
            isinstance(run.get("runIndex"), int)
            and isinstance(run.get("scheduleOrder"), int),
            "run index and schedule order are required",
        )
        metrics = run.get("metrics")
        require(isinstance(metrics, dict), "run metrics must be an object")
        for metric in (
            "rtf",
            "incrementalPeakRssBytes",
        ):
            _finite_number(metrics.get(metric), f"{run['runId']}.{metric}")
        for metric in (
            "cer",
            "terminologyRecall",
            "numericEventAccuracy",
        ):
            if metrics.get(metric) is not None:
                _finite_number(metrics[metric], f"{run['runId']}.{metric}")
        raw_hash = run.get("rawOutputSha256")
        require(
            isinstance(raw_hash, str)
            and len(raw_hash) == 64
            and all(character in "0123456789abcdef" for character in raw_hash),
            "raw output hash must be SHA-256",
        )
        raw_hashes.add(raw_hash)
        by_scenario[run["scenario"]].append(run)

    scenario_metrics: dict[str, dict[str, Any]] = {}
    macro_inputs: dict[str, list[float]] = defaultdict(list)
    for scenario, scenario_runs in sorted(by_scenario.items()):
        metrics: dict[str, Any] = {"measuredRuns": len(scenario_runs)}
        for metric in ("cer", "terminologyRecall", "numericEventAccuracy"):
            values = [
                float(run["metrics"][metric])
                for run in scenario_runs
                if run["metrics"].get(metric) is not None
            ]
            value = _mean(values)
            metrics[metric] = value
            if value is not None:
                macro_inputs[metric].append(value)
        scenario_metrics[scenario] = metrics
    macro = {
        metric: _mean(values)
        for metric, values in sorted(macro_inputs.items())
    }
    for metric in ("cer", "terminologyRecall", "numericEventAccuracy"):
        macro.setdefault(metric, None)
    rtf_values = [float(run["metrics"]["rtf"]) for run in measured]
    rss_values = [
        int(run["metrics"]["incrementalPeakRssBytes"]) for run in measured
    ]
    published_runs = [
        {
            "runId": run["runId"],
            "scenario": run["scenario"],
            "fixtureId": run["fixtureId"],
            "runIndex": run["runIndex"],
            "warmup": bool(run["warmup"]),
            "scheduleOrder": run["scheduleOrder"],
            "metrics": run["metrics"],
            "rawOutputSha256": run["rawOutputSha256"],
        }
        for run in sorted(runs, key=lambda item: (item["scheduleOrder"], item["runId"]))
    ]
    return {
        "schemaVersion": 2,
        "candidateId": candidate_id,
        "laneId": lane_id,
        "profileId": profile_id,
        "scorecard": scorecard,
        "runs": published_runs,
        "measuredRunCount": len(measured),
        "scenarioMetrics": scenario_metrics,
        "macroMetrics": macro,
        "performance": {"rtf": _distribution(rtf_values)},
        "resources": {
            "incrementalPeakRssBytes": {
                "maximum": max(rss_values),
                **_distribution([float(value) for value in rss_values]),
            }
        },
        "determinism": {
            "distinctRawOutputCount": len(raw_hashes),
            "stable": len(raw_hashes) == 1,
        },
        "aggregationPolicy": {
            "warmupsExcluded": True,
            "scenarioMacroEqualWeight": True,
            "durationWeighted": False,
        },
    }


def _relative_reduction(baseline: float, candidate: float) -> float:
    if baseline <= 0:
        return 0.0 if candidate >= baseline else 1.0
    return (baseline - candidate) / baseline


def compare_to_baseline(
    candidate: dict[str, Any],
    baseline: dict[str, Any],
    *,
    hard_gates: dict[str, Any],
    materiality: dict[str, Any],
) -> dict[str, Any]:
    require(
        candidate["laneId"] == baseline["laneId"],
        "candidate and baseline must be in the same runtime lane",
    )
    require(
        candidate["profileId"] == baseline["profileId"]
        and candidate["scorecard"] == baseline["scorecard"],
        "candidate and baseline profile/scorecard mismatch",
    )
    candidate_cer = candidate["macroMetrics"].get("cer")
    require(candidate_cer is not None, "candidate macro CER is required")
    median_rtf = candidate["performance"]["rtf"]["median"]
    peak_rss = candidate["resources"]["incrementalPeakRssBytes"]["maximum"]
    gate_results = {
        "cer": "PASS" if candidate_cer <= hard_gates["maxCer"] else "FAIL",
        "rtf": "PASS" if median_rtf <= hard_gates["maxRtf"] else "FAIL",
        "incrementalPeakRssBytes": (
            "PASS"
            if peak_rss <= hard_gates["maxFinalistIncrementalPeakRssBytes"]
            else "FAIL"
        ),
    }
    hard_failures = [
        metric for metric, result in gate_results.items() if result == "FAIL"
    ]
    if hard_failures:
        return {
            "hardGateResults": gate_results,
            "hardFailures": hard_failures,
            "materialBenefit": None,
            "paretoEligible": False,
            "disposition": "REJECTED_HARD_GATE",
        }

    scenario_reductions: dict[str, float] = {}
    for scenario, candidate_metrics in candidate["scenarioMetrics"].items():
        baseline_metrics = baseline["scenarioMetrics"].get(scenario)
        if (
            baseline_metrics is None
            or candidate_metrics.get("cer") is None
            or baseline_metrics.get("cer") is None
        ):
            continue
        scenario_reductions[scenario] = _relative_reduction(
            baseline_metrics["cer"], candidate_metrics["cer"]
        )
    improved_hard_scenarios = sum(
        reduction
        >= materiality["minimumRelativeMacroLexicalErrorReduction"]
        for scenario, reduction in scenario_reductions.items()
        if scenario != "clean_near_field_mandarin"
    )
    clean_reduction = scenario_reductions.get("clean_near_field_mandarin", 0.0)
    clean_regression_ok = (
        clean_reduction
        >= -materiality["maximumRelativeCleanMandarinRegression"]
    )
    baseline_terms = baseline["macroMetrics"].get("terminologyRecall")
    candidate_terms = candidate["macroMetrics"].get("terminologyRecall")
    baseline_numeric = baseline["macroMetrics"].get("numericEventAccuracy")
    candidate_numeric = candidate["macroMetrics"].get("numericEventAccuracy")
    gains = [
        candidate_value - baseline_value
        for candidate_value, baseline_value in (
            (candidate_terms, baseline_terms),
            (candidate_numeric, baseline_numeric),
        )
        if candidate_value is not None and baseline_value is not None
    ]
    best_event_gain = max(gains, default=0.0)
    macro_reduction = _relative_reduction(
        baseline["macroMetrics"]["cer"], candidate_cer
    )
    scenario_path = (
        macro_reduction
        >= materiality["minimumRelativeMacroLexicalErrorReduction"]
        and improved_hard_scenarios
        >= materiality["minimumHardScenariosImproved"]
    )
    event_path = (
        best_event_gain
        >= materiality["alternativeMinimumTerminologyNumericPointGain"]
    )
    material_benefit = clean_regression_ok and (scenario_path or event_path)
    return {
        "hardGateResults": gate_results,
        "hardFailures": [],
        "materialBenefit": {
            "qualified": material_benefit,
            "macroRelativeLexicalErrorReduction": macro_reduction,
            "hardScenariosMeetingReduction": improved_hard_scenarios,
            "bestTerminologyNumericPointGain": best_event_gain,
            "cleanMandarinRegressionWithinLimit": clean_regression_ok,
            "scenarioRelativeReductions": scenario_reductions,
        },
        "paretoEligible": material_benefit,
        "disposition": (
            "PARETO_REVIEW_ELIGIBLE"
            if material_benefit
            else "RETAIN_BASELINE_NO_MATERIAL_BENEFIT"
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runs", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    try:
        payload = json.loads(args.runs.read_text())
        require(isinstance(payload, list), "runs file must contain a list")
        aggregate = aggregate_candidate(payload)
    except (OSError, json.JSONDecodeError, AggregationError) as error:
        print(f"ASR aggregation: FAIL: {error}")
        return 1
    encoded = json.dumps(aggregate, ensure_ascii=False, indent=2, sort_keys=True)
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded + "\n")
    print(encoded)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
