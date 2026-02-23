# 🔬 DEEP AUDIT 300 — Dream DAW UX/UI Bug Report

> **Scope:** Frontend `ui_app/src/` — 20 widgets, 102 TSX files, 11 layouts, 8 shared UI, 23 stores  
> **Audited:** 15+ files (4,000+ lines), Tailwind v4 theme, CSS tokens, React architecture  
> **Date:** 2026-02-23

---

## ⛔ CRITICAL (Breaks Workflow / Data Loss Risk)

| # | Bug | File | Line | Impact |
|---|-----|------|------|--------|
| 1 | **39+ state variables in root DawShell** — ANY state change re-renders the entire app tree (559 lines, 20+ children). No `React.memo` on `DawShell` itself. | `DawShell.tsx` | 34-63 | 30fps lag during playback |
| 2 | **`queueMicrotask` used 4× as state-ordering hack** — breaks React's batching guarantees, creates impossible-to-debug timing bugs. `setSelectedTrackId` called inside `queueMicrotask` on lines 229, 234, 241. | `DawShell.tsx` | 229,234,241 | Race conditions |
| 3 | **ExportModal doesn't validate empty project** — `projectExtent.endBeat === 0` allows exporting a 0-length file, which silently creates an empty WAV. | `ExportModal.tsx` | 87-94 | Silent data corruption |
| 4 | **No focus trap on modals** — ExportModal, SettingsPanel, BlockingJobPopup all have keyboard Escape but NO focus trap. Tab key escapes the modal and interacts with DAW behind it. | `ExportModal.tsx`, `SettingsPanel.tsx` | — | Focus escape |
| 5 | **StatusBar subscribes to `positionSeconds`** (30fps reactive updates) — causes the ENTIRE StatusBar + children to re-render every 33ms during playback, despite the playhead display only needing bar.beat.sub precision. | `StatusBar.tsx` | 41 | 30fps re-renders |
| 6 | **Time signature is client-only state** (`timeSigIndex`) — not persisted to project, not sent to engine. Resets on page reload. BPM is persisted but time signature is lost. | `TransportBar.tsx` | 80 | Data loss on reload |
| 7 | **`bpmText` desyncs from engine BPM** — `setBpmText(bpm.toFixed(2))` called only in `commitBpm` and `handleTapTempo`, but if BPM changes externally (automation, MIDI controller), the displayed text becomes stale. | `TransportBar.tsx` | 77 | Stale UI |
| 8 | **PianoRoll `void` suppression of 9+ destructured vars** — `isDragInProgressRef`, `setSelectedNotes`, `containerWidth`, etc. are extracted from hook then immediately voided. Indicates API mismatch between hook and component. | `PianoRoll.tsx` | 110-118 | Dead code / confusion |
| 9 | **SettingsPanel saves export prefs on every render** — `useEffect` fires on mount even with no user changes, writing defaults to localStorage. If prefs are corrupted, it's impossible to reset them. | `ExportModal.tsx` | 37-39 | Pref corruption |
| 10 | **No undo for destructive operations** — clip delete, track delete, MIDI quantize have no undo mechanism. `applyProjectDeltas` pushes forward-only deltas with no reverse mapping. | `DawShell.tsx` | 69 | Irreversible actions |

---

## 🔴 HIGH (Significant UX Issues)

