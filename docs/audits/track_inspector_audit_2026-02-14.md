# Track Inspector Audit (2026-02-14)

## Scope
- File: `/Users/leoerdman/Programming - MAIN FOLDER/Dream DAW/frontend/ui_app/src/widgets/TrackInspector/TrackInspector.tsx`
- Related systems: routing IPC, transport/meter telemetry, timeline track selection, theme tokens.

## What was improved in this pass
- Routing controls now call real backend commands (`setTrackRouting`, `setTrackInput`) instead of stubs.
- Right panel now follows selected-track focus model:
  - full routing controls only for selected/hovered tracks,
  - compact routing summary for non-focused rows.
- Key row surfaces were migrated to semantic tokens (`--surface-*`, `--text-*`, `--accent-*`) in core track row sections.
- Visual regression baseline scaffolding added for right panel.

## Key findings and recommendations

### P0 (must-do for reliability)
1. Routing transactional UX:
   - Add optimistic pending state for routing selects (spinner/disabled while IPC in flight).
   - Revert UI state if IPC fails.
2. Track row action consistency:
   - Define one authoritative action policy for Mute/Solo/Arm/Enable.
   - Current “Enable” button is coupled to mute state; split semantics or relabel.
3. Error surfacing:
   - Route all TrackInspector command failures to global status/toast store (not only console).

### P1 (high impact UX)
4. Strong selected-track focus:
   - Keep full controls expanded only for selected track by default.
   - Add optional “mixer focus mode” toggle to expand all.
5. Density tiers:
   - Implement compact/normal row density presets.
   - Tie to zoom/track-height to keep readability at scale.
6. Master lane parity:
   - Master should follow same visual grammar with explicit exceptions only for routing/input.

### P1 (architecture)
7. View-model extraction:
   - Move derived row state (input/output validity, compact labels, meter normalization) into a pure selector module.
8. Row command bus:
   - Align with timeline command bus pattern (explicit commands from UI -> handler).
9. Tokenization completion:
   - Replace remaining raw colors in TrackInspector + transport/device rack.

### P2 (performance)
10. Minimize high-frequency row rerenders:
   - Memoize row props and separate meter updates from static controls.
11. Meter paint budget:
   - Coalesce meter refreshes to fixed cadence (e.g. 30/60 Hz) and avoid per-row style churn.
12. Select control perf:
   - Cache routing target option lists per track snapshot.

### P2 (interaction quality)
13. Keyboard workflow:
   - Arrow navigation between tracks.
   - Enter to arm/solo focus actions.
   - Quick rename with deterministic focus return.
14. Context menu refinement:
   - Replace emoji icons with unified icon system.
   - Add “Duplicate Track” and “Freeze/Flatten” placeholders for future parity.
15. Accessibility:
   - Add ARIA labels for all control buttons/selects and current state announcements.

### P3 (future/scale)
16. Collapsible section model:
   - Route, Mixer, Monitoring sections per selected track.
17. Multi-track editing:
   - Apply volume/pan/routing changes to multi-selected tracks.
18. Inspector tabs:
   - “Track”, “Devices”, “Automation” contextual tabs for selected track.

## Suggested phased rollout
- Phase 1: reliability & command/error plumbing (P0).
- Phase 2: selected-track focus + density + token completion (P1).
- Phase 3: perf isolation and memoized meter lane (P2).
- Phase 4: keyboard/accessibility/multi-edit (P2/P3).

