#!/usr/bin/env python3
"""Validate and evaluate SenseVoice live-caption evidence."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import statistics
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[3]
DEFAULT_CONTRACT = Path(__file__).with_name(
    "sensevoice_live_caption_contract.json"
)
DEFAULT_OPTIMIZATION_CONTRACT = Path(__file__).with_name(
    "sensevoice_optimization_contract.json"
)
EXPECTED_TARGET = {
    "modelIdentifier": "Mac16,10",
    "os": "macOS 15.7.5",
    "osBuild": "24G624",
    "architecture": "arm64",
    "cpu": "Apple M4",
    "logicalCpuCount": 10,
    "memoryBytes": 17179869184,
    "buildMode": "debug",
}
REQUIRED_SCENARIOS = {
    "clean_near_field_mandarin",
    "clean_near_field_english",
    "far_field_noisy_meeting",
    "zh_en_code_switch",
    "terminology_numbers",
    "keyboard_noise",
    "system_microphone_double_talk",
    "long_utterance",
    "short_confirmation",
    "non_speech",
}


class LiveCaptionError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise LiveCaptionError(message)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _load_scorer():
    path = ROOT / "benchmark/desktop/asr_comparison/asr_scoring.py"
    specification = importlib.util.spec_from_file_location(
        "live_caption_frozen_scorer",
        path,
    )
    require(
        specification is not None and specification.loader is not None,
        "frozen scorer cannot be loaded",
    )
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


def mapping(value: Any, label: str) -> dict[str, Any]:
    require(isinstance(value, dict), f"{label} must be an object")
    return value


def finite(value: Any, label: str) -> float:
    require(
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value),
        f"{label} must be finite",
    )
    return float(value)


def optimization_scenario_error_rate(
    scenario: str,
    hypothesis: str,
    lexical: dict[str, Any],
) -> float:
    if scenario == "non_speech":
        return 1.0 if hypothesis.strip() else 0.0
    return float(
        lexical["wer"]
        if scenario == "clean_near_field_english"
        else lexical["cer"]
    )


def validate_fixture_manifest(manifest: dict[str, Any]) -> None:
    require(
        manifest.get("schemaVersion") == 1
        and manifest.get("status") == "FROZEN",
        "fixture manifest is not frozen",
    )
    dataset = mapping(manifest.get("dataset"), "dataset")
    require(
        dataset.get("id") == "google/fleurs"
        and dataset.get("revision")
        == "70bb2e84b976b7e960aa89f1c648e09c59f894dd"
        and dataset.get("license") == "CC-BY-4.0"
        and dataset.get("localOnly") is True,
        "fixture source identity drifted",
    )
    fixtures = manifest.get("fixtures")
    require(isinstance(fixtures, list), "fixtures must be an array")
    for role in ("development", "held_out"):
        selected = [
            item
            for item in fixtures
            if isinstance(item, dict) and item.get("fixtureRole") == role
        ]
        require(
            {item.get("scenario") for item in selected} == REQUIRED_SCENARIOS,
            f"{role} fixture scenario coverage is incomplete",
        )
        require(
            all(item.get("freezeState") == "FROZEN" for item in selected),
            f"{role} fixtures are not frozen",
        )
    development_rows = {
        (row["language"], row["split"], row["rowIndex"])
        for fixture in fixtures
        if isinstance(fixture, dict)
        and fixture.get("fixtureRole") == "development"
        for row in fixture.get("sourceRows", [])
    }
    held_out_rows = {
        (row["language"], row["split"], row["rowIndex"])
        for fixture in fixtures
        if isinstance(fixture, dict)
        and fixture.get("fixtureRole") == "held_out"
        for row in fixture.get("sourceRows", [])
    }
    require(
        development_rows.isdisjoint(held_out_rows),
        "development and held-out source rows overlap",
    )
    stability = [
        item
        for item in fixtures
        if isinstance(item, dict) and item.get("fixtureRole") == "stability"
    ]
    require(
        len(stability) == 1
        and 900 <= stability[0]["audio"]["durationSeconds"] <= 1800,
        "bounded stability fixture is invalid",
    )


def validate_contract(
    contract: dict[str, Any],
    *,
    root: Path = ROOT,
    validate_files: bool = True,
) -> None:
    require(contract.get("schemaVersion") == 1, "contract schema changed")
    require(
        contract.get("developmentPosture") == "DEVELOPMENT_ONLY",
        "live captions must remain DEVELOPMENT_ONLY",
    )
    require(contract.get("maximumProbeMinutes") == 30, "probe exceeds 30 minutes")
    require(contract.get("target") == EXPECTED_TARGET, "target drifted")
    control = mapping(contract.get("control"), "control")
    require(
        control
        == {
            "provider": "cpu",
            "threads": 2,
            "concurrency": 1,
            "decodingMethod": "greedy_search",
            "language": "auto",
            "useInverseTextNormalization": False,
            "recognizerLifecycle": "resident_preloaded",
            "vadThreshold": 0.5,
            "minimumSpeechSeconds": 0.25,
            "minimumSilenceSeconds": 0.5,
            "maximumUtteranceSeconds": 15.0,
            "publishesTokenPartials": False,
            "publishesCompletedUtterancesOnly": True,
        },
        "U13 control changed",
    )
    require(
        contract["runtime"]["minimumMacosVersion"] == "15.5",
        "local processing minimum macOS changed",
    )
    if validate_files:
        inputs = mapping(contract.get("inputs"), "inputs")
        for label, path_key, sha_key in (
            ("fixture manifest", "fixtureManifestPath", "fixtureManifestSha256"),
            ("scorer", "scorerPath", "scorerSha256"),
        ):
            path = root / str(inputs[path_key])
            require(path.is_file(), f"{label} is missing")
            require(sha256(path) == inputs[sha_key], f"{label} hash drifted")
        manifest = json.loads(
            (root / inputs["fixtureManifestPath"]).read_text(encoding="utf-8")
        )
        validate_fixture_manifest(manifest)


def build_optimization_profiles(
    contract: dict[str, Any],
) -> list[dict[str, Any]]:
    profiles: dict[str, dict[str, Any]] = {
        "control": dict(mapping(contract.get("control"), "optimization control"))
    }
    result = [
        {
            "id": "control",
            "baseArmId": None,
            "changedVariable": None,
            "config": profiles["control"],
        }
    ]
    for raw in contract.get("arms", []):
        arm = mapping(raw, "optimization arm")
        base = str(arm["baseArmId"])
        require(base in profiles, "optimization arm base is unavailable")
        config = dict(profiles[base])
        config[str(arm["variable"])] = arm["value"]
        profiles[str(arm["id"])] = config
        result.append(
            {
                "id": arm["id"],
                "baseArmId": base,
                "changedVariable": arm["variable"],
                "config": config,
            }
        )
    return result


def validate_optimization_contract(
    contract: dict[str, Any],
    *,
    root: Path = ROOT,
    validate_files: bool = True,
) -> None:
    require(contract.get("schemaVersion") == 1, "optimization schema changed")
    require(
        contract.get("developmentPosture") == "DEVELOPMENT_ONLY",
        "SenseVoice optimization must remain DEVELOPMENT_ONLY",
    )
    require(
        contract.get("maximumProbeMinutes") == 30,
        "optimization probe exceeds 30 minutes",
    )
    require(contract.get("target") == EXPECTED_TARGET, "optimization target drifted")
    inputs = mapping(contract.get("inputs"), "optimization inputs")
    if validate_files:
        for label, path_key, sha_key in (
            ("U13 contract", "u13ContractPath", "u13ContractSha256"),
            ("U13 decision", "u13DecisionPath", "u13DecisionSha256"),
            ("fixture manifest", "fixtureManifestPath", "fixtureManifestSha256"),
            ("scorer", "scorerPath", "scorerSha256"),
        ):
            path = root / str(inputs[path_key])
            require(path.is_file(), f"{label} is missing")
            require(sha256(path) == inputs[sha_key], f"{label} hash drifted")
        u13 = json.loads(
            (root / inputs["u13DecisionPath"]).read_text(encoding="utf-8")
        )
        require(
            u13.get("status") == "PASS"
            and u13.get("productDisposition")
            == "U13_CONTROL_ADMITTED_PENDING_U18_OPTIMIZATION_DECISION",
            "U13 control decision is not admissible",
        )
        manifest = json.loads(
            (root / inputs["fixtureManifestPath"]).read_text(encoding="utf-8")
        )
        validate_fixture_manifest(manifest)
    control = mapping(contract.get("control"), "optimization control")
    expected_control = {
        "runtime": "sherpa-onnx-1.13.4-ort-1.27.0",
        "model": "sensevoice-int8-2024-07-17",
        "provider": "cpu",
        "threads": 2,
        "concurrency": 1,
        "decodingMethod": "greedy_search",
        "language": "auto",
        "useInverseTextNormalization": False,
        "recognizerLifecycle": "resident_preloaded",
        "vadThreshold": 0.5,
        "minimumSpeechSeconds": 0.25,
        "minimumSilenceSeconds": 0.5,
        "maximumUtteranceSeconds": 15.0,
        "publishesTokenPartials": False,
        "publishesCompletedUtterancesOnly": True,
    }
    require(control == expected_control, "SenseVoice optimization control changed")
    runtimes = mapping(contract.get("runtimes"), "optimization runtimes")
    models = mapping(contract.get("models"), "optimization models")
    require(
        set(runtimes)
        == {
            "sherpa-onnx-1.13.4-ort-1.27.0",
            "sherpa-onnx-1.13.4-ort-1.24.4",
        },
        "optimization runtime set changed",
    )
    require(
        set(models)
        == {
            "sensevoice-int8-2024-07-17",
            "sensevoice-int8-2025-09-09",
        },
        "optimization model set changed",
    )
    for runtime_id, runtime in runtimes.items():
        runtime = mapping(runtime, runtime_id)
        require(
            isinstance(runtime.get("archiveSha256"), str)
            and len(runtime["archiveSha256"]) == 64,
            "optimization runtime hash is invalid",
        )
        libraries = mapping(runtime.get("libraries"), f"{runtime_id} libraries")
        require(
            len(libraries) == 3
            and all(
                isinstance(value, str) and len(value) == 64
                for value in libraries.values()
            ),
            "optimization runtime libraries are not pinned",
        )
    for model_id, model in models.items():
        model = mapping(model, model_id)
        require(
            all(
                isinstance(model.get(key), str) and len(model[key]) == 64
                for key in ("archiveSha256", "modelSha256", "tokensSha256")
            ),
            "optimization model hashes are invalid",
        )
    require(
        models["sensevoice-int8-2024-07-17"].get("promotionEligible") is True
        and models["sensevoice-int8-2025-09-09"].get("promotionEligible") is False
        and models["sensevoice-int8-2025-09-09"].get("licenseDisposition")
        == "UNRESOLVED_UPSTREAM_LICENSE",
        "unlicensed model arm became promotion eligible",
    )
    allowed_variables = {
        "runtime",
        "model",
        "useInverseTextNormalization",
        "language",
        "threads",
        "vadThreshold",
        "minimumSpeechSeconds",
        "minimumSilenceSeconds",
        "maximumUtteranceSeconds",
    }
    seen = {"control"}
    for raw in contract.get("arms", []):
        arm = mapping(raw, "optimization arm")
        require(
            set(arm) == {"id", "baseArmId", "variable", "value"},
            "optimization arm contains multiple-variable fields",
        )
        require(
            isinstance(arm.get("id"), str)
            and arm["id"] not in seen
            and arm.get("baseArmId") in seen,
            "optimization arm dependency is invalid",
        )
        variable = arm.get("variable")
        require(variable in allowed_variables, "optimization variable is unregistered")
        base_config = next(
            item["config"]
            for item in build_optimization_profiles(
                {
                    **contract,
                    "arms": [
                        item
                        for item in contract["arms"]
                        if item["id"] in seen
                    ],
                }
            )
            if item["id"] == arm["baseArmId"]
        )
        require(
            arm.get("value") != base_config[variable],
            "optimization arm does not change its variable",
        )
        seen.add(arm["id"])
    profiles = build_optimization_profiles(contract)
    require(len(profiles) == 14, "optimization matrix size changed")
    for profile in profiles:
        config = profile["config"]
        require(config["runtime"] in runtimes, "profile runtime is unregistered")
        require(config["model"] in models, "profile model is unregistered")
        require(config["threads"] in {1, 2, 3}, "profile threads escaped bounds")
        require(config["language"] in {"auto", "zh", "en"}, "profile language escaped")
        require(
            config["vadThreshold"] in {0.4, 0.5, 0.6}
            and config["minimumSpeechSeconds"] in {0.15, 0.25}
            and config["minimumSilenceSeconds"] in {0.35, 0.5, 0.7}
            and config["maximumUtteranceSeconds"] in {12.0, 15.0},
            "profile VAD escaped bounds",
        )
        differences = {
            key for key in control if config.get(key) != control.get(key)
        }
        require(
            len(differences) <= 1,
            "optimization profile changed more than one variable",
        )
    screening = mapping(contract.get("screening"), "optimization screening")
    finalist = mapping(contract.get("finalist"), "optimization finalist")
    require(
        screening
        == {
            "fixtureRole": "development",
            "warmupFixtureId": "development-short-confirmation",
            "warmupRuns": 1,
            "measuredRuns": 1,
            "replayRealtime": False,
        },
        "optimization screening changed",
    )
    require(
        finalist.get("qualityFixtureRole") == "held_out"
        and finalist.get("stabilityFixtureId") == "stability-multiscene-15m"
        and finalist.get("stabilityReplaySeconds") == 900
        and finalist.get("replayRealtime") is True,
        "optimization finalist probe changed",
    )


def build_optimization_summary(
    *,
    raw: dict[str, Any],
    contract: dict[str, Any],
    manifest: dict[str, Any],
    fixture_root: Path,
) -> dict[str, Any]:
    validate_optimization_contract(contract)
    validate_fixture_manifest(manifest)
    require(
        raw.get("schemaVersion") == 1
        and raw.get("kind") == "sensevoice_live_caption_optimization_raw"
        and raw.get("contractId") == contract["contractId"]
        and raw.get("status") == "COMPLETE"
        and raw.get("stage") in {"screening", "finalist"},
        "optimization raw identity is invalid",
    )
    require(raw.get("target") == EXPECTED_TARGET, "optimization raw target drifted")
    bindings = mapping(raw.get("bindings"), "optimization bindings")
    require(
        bindings.get("contractSha256") == sha256(DEFAULT_OPTIMIZATION_CONTRACT)
        and bindings.get("fixtureManifestSha256")
        == contract["inputs"]["fixtureManifestSha256"]
        and bindings.get("scorerSha256") == contract["inputs"]["scorerSha256"]
        and bindings.get("vadSha256")
        == json.loads(
            (ROOT / contract["inputs"]["u13ContractPath"]).read_text(
                encoding="utf-8"
            )
        )["vad"]["sha256"],
        "optimization raw bindings drifted",
    )
    expected_profiles = {
        profile["id"]: profile for profile in build_optimization_profiles(contract)
    }
    raw_arms = raw.get("arms")
    require(isinstance(raw_arms, list) and raw_arms, "optimization arms are missing")
    expected_arm_ids = (
        set(expected_profiles)
        if raw["stage"] == "screening"
        else {str(raw_arms[0].get("id"))}
    )
    require(
        {str(arm.get("id")) for arm in raw_arms} == expected_arm_ids,
        "optimization arm coverage drifted",
    )
    fixture_index = {
        fixture["fixtureId"]: fixture
        for fixture in manifest["fixtures"]
        if isinstance(fixture, dict)
    }
    scorer = _load_scorer()
    summaries: list[dict[str, Any]] = []
    observed_worker_sha256: str | None = None
    for raw_arm in raw_arms:
        arm = mapping(raw_arm, "optimization arm")
        arm_id = str(arm.get("id"))
        expected = expected_profiles[arm_id]
        require(
            arm.get("baseArmId") == expected["baseArmId"]
            and arm.get("changedVariable") == expected["changedVariable"]
            and arm.get("effectiveConfig") == expected["config"],
            "optimization arm identity drifted",
        )
        arm_bindings = mapping(arm.get("bindings"), "optimization arm bindings")
        effective = expected["config"]
        runtime_contract = contract["runtimes"][effective["runtime"]]
        model_contract = contract["models"][effective["model"]]
        worker_sha256 = arm_bindings.get("workerSha256")
        require(
            arm_bindings.get("runtimeArchiveSha256")
            == runtime_contract["archiveSha256"]
            and arm_bindings.get("modelArchiveSha256")
            == model_contract["archiveSha256"]
            and arm_bindings.get("modelSha256") == model_contract["modelSha256"]
            and arm_bindings.get("tokensSha256") == model_contract["tokensSha256"]
            and isinstance(worker_sha256, str)
            and len(worker_sha256) == 64
            and all(character in "0123456789abcdef" for character in worker_sha256),
            "optimization arm asset bindings drifted",
        )
        if observed_worker_sha256 is None:
            observed_worker_sha256 = worker_sha256
        require(
            worker_sha256 == observed_worker_sha256,
            "optimization worker changed between arms",
        )
        require(
            finite(arm.get("probeDurationSeconds"), "optimization duration")
            <= contract["maximumProbeMinutes"] * 60
            and finite(arm.get("workerCpuSeconds"), "optimization CPU seconds")
            >= 0
            and finite(
                arm.get("workerCpuSecondsPerAudioSecond"),
                "optimization CPU per audio second",
            )
            >= 0
            and arm.get("retainedRssBytesAfterWorkerExit") == 0
            and arm.get("workerExitedCleanly") is True
            and arm.get("temporaryFilesClean") is True,
            "optimization arm did not terminate cleanly",
        )
        ready = mapping(arm.get("ready"), "optimization ready")
        cold_load_ms = finite(ready.get("modelLoadMs"), "cold model load")
        runs = arm.get("runs")
        require(isinstance(runs, list) and runs, "optimization runs are missing")
        error_rates: list[float] = []
        non_target_error_rates: list[float] = []
        code_switch_error_rates: list[float] = []
        terminology_values: list[float] = []
        numeric_values: list[float] = []
        itn_values: list[float] = []
        decode_values: list[float] = []
        visibility_values: list[float] = []
        maximum_rss = int(finite(ready.get("residentBytes"), "ready RSS"))
        maximum_backlog = 0.0
        maximum_utterance = 0.0
        complete_input = True
        short_confirmation_detected = False
        hallucinated = False
        scenario_metrics: list[dict[str, Any]] = []
        for run in runs:
            run = mapping(run, "optimization run")
            fixture = mapping(
                fixture_index.get(run.get("fixtureId")),
                "optimization fixture",
            )
            require(
                run.get("fixtureRole") == fixture["fixtureRole"]
                and run.get("scenario") == fixture["scenario"]
                and run.get("audioSha256") == fixture["audio"]["sha256"]
                and run.get("referenceSha256") == fixture["reference"]["sha256"],
                "optimization fixture binding drifted",
            )
            complete = mapping(run.get("complete"), "optimization complete")
            complete_input = complete_input and (
                complete.get("inputSamples") == complete.get("consumedSamples")
            )
            maximum_backlog = max(
                maximum_backlog,
                finite(complete.get("maximumQueuedSeconds"), "optimization backlog"),
            )
            maximum_rss = max(
                maximum_rss,
                int(finite(complete.get("residentBytes"), "optimization RSS")),
            )
            utterances = run.get("utterances")
            require(isinstance(utterances, list), "optimization utterances missing")
            texts: list[str] = []
            for utterance in utterances:
                utterance = mapping(utterance, "optimization utterance")
                start = finite(utterance.get("startSeconds"), "utterance start")
                end = finite(utterance.get("endSeconds"), "utterance end")
                require(
                    0 <= start <= end <= float(run["audioDurationSeconds"]) + 0.001,
                    "optimization utterance offsets are invalid",
                )
                maximum_utterance = max(maximum_utterance, end - start)
                text = utterance.get("text")
                require(isinstance(text, str), "optimization utterance text invalid")
                texts.append(text)
                decode_values.append(
                    finite(utterance.get("decodeMilliseconds"), "decode latency")
                )
                maximum_rss = max(
                    maximum_rss,
                    int(finite(utterance.get("residentBytes"), "utterance RSS")),
                )
                if run.get("replayRealtime") is True:
                    visibility_values.append(
                        (
                            int(
                                finite(
                                    utterance.get("driverReceivedEpochUs"),
                                    "driver receipt",
                                )
                            )
                            - int(
                                finite(
                                    utterance.get("speechEndEpochUs"),
                                    "speech end",
                                )
                            )
                        )
                        / 1000
                    )
            hypothesis = " ".join(texts)
            reference_path = fixture_root / fixture["reference"]["relativePath"]
            require(reference_path.is_file(), "optimization reference is missing")
            require(
                sha256(reference_path) == fixture["reference"]["sha256"],
                "optimization reference hash drifted",
            )
            score = scorer.score_text(
                reference_path.read_text(encoding="utf-8"),
                hypothesis,
                duration_seconds=float(run["audioDurationSeconds"]),
                annotations=fixture.get("optimizationAnnotations", {}),
            )
            lexical = score["lexical"]
            scenario = str(run["scenario"])
            error_rate = optimization_scenario_error_rate(
                scenario,
                hypothesis,
                lexical,
            )
            is_quality_fixture = fixture["fixtureRole"] in {
                "development",
                "held_out",
            }
            if is_quality_fixture and scenario != "non_speech":
                error_rates.append(error_rate)
                if scenario != "terminology_numbers":
                    non_target_error_rates.append(error_rate)
            if is_quality_fixture and scenario == "zh_en_code_switch":
                code_switch_error_rates.append(
                    statistics.fmean(
                        [
                            float(lexical["codeSwitchZhCer"]),
                            float(lexical["codeSwitchEnWer"]),
                        ]
                    )
                )
            if is_quality_fixture and lexical["terminologyRecall"] is not None:
                terminology_values.append(float(lexical["terminologyRecall"]))
            if is_quality_fixture and lexical["numericEventAccuracy"] is not None:
                numeric_values.append(float(lexical["numericEventAccuracy"]))
            if (
                is_quality_fixture
                and score["display"]["itnEventAccuracy"] is not None
            ):
                itn_values.append(float(score["display"]["itnEventAccuracy"]))
            if scenario == "short_confirmation":
                short_confirmation_detected = bool(hypothesis.strip())
            if scenario == "non_speech":
                hallucinated = bool(hypothesis.strip())
            scenario_metrics.append(
                {
                    "scenario": scenario,
                    "errorRate": error_rate,
                    "utteranceCount": len(utterances),
                    "terminologyRecall": lexical["terminologyRecall"],
                    "numericEventAccuracy": lexical["numericEventAccuracy"],
                    "itnEventAccuracy": score["display"]["itnEventAccuracy"],
                }
            )
        require(error_rates and decode_values, "optimization metrics are empty")
        decode_sorted = sorted(decode_values)
        summary = {
            "id": arm_id,
            "baseArmId": expected["baseArmId"],
            "changedVariable": expected["changedVariable"],
            "effectiveConfig": expected["config"],
            "bindings": arm_bindings,
            "probeDurationSeconds": arm["probeDurationSeconds"],
            "workerCpuSeconds": arm["workerCpuSeconds"],
            "workerCpuSecondsPerAudioSecond": arm[
                "workerCpuSecondsPerAudioSecond"
            ],
            "retainedRssBytesAfterWorkerExit": 0,
            "coldLoadMs": cold_load_ms,
            "warmUtteranceP50Ms": statistics.median(decode_values),
            "warmUtteranceP95Ms": decode_sorted[
                max(0, math.ceil(len(decode_sorted) * 0.95) - 1)
            ],
            "speechEndToDriverP50Ms": (
                statistics.median(visibility_values) if visibility_values else None
            ),
            "speechEndToDriverP95Ms": (
                sorted(visibility_values)[
                    max(0, math.ceil(len(visibility_values) * 0.95) - 1)
                ]
                if visibility_values
                else None
            ),
            "errorRate": statistics.fmean(error_rates),
            "nonTargetErrorRate": statistics.fmean(non_target_error_rates),
            "codeSwitchErrorRate": (
                statistics.fmean(code_switch_error_rates)
                if code_switch_error_rates
                else None
            ),
            "terminologyRecall": (
                statistics.fmean(terminology_values)
                if terminology_values
                else None
            ),
            "numericEventAccuracy": (
                statistics.fmean(numeric_values) if numeric_values else None
            ),
            "itnEventAccuracy": (
                statistics.fmean(itn_values) if itn_values else None
            ),
            "maximumRssBytes": maximum_rss,
            "maximumBacklogSeconds": maximum_backlog,
            "maximumUtteranceSeconds": round(maximum_utterance, 6),
            "completeInputConsumed": complete_input,
            "shortConfirmationDetected": short_confirmation_detected,
            "hallucinated": hallucinated,
            "scenarioMetrics": scenario_metrics,
        }
        summaries.append(summary)
    output: dict[str, Any] = {
        "schemaVersion": 1,
        "kind": "sensevoice_live_caption_optimization_summary",
        "contractId": contract["contractId"],
        "status": "COMPLETE",
        "stage": raw["stage"],
        "target": EXPECTED_TARGET,
        "bindings": bindings,
        "arms": summaries,
    }
    if raw["stage"] == "screening":
        output["selection"] = select_optimization_finalist(summaries, contract)
    return output


def select_optimization_finalist(
    arms: list[dict[str, Any]],
    contract: dict[str, Any],
) -> dict[str, Any]:
    by_id = {arm["id"]: arm for arm in arms}
    require("control" in by_id, "optimization control summary missing")
    control = by_id["control"]
    promotion = contract["promotion"]
    eligible: list[tuple[float, float, str, str]] = []
    models = contract["models"]
    admitted_ids = {"control"}
    for arm_contract in contract["arms"]:
        arm_id = arm_contract["id"]
        arm = by_id[arm_id]
        base_id = arm_contract["baseArmId"]
        if base_id not in admitted_ids:
            continue
        base = by_id[base_id]
        model = models[arm["effectiveConfig"]["model"]]
        quality_gain = base["errorRate"] - arm["errorRate"]
        latency_gain = (
            base["warmUtteranceP95Ms"] - arm["warmUtteranceP95Ms"]
        ) / base["warmUtteranceP95Ms"]
        non_target_regression = (
            arm["nonTargetErrorRate"] - base["nonTargetErrorRate"]
        )
        code_switch_regression = (
            arm["codeSwitchErrorRate"] - base["codeSwitchErrorRate"]
        )
        rss_regression = (
            arm["maximumRssBytes"] - base["maximumRssBytes"]
        ) / base["maximumRssBytes"]
        numeric_non_regression = (
            arm["numericEventAccuracy"] >= base["numericEventAccuracy"]
            and arm["itnEventAccuracy"] >= base["itnEventAccuracy"]
        )
        admitted = (
            model["promotionEligible"] is True
            and (
                quality_gain
                >= promotion["minimumAbsoluteErrorRateImprovement"]
                or latency_gain
                >= promotion["minimumRelativeLatencyImprovement"]
            )
            and non_target_regression
            <= promotion["maximumNonTargetErrorRateRegression"]
            and code_switch_regression
            <= promotion["maximumCodeSwitchErrorRateRegression"]
            and rss_regression <= promotion["maximumRssRelativeRegression"]
            and numeric_non_regression
            and arm["shortConfirmationDetected"] is True
            and arm["hallucinated"] is False
            and arm["completeInputConsumed"] is True
            and arm["maximumUtteranceSeconds"]
            <= promotion["maximumUtteranceSeconds"] + 1e-6
            and arm["maximumBacklogSeconds"]
            <= promotion["maximumBacklogSeconds"]
        )
        if admitted:
            admitted_ids.add(arm_id)
            basis = (
                "quality"
                if quality_gain
                >= promotion["minimumAbsoluteErrorRateImprovement"]
                else "latency"
            )
            eligible.append(
                (arm["errorRate"], arm["warmUtteranceP95Ms"], arm_id, basis)
            )
    if not eligible:
        return {
            "status": "CONTROL_RETAINED",
            "selectedArm": "control",
            "reason": "no arm met all preregistered screening guardrails",
        }
    eligible.sort()
    _, _, selected, basis = eligible[0]
    return {
        "status": "OPTIMIZATION_SCREENED_IN",
        "selectedArm": selected,
        "reason": f"{basis} gate passed; held-out/stability validation required",
    }


def build_u13_optimization_control_metrics(
    *,
    raw: dict[str, Any],
    contract: dict[str, Any],
    manifest: dict[str, Any],
    fixture_root: Path,
) -> dict[str, Any]:
    require(
        raw.get("schemaVersion") == 1
        and raw.get("kind") == "sensevoice_live_caption_raw"
        and raw.get("status") == "COMPLETE"
        and raw.get("target") == EXPECTED_TARGET,
        "U13 optimization control identity drifted",
    )
    expected_config = dict(mapping(contract.get("control"), "control"))
    expected_config.pop("runtime")
    expected_config.pop("model")
    require(
        raw.get("effectiveConfig") == expected_config,
        "U13 optimization control profile drifted",
    )
    fixture_index = {
        fixture["fixtureId"]: fixture
        for fixture in manifest["fixtures"]
        if isinstance(fixture, dict)
    }
    scorer = _load_scorer()
    error_rates: list[float] = []
    non_target_error_rates: list[float] = []
    code_switch_error_rates: list[float] = []
    terminology_values: list[float] = []
    numeric_values: list[float] = []
    itn_values: list[float] = []
    decode_values: list[float] = []
    maximum_rss = int(
        finite(mapping(raw.get("ready"), "U13 ready").get("residentBytes"), "U13 RSS")
    )
    maximum_backlog = 0.0
    maximum_utterance = 0.0
    complete_input = True
    short_confirmation_detected = False
    hallucinated = False
    for raw_run in raw.get("runs", []):
        run = mapping(raw_run, "U13 optimization run")
        fixture = mapping(
            fixture_index.get(run.get("fixtureId")),
            "U13 optimization fixture",
        )
        require(
            run.get("fixtureRole") == fixture["fixtureRole"]
            and run.get("scenario") == fixture["scenario"]
            and run.get("audioSha256") == fixture["audio"]["sha256"]
            and run.get("referenceSha256") == fixture["reference"]["sha256"],
            "U13 optimization fixture binding drifted",
        )
        complete = mapping(run.get("complete"), "U13 optimization complete")
        complete_input = complete_input and (
            complete.get("inputSamples") == complete.get("consumedSamples")
        )
        maximum_backlog = max(
            maximum_backlog,
            finite(complete.get("maximumQueuedSeconds"), "U13 backlog"),
        )
        maximum_rss = max(
            maximum_rss,
            int(finite(complete.get("residentBytes"), "U13 RSS")),
        )
        texts: list[str] = []
        for raw_utterance in run.get("utterances", []):
            utterance = mapping(raw_utterance, "U13 optimization utterance")
            start = finite(utterance.get("startSeconds"), "U13 utterance start")
            end = finite(utterance.get("endSeconds"), "U13 utterance end")
            require(0 <= start <= end, "U13 utterance offsets are invalid")
            maximum_utterance = max(maximum_utterance, end - start)
            text = utterance.get("text")
            require(isinstance(text, str), "U13 utterance text is invalid")
            texts.append(text)
            decode_values.append(
                finite(utterance.get("decodeMilliseconds"), "U13 decode latency")
            )
            maximum_rss = max(
                maximum_rss,
                int(finite(utterance.get("residentBytes"), "U13 RSS")),
            )
        if fixture["fixtureRole"] != "held_out":
            continue
        hypothesis = " ".join(texts)
        reference_path = fixture_root / fixture["reference"]["relativePath"]
        require(
            reference_path.is_file()
            and sha256(reference_path) == fixture["reference"]["sha256"],
            "U13 optimization reference drifted",
        )
        score = scorer.score_text(
            reference_path.read_text(encoding="utf-8"),
            hypothesis,
            duration_seconds=float(run["audioDurationSeconds"]),
            annotations=fixture.get("optimizationAnnotations", {}),
        )
        lexical = score["lexical"]
        scenario = str(fixture["scenario"])
        error_rate = optimization_scenario_error_rate(
            scenario,
            hypothesis,
            lexical,
        )
        if scenario != "non_speech":
            error_rates.append(error_rate)
            if scenario != "terminology_numbers":
                non_target_error_rates.append(error_rate)
        if scenario == "zh_en_code_switch":
            code_switch_error_rates.append(
                statistics.fmean(
                    [
                        float(lexical["codeSwitchZhCer"]),
                        float(lexical["codeSwitchEnWer"]),
                    ]
                )
            )
        if lexical["terminologyRecall"] is not None:
            terminology_values.append(float(lexical["terminologyRecall"]))
        if lexical["numericEventAccuracy"] is not None:
            numeric_values.append(float(lexical["numericEventAccuracy"]))
        if score["display"]["itnEventAccuracy"] is not None:
            itn_values.append(float(score["display"]["itnEventAccuracy"]))
        if scenario == "short_confirmation":
            short_confirmation_detected = bool(hypothesis.strip())
        if scenario == "non_speech":
            hallucinated = bool(hypothesis.strip())
    require(
        error_rates and decode_values and code_switch_error_rates,
        "U13 optimization control metrics are empty",
    )
    ordered_decode = sorted(decode_values)
    return {
        "id": "control",
        "errorRate": statistics.fmean(error_rates),
        "nonTargetErrorRate": statistics.fmean(non_target_error_rates),
        "codeSwitchErrorRate": statistics.fmean(code_switch_error_rates),
        "terminologyRecall": statistics.fmean(terminology_values),
        "numericEventAccuracy": statistics.fmean(numeric_values),
        "itnEventAccuracy": statistics.fmean(itn_values),
        "warmUtteranceP95Ms": ordered_decode[
            max(0, math.ceil(len(ordered_decode) * 0.95) - 1)
        ],
        "maximumRssBytes": maximum_rss,
        "maximumBacklogSeconds": maximum_backlog,
        "maximumUtteranceSeconds": round(maximum_utterance, 6),
        "completeInputConsumed": complete_input,
        "shortConfirmationDetected": short_confirmation_detected,
        "hallucinated": hallucinated,
    }


def select_optimization_final_decision(
    *,
    screening: dict[str, Any],
    finalist: dict[str, Any],
    control: dict[str, Any],
    contract: dict[str, Any],
) -> dict[str, Any]:
    selection = mapping(screening.get("selection"), "screening selection")
    require(
        selection.get("status") == "OPTIMIZATION_SCREENED_IN",
        "screening did not nominate a finalist",
    )
    finalist_arms = finalist.get("arms")
    require(
        isinstance(finalist_arms, list)
        and len(finalist_arms) == 1
        and finalist_arms[0].get("id") == selection.get("selectedArm"),
        "finalist identity drifted",
    )
    candidate = finalist_arms[0]
    promotion = mapping(contract.get("promotion"), "promotion")
    quality_gain = control["errorRate"] - candidate["errorRate"]
    latency_gain = (
        control["warmUtteranceP95Ms"] - candidate["warmUtteranceP95Ms"]
    ) / control["warmUtteranceP95Ms"]
    non_target_regression = (
        candidate["nonTargetErrorRate"] - control["nonTargetErrorRate"]
    )
    code_switch_regression = (
        candidate["codeSwitchErrorRate"] - control["codeSwitchErrorRate"]
    )
    rss_regression = (
        candidate["maximumRssBytes"] - control["maximumRssBytes"]
    ) / control["maximumRssBytes"]
    model = contract["models"][candidate["effectiveConfig"]["model"]]
    gates = {
        "promotionEligibleModel": model["promotionEligible"] is True,
        "qualityOrLatencyImprovement": (
            quality_gain >= promotion["minimumAbsoluteErrorRateImprovement"]
            or latency_gain >= promotion["minimumRelativeLatencyImprovement"]
        ),
        "nonTargetNonRegression": (
            non_target_regression
            <= promotion["maximumNonTargetErrorRateRegression"]
        ),
        "codeSwitchNonRegression": (
            code_switch_regression
            <= promotion["maximumCodeSwitchErrorRateRegression"]
        ),
        "rssBounded": (
            rss_regression <= promotion["maximumRssRelativeRegression"]
        ),
        "numericSemanticNonRegression": (
            candidate["numericEventAccuracy"]
            >= control["numericEventAccuracy"]
            and candidate["itnEventAccuracy"] >= control["itnEventAccuracy"]
        ),
        "shortConfirmationDetected": (
            candidate["shortConfirmationDetected"] is True
        ),
        "nonSpeechClean": candidate["hallucinated"] is False,
        "completeInputConsumed": candidate["completeInputConsumed"] is True,
        "maximumUtteranceBounded": (
            candidate["maximumUtteranceSeconds"]
            <= promotion["maximumUtteranceSeconds"] + 1e-6
        ),
        "maximumBacklogBounded": (
            candidate["maximumBacklogSeconds"]
            <= promotion["maximumBacklogSeconds"]
        ),
        "workerExitedCleanly": (
            candidate["retainedRssBytesAfterWorkerExit"] == 0
        ),
    }
    admitted = all(gates.values())
    return {
        "status": (
            "OPTIMIZATION_ADMITTED" if admitted else "CONTROL_RETAINED"
        ),
        "selectedArm": (
            candidate["id"] if admitted else "control"
        ),
        "screenedCandidate": candidate["id"],
        "reason": (
            "all held-out and bounded stability guardrails passed"
            if admitted
            else "screened candidate failed held-out or bounded stability guardrails"
        ),
        "gates": gates,
        "comparison": {
            "qualityGain": quality_gain,
            "latencyGain": latency_gain,
            "nonTargetRegression": non_target_regression,
            "codeSwitchRegression": code_switch_regression,
            "rssRegression": rss_regression,
        },
    }


def validate_evidence(
    evidence: dict[str, Any],
    contract: dict[str, Any],
) -> dict[str, Any]:
    validate_contract(contract)
    require(evidence.get("schemaVersion") == 1, "evidence schema changed")
    require(
        evidence.get("contractId") == contract["contractId"],
        "evidence contract mismatch",
    )
    require(evidence.get("status") in {"COMPLETE", "BLOCKED"}, "status invalid")
    if evidence["status"] == "BLOCKED":
        missing = evidence.get("missingInputs")
        require(isinstance(missing, list) and missing, "blocked evidence needs inputs")
        return {
            "status": "UNAVAILABLE",
            "reason": "fixed live-caption inputs are unavailable",
        }
    require(evidence.get("target") == EXPECTED_TARGET, "evidence target drifted")
    bindings = mapping(evidence.get("bindings"), "bindings")
    require(
        bindings.get("fixtureManifestSha256")
        == contract["inputs"]["fixtureManifestSha256"]
        and bindings.get("scorerSha256")
        == contract["inputs"]["scorerSha256"]
        and bindings.get("modelArchiveSha256")
        == contract["model"]["archiveSha256"]
        and bindings.get("sileroVadSha256") == contract["vad"]["sha256"],
        "evidence bindings drifted",
    )
    require(evidence.get("effectiveConfig") == contract["control"], "control drifted")
    require(evidence.get("tokenPartialCount") == 0, "fake token partials observed")
    require(evidence.get("invalidWorkerEventCount") == 0, "invalid worker event")
    require(evidence.get("captureFrameLossDelta") == 0, "capture frame loss changed")
    quality = evidence.get("quality")
    require(isinstance(quality, list), "quality observations missing")
    require(
        {item.get("scenario") for item in quality} == REQUIRED_SCENARIOS,
        "quality scenario coverage is incomplete",
    )
    for item in quality:
        finite(item.get("errorRate"), f"{item.get('scenario')}.errorRate")
        require(item.get("completeInputConsumed") is True, "input was not consumed")
        require(item.get("offsetsValid") is True, "worker offsets are invalid")
    latency = mapping(evidence.get("latency"), "latency")
    resources = mapping(evidence.get("resources"), "resources")
    stability = mapping(evidence.get("stability"), "stability")
    gates = contract["gates"]
    p50 = finite(latency.get("speechEndToVisibleP50Ms"), "latency p50")
    p95 = finite(latency.get("speechEndToVisibleP95Ms"), "latency p95")
    maximum_backlog = finite(
        latency.get("maximumBacklogSeconds"),
        "maximum backlog",
    )
    duration = finite(stability.get("durationSeconds"), "stability duration")
    long_frame_rate = finite(resources.get("uiLongFrameRate"), "long frame rate")
    passed = (
        p50 <= gates["speechEndToVisibleP50Ms"]
        and p95 <= gates["speechEndToVisibleP95Ms"]
        and maximum_backlog <= gates["maximumBacklogSeconds"]
        and gates["minimumStabilityReplaySeconds"]
        <= duration
        <= gates["maximumStabilityReplaySeconds"]
        and resources.get("maximumAppRssBytes", gates["maximumAppRssBytes"] + 1)
        <= gates["maximumAppRssBytes"]
        and long_frame_rate <= gates["maximumUiLongFrameRate"]
        and stability.get("crashed") is False
        and stability.get("oom") is False
        and stability.get("maximumUtteranceSeconds", 16)
        <= gates["maximumUtteranceSeconds"]
    )
    return {
        "status": "PASS" if passed else "UNAVAILABLE",
        "reason": (
            "all frozen live-caption gates passed"
            if passed
            else "one or more frozen live-caption gates failed"
        ),
    }


def validate_integration_probe(
    probe: dict[str, Any],
    contract: dict[str, Any],
    manifest: dict[str, Any],
) -> dict[str, float | int]:
    require(
        probe.get("schemaVersion") == 1
        and probe.get("kind")
        == "sensevoice_live_caption_flutter_capture_probe"
        and probe.get("status") == "COMPLETE",
        "integration probe identity is invalid",
    )
    require(probe.get("target") == EXPECTED_TARGET, "integration target drifted")
    bindings = mapping(probe.get("bindings"), "integration bindings")
    stability = next(
        item
        for item in manifest["fixtures"]
        if item.get("fixtureRole") == "stability"
    )
    require(
        bindings.get("contractSha256") == sha256(DEFAULT_CONTRACT)
        and bindings.get("fixtureManifestSha256")
        == contract["inputs"]["fixtureManifestSha256"]
        and bindings.get("fixtureAudioSha256") == stability["audio"]["sha256"],
        "integration bindings drifted",
    )
    require(
        finite(probe.get("durationSeconds"), "integration duration") >= 120
        and finite(probe.get("controlDurationSeconds"), "control duration") >= 60
        and finite(
            probe.get("concurrentDurationSeconds"),
            "concurrent duration",
        )
        >= 60,
        "integration probe is too short",
    )
    require(
        probe.get("visibilityMeasurement") == "flutter_frame_timing",
        "Flutter visibility was not measured",
    )
    visibility = mapping(probe.get("flutterVisibility"), "Flutter visibility")
    result_to_visible = visibility.get("resultToVisibleMs")
    speech_to_visible = visibility.get("speechEndToVisibleMs")
    require(
        isinstance(result_to_visible, list)
        and isinstance(speech_to_visible, list)
        and len(result_to_visible) == len(speech_to_visible)
        and len(result_to_visible) == visibility.get("sampleCount")
        and len(result_to_visible) >= 3,
        "Flutter visibility samples are incomplete",
    )
    result_to_visible_values = [
        finite(value, "result-to-visible sample") for value in result_to_visible
    ]
    require(
        all(value >= 0 for value in result_to_visible_values),
        "Flutter visibility sample is negative",
    )
    ui_frames = mapping(probe.get("uiFrames"), "UI frames")
    ui_sample_count = int(finite(ui_frames.get("sampleCount"), "UI sample count"))
    ui_long_count = int(
        finite(ui_frames.get("longFrameCount"), "UI long-frame count")
    )
    ui_long_rate = finite(ui_frames.get("longFrameRate"), "UI long-frame rate")
    require(
        ui_sample_count > 0
        and 0 <= ui_long_count <= ui_sample_count
        and math.isclose(
            ui_long_rate,
            ui_long_count / ui_sample_count,
            abs_tol=1e-9,
        ),
        "UI frame accounting is invalid",
    )
    require(
        probe.get("captureControlMeasurement") == "concurrent_native_capture",
        "concurrent capture was not measured",
    )
    accounting = mapping(probe.get("captureAccounting"), "capture accounting")
    losses: dict[str, int] = {}
    for arm in ("control", "concurrent"):
        run = mapping(accounting.get(arm), f"{arm} capture")
        require(
            run.get("measurement") == "native_callback_to_durable_chunk",
            f"{arm} capture measurement drifted",
        )
        total_loss = 0
        for track in ("systemAudio", "microphone"):
            values = mapping(run.get(track), f"{arm}.{track}")
            delivered = int(
                finite(values.get("deliveredFrames"), f"{arm}.{track}.delivered")
            )
            committed = int(
                finite(values.get("committedFrames"), f"{arm}.{track}.committed")
            )
            lost = int(finite(values.get("lostFrames"), f"{arm}.{track}.lost"))
            require(
                delivered > 0 and committed == delivered and lost == 0,
                f"{arm}.{track} frame accounting failed",
            )
            total_loss += lost
        losses[arm] = total_loss
    resources = mapping(probe.get("resourceSampling"), "resource sampling")
    flutter_rss = int(
        finite(
            resources.get("maximumFlutterAppRssBytes"),
            "Flutter app RSS",
        )
    )
    worker_rss = int(
        finite(resources.get("maximumWorkerRssBytes"), "worker RSS")
    )
    combined_rss = int(
        finite(
            resources.get("conservativeMaximumCombinedRssBytes"),
            "combined RSS",
        )
    )
    require(
        flutter_rss > 0
        and worker_rss > 0
        and combined_rss == flutter_rss + worker_rss,
        "resource accounting is invalid",
    )
    ordered_visibility = sorted(result_to_visible_values)
    visibility_p95 = ordered_visibility[
        max(0, math.ceil(len(ordered_visibility) * 0.95) - 1)
    ]
    return {
        "resultToVisibleP95Ms": visibility_p95,
        "uiLongFrameRate": ui_long_rate,
        "maximumFlutterAppRssBytes": flutter_rss,
        "maximumProbeWorkerRssBytes": worker_rss,
        "captureFrameLossDelta": losses["concurrent"] - losses["control"],
    }


def build_evidence(
    *,
    raw: dict[str, Any],
    contract: dict[str, Any],
    manifest: dict[str, Any],
    fixture_root: Path,
    integration_probe: dict[str, Any] | None = None,
    integration_probe_sha256: str | None = None,
) -> dict[str, Any]:
    validate_contract(contract)
    validate_fixture_manifest(manifest)
    require(raw.get("schemaVersion") == 1, "raw schema changed")
    require(
        raw.get("kind") == "sensevoice_live_caption_raw"
        and raw.get("contractId") == contract["contractId"]
        and raw.get("status") == "COMPLETE",
        "raw identity is invalid",
    )
    require(raw.get("target") == EXPECTED_TARGET, "raw target drifted")
    require(raw.get("effectiveConfig") == contract["control"], "raw control drifted")
    bindings = mapping(raw.get("bindings"), "raw bindings")
    require(
        bindings.get("fixtureManifestSha256")
        == contract["inputs"]["fixtureManifestSha256"]
        and bindings.get("scorerSha256")
        == contract["inputs"]["scorerSha256"]
        and bindings.get("modelArchiveSha256")
        == contract["model"]["archiveSha256"]
        and bindings.get("sileroVadSha256") == contract["vad"]["sha256"],
        "raw bindings drifted",
    )
    fixture_index = {
        fixture["fixtureId"]: fixture
        for fixture in manifest["fixtures"]
        if isinstance(fixture, dict)
    }
    runs = raw.get("runs")
    require(isinstance(runs, list), "raw runs are missing")
    scorer = _load_scorer()
    quality: list[dict[str, Any]] = []
    stability_run: dict[str, Any] | None = None
    maximum_rss = int(raw["ready"]["residentBytes"])
    token_partial_count = 0
    invalid_event_count = 0
    for run in runs:
        require(isinstance(run, dict), "raw run is invalid")
        fixture = mapping(fixture_index.get(run.get("fixtureId")), "fixture")
        require(
            run.get("scenario") == fixture["scenario"]
            and run.get("audioSha256") == fixture["audio"]["sha256"]
            and run.get("referenceSha256") == fixture["reference"]["sha256"],
            "raw run fixture binding drifted",
        )
        complete = mapping(run.get("complete"), "raw complete event")
        token_partial_count += int(complete.get("tokenPartialCount", -1))
        maximum_rss = max(maximum_rss, int(complete.get("residentBytes", 0)))
        utterances = run.get("utterances")
        require(isinstance(utterances, list), "raw utterances are missing")
        previous_end = 0.0
        offsets_valid = True
        texts: list[str] = []
        for utterance in utterances:
            require(isinstance(utterance, dict), "raw utterance is invalid")
            start = finite(utterance.get("startSeconds"), "utterance start")
            end = finite(utterance.get("endSeconds"), "utterance end")
            offsets_valid = (
                offsets_valid
                and start >= previous_end
                and end >= start
                and end <= float(run["audioDurationSeconds"]) + 0.001
            )
            previous_end = end
            text = utterance.get("text")
            if not isinstance(text, str):
                invalid_event_count += 1
            else:
                texts.append(text)
            maximum_rss = max(
                maximum_rss,
                int(utterance.get("residentBytes", 0)),
            )
        complete_input = (
            complete.get("inputSamples") == complete.get("consumedSamples")
        )
        if fixture["fixtureRole"] == "held_out":
            reference_path = fixture_root / fixture["reference"]["relativePath"]
            require(reference_path.is_file(), "fixture reference is missing")
            require(
                sha256(reference_path) == fixture["reference"]["sha256"],
                "fixture reference hash drifted",
            )
            reference = reference_path.read_text(encoding="utf-8")
            hypothesis = " ".join(texts)
            metrics = scorer.score_text(
                reference,
                hypothesis,
                duration_seconds=float(run["audioDurationSeconds"]),
                annotations={
                    "codeSwitch": fixture["scenario"] == "zh_en_code_switch"
                },
            )
            cer = metrics["lexical"]["cer"]
            error_rate = (
                float(cer)
                if cer is not None
                else float(
                    metrics["nonSpeech"][
                        "hallucinationLexicalCharactersPerMinute"
                    ]
                )
            )
            quality.append(
                {
                    "fixtureId": fixture["fixtureId"],
                    "scenario": fixture["scenario"],
                    "errorRate": error_rate,
                    "cer": cer,
                    "wer": metrics["lexical"]["wer"],
                    "hallucinationLexicalCharactersPerMinute": metrics[
                        "nonSpeech"
                    ]["hallucinationLexicalCharactersPerMinute"],
                    "completeInputConsumed": complete_input,
                    "offsetsValid": offsets_valid,
                    "utteranceCount": len(utterances),
                }
            )
        elif fixture["fixtureRole"] == "stability":
            stability_run = run
    require(
        {item["scenario"] for item in quality} == REQUIRED_SCENARIOS,
        "raw held-out coverage is incomplete",
    )
    require(stability_run is not None, "raw stability run is missing")
    latency_values = [
        float(utterance["speechEndToDriverVisibleMs"])
        for utterance in stability_run["utterances"]
        if "speechEndToDriverVisibleMs" in utterance
    ]
    require(latency_values, "raw live latency is missing")
    probe_metrics = (
        validate_integration_probe(integration_probe, contract, manifest)
        if integration_probe is not None
        else None
    )
    visibility_overhead = (
        float(probe_metrics["resultToVisibleP95Ms"])
        if probe_metrics is not None
        else 0.0
    )
    ordered_latency = sorted(value + visibility_overhead for value in latency_values)

    def percentile(fraction: float) -> float:
        index = max(0, math.ceil(len(ordered_latency) * fraction) - 1)
        return ordered_latency[index]

    missing: list[str] = []
    if probe_metrics is None:
        missing.append("flutter_visibility_measurement")
    if probe_metrics is None:
        missing.append("concurrent_capture_frame_control")
    evidence: dict[str, Any] = {
        "schemaVersion": 1,
        "contractId": contract["contractId"],
        "status": "BLOCKED" if missing else "COMPLETE",
        "target": EXPECTED_TARGET,
        "bindings": {
            "fixtureManifestSha256": bindings["fixtureManifestSha256"],
            "scorerSha256": bindings["scorerSha256"],
            "modelArchiveSha256": bindings["modelArchiveSha256"],
            "sileroVadSha256": bindings["sileroVadSha256"],
            "rawSha256": hashlib.sha256(
                json.dumps(
                    raw,
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                ).encode()
            ).hexdigest(),
            **(
                {"flutterCaptureProbeSha256": integration_probe_sha256}
                if integration_probe_sha256 is not None
                else {}
            ),
        },
        "effectiveConfig": contract["control"],
        "tokenPartialCount": token_partial_count,
        "invalidWorkerEventCount": invalid_event_count,
        "captureFrameLossDelta": (
            int(probe_metrics["captureFrameLossDelta"])
            if probe_metrics is not None
            else None
        ),
        "quality": quality,
        "latency": {
            "speechEndToVisibleP50Ms": statistics.median(ordered_latency),
            "speechEndToVisibleP95Ms": percentile(0.95),
            "maximumBacklogSeconds": float(
                stability_run["complete"]["maximumQueuedSeconds"]
            ),
            "resultToVisibleP95Ms": (
                visibility_overhead if probe_metrics is not None else None
            ),
            "measurement": (
                "flutter_frame_timing_composed_with_worker_receipt"
                if probe_metrics is not None
                else raw.get("visibilityMeasurement")
            ),
        },
        "resources": {
            "maximumAppRssBytes": (
                max(
                    maximum_rss,
                    int(probe_metrics["maximumProbeWorkerRssBytes"]),
                )
                + int(probe_metrics["maximumFlutterAppRssBytes"])
                if probe_metrics is not None
                else maximum_rss
            ),
            "uiLongFrameRate": (
                float(probe_metrics["uiLongFrameRate"])
                if probe_metrics is not None
                else raw.get("uiLongFrameRate")
            ),
        },
        "stability": {
            "durationSeconds": stability_run["audioDurationSeconds"],
            "crashed": False,
            "oom": False,
            "maximumUtteranceSeconds": round(
                max(
                    (
                        float(item["endSeconds"]) - float(item["startSeconds"])
                        for item in stability_run["utterances"]
                    ),
                    default=0.0,
                ),
                6,
            ),
        },
    }
    if missing:
        evidence["missingInputs"] = missing
    return evidence


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--contract", type=Path, default=DEFAULT_CONTRACT)
    parser.add_argument("--evidence", type=Path)
    parser.add_argument("--raw", type=Path)
    parser.add_argument("--integration-probe", type=Path)
    parser.add_argument("--fixture-root", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    try:
        contract = json.loads(args.contract.read_text(encoding="utf-8"))
        is_optimization = (
            contract.get("contractId")
            == "sensevoice-live-caption-optimization/macos-m4/v1"
        )
        if is_optimization:
            validate_optimization_contract(contract)
        else:
            validate_contract(contract)
        if args.raw is not None:
            require(args.fixture_root is not None, "--fixture-root is required")
            require(args.output is not None, "--output is required")
            manifest = json.loads(
                (
                    ROOT
                    / contract["inputs"]["fixtureManifestPath"]
                ).read_text(encoding="utf-8")
            )
            raw = json.loads(args.raw.read_text(encoding="utf-8"))
            built = (
                build_optimization_summary(
                    raw=raw,
                    contract=contract,
                    manifest=manifest,
                    fixture_root=args.fixture_root,
                )
                if is_optimization
                else build_evidence(
                    raw=raw,
                    contract=contract,
                    manifest=manifest,
                    fixture_root=args.fixture_root,
                    integration_probe=(
                        json.loads(
                            args.integration_probe.read_text(encoding="utf-8")
                        )
                        if args.integration_probe is not None
                        else None
                    ),
                    integration_probe_sha256=(
                        sha256(args.integration_probe)
                        if args.integration_probe is not None
                        else None
                    ),
                )
            )
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(
                json.dumps(built, ensure_ascii=False, indent=2, sort_keys=True)
                + "\n",
                encoding="utf-8",
            )
            print(
                json.dumps(
                    {
                        "status": built["status"],
                        "output": str(args.output),
                        "sha256": sha256(args.output),
                    },
                    sort_keys=True,
                )
            )
        elif args.evidence is None:
            print("PASS: SenseVoice live-caption contract is valid")
        else:
            evidence = json.loads(args.evidence.read_text(encoding="utf-8"))
            print(json.dumps(validate_evidence(evidence, contract), sort_keys=True))
    except (OSError, json.JSONDecodeError, LiveCaptionError) as error:
        print(f"FAIL: {error}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