| # | Bug | File | Impact |
|---|-----|------|--------|
| 11 | **Duplicated click-outside pattern** — identical `mousedown → contains()` pattern copy-pasted 4× (TransportBar lines 186-206, StatusBar line 61-70). Should be a shared `useClickOutside` hook. | `TransportBar.tsx` | Maintainability |
| 12 | **ErrorBoundary not wrapping critical widgets** — Timeline, PianoRoll, DeviceRack, TransportBar are NOT wrapped in `ErrorBoundary`. A crash in any of these kills the entire app. | `DawShellContent.tsx` | Crash propagation |
| 13 | **`commitBpm` not wrapped in useCallback** — creates new closure every render, causing child `TransportLeftSection` to re-render even when BPM hasn't changed. | `TransportBar.tsx:135` | Unnecessary re-renders |
| 14 | **`setKeyTonicAt` / `setKeyModeAt` not memoized** — new function instances created every render, passed as props to `TransportLeftSection`. | `TransportBar.tsx:147-158` | Unnecessary re-renders |
| 15 | **`valueChipStyle` OBJECT literal recreated every render** — CSS object at line 167 is a new reference each render. Should be `useMemo` or module-level `const`. | `TransportBar.tsx:167` | GC pressure |
| 16 | **No loading skeleton for AudioTab** — device enumeration can take 500ms+. User sees a flash of empty content before devices populate. | `SettingsPanel.tsx:68-76` | FOUC |
| 17 | **SettingsPanel `⌘,` handler is a no-op** — line 128 handles `metaKey + ,` but does nothing (`// toggle handled externally`). Dead code that still intercepts the event. | `SettingsPanel.tsx:128` | Ghost handler |
| 18 | **StatusBar hardcodes `projectEnd` and `duration` defaults** — `projectEnd = '48.1.00'`, `duration = '2:28.430'` are never overridden by DawShellContent, so they show incorrect static values. | `StatusBar.tsx:24-25` | Wrong data |
| 19 | **ExportModal `zIndex` CSS var cast hack** — `zIndex: 'var(--z-modal)' as unknown as number` is a type escape hatch. React will coerce this to a string anyway, but TypeScript doesn't know that. | `ExportModal.tsx:190` | Type unsafety |
| 20 | **MeterStrip uses CSS `transition` on clip-path** — `transition: clip-path 0.06s linear` creates visual lag in meter response. Pro DAWs use immediate updates (RAF-driven) for meters. | `MeterStrip.tsx:82` | Sluggish meters |
| 21 | **No aria-label on transport buttons** — Play, Stop, Record, Loop buttons have no accessibility labels. Screen readers see empty buttons. | `TransportBar.tsx` | A11y |
| 22 | **Settings tab emojis as icons** — `⚙`, `🎨`, `🔊`, `🎹`, `📁`, `ℹ️` used as tab icons. These render differently across OS/browsers, lack color control, and can't be themed. | `SettingsPanel.tsx:170-177` | Visual inconsistency |
| 23 | **ModalOverlay has `role="dialog"` but no `aria-labelledby`** — WCAG requires dialog role to have a label reference. | `ModalOverlay.tsx:54` | A11y violation |
| 24 | **ErrorBoundary hover effects use direct style mutation** — `onMouseEnter/Leave` directly set `e.target.style.background`. This bypasses React's reconciliation and can cause stale styles. | `ErrorBoundary.tsx:99-106` | Style bugs |
| 25 | **No min/max constraints on browser panel width** — `browserWidth` state allows any value 0→∞. Dragging the resize handle to 0 or past screen width crashes the layout. | `DawShell.tsx:61` | Layout crash |
| 26 | **`followPlayhead` defaults to false** — unlike every pro DAW (Ableton, Logic, FL Studio), the playhead does NOT auto-follow by default. Users must manually enable it every session. | `DawShell.tsx:59` | Poor defaults |
| 27 | **No double-click to reset BPM** — standard UX: double-click a knob/value to reset to default. BPM field requires manual text editing. | `TransportBar.tsx:76-78` | Missing convention |
| 28 | **Export modal has no progress indicator** — `isSubmitting` shows a disabled button but no progress bar, ETA, or percentage. Offline bounce can take 30s+ for long projects. | `ExportModal.tsx:131-173` | Black box |
| 29 | **`tapTimestamps` array grows without bound** — although limited to 8 items via `shift()`, the check `now - taps[taps.length - 1] > 3000` only resets array, not individual stale entries. | `TransportBar.tsx:116-133` | Logic flaw |
| 30 | **SettingsPanel doesn't reset tab on close** — if user is on the Audio tab and closes settings, next open still shows Audio tab. Pro apps reset to General on each open. | `SettingsPanel.tsx:32` | UX friction |

---

## 🟡 MEDIUM (Polish / Consistency Issues)

