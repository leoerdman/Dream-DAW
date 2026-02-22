#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

err() { printf "[ZUSTAND GUARD] %s\n" "$*" >&2; }

TARGET_GLOBS=(-g'*.ts' -g'*.tsx')
STORE_HOOK_PATTERN='use[A-Za-z0-9_]+Store'

filter_comment_lines() {
  awk -F: '{
    text=$0;
    if (NF >= 3) {
      text=$3;
      for (i=4; i<=NF; i++) text=text ":" $i;
    }
    if (text ~ /^[[:space:]]*\/\//) next;
    if (text ~ /^[[:space:]]*\*/) next;
    if (text ~ /^[[:space:]]*\/\*/) next;
    print $0;
  }'
}

# 1) Forbid broad subscriptions that attach component updates to the full store.
if rg -n "${STORE_HOOK_PATTERN}\\s*\\(\\s*\\)" frontend/ui_app/src "${TARGET_GLOBS[@]}" | filter_comment_lines | grep -q .; then
  err "Found forbidden broad subscription: use*Store() without a selector."
  rg -n "${STORE_HOOK_PATTERN}\\s*\\(\\s*\\)" frontend/ui_app/src "${TARGET_GLOBS[@]}" | filter_comment_lines >&2 || true
  exit 1
fi

# 2) Require shallow wrapping for object-literal selectors to avoid referential churn.
if rg -n "${STORE_HOOK_PATTERN}\\s*\\(\\s*\\(\\s*[A-Za-z_][A-Za-z0-9_]*\\s*\\)\\s*=>\\s*\\(\\s*\\{" frontend/ui_app/src "${TARGET_GLOBS[@]}" | filter_comment_lines | grep -q .; then
  err "Found object-literal selector without useShallow wrapper in use*Store selector."
  rg -n "${STORE_HOOK_PATTERN}\\s*\\(\\s*\\(\\s*[A-Za-z_][A-Za-z0-9_]*\\s*\\)\\s*=>\\s*\\(\\s*\\{" frontend/ui_app/src "${TARGET_GLOBS[@]}" | filter_comment_lines >&2 || true
  exit 1
fi

printf "[ZUSTAND GUARD] OK\n"
