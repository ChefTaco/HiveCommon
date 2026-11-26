#!/usr/bin/env bash
# Scan exact staged bytes, immutable outgoing history or build output with the pinned Gitleaks.
# Never prints secret values.
#
#   hive-gitleaks [--root DIR] [--config FILE] --staged          the exact git index (pre-commit hook)
#   hive-gitleaks [--root DIR] [--config FILE] --history         all reachable history (CI)
#   hive-gitleaks [--root DIR] [--config FILE] --pre-push        outgoing refs read from stdin (pre-push hook)
#   hive-gitleaks [--root DIR] [--config FILE] --dir PATH...     directories such as build output
#
# --root defaults to the git top level of the current directory; --config is relative to the root
# and defaults to .gitleaks.toml. In --staged mode the staged copy of the config is used.
set -euo pipefail
version=8.30.1
usage() {
  echo 'Usage: hive-gitleaks [--root DIR] [--config FILE] --staged|--history|--pre-push|--dir PATH...' >&2
  exit 2
}
root=""
config=".gitleaks.toml"
mode=""
directories=()
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --root) [[ "$#" -ge 2 ]] || usage; root="$2"; shift 2 ;;
    --config) [[ "$#" -ge 2 ]] || usage; config="$2"; shift 2 ;;
    --staged|--history|--pre-push) [[ -z "$mode" ]] || usage; mode="$1"; shift ;;
    --dir)
      [[ -z "$mode" && "$#" -ge 2 ]] || usage; mode=--dir; shift
      while [[ "$#" -gt 0 && "$1" != --* ]]; do directories+=("$1"); shift; done
      ;;
    *) usage ;;
  esac
done
mode="${mode:---staged}"
if [[ "$config" = /* || "$config" == *..* || -z "$config" ]]; then
  echo 'The Gitleaks config must be a path inside the repository.' >&2
  exit 2
fi
if [[ -z "$root" ]]; then
  root="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo 'Not inside a git repository; pass --root.' >&2; exit 2; }
fi
root="$(cd "$root" && pwd)"
binary="${XDG_CACHE_HOME:-$HOME/.cache}/hivemagnus-tools/gitleaks/$version/gitleaks"
if [[ ! -x "$binary" ]]; then
  binary="$(command -v gitleaks || true)"
fi
if [[ -z "$binary" ]] || [[ "$("$binary" version)" != "$version" ]]; then
  echo "Gitleaks $version is required. Run: hive-install-gitleaks (from @hivemagnus/hive-devtools)" >&2
  exit 2
fi
cd "$root"
options=(--gitleaks-ignore-path /dev/null
  --redact=100 --ignore-gitleaks-allow --no-banner --no-color --log-level=warn)
require_config() {
  [[ -f "$1" ]] || { echo "Gitleaks config $config not found." >&2; exit 2; }
}
scan_history() {
  git rev-parse --verify "$1^{commit}" >/dev/null
  "$binary" git --config "$root/$config" "${options[@]}" --log-opts="$2" "$root"
}
require_full_history() {
  if [[ "$(git rev-parse --is-shallow-repository)" == true ]]; then
    echo "$1" >&2
    exit 2
  fi
}
case "$mode" in
  --staged)
    umask 077
    temporary="$(mktemp -d)"
    trap 'rm -rf "$temporary"' EXIT
    # Export the index, including force-added ignored files. Working-tree edits,
    # untracked files, .gitignore and partial staging cannot hide staged secrets.
    git checkout-index --all --prefix="$temporary/"
    if [[ ! -f "$temporary/$config" ]]; then
      echo "Stage $config before running the staged scan." >&2
      exit 2
    fi
    (cd "$temporary"; "$binary" dir --config "$temporary/$config" "${options[@]}" .)
    ;;
  --history)
    require_config "$root/$config"
    require_full_history 'Full history is required; fetch with depth 0 before scanning.'
    scan_history HEAD HEAD
    ;;
  --pre-push)
    require_config "$root/$config"
    require_full_history 'Full history is required before pushing; fetch with depth 0.'
    while read -r local_ref local_sha remote_ref remote_sha; do
      [[ -n "$local_ref" && -n "$remote_ref" ]] || { echo 'Invalid pre-push input.' >&2; exit 2; }
      [[ "$local_sha" =~ ^[0-9a-f]{40,64}$ && "$remote_sha" =~ ^[0-9a-f]{40,64}$ ]] || exit 2
      [[ "$local_sha" =~ ^0+$ ]] && continue # Ref deletion carries no new content.
      if [[ "$remote_sha" =~ ^0+$ ]]; then
        scan_history "$local_sha" "$local_sha"
      elif git cat-file -e "$remote_sha^{commit}" 2>/dev/null; then
        scan_history "$local_sha" "$remote_sha..$local_sha"
      else
        # Unknown remote base: scan all reachable commits instead of skipping.
        scan_history "$local_sha" "$local_sha"
      fi
    done
    ;;
  --dir)
    require_config "$root/$config"
    [[ "${#directories[@]}" -gt 0 ]] || { echo 'Name at least one directory to scan.' >&2; exit 2; }
    for directory in "${directories[@]}"; do
      [[ -d "$directory" ]] || { echo "Not a directory: $directory" >&2; exit 2; }
      "$binary" dir --config "$root/$config" "${options[@]}" "$directory"
    done
    ;;
esac