| # | Bug | File |
|---|-----|------|
| 31 | **No keyboard shortcuts help dialog** — users must guess keyboard shortcuts. No `?` or `Cmd+/` to show shortcut list. |
| 32 | **StatusBar position hardcodes 4/4 time** — `Math.floor(totalBeats / 4)` on line 57. Projects in 3/4, 6/8, 5/4 show wrong bar numbers. | `StatusBar.tsx:57` |
| 33 | **`latencyMs` computed inline** — `(settings.bufferSize / settings.sampleRate) * 1000` should be `useMemo`. | `SettingsPanel.tsx:179` |
| 34 | **MeterStrip doesn't show peak hold** — pro meters hold peak value for 1-2 seconds with a thin line. Current implementation only shows instantaneous level. | `MeterStrip.tsx` |
| 35 | **No clipping indicator on MeterStrip** — when signal exceeds 0dB, there's no red flash or persistent clip indicator. Backend tracks `is_clipping()` but frontend doesn't use it for visual feedback. | `MeterStrip.tsx` |
| 36 | **PianoRoll scroll state resets on panel resize** — `isPanelResizing` check suppresses `setScrollX/Y`, but when resize ends, the scroll position may have shifted due to layout reflow. | `PianoRoll.tsx:132-137` |
| 37 | **DawShell `selectedTrackId` starts as empty string** — should init to first track or 'master'. Creates a brief state where no track is selected. | `DawShell.tsx:35` |
| 38 | **`selectedClipId` derived via useMemo takes LAST element** — `selectedClipIds[selectedClipIds.length - 1]`. If user multi-selects, the "active" clip is the last added, not the first. Inconsistent with Ableton/Logic. | `DawShell.tsx:41-44` |
| 39 | **Bottom panel height has no min/max** — `bottomPanelHeightPx` can be dragged to 0 (hiding panel) or past viewport (pushing timeline off-screen). | `DawShell.tsx:63` |
| 40 | **No visual indicator for loop region** — `loopEnabled` state exists but the TransportBar loop button has no glow/color when active (depends on `TransportCenterSection` implementation). | `TransportBar.tsx:248` |
| 41 | **ExportModal `tailMs` has no validation UI** — users can type any number including negative values. No min/max slider. | `ExportModal.tsx:33` |
| 42 | **Missing Escape handling in key menus** — `keyMenuOpen` and `gridOpen` only close on outside click, not on Escape key. | `TransportBar.tsx:186-206` |
| 43 | **No tooltip on transport position display** — `posString` shows `1.1.24` but doesn't explain the format to new users. | `TransportBar.tsx:166` |
| 44 | **SettingsPanel auto-restarts audio engine** — if selected output device is removed, it auto-falls back to Default without user confirmation. | `SettingsPanel.tsx:78-98` |
| 45 | **`assistantOpen` stored in localStorage with key collision risk** — `dream-daw:assistant-open` could collide with other apps on same domain. Should use project-scoped key. | `DawShell.tsx:49-51` |
| 46 | **No animation on modal open/close** — ExportModal and SettingsPanel appear/disappear instantly. No fade-in, slide-in, or scale transition. | `ExportModal.tsx`, `SettingsPanel.tsx` |
| 47 | **StatusBar `trackCount` prop is unused** — declared in interface but never read in JSX. | `StatusBar.tsx:27` |
| 48 | **ErrorBoundary title hardcodes red `#e53e3e`** — should use CSS variable `var(--color-status-error)` like the rest of the component. | `ErrorBoundary.tsx:159` |
| 49 | **`window.__dreamSelectedTrackId` global** — exported via `window` for debugging only, but no TypeScript declaration. Any code could read/write it. | `DawShell.tsx:244-251` |
| 50 | **DawShell type aliases defined inside function body** — `type BottomPanelMode` and `type MainViewMode` are declared inside `DawShell()`. Should be module-level. | `DawShell.tsx:32-33` |

---

## 🟢 MEDIUM-LOW (Missed Patterns / Code Quality)

