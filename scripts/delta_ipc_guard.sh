#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

# Mutating engine API calls that must go through delta variants.
MUTATORS=(
  setBpm setLoop setTrackVolume setTrackPan setTrackMute setTrackSolo
  addTrack deleteTrack renameTrack setTrackColor createGroup moveTrackToIndex
  duplicateTracks importAudioFile createMidiClip updateMidiClip moveClip resizeClip
  splitClip duplicateClip mergeClips deleteClip setClipMuted setClipsMuted
  resolveMissingFile setAutomationPoints setArrangementGrid setKeySignature
  setTrackRouting setPluginSidechainSource addPluginToTrack removePluginFromTrack
  pasteDeviceToTrack setInternalPluginParam setSamplerSample setSampleRackPadSample
  setSampleRackPadVolume setSampleRackPadMute setSampleRackPadSolo
  setSampleRackPadAdsr setSampleRackPadFilterCutoff setClipFades
  setClipSourceOffset setClipWarp bounceTrack undo redo armTrack
  replaceMissingPluginSlot setSlotBypass moveEffectSlot
)

joined="$(IFS='|'; echo "${MUTATORS[*]}")"

# Enforce at usage sites only; API definitions in engine.ts are allowed.
hits="$(rg -n "engineApi\.(${joined})\\(" frontend/ui_app/src \
  -g '!frontend/ui_app/src/shared/api/engine.ts' | rg -v 'WithDeltas\(' || true)"

if [[ -n "$hits" ]]; then
  echo "[DELTA IPC GUARD] FAIL: found direct non-delta mutator calls:" >&2
  echo "$hits" >&2
  exit 1
fi

snapshot_fallback_hits="$(rg -n -P "^\\s*(?!//).*(\\bgetProject\\(|invoke<.*>\\('get_project'|invoke\\('get_project')" frontend/ui_app/src \
  -g '!frontend/ui_app/src/shared/api/engine.ts' || true)"

if [[ -n "$snapshot_fallback_hits" ]]; then
  echo "[DELTA IPC GUARD] FAIL: found legacy full-project fetch usage in frontend runtime:" >&2
  echo "$snapshot_fallback_hits" >&2
  exit 1
fi

echo "[DELTA IPC GUARD] OK"
