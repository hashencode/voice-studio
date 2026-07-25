#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
MANIFEST="$ROOT/benchmark/asr_benchmark_manifest.json"
OUT_ROOT="$ROOT/build/asr_benchmark"
ARCHIVE_DIR="$OUT_ROOT/archives"
MODEL_DIR="$OUT_ROOT/models"

if ! command -v jq >/dev/null 2>&1; then
  echo "Missing dependency: jq"
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "Missing dependency: curl"
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "Missing dependency: python3"
  exit 1
fi

mkdir -p "$ARCHIVE_DIR" "$MODEL_DIR"

if [[ "$#" -gt 0 ]]; then
  model_ids=("$@")
else
  model_ids=()
  while IFS= read -r model_id; do
    model_ids+=("$model_id")
  done < <(jq -r '.models[].id' "$MANIFEST")
fi

verify_model() {
  local model_id="$1"
  local dir="$2"
  local missing=0
  local expected_archive_sha
  local expected_file_sha

  expected_archive_sha="$(jq -r --arg id "$model_id" '.models[] | select(.id == $id) | .archiveSha256' "$MANIFEST")"

  while IFS=$'\t' read -r key required; do
    if [[ ! -f "$dir/$required" ]]; then
      echo "Missing required file for $model_id: $dir/$required"
      missing=1
      continue
    fi
    expected_file_sha="$(
      jq -r --arg id "$model_id" --arg key "$key" \
        '.models[] | select(.id == $id) | .requiredFileSha256[$key] // empty' \
        "$MANIFEST"
    )"
    if [[ -n "$expected_file_sha" ]] &&
      [[ "$(shasum -a 256 "$dir/$required" | awk '{print $1}')" != "$expected_file_sha" ]]; then
      echo "Required-file SHA-256 mismatch for $model_id: $required"
      missing=1
    fi
  done < <(
    jq -r --arg id "$model_id" \
      '.models[] | select(.id == $id) | .requiredFiles | to_entries[] | [.key, .value] | @tsv' \
      "$MANIFEST"
  )

  if [[ "$missing" -eq 1 ]]; then
    return 1
  fi
  if [[ ! -f "$dir/.archive.sha256" ]] ||
    [[ "$(tr -d '\r\n' <"$dir/.archive.sha256")" != "$expected_archive_sha" ]]; then
    echo "Missing or stale extraction identity for $model_id"
    return 1
  fi
}

verify_archive() {
  local model_id="$1"
  local archive_path="$2"
  local expected_sha
  local expected_bytes
  local actual_sha
  local actual_bytes

  expected_sha="$(jq -r --arg id "$model_id" '.models[] | select(.id == $id) | .archiveSha256 // empty' "$MANIFEST")"
  expected_bytes="$(jq -r --arg id "$model_id" '.models[] | select(.id == $id) | .archiveBytes // empty' "$MANIFEST")"
  if [[ ! "$expected_sha" =~ ^[0-9a-f]{64}$ ]] || [[ ! "$expected_bytes" =~ ^[1-9][0-9]*$ ]]; then
    echo "Missing pinned archiveSha256/archiveBytes for $model_id"
    return 1
  fi

  actual_sha="$(shasum -a 256 "$archive_path" | awk '{print $1}')"
  actual_bytes="$(python3 - "$archive_path" <<'PY'
from pathlib import Path
import sys

print(Path(sys.argv[1]).stat().st_size)
PY
)"
  if [[ "$actual_sha" != "$expected_sha" ]]; then
    echo "Archive SHA-256 mismatch for $model_id"
    return 1
  fi
  if [[ "$actual_bytes" != "$expected_bytes" ]]; then
    echo "Archive byte-size mismatch for $model_id"
    return 1
  fi
}