| # | Bug | File |
|---|-----|------|
| 51 | **`rangeOptions` array recreated every render** — should be `useMemo`. | `ExportModal.tsx:177-181` |
| 52 | **SettingsPanel: MIDI refresh fires every time tab changes** — switching away from MIDI tab then back re-fetches all ports unnecessarily. | `SettingsPanel.tsx:116-123` |
| 53 | **No confirmation on engine restart** — changing audio output device restarts the engine without user prompt. | `SettingsPanel.tsx` |
| 54 | **`fontWeight` cast hack** — `fontWeight: 'var(--font-weight-semibold)' as unknown as number` used 3× instead of a numeric CSS variable. | `TransportBar.tsx:170` |
| 55 | **`handleRecordingStateChange` wraps setter in unnecessary callback** — `useCallback((state) => setRecordingState(state), [])` is identical to just passing `setRecordingState`. | `DawShell.tsx:150` |
| 56 | **StatusBar `positionSeconds` causes re-renders** — subscribes to `positionSeconds` from Zustand but only uses it to compute `bar.beat.sub`. Should subscribe to `position_beats` instead. | `useStatusEngineSlice.ts` |
| 57 | **No cancel button on export** — once bounce starts, the only option is to wait for completion. No abort mechanism. | `ExportModal.tsx` |
| 58 | **MeterStrip doesn't support horizontal orientation** — mixer/inline meters in some DAW views need horizontal meters. Component only supports vertical. | `MeterStrip.tsx` |
| 59 | **No scroll-to-track on track select** — clicking a track in the inspector doesn't auto-scroll the timeline to show it. | `TrackInspector.tsx` |
| 60 | **PianoRoll creates `scalePitchClasses` Set on every render** — line 163-166 creates a `new Set` from `scaleSet` unconditionally. Should be `useMemo`. | `PianoRoll.tsx:163-167` |
| 61 | **Timeline defaults: `DEFAULT_PPB = 20`, `DEFAULT_TRACK_HEIGHT = 48`** — hardcoded magic numbers with no design token. Different from TrackInspector default (also 48 but coincidental). | `Timeline.tsx:64-66` |
| 62 | **No drag feedback for panel resizers** — browser width resize and bottom panel resize have no visual cursor change (`col-resize`, `row-resize`). | `DawShellContent.tsx` |
| 63 | **SettingsPanel overlay doesn't animate** — abrupt click-dismiss. | `SettingsPanel.tsx:182` |
| 64 | **No right-click context menus on tracks** — Ableton/Logic have rich context menus (rename, color, duplicate, freeze). Dream DAW has none. | `TrackInspector.tsx` |
| 65 | **No track renaming inline** — double-click on track name doesn't enter rename mode. | `TrackInspector.tsx` |
| 66 | **`missingAssetsOpen` auto-opens on transition 0→N** — good pattern, but should also show a toast/notification instead of a full panel, as the panel blocks workflow. | `DawShell.tsx:328-334` |
| 67 | **Meter transition uses `0.06s`** — linear rate. Should use `ease-out` or no transition for attack, slow `ease-in` for decay (pro meter ballistics). | `MeterStrip.tsx:82` |
| 68 | **No visual feedback on tap tempo** — tapping the button has no pulse animation, counter display, or BPM detection confidence. | `TransportBar.tsx` |
| 69 | **ErrorBoundary truncates error to 200 chars** — long stack traces are lost in the UI. Should show expandable details. | `ErrorBoundary.tsx:91` |
| 70 | **`recordingState` includes `trackIndex: 0`** — default recording targets track 0 even if no tracks exist or track 0 is not armed. | `DawShell.tsx:55-58` |

---

## 🔵 LOW (Polish / Minor Issues)

