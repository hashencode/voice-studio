#!/usr/bin/env python3
"""Freeze the complete private ranked fixture manifest without decoding it."""

from __future__ import annotations

import argparse
import copy
import json
import os
import shutil
import tempfile
import wave
from datetime import date
from pathlib import Path
from typing import Any, Callable

from prepare_fixtures import (
    FixtureError,
    is_sha256,
    resolve_fixture_source,
    sha256_bytes,
    sha256_file,
    validate_manifest,
)


RANKED_ROLES = {"development", "held_out", "long_7200s"}
CONSENTED_SOURCE_KINDS = {
    "consented_internal_recording",
    "reviewed_local_meeting",
    "consented_local_meeting",
}
REVIEW_ROOT_FIELDS = {
    "schemaVersion",
    "kind",
    "fixtureManifestId",
    "fixtures",
}
REVIEW_FIELDS = {
    "fixtureId",
    "fixtureRole",
    "sourceKind",
    "scenario",
    "sourceProvenanceRecordSha256",
    "sourceProvenanceRecordDate",
    "licenseOrConsent",
    "licenseOrConsentRecordSha256",
    "licenseOrConsentRecordDate",
    "referenceReview",
    "referenceReviewRecordSha256",
    "varietyReview",
    "varietyReviewRecordSha256",
    "roleAssignmentConfirmed",
    "speakerSessionDisjointnessConfirmed",
    "heldOutContentDisposition",
    "redistributionConfirmed",
    "localOnlyConfirmed",
}


class RankedFixtureFreezeError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RankedFixtureFreezeError(message)


