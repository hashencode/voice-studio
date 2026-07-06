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
  mapfile -t model_ids < <(jq -r '.models[].id' "$MANIFEST")
fi

verify_model() {
  local model_id="$1"
  local dir="$2"
  local missing=0

  while IFS= read -r required; do
    if [[ ! -f "$dir/$required" ]]; then
      echo "Missing required file for $model_id: $dir/$required"
      missing=1
    fi
  done < <(jq -r --arg id "$model_id" '.models[] | select(.id == $id) | .requiredFiles | to_entries[].value' "$MANIFEST")

  if [[ "$missing" -eq 1 ]]; then
    return 1
  fi
}

prune_model() {
  local model_id="$1"
  local dir="$2"

  python3 - "$MANIFEST" "$model_id" "$dir" <<'PY'
import json
import sys
from pathlib import Path

manifest = json.loads(Path(sys.argv[1]).read_text())
model_id = sys.argv[2]
root = Path(sys.argv[3])
model = next(item for item in manifest["models"] if item["id"] == model_id)
keep = {Path(path) for path in model["requiredFiles"].values()}

for path in sorted(root.rglob("*"), reverse=True):
    if path.is_file() and path.relative_to(root) not in keep:
        path.unlink()

for path in sorted(root.rglob("*"), reverse=True):
    if path.is_dir():
        try:
            path.rmdir()
        except OSError:
            pass
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
  target_dir="$MODEL_DIR/$extracted_dir"
  archive_path="$ARCHIVE_DIR/$archive_name"

  if [[ -d "$target_dir" ]] && verify_model "$model_id" "$target_dir"; then
    prune_model "$model_id" "$target_dir"
    echo "Model already ready: $model_id -> $target_dir"
    continue
  fi

  if [[ ! -f "$archive_path" ]]; then
    echo "Downloading $model_id"
    curl -L --fail --retry 3 -o "$archive_path" "$archive_url"
  else
    echo "Using existing archive: $archive_path"
  fi

  rm -rf "$target_dir"
  tar -xjf "$archive_path" -C "$MODEL_DIR"
  verify_model "$model_id" "$target_dir"
  prune_model "$model_id" "$target_dir"
  echo "Prepared $model_id -> $target_dir"
done

echo "Models ready under $MODEL_DIR"