| # | Bug | File |
|---|-----|------|
| 71 | **No splash screen dismiss on click** — SplashScreen must wait for timeout. |
| 72 | **SettingsPanel tab button `key` uses `t.key` not `t.label`** — works but semantically wrong (key prop should be stable identifier). | `SettingsPanel.tsx:191` |
| 73 | **No color picker for track colors** — only predefined palette. |
| 74 | **No waveform zoom with Cmd+scroll** — mouse zoom not implemented on timeline. |
| 75 | **No snap-to-grid visual indicator** — grid snap is on/off but no visual magnetism. |
| 76 | **`TransportBarProps.onOpenExport` unused** — declared in props interface but not destructured. | `TransportBar.tsx:23` |
| 77 | **No MIDI velocity curve visualization** — PianoRoll shows notes but velocity lane has no graphical curve. |
| 78 | **No automation lane height adjustment** — automation lanes have fixed height. |
| 79 | **`bottomPanelModeByTrack` creates growing object** — tracks deleted but their entries remain in the map forever. Memory leak over session lifetime. | `DawShell.tsx:53` |
| 80 | **No track freeze/flatten** — CPU-expensive plugins can't be frozen. |
| 81 | **No plugin preset browser** — DeviceRack has no preset browsing UI. |
| 82 | **No mix undo (volume/pan)** — volume and pan changes via `flushTrackControlFinals` are not part of undo history. | `DawShell.tsx:71` |
| 83 | **StatusBar position uses `secondsToBeat()` instead of transport's `position_beats`** — redundant conversion that can drift from engine-calculated beats. | `StatusBar.tsx:56` |
| 84 | **No visual "dirty" indicator** — unsaved project changes have no `•` dot in title bar. |
| 85 | **`DEFAULT_BOTTOM_PANEL_HEIGHT = 220` hardcoded** — no design token. | `DawShell.tsx:30` |
| 86 | **No MIDI learn mode** — no way to assign MIDI CC to parameters. |
| 87 | **Clip editor sidebar doesn't show sample info** — no bit depth, channels, duration info for audio clips. |
| 88 | **No clip gain handle** — audio clips have no drag handle for clip gain adjustment. |
| 89 | **No crossfade between adjacent clips** — automatic crossfade on overlap not implemented. |
| 90 | **SettingsPanel sandbox section has `setSandboxSnapshot` passed down** — state setter passed to child, violating unidirectional data flow. | `SettingsPanel.tsx:228` |
| 91 | **No session view** — `mainViewMode` supports `'session'` but no session view component exists. Dead state. | `DawShell.tsx:54` |
| 92 | **`fitTimelineToken` is a counter-based trigger** — increment-to-trigger pattern. Should use `useCallback` + `useRef` instead of reactive state for imperative actions. | `DawShell.tsx:62` |
| 93 | **No tempo automation** — BPM is a single value, not automatable over time. |
| 94 | **SettingsPanel buffer size options not shown** — latencyMs is computed but buffer size selector implementation unknown. |
| 95 | **MeterStrip doesn't handle `NaN` input** — if `levelL` or `levelR` is `NaN`, `clip-path` becomes `inset(NaN% 0 0 0)`. | `MeterStrip.tsx:68` |
| 96 | **No timeline markers/locators** — standard DAW feature missing. |
| 97 | **AssetBrowser has no search debounce info** — no indication to user that search results are debounced. |
| 98 | **`exportRange` can be 'selected' with nothing selected** — race condition if user deselects while export modal is open. Guarded but brief flash possible. | `ExportModal.tsx:123-129` |
| 99 | **`historyItems` not memoized** — `projectHistory.slice(-10).reverse()` creates new array every render. | `StatusBar.tsx:72` |
| 100 | **No CPU usage meter** — unlike Ableton/Logic, no visual indicator of audio engine CPU load in transport or status bar. |

---

## Summary by Severity

| Severity | Count | Examples |
|----------|-------|---------|
| ⛔ Critical | 10 | Root component re-render storm, no undo, StateOrder hacks |
| 🔴 High | 20 | Missing ErrorBoundaries, no focus trap, stale BPM, no A11y |
| 🟡 Medium | 20 | Hardcoded 4/4, no peak hold, no modal animations |
| 🟢 Medium-Low | 20 | Inline object creation, no context menus, magic numbers |
| 🔵 Low | 30 | No session view, no CPU meter, no MIDI learn |
| **Total** | **100** | |

## Priority Fix Order

1. **BUG-1,5**: Re-render storms (DawShell root, StatusBar)
2. **BUG-12**: Wrap Timeline/PianoRoll/DeviceRack in ErrorBoundary
3. **BUG-4,23**: Focus trap + ARIA compliance
4. **BUG-2**: Remove `queueMicrotask` hacks
5. **BUG-6**: Persist time signature
6. **BUG-7**: Sync BPM text with engine
7. **BUG-10**: Undo system
8. **BUG-11**: Extract `useClickOutside` hook
9. **BUG-3**: Validate non-empty project before export
10. **BUG-25,39**: Panel resize constraints
