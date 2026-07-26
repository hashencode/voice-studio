#!/usr/bin/env python3
"""Validate the M4 Mandarin/English expansion and resolve worker profiles."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any


HEX64 = re.compile(r"^[0-9a-f]{64}$")
LANGUAGE_LANES = {"zh", "en"}
REQUIRED_MODEL_ROLES = {
    "streaming_zipformer_transducer": {"encoder", "decoder", "joiner", "tokens"},
    "funasr_nano": {"encoderAdaptor", "llm", "embedding", "tokenizer"},
    "offline_whisper": {"encoder", "decoder", "tokens"},
    "moonshine": {"encoder", "mergedDecoder", "tokens"},
    "nemo_transducer": {"encoder", "decoder", "joiner", "tokens"},
    "sense_voice": {"model", "tokens"},
    "firered_asr_ctc": {"model", "tokens"},
}


class ExpansionError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ExpansionError(message)


def _exact(value: dict[str, Any], fields: set[str], location: str) -> None:
    require(set(value) == fields, f"{location} fields mismatch")


def validate_expansion(
    expansion: dict[str, Any],
    base_registry: dict[str, Any],
) -> None:
    _exact(
        expansion,
        {
            "schemaVersion",
            "expansionId",
            "baseRegistryId",
            "comparisonContractId",
            "targetCpuModel",
            "runtimeLaneId",
            "languagePolicy",
            "hardGates",
            "candidateOverrides",
            "newCandidates",
            "evaluationPolicy",
        },
        "expansion",
    )
    require(expansion["schemaVersion"] == 1, "expansion schemaVersion")
    require(
        expansion["baseRegistryId"] == base_registry["registryId"],
        "base registry identity mismatch",
    )
    require(expansion["targetCpuModel"] == "Apple M4", "target must remain Apple M4")
    policy = expansion["languagePolicy"]
    _exact(
        policy,
        {"rankings", "codeSwitchRequired", "singleCrossLanguageWinnerRequired"},
        "language policy",
    )
    require(
        policy["codeSwitchRequired"] is False
        and policy["singleCrossLanguageWinnerRequired"] is False,
        "Mandarin and English must remain independent rankings",
    )
    require(
        expansion["hardGates"]
        == {
            "maxCer": 0.35,
            "maxWer": 0.35,
            "maxRtf": 0.5,
            "maxFinalistIncrementalPeakRssBytes": 2 * 1024**3,
        },
        "language expansion hard gates drifted",
    )
    rankings = policy["rankings"]
    require(
        isinstance(rankings, list)
        and {
            (item.get("languageLane"), item.get("lexicalMetric"))
            for item in rankings
        }
        == {("zh", "cer"), ("en", "wer")},
        "language rankings must bind zh/CER and en/WER",
    )
    base = {
        candidate["candidateId"]: candidate
        for candidate in base_registry["candidates"]
    }
    overrides = expansion["candidateOverrides"]
    require(isinstance(overrides, list), "candidate overrides missing")
    override_ids: set[str] = set()
    for override in overrides:
        _exact(
            override,
            {
                "candidateId",
                "languageLanes",
                "licenseDisposition",
                "accessState",
                "artifacts",
                "stage0State",
                "note",
            },
            "candidate override",
        )
        candidate_id = override["candidateId"]
        require(
            candidate_id in base and candidate_id not in override_ids,
            "candidate override identity mismatch",
        )
        override_ids.add(candidate_id)
        require(
            set(override["languageLanes"]) <= LANGUAGE_LANES
            and override["languageLanes"],
            f"{candidate_id}: invalid language lanes",
        )
        require(
            override["licenseDisposition"]
            in {"ACCEPTED_FOR_BENCHMARK", "USER_AUTHORIZED_BENCHMARK_ONLY"},
            f"{candidate_id}: expansion license is not authorized",
        )
        family = base[candidate_id]["family"]
        require(
            family in REQUIRED_MODEL_ROLES
            and set(override["artifacts"]) == REQUIRED_MODEL_ROLES[family]
            and all(
                HEX64.fullmatch(value) is not None
                for value in override["artifacts"].values()
            ),
            f"{candidate_id}: override model roles or hashes mismatch",
        )
    candidates = expansion["newCandidates"]
    require(isinstance(candidates, list) and candidates, "new candidates missing")
    ids: set[str] = set()
    for candidate in candidates:
        _exact(
            candidate,
            {
                "candidateId",
                "displayName",
                "family",
                "languageLanes",
                "role",
                "sourceUrl",
                "archiveSha256",
                "license",
                "artifacts",
                "stage0State",
            },
            "new candidate",
        )
        candidate_id = candidate["candidateId"]
        require(
            isinstance(candidate_id, str)
            and len(candidate_id) >= 12
            and candidate_id not in base
            and candidate_id not in ids,
            "new candidate identity mismatch",
        )
        ids.add(candidate_id)
        family = candidate["family"]
        require(family in REQUIRED_MODEL_ROLES, f"{candidate_id}: unsupported family")
        require(
            set(candidate["languageLanes"]) <= LANGUAGE_LANES
            and candidate["languageLanes"],
            f"{candidate_id}: invalid language lanes",
        )
        require(
            isinstance(candidate["sourceUrl"], str)
            and candidate["sourceUrl"].startswith("https://")
            and HEX64.fullmatch(candidate["archiveSha256"]) is not None,
            f"{candidate_id}: source identity is not hash-pinned",
        )
        license_info = candidate["license"]
        _exact(
            license_info,
            {"spdx", "disposition", "noticeSource"},
            f"{candidate_id}.license",
        )
        require(
            license_info["disposition"] == "ACCEPTED_FOR_BENCHMARK"
            and isinstance(license_info["noticeSource"], str)
            and license_info["noticeSource"],
            f"{candidate_id}: license is not accepted",
        )
        artifacts = candidate["artifacts"]
        require(
            set(artifacts) == REQUIRED_MODEL_ROLES[family]
            and all(HEX64.fullmatch(value) is not None for value in artifacts.values()),
            f"{candidate_id}: model roles or hashes mismatch",
        )
        require(
            candidate["stage0State"] in {"PENDING", "PASS", "FAIL"},
            f"{candidate_id}: Stage 0 state invalid",
        )
    english_baseline = next(
        item["baselineCandidateId"]
        for item in rankings
        if item["languageLane"] == "en"
    )
    require(
        english_baseline in ids
        and next(
            candidate
            for candidate in candidates
            if candidate["candidateId"] == english_baseline
        )["role"]
        == "english_baseline",
        "English baseline must be an expansion candidate",
    )
    evaluation = expansion["evaluationPolicy"]
    _exact(
        evaluation,
        {
            "developmentAndHeldOutRankingsDeferred",
            "twoHourFinalistDeferred",
            "committedOrGeneratedSmokeRequired",
            "modelFilesCommitted",
            "audioCommitted",
        },
        "evaluation policy",
    )
    require(
        evaluation
        == {
            "developmentAndHeldOutRankingsDeferred": True,
            "twoHourFinalistDeferred": True,
            "committedOrGeneratedSmokeRequired": True,
            "modelFilesCommitted": False,
            "audioCommitted": False,
        },
        "expansion must remain smoke-only and privacy-safe",
    )


def lexical_metric_for_lane(expansion: dict[str, Any], language_lane: str) -> str:
    require(language_lane in LANGUAGE_LANES, "unknown language lane")
    matches = [
        ranking["lexicalMetric"]
        for ranking in expansion["languagePolicy"]["rankings"]
        if ranking["languageLane"] == language_lane
    ]
    require(len(matches) == 1, "language lane metric must resolve once")
    return matches[0]


def effective_config(
    family: str,
    *,
    language_lane: str,
    profile_id: str,
) -> dict[str, Any]:
    require(language_lane in LANGUAGE_LANES, "unknown language lane")
    require(profile_id in {"recommended", "fixed-resource"}, "unknown profile")
    config: dict[str, Any] = {
        "modelFamily": {
            "streaming_zipformer_transducer": "streaming_transducer",
            "offline_whisper": "whisper",
            "moonshine": "moonshine",
            "nemo_transducer": "nemo_transducer",
            "sense_voice": "sense_voice",
            "funasr_nano": "funasr_nano",
            "firered_asr_ctc": "firered_asr_ctc",
        }[family],
        "provider": "cpu",
        "numThreads": 2,
        "modelPrecision": "int8",
    }
    if profile_id == "fixed-resource":
        config.update(
            {
                "concurrency": 1,
                "inputMode": "frozen_segments",
                "segmentDurationSeconds": 15,
                "pacingPolicy": "unpaced",
                "warmupRuns": 1,
                "measuredRuns": 5,
            }
        )
    if family == "streaming_zipformer_transducer":
        config["decodingMethod"] = "greedy_search"
        if profile_id == "recommended":
            config.update(
                {
                    "chunkSeconds": 0.32,
                    "pacingPolicy": "realtime_audio_clock",
                    "endpointPolicy": "official_default",
                }
            )
    elif family == "offline_whisper":
        config.update(
            {
                "decodingMethod": "greedy_search",
                "language": "en",
                "task": "transcribe",
                "tailPaddings": -1,
                "enableTokenTimestamps": False,
                "enableSegmentTimestamps": False,
            }
        )
    elif family in {"moonshine", "nemo_transducer"}:
        config["decodingMethod"] = "greedy_search"
    elif family == "firered_asr_ctc":
        config["decodingMethod"] = "greedy_search"
    elif family == "sense_voice":
        config.update(
            {
                "decodingMethod": "greedy_search",
                "language": "auto",
                "useInverseTextNormalization": False,
            }
        )
    elif family == "funasr_nano":
        config.update(
            {
                "language": language_lane,
                "itn": False,
                "hotwords": "",
                "systemPrompt": "You are a helpful assistant.",
                "userPrompt": "Speech transcription:",
                "seed": 20260726,
                "maxNewTokens": 512,
                "temperature": 0.000001,
                "topP": 0.8,
            }
        )
    else:
        raise ExpansionError(f"unsupported family: {family}")
    return config


def main() -> int:
    root = Path(__file__).resolve().parent
    try:
        expansion = json.loads((root / "expanded_candidates_m4.json").read_text())
        base = json.loads((root / "candidates.json").read_text())
        validate_expansion(expansion, base)
    except (OSError, json.JSONDecodeError, ExpansionError) as error:
        print(f"M4 candidate expansion: FAIL: {error}")
        return 1
    print(
        "M4 candidate expansion: PASS "
        f"new={len(expansion['newCandidates'])} "
        f"overrides={len(expansion['candidateOverrides'])} "
        "lanes=zh:CER,en:WER"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