def canonical_json(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode()


def _reject_private_strings(value: Any, location: str = "$") -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            require(
                key
                not in {
                    "absolutePath",
                    "privateMeetingLabel",
                    "speakerName",
                    "speakerIdentity",
                },
                f"{location}: private field {key}",
            )
            _reject_private_strings(child, f"{location}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _reject_private_strings(child, f"{location}[{index}]")
    elif isinstance(value, str):
        require(
            not value.startswith("/")
            and not value.startswith("~")
            and "/Users/" not in value
            and "\\Users\\" not in value,
            f"{location}: absolute or user-home value is forbidden",
        )


def _ranked_fixtures(
    manifest: dict[str, Any],
) -> list[dict[str, Any]]:
    return [
        fixture
        for fixture in manifest["fixtures"]
        if fixture["fixtureRole"] in RANKED_ROLES
    ]


def build_ranked_review_template(
    manifest: dict[str, Any],
) -> dict[str, Any]:
    try:
        validate_manifest(manifest, ranked=False)
    except FixtureError as error:
        raise RankedFixtureFreezeError(str(error)) from error
    fixtures = []
    for fixture in _ranked_fixtures(manifest):
        fixtures.append(
            {
                "fixtureId": fixture["fixtureId"],
                "fixtureRole": fixture["fixtureRole"],
                "sourceKind": fixture["sourceKind"],
                "scenario": fixture["scenario"],
                "sourceProvenanceRecordSha256": None,
                "sourceProvenanceRecordDate": None,
                "licenseOrConsent": "PENDING",
                "licenseOrConsentRecordSha256": None,
                "licenseOrConsentRecordDate": None,
                "referenceReview": "PENDING",
                "referenceReviewRecordSha256": None,
                "varietyReview": (
                    "PENDING"
                    if fixture["scenario"] == "dialect_accent"
                    else "NOT_APPLICABLE"
                ),
                "varietyReviewRecordSha256": None,
                "roleAssignmentConfirmed": False,
                "speakerSessionDisjointnessConfirmed": False,
                "heldOutContentDisposition": (
                    "PENDING"
                    if fixture["fixtureRole"]
                    in {"held_out", "long_7200s"}
                    else "NOT_APPLICABLE"
                ),
                "redistributionConfirmed": "PENDING",
                "localOnlyConfirmed": False,
            }
        )
    require(fixtures, "ranked fixture set is empty")
    return {
        "schemaVersion": 1,
        "kind": "ranked_fixture_review",
        "fixtureManifestId": manifest["fixtureManifestId"],
        "fixtures": fixtures,
    }


def _require_review_date(value: Any, message: str) -> None:
    require(isinstance(value, str), message)
    try:
        reviewed_on = date.fromisoformat(value)
    except ValueError as error:
        raise RankedFixtureFreezeError(message) from error
    require(reviewed_on <= date.today(), message)


def _validate_review(
    manifest: dict[str, Any],
    review: dict[str, Any],
) -> dict[str, dict[str, Any]]:
    require(
        isinstance(review, dict) and set(review) == REVIEW_ROOT_FIELDS,
        "review receipt fields mismatch",
    )
    require(
        review["schemaVersion"] == 1
        and review["kind"] == "ranked_fixture_review",
        "review receipt identity mismatch",
    )
    require(
        review["fixtureManifestId"] == manifest["fixtureManifestId"],
        "review receipt fixture manifest identity mismatch",
    )
    _reject_private_strings(review)
    entries = review["fixtures"]
    require(
        isinstance(entries, list),
        "ranked review fixtures must be a list",
    )
    index: dict[str, dict[str, Any]] = {}
    for entry in entries:
        require(
            isinstance(entry, dict) and set(entry) == REVIEW_FIELDS,
            "ranked fixture review fields mismatch",
        )
        fixture_id = entry["fixtureId"]
        require(
            isinstance(fixture_id, str)
            and fixture_id
            and fixture_id not in index,
            "ranked fixture reviews must be uniquely identified",
        )
        index[fixture_id] = entry
    fixtures = _ranked_fixtures(manifest)
    require(
        set(index) == {fixture["fixtureId"] for fixture in fixtures},
        "ranked fixture review set mismatch",
    )
    for fixture in fixtures:
        fixture_id = fixture["fixtureId"]
        entry = index[fixture_id]
        require(
            entry["fixtureRole"] == fixture["fixtureRole"]
            and entry["sourceKind"] == fixture["sourceKind"]
            and entry["scenario"] == fixture["scenario"],
            f"{fixture_id}: review source identity mismatch",
        )
        require(
            is_sha256(entry["sourceProvenanceRecordSha256"]),
            f"{fixture_id}: source provenance record hash is required",
        )
        _require_review_date(
            entry["sourceProvenanceRecordDate"],
            f"{fixture_id}: source provenance record date is required",
        )
        expected_license = (
            "SIGNED_CONSENT_REVIEWED_FOR_LOCAL_BENCHMARK"
            if fixture["sourceKind"] in CONSENTED_SOURCE_KINDS
            else "REVIEWED_FOR_LOCAL_BENCHMARK"
        )
        if fixture["sourceKind"] in CONSENTED_SOURCE_KINDS:
            require(
                entry["licenseOrConsent"] == expected_license,
                f"{fixture_id}: signed consent review is required",
            )
        else:
            require(
                entry["licenseOrConsent"] == expected_license,
                f"{fixture_id}: license or terms review is required",
            )
        require(
            is_sha256(entry["licenseOrConsentRecordSha256"]),
            f"{fixture_id}: license or consent record hash is required",
        )
        _require_review_date(
            entry["licenseOrConsentRecordDate"],
            f"{fixture_id}: license or consent record date is required",
        )
        require(
            entry["referenceReview"] == "REVIEWED"
            and is_sha256(entry["referenceReviewRecordSha256"]),
            f"{fixture_id}: independent reference review is required",
        )
        if fixture["scenario"] == "dialect_accent":
            require(
                entry["varietyReview"] == "REVIEWED"
                and is_sha256(entry["varietyReviewRecordSha256"]),
                f"{fixture_id}: independent variety review is required",
            )
        else:
            require(
                entry["varietyReview"] == "NOT_APPLICABLE"
                and entry["varietyReviewRecordSha256"] is None,
                f"{fixture_id}: unexpected variety review",
            )
        require(
            entry["roleAssignmentConfirmed"] is True,
            f"{fixture_id}: role assignment is not confirmed",
        )
        require(
            entry["speakerSessionDisjointnessConfirmed"] is True,
            f"{fixture_id}: speaker/session disjointness is not confirmed",
        )
        expected_disposition = (
            "SEALED_FROM_BENCHMARK_OPERATOR"
            if fixture["fixtureRole"] in {"held_out", "long_7200s"}
            else "NOT_APPLICABLE"
        )
        require(
            entry["heldOutContentDisposition"]
            == expected_disposition,
            f"{fixture_id}: held-out content is not sealed",
        )
        require(
            entry["redistributionConfirmed"] == "never_commit",
            f"{fixture_id}: redistribution restriction is not confirmed",
        )
        require(
            entry["localOnlyConfirmed"] is True,
            f"{fixture_id}: local-only handling is not confirmed",
        )
    return index


def inspect_pcm_audio(path: Path, fixture_id: str) -> dict[str, Any]:
    require(path.is_file(), f"{fixture_id}: audio source missing")
    try:
        with wave.open(str(path), "rb") as source:
            channels = source.getnchannels()
            sample_width = source.getsampwidth()
            sample_rate = source.getframerate()
            frames = source.getnframes()
            payload_bytes = 0
            while True:
                payload = source.readframes(65_536)
                if not payload:
                    break
                payload_bytes += len(payload)
    except (OSError, EOFError, wave.Error) as error:
        raise RankedFixtureFreezeError(
            f"{fixture_id}: invalid PCM WAV"
        ) from error
    require(channels == 1, f"{fixture_id}: channels mismatch")
    require(sample_width == 2, f"{fixture_id}: sample width mismatch")
    require(sample_rate == 16000, f"{fixture_id}: sample rate mismatch")
    require(frames > 0, f"{fixture_id}: audio is empty")
    require(
        payload_bytes == frames * channels * sample_width,
        f"{fixture_id}: PCM payload is truncated",
    )
    return {
        "sha256": sha256_file(path),
        "bytes": path.stat().st_size,
        "durationSeconds": frames / sample_rate,
        "sampleRateHz": sample_rate,
        "channels": channels,
        "sampleWidthBytes": sample_width,
    }


def _inspect_reference(
    path: Path,
    fixture: dict[str, Any],
) -> dict[str, Any]:
    fixture_id = fixture["fixtureId"]
    require(path.is_file(), f"{fixture_id}: reference source missing")
    payload = path.read_bytes()
    try:
        reference = payload.decode("utf-8")
    except UnicodeDecodeError as error:
        raise RankedFixtureFreezeError(
            f"{fixture_id}: reference is not UTF-8"
        ) from error
    require(
        bool(reference.strip())
        or fixture["scenario"] == "non_speech",
        f"{fixture_id}: reference is empty",
    )
    return {
        "sha256": sha256_bytes(payload),
        "bytes": len(payload),
    }


def _activate_directory(staging: Path, output_root: Path) -> None:
    output_parent = output_root.parent
    if output_root.exists():
        backup = output_parent / f".{output_root.name}.previous-{os.getpid()}"
        require(not backup.exists(), "ranked freeze backup already exists")
        output_root.replace(backup)
        try:
            staging.replace(output_root)
        except BaseException:
            backup.replace(output_root)
            raise
        shutil.rmtree(backup)
    else:
        staging.replace(output_root)


def freeze_ranked_manifest(
    manifest: dict[str, Any],
    review: dict[str, Any],
    *,
    repository_root: Path,
    output_root: Path,
    audio_inspector: Callable[
        [Path, str],
        dict[str, Any],
    ] = inspect_pcm_audio,
) -> dict[str, Any]:
    try:
        validate_manifest(manifest, ranked=False)
    except FixtureError as error:
        raise RankedFixtureFreezeError(str(error)) from error
    review_index = _validate_review(manifest, review)
    frozen = copy.deepcopy(manifest)
    frozen_index = {
        fixture["fixtureId"]: fixture
        for fixture in frozen["fixtures"]
    }
    bindings = []
    try:
        for fixture in _ranked_fixtures(manifest):
            fixture_id = fixture["fixtureId"]
            audio_source = resolve_fixture_source(
                manifest,
                fixture,
                fixture["audio"],
                repository_root=repository_root,
                location=f"{fixture_id}.audio",
            )
            reference_source = resolve_fixture_source(
                manifest,
                fixture,
                fixture["reference"],
                repository_root=repository_root,
                location=f"{fixture_id}.reference",
            )
            audio = audio_inspector(audio_source, fixture_id)
            reference = _inspect_reference(reference_source, fixture)
            if fixture["fixtureRole"] == "long_7200s":
                require(
                    audio["durationSeconds"] == 7200.0,
                    f"{fixture_id}: finalist fixture must be 7,200-second",
                )
            review_entry = review_index[fixture_id]
            target = frozen_index[fixture_id]
            target["licenseOrConsent"] = review_entry[
                "licenseOrConsent"
            ]
            target["referenceReview"] = "REVIEWED"
            target["varietyReview"] = review_entry["varietyReview"]
            target["freezeState"] = "FROZEN"
            target["audio"].update(audio)
            target["reference"].update(reference)
            bindings.append(
                {
                    "fixtureId": fixture_id,
                    "fixtureRole": fixture["fixtureRole"],
                    "scenario": fixture["scenario"],
                    "sourceKind": fixture["sourceKind"],
                    "sourceProvenanceRecordSha256": review_entry[
                        "sourceProvenanceRecordSha256"
                    ],
                    "sourceProvenanceRecordDate": review_entry[
                        "sourceProvenanceRecordDate"
                    ],
                    "audioSha256": audio["sha256"],
                    "audioBytes": audio["bytes"],
                    "audioDurationSeconds": audio["durationSeconds"],
                    "referenceSha256": reference["sha256"],
                    "referenceBytes": reference["bytes"],
                    "licenseOrConsent": review_entry[
                        "licenseOrConsent"
                    ],
                    "licenseOrConsentRecordSha256": review_entry[
                        "licenseOrConsentRecordSha256"
                    ],
                    "licenseOrConsentRecordDate": review_entry[
                        "licenseOrConsentRecordDate"
                    ],
                    "referenceReviewRecordSha256": review_entry[
                        "referenceReviewRecordSha256"
                    ],
                    "varietyReview": review_entry["varietyReview"],
                    "varietyReviewRecordSha256": review_entry[
                        "varietyReviewRecordSha256"
                    ],
                    "heldOutContentDisposition": review_entry[
                        "heldOutContentDisposition"
                    ],
                }
            )
    except FixtureError as error:
        raise RankedFixtureFreezeError(str(error)) from error
    frozen["fixtureManifestId"] = (
        "desktop-processing/macos-asr-fixtures-v2-ranked-pending"
    )
    revision = sha256_bytes(canonical_json(frozen))[:16]
    frozen["fixtureManifestId"] = (
        f"desktop-processing/macos-asr-fixtures-v2-ranked-{revision}"
    )
    try:
        validate_manifest(frozen, ranked=True)
    except FixtureError as error:
        raise RankedFixtureFreezeError(str(error)) from error

    output_parent = output_root.parent
    output_parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(
            prefix=f".{output_root.name}.staging-",
            dir=output_parent,
        )
    )
    try:
        frozen_payload = (
            json.dumps(
                frozen,
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
            )
            + "\n"
        ).encode()
        role_counts = {
            role: sum(
                binding["fixtureRole"] == role
                for binding in bindings
            )
            for role in sorted(RANKED_ROLES)
        }
        result = {
            "schemaVersion": 1,
            "kind": "ranked_fixture_freeze",
            "complete": True,
            "rankEligible": False,
            "heldOutDecoded": False,
            "baseFixtureManifestId": manifest["fixtureManifestId"],
            "baseFixtureManifestCanonicalSha256": sha256_bytes(
                canonical_json(manifest)
            ),
            "reviewReceiptCanonicalSha256": sha256_bytes(
                canonical_json(review)
            ),
            "frozenFixtureManifestId": frozen["fixtureManifestId"],
            "frozenFixtureManifestSha256": sha256_bytes(
                frozen_payload
            ),
            "rankedFixtureCount": len(bindings),
            "roleCounts": role_counts,
            "fixtureBindings": sorted(
                bindings,
                key=lambda value: value["fixtureId"],
            ),
            "privacy": {
                "rawAudioPublished": False,
                "transcriptsPublished": False,
                "speakerIdentityPublished": False,
                "absolutePathsPublished": False,
            },
        }
        _reject_private_strings(result)
        (staging / "fixtures.json").write_bytes(frozen_payload)
        (staging / "ranked-fixture-freeze.json").write_text(
            json.dumps(
                result,
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
            )
            + "\n"
        )
        _activate_directory(staging, output_root)
        return result
    except BaseException:
        if staging.exists():
            shutil.rmtree(staging)
        raise


def _write_template(path: Path, template: dict[str, Any]) -> None:
    require(not path.exists(), "ranked review template already exists")
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.parent / f".{path.name}.temporary-{os.getpid()}"
    require(not temporary.exists(), "ranked review temporary file exists")
    try:
        temporary.write_text(
            json.dumps(
                template,
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
            )
            + "\n"
        )
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def main() -> int:
    comparison_root = Path(__file__).resolve().parent
    repository_root = comparison_root.parents[2]
    private_root = (
        repository_root / "build/desktop_asr_comparison/fixtures"
    ).resolve()
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--manifest",
        type=Path,
        default=comparison_root / "fixtures.json",
    )
    parser.add_argument(
        "--review",
        type=Path,
        default=private_root / "ranked-review.json",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=private_root / "ranked-freeze",
    )
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--write-template", action="store_true")
    mode.add_argument("--freeze", action="store_true")
    args = parser.parse_args()
    review_path = args.review.resolve()
    output_root = args.output.resolve()
    try:
        require(
            review_path
            == private_root / "ranked-review.json",
            "ranked review receipt path is fixed",
        )
        require(
            output_root == private_root / "ranked-freeze",
            "ranked freeze must use its dedicated private output root",
        )
        manifest = json.loads(args.manifest.read_text())
        if args.write_template:
            _write_template(
                review_path,
                build_ranked_review_template(manifest),
            )
            print(
                "ranked fixture review template: PASS "
                f"{review_path.name}"
            )
            return 0
        review = json.loads(review_path.read_text())
        result = freeze_ranked_manifest(
            manifest,
            review,
            repository_root=repository_root,
            output_root=output_root,
        )
    except (
        OSError,
        json.JSONDecodeError,
        RankedFixtureFreezeError,
    ) as error:
        print(f"ranked fixture freeze: FAIL: {error}")
        return 1
    print(
        "ranked fixture freeze: PASS "
        f"fixtures={result['rankedFixtureCount']} "
        f"manifest={result['frozenFixtureManifestId']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
