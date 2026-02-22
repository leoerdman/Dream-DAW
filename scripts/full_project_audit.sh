#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

RUST_LIMIT="${RUST_LIMIT:-1000}"
TS_LIMIT="${TS_LIMIT:-300}"
TOP_N="${TOP_N:-30}"
report_file=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --report)
      if [[ $# -lt 2 ]]; then
        echo "error: --report requires a file path" >&2
        exit 2
      fi
      report_file="$2"
      shift 2
      ;;
    *)
      echo "error: unknown argument '$1'" >&2
      echo "usage: $0 [--report <file>]" >&2
      exit 2
      ;;
  esac
done

emit() {
  if [[ -n "$report_file" ]]; then
    printf "%s\n" "$*" >> "$report_file"
  else
    printf "%s\n" "$*"
  fi
}

if [[ -n "$report_file" ]]; then
  : > "$report_file"
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

OVERSIZED_ALL="$TMP_DIR/oversized_all.txt"
CHANGED_FILES="$TMP_DIR/changed_files.txt"
OVERSIZED_UNTOUCHED="$TMP_DIR/oversized_untouched.txt"
TOP_FILES="$TMP_DIR/top_files.txt"
TODO_COUNTS="$TMP_DIR/todo_counts.txt"

emit "[FULL AUDIT] limits: rust>${RUST_LIMIT}, ts/tsx>${TS_LIMIT}"
emit "[FULL AUDIT] root: $ROOT_DIR"

find apps core frontend \
  -type d \( -name node_modules -o -name target -o -name dist -o -name .next -o -path 'frontend/shared_bindings' -o -path 'core/dream_models/bindings' \) -prune -o \
  -type f \( -name '*.rs' -o -name '*.ts' -o -name '*.tsx' \) -print0 \
  | xargs -0 wc -l \
  | awk -v rl="$RUST_LIMIT" -v tl="$TS_LIMIT" '
      $2=="total" { next }
      {
        path=$2;
        lines=$1+0;
        kind="";
        if (path ~ /\.rs$/) kind="rust";
        else if (path ~ /\.tsx?$/) kind="ts";
        else next;
        if ((kind=="rust" && lines>rl) || (kind=="ts" && lines>tl)) {
          print kind "\t" lines "\t" path;
        }
      }
    ' \
  | sort -t$'\t' -k2,2nr > "$OVERSIZED_ALL"

git status --porcelain=v1 \
  | awk '{print $2}' \
  | sed 's#^"##; s#"$##' \
  | sort -u > "$CHANGED_FILES"

awk -F'\t' '{print $3}' "$OVERSIZED_ALL" | sort -u > "$TMP_DIR/oversized_paths.txt"
comm -23 "$TMP_DIR/oversized_paths.txt" "$CHANGED_FILES" > "$TMP_DIR/oversized_untouched_paths.txt" || true

awk -F'\t' 'NR==FNR { keep[$1]=1; next } keep[$3] { print $0 }' \
  "$TMP_DIR/oversized_untouched_paths.txt" "$OVERSIZED_ALL" \
  > "$OVERSIZED_UNTOUCHED"

find apps core frontend \
  -type d \( -name node_modules -o -name target -o -name dist -o -name .next -o -path 'frontend/shared_bindings' -o -path 'core/dream_models/bindings' \) -prune -o \
  -type f \( -name '*.rs' -o -name '*.ts' -o -name '*.tsx' \) -print0 \
  | xargs -0 wc -l \
  | awk '$2!="total" {print $1 "\t" $2}' \
  | sort -t$'\t' -k1,1nr \
  | head -n "$TOP_N" > "$TOP_FILES"

{
  printf "apps\t"
  rg -n "TODO|FIXME|HACK|XXX|not implemented|placeholder|stub" apps -S | wc -l | tr -d '[:space:]'
  printf "\ncore\t"
  rg -n "TODO|FIXME|HACK|XXX|not implemented|placeholder|stub" core -S | wc -l | tr -d '[:space:]'
  printf "\nfrontend\t"
  rg -n "TODO|FIXME|HACK|XXX|not implemented|placeholder|stub" frontend -S | wc -l | tr -d '[:space:]'
  printf "\nscripts\t"
  rg -n "TODO|FIXME|HACK|XXX|not implemented|placeholder|stub" scripts -S | wc -l | tr -d '[:space:]'
  printf "\n"
} > "$TODO_COUNTS"

emit ""
emit "[FULL AUDIT] Oversized files (all)"
if [[ -s "$OVERSIZED_ALL" ]]; then
  emit "kind\tlines\tpath"
  cat "$OVERSIZED_ALL" | while IFS= read -r line; do emit "$line"; done
else
  emit "OK"
fi

emit ""
emit "[FULL AUDIT] Oversized files untouched by current changes"
if [[ -s "$OVERSIZED_UNTOUCHED" ]]; then
  emit "kind\tlines\tpath"
  cat "$OVERSIZED_UNTOUCHED" | while IFS= read -r line; do emit "$line"; done
else
  emit "OK"
fi

emit ""
emit "[FULL AUDIT] Top $TOP_N largest code files"
emit "lines\tpath"
cat "$TOP_FILES" | while IFS= read -r line; do emit "$line"; done

emit ""
emit "[FULL AUDIT] Debt markers by block"
emit "block\tcount"
cat "$TODO_COUNTS" | while IFS= read -r line; do emit "$line"; done

emit ""
emit "[FULL AUDIT] Changed file count: $(wc -l < "$CHANGED_FILES" | tr -d '[:space:]')"
emit "[FULL AUDIT] Oversized total: $(wc -l < "$OVERSIZED_ALL" | tr -d '[:space:]')"
emit "[FULL AUDIT] Oversized untouched: $(wc -l < "$OVERSIZED_UNTOUCHED" | tr -d '[:space:]')"
emit "[FULL AUDIT] DONE"