extract_required_model_files() {
  local model_id="$1"
  local archive_path="$2"

  python3 - "$MANIFEST" "$model_id" "$archive_path" "$MODEL_DIR" <<'PY'
import json
import shutil
import sys
import tarfile
import tempfile
from pathlib import Path

manifest = json.loads(Path(sys.argv[1]).read_text())
model_id = sys.argv[2]
archive = Path(sys.argv[3])
models_root = Path(sys.argv[4]).resolve()
model = next(item for item in manifest["models"] if item["id"] == model_id)
extracted_dir = Path(model["extractedDir"])
if (
    extracted_dir.is_absolute()
    or len(extracted_dir.parts) != 1
    or ".." in extracted_dir.parts
):
    raise SystemExit(f"unsafe extractedDir for {model_id}")
required = {}
for key, value in model["requiredFiles"].items():
    relative = Path(value)
    if relative.is_absolute() or ".." in relative.parts:
        raise SystemExit(f"unsafe required file for {model_id}: {key}")
    required[(extracted_dir / relative).as_posix()] = relative

with tempfile.TemporaryDirectory(prefix="asr-model-", dir=models_root) as temporary:
    prepared = Path(temporary) / extracted_dir
    prepared.mkdir()
    found = set()
    with tarfile.open(archive, mode="r:bz2") as source:
        for member in source:
            relative = required.get(member.name)
            if relative is None:
                continue
            if not member.isfile():
                raise SystemExit(f"required member is not a file: {member.name}")
            destination = (prepared / relative).resolve()
            if not destination.is_relative_to(prepared.resolve()):
                raise SystemExit(f"unsafe archive member: {member.name}")
            destination.parent.mkdir(parents=True, exist_ok=True)
            extracted = source.extractfile(member)
            if extracted is None:
                raise SystemExit(f"cannot read archive member: {member.name}")
            with extracted, destination.open("wb") as output:
                shutil.copyfileobj(extracted, output, length=1024 * 1024)
            found.add(member.name)
    missing = set(required) - found
    if missing:
        raise SystemExit(f"archive is missing required members: {sorted(missing)}")
    (prepared / ".archive.sha256").write_text(model["archiveSha256"] + "\n")
    target = (models_root / extracted_dir).resolve()
    if target.parent != models_root:
        raise SystemExit(f"unsafe model target for {model_id}")
    if target.exists():
        shutil.rmtree(target)
    prepared.replace(target)
PY
}

for model_id in "${model_ids[@]}"; do
  if ! jq -e --arg id "$model_id" '.models[] | select(.id == $id)' "$MANIFEST" >/dev/null; then
    echo "Unknown model id: $model_id"
    exit 1
  fi

  archive_name="$(jq -r --arg id "$model_id" '.models[] | select(.id == $id) | .archiveName' "$MANIFEST")"
  archive_url="$(jq -r --arg id "$model_id" '.models[] | select(.id == $id) | .archiveUrl' "$MANIFEST")"
  extracted_dir="$(jq -r --arg id "$model_id" '.models[] | select(.id == $id) | .extractedDir' "$MANIFEST")"
  python3 - "$archive_name" "$extracted_dir" <<'PY'
import sys
from pathlib import Path

for label, value in zip(("archiveName", "extractedDir"), sys.argv[1:]):
    path = Path(value)
    if path.is_absolute() or len(path.parts) != 1 or ".." in path.parts:
        raise SystemExit(f"unsafe {label}: {value!r}")
PY
  target_dir="$MODEL_DIR/$extracted_dir"
  archive_path="$ARCHIVE_DIR/$archive_name"

  if [[ -d "$target_dir" ]] && verify_model "$model_id" "$target_dir"; then
    echo "Model already ready: $model_id -> $target_dir"
    continue
  fi

  if [[ ! -f "$archive_path" ]]; then
    echo "Downloading $model_id"
    partial_path="${archive_path}.partial"
    rm -f "$partial_path"
    curl -L --fail --retry 3 --connect-timeout 30 --max-time 7200 \
      -o "$partial_path" "$archive_url"
    verify_archive "$model_id" "$partial_path"
    mv "$partial_path" "$archive_path"
  else
    echo "Using existing archive: $archive_path"
  fi

  verify_archive "$model_id" "$archive_path"
  extract_required_model_files "$model_id" "$archive_path"
  verify_model "$model_id" "$target_dir"
  echo "Prepared $model_id -> $target_dir"
done

echo "Models ready under $MODEL_DIR"
