#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

# Mutating engine API calls that must go through delta variants.
MUTATORS=(
  setBpm setLoop setTrackVolume setTrackPan setTrackMute setTrackSolo
  addTrack deleteTrack renameTrack setTrackHeight setTrackColor createGroup setGroupExpanded moveTrackToIndex
  moveTrackWithParent setTrackGroup ungroupTrack moveTrackBlockToIndex
  duplicateTracks importAudioFile createMidiClip updateMidiClip moveClip resizeClip
  splitClip duplicateClip mergeClips deleteClip setClipMuted setClipsMuted
  resolveMissingFile setAutomationPoints setArrangementGrid setKeySignature
  setTrackRouting setTrackInput setPluginSidechainSource
  paintTrackClipsWithTrackColor
  addPluginToTrack removePluginFromTrack setExternalPluginParamForSlot
  pasteDeviceToTrack setInternalPluginParam setSamplerSample setSampleRackPadSample
  setSampleRackPadVolume setSampleRackPadMute setSampleRackPadSolo
  setSampleRackPadAdsr setSampleRackPadFilterCutoff setClipFades
  setClipSourceOffset setClipWarp setClipPitch
  bounceSelectionToTrack bounceTrack bounceGroup splitTrackToStems
  undo redo armTrack
  replaceMissingPluginSlot setSlotBypass moveEffectSlot
)

joined="$(IFS='|'; echo "${MUTATORS[*]}")"
engine_api_file="frontend/ui_app/src/shared/api/engine.ts"

# API surface ratchet: each mutator must have a delta variant on engine API layer.
missing_delta_variants=()
for m in "${MUTATORS[@]}"; do
  if rg -q "export const ${m}\\s*=" "$engine_api_file"; then
    if ! rg -q "export const ${m}WithDeltas\\s*=" "$engine_api_file"; then
      missing_delta_variants+=("$m")
    fi
  fi
done

if [[ ${#missing_delta_variants[@]} -gt 0 ]]; then
  echo "[DELTA IPC GUARD] FAIL: engine API mutators without WithDeltas variant:" >&2
  printf ' - %s\n' "${missing_delta_variants[@]}" >&2
  exit 1
fi

# Enforce at usage sites only; API definitions in engine.ts are allowed.
hits_api="$(rg -n "\\bengineApi\\.(${joined})\\(" frontend/ui_app/src \
  -g "!$engine_api_file" | rg -v 'WithDeltas\(' || true)"

# `engine.*` alias is used in shared store/hook modules; restrict checks there
# to avoid collisions with local timeline engine objects.
hits_engine="$(rg -n "\\bengine\\.(${joined})\\(" frontend/ui_app/src/shared \
  -g "!$engine_api_file" | rg -v 'WithDeltas\(' | rg -v '^[[:space:]]*//' || true)"

hits="$(printf "%s\n%s" "$hits_api" "$hits_engine" | sed '/^$/d' || true)"

if [[ -n "$hits" ]]; then
  echo "[DELTA IPC GUARD] FAIL: found direct non-delta mutator calls:" >&2
  echo "$hits" >&2
  exit 1
fi

# Named-import guard: do not allow importing legacy mutators from engine API,
# even if they are not invoked through `engineApi.*`.
named_import_hits="$(
  rg -n -U -P "import\\s*\\{[^}]*\\b(${joined})\\b[^}]*\\}\\s*from\\s*['\"][^'\"]*/shared/api/engine['\"]" frontend/ui_app/src \
    -g "!$engine_api_file" \
    || true
)"

if [[ -n "$named_import_hits" ]]; then
  echo "[DELTA IPC GUARD] FAIL: found legacy mutator named-imports from engine API:" >&2
  echo "$named_import_hits" >&2
  exit 1
fi

snapshot_fallback_hits="$(rg -n -P "^\\s*(?!//).*(\\bgetProject\\(|invoke<.*>\\('get_project'|invoke\\('get_project')" frontend/ui_app/src \
  -g "!$engine_api_file" || true)"

if [[ -n "$snapshot_fallback_hits" ]]; then
  echo "[DELTA IPC GUARD] FAIL: found legacy full-project fetch usage in frontend runtime:" >&2
  echo "$snapshot_fallback_hits" >&2
  exit 1
fi

legacy_sync_hits="$(rg -n "\\bsyncProjectSnapshotDelta\\b|\\bgetProjectSnapshotDelta\\(" frontend/ui_app/src || true)"

if [[ -n "$legacy_sync_hits" ]]; then
  echo "[DELTA IPC GUARD] FAIL: found legacy snapshot-sync fallback entrypoints:" >&2
  echo "$legacy_sync_hits" >&2
  exit 1
fi

# Backend policy: full project snapshot replacement is allowed only for
# explicit snapshot-jump flows (new/open/undo/redo). Regular mutators must
# emit fine-grained deltas.
snapshot_delta_hits="$(rg -n "ProjectSnapshotReplaced" apps/desktop_host/src/commands || true)"
if [[ -n "$snapshot_delta_hits" ]]; then
  unauthorized_snapshot_hits="$(printf "%s\n" "$snapshot_delta_hits" \
    | rg -v "apps/desktop_host/src/commands/sections/(project_management|undo_redo)\\.rs" || true)"
  if [[ -n "$unauthorized_snapshot_hits" ]]; then
    echo "[DELTA IPC GUARD] FAIL: unauthorized ProjectSnapshotReplaced usage outside new/open/undo/redo:" >&2
    echo "$unauthorized_snapshot_hits" >&2
    exit 1
  fi
fi

# Direct invoke guard: frontend runtime must not call legacy mutating Tauri
# commands directly (without delta envelope) outside engine.ts wrappers.
legacy_cmd_invoke_hits="$(
  rg -n -P "invoke(?:<[^>]+>)?\\(\\s*'(?:(?:set|add|delete|move|split|duplicate|merge|import|resolve|paint|bounce|arm)_[a-z0-9_]*_cmd|undo_cmd|redo_cmd)'" frontend/ui_app/src \
    -g "!$engine_api_file" \
    | rg -v "_with_deltas_cmd'" \
    || true
)"

if [[ -n "$legacy_cmd_invoke_hits" ]]; then
  echo "[DELTA IPC GUARD] FAIL: found direct legacy mutating invoke(...) calls:" >&2
  echo "$legacy_cmd_invoke_hits" >&2
  exit 1
fi

echo "[DELTA IPC GUARD] OK"
