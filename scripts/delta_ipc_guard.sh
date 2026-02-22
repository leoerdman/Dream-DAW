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

echo "[DELTA IPC GUARD] OK"
