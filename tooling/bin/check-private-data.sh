#!/usr/bin/env bash
# Blocks private data from entering git history.
#
#   hive-check-private-data [options]                 check every tracked file (CI and manual use)
#   hive-check-private-data [options] --staged        check files staged for commit (pre-commit hook)
#   hive-check-private-data [options] --message FILE  check a commit message (commit-msg hook)
#
# Options (repeatable where marked):
#   --root DIR          repository to check (default: the git top level of the current directory)
#   --terms-file FILE   private-terms denylist (default: <root>/.private-terms; a missing file is skipped)
#   --forbid-dir NAME   also forbid any path inside a directory with this name (repeatable)
#   --allow REGEX       exempt paths matching this extended regex from the forbidden-path rule (repeatable)
#
# Two layers:
#   1. Forbidden paths: env files, keys, certificates, databases, backups, runtime state and
#      private agent notes (*.local.md) may never be committed.
#   2. Private terms: an optional, gitignored `.private-terms` file lists one extended regex per
#      line (case-insensitive) for names that must never appear in the repo or in commit
#      messages, such as personal hostnames, private network domains, usernames or private
#      project names. Lines starting with # and blank lines are ignored. The file is local so
#      the denylist itself never becomes public. Findings never print the matching text.
set -euo pipefail
shopt -s nocasematch

usage() {
  echo 'usage: hive-check-private-data [--root DIR] [--terms-file FILE] [--forbid-dir NAME]... [--allow REGEX]... [--staged | --message FILE]' >&2
  exit 2
}

MODE="tracked"
MESSAGE_FILE=""
ROOT_DIR=""
TERMS_FILE=""
# Keep this list identical to DEFAULT_FORBIDDEN_DIRS in lib/privacy-policy.mjs (a test checks it).
FORBIDDEN_DIRS=(certs backups state artifacts .ardent .magnus .cindertrace .hive-dev .ssh audit-logs terminal-audit)
ALLOWED=('\.env\.example$')
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --staged) MODE="staged"; shift ;;
    --message) [[ "$#" -ge 2 ]] || usage; MODE="message"; MESSAGE_FILE="$2"; shift 2 ;;
    --root) [[ "$#" -ge 2 ]] || usage; ROOT_DIR="$2"; shift 2 ;;
    --terms-file) [[ "$#" -ge 2 ]] || usage; TERMS_FILE="$2"; shift 2 ;;
    --forbid-dir)
      [[ "$#" -ge 2 && "$2" =~ ^[A-Za-z0-9._-]{1,64}$ && "$2" != . && "$2" != .. ]] || {
        echo 'private-data check: --forbid-dir needs a plain directory name' >&2; exit 2; }
      FORBIDDEN_DIRS+=("$2"); shift 2 ;;
    --allow) [[ "$#" -ge 2 && -n "$2" ]] || usage; ALLOWED+=("$2"); shift 2 ;;
    *) usage ;;
  esac
done

if [[ -z "$ROOT_DIR" ]]; then
  ROOT_DIR="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo 'private-data check: not inside a git repository; pass --root' >&2; exit 2; }
fi
ROOT_DIR="$(cd "$ROOT_DIR" && pwd)"
if [[ -n "$MESSAGE_FILE" ]]; then
  [[ "$MESSAGE_FILE" = /* ]] || MESSAGE_FILE="$PWD/$MESSAGE_FILE"
fi
[[ -n "$TERMS_FILE" ]] || TERMS_FILE="$ROOT_DIR/.private-terms"
[[ "$TERMS_FILE" = /* ]] || TERMS_FILE="$PWD/$TERMS_FILE"
cd "$ROOT_DIR"

TERMS_PATTERN=""
if [[ -f "$TERMS_FILE" ]]; then
  TERMS_PATTERN="$(grep -vE '^[[:space:]]*(#|$)' "$TERMS_FILE" | paste -sd '|' - || true)"
fi

if [[ -n "$TERMS_PATTERN" ]]; then
  if grep -qiE -- "$TERMS_PATTERN" </dev/null; then :
  elif [[ "$?" -gt 1 ]]; then
    echo 'private-data check: invalid regular expression in the private-terms file' >&2
    exit 2
  fi
fi
for pattern in "${ALLOWED[@]}"; do
  if grep -qE -- "$pattern" </dev/null; then :
  elif [[ "$?" -gt 1 ]]; then
    echo 'private-data check: invalid --allow regular expression' >&2
    exit 2
  fi
done

dirs=""
for name in "${FORBIDDEN_DIRS[@]}"; do dirs+="${dirs:+|}${name//./\\.}"; done
FORBIDDEN_PATHS='(^|/)\.env($|\.)|(^|/)\.npmrc$|\.(pem|key|crt|p12|pfx|db|sqlite|sqlite3|bundle)(-(wal|shm|journal))?$|(^|/)('"$dirs"')/|(^|/)[^/]+\.local\.md$|(^|/)\.private-terms$|(^|/)\.vscode/mcp\.json$'

failures=0
fail() {
  printf 'private-data check: %s\n' "$1" >&2
  failures=$((failures + 1))
}
# A path that itself contains a private term is never printed.
shown() {
  if [[ -n "$TERMS_PATTERN" ]] && grep -qiE -- "$TERMS_PATTERN" <<< "$1"; then printf '(path redacted)'; else printf '%s' "$1"; fi
}
allowed() {
  local pattern
  for pattern in "${ALLOWED[@]}"; do [[ "$1" =~ $pattern ]] && return 0; done
  return 1
}

if [[ "$MODE" == "message" ]]; then
  [[ -f "$MESSAGE_FILE" ]] || { echo 'private-data check: the commit message file does not exist' >&2; exit 2; }
  if [[ -n "$TERMS_PATTERN" ]] && grep -vE '^#' "$MESSAGE_FILE" | grep -qiE -- "$TERMS_PATTERN"; then
    fail "commit message contains a private term"
  fi
  [[ "$failures" -eq 0 ]] || exit 1
  exit 0
fi

if [[ "$MODE" == "staged" ]]; then
  mapfile -d '' -t files < <(git diff --cached --name-only --diff-filter=ACMR -z)
else
  mapfile -d '' -t files < <(git ls-files -z)
fi

for file in "${files[@]}"; do
  [[ -n "$file" ]] || continue
  if [[ "$file" =~ $FORBIDDEN_PATHS ]] && ! allowed "$file"; then
    fail "forbidden file: $(shown "$file")"
  fi
done

if [[ -n "$TERMS_PATTERN" && "${#files[@]}" -gt 0 ]]; then
  index_file="$(mktemp)"
  trap 'rm -f "$index_file"' EXIT
  for file in "${files[@]}"; do
    [[ -n "$file" ]] || continue
    if [[ "$MODE" == "staged" ]]; then
      git show ":$file" > "$index_file"
      content_file="$index_file"
    else
      [[ -f "$file" ]] || continue
      content_file="$file"
    fi
    display="$(shown "$file")"
    if matches="$(grep -naiE -- "$TERMS_PATTERN" "$content_file" | cut -d: -f1)"; then
      while IFS= read -r line; do
        fail "private term in $display:$line [redacted]"
      done <<< "$matches"
    fi
    if [[ "$display" != "$file" ]]; then
      fail "private term in a file name: $display"
    fi
  done
fi

if [[ "$failures" -gt 0 ]]; then
  echo "private-data check failed with $failures finding(s). Remove the data, or genericize it (example.com hosts, env vars)." >&2
  exit 1
fi
echo "Private data check passed."
