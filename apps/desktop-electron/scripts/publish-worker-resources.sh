#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 2 ]]; then
  echo "usage: publish-worker-resources.sh <staging-root> <worker-root>" >&2
  exit 64
fi

staging_root="$1"
worker_root="$2"
resources_root="$(dirname "$worker_root")"

if [[ ! -d "$staging_root" || -L "$staging_root" ]]; then
  echo "worker resource staging root must be a private directory" >&2
  exit 1
fi
if [[ -L "$worker_root" ]] || [[ -e "$worker_root" && ! -d "$worker_root" ]]; then
  echo "worker resource target must be a private directory" >&2
  exit 1
fi
if [[ "$(dirname "$staging_root")" != "$resources_root" ]]; then
  echo "worker resource staging and target roots must share one parent" >&2
  exit 1
fi

backup_root="$resources_root/.worker-previous.$$"
backup_moved=0
candidate_installed=0

restore_on_exit() {
  status=$?
  trap - EXIT
  if [[ "$backup_moved" -eq 1 && "$candidate_installed" -eq 0 ]]; then
    if [[ -e "$worker_root" || -L "$worker_root" ]]; then
      echo "cannot restore worker resource backup over an occupied target" >&2
      exit 1
    fi
    if ! mv "$backup_root" "$worker_root"; then
      echo "failed to restore worker resource backup" >&2
      exit 1
    fi
  fi
  exit "$status"
}

trap restore_on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ -e "$worker_root" ]]; then
  mv "$worker_root" "$backup_root"
  backup_moved=1
fi

if [[ "${VOICE2TEXT_TEST_SIGNAL_AFTER_WORKER_BACKUP:-0}" == "1" ]]; then
  kill -TERM "$$"
fi

mv "$staging_root" "$worker_root"
candidate_installed=1

if [[ "$backup_moved" -eq 1 ]]; then
  if [[ ! -d "$backup_root" || -L "$backup_root" ]]; then
    echo "worker resource backup changed type before cleanup" >&2
    exit 1
  fi
  rm -rf -- "$backup_root"
fi

trap - EXIT INT TERM
