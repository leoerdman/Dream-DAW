import { create } from 'zustand';

/**
 * Canonical panel identifiers used across the DAW.
 *
 * 'arrangement'    – main timeline / arrangement view
 * 'piano-roll'     – MIDI note editor (bottom panel)
 * 'device-rack'    – insert/device chain editor (bottom panel)
 * 'sample-editor'  – audio clip / sample editor (bottom panel)
 * 'mixer'          – mixer panel
 * 'browser'        – asset browser sidebar
 * 'none'           – no panel focused (initial state)
 */
export type FocusPanel =
    | 'arrangement'
    | 'piano-roll'
    | 'device-rack'
    | 'sample-editor'
    | 'mixer'
    | 'browser'
    | 'flow-synth'
    | 'none';

interface FocusPanelState {
    /** The panel that was most recently clicked / interacted with. */
    activePanel: FocusPanel;
    /** Set the active panel. Call from each panel's onMouseDown/onPointerDown. */
    setActivePanel: (panel: FocusPanel) => void;
}

/**
 * Global focus-follows-click store.
 *
 * Every major DAW panel calls `setActivePanel()` on mousedown so that
 * keyboard-shortcut routing can determine which panel "owns" the shortcut
 * without relying on brittle DOM focus (`document.activeElement`).
 */
export const useFocusPanelStore = create<FocusPanelState>((set) => ({
    activePanel: 'arrangement',
    // BUG-098 FIX: Guard against redundant state updates on every mousedown.
    setActivePanel: (panel) => set((s) => s.activePanel === panel ? s : { activePanel: panel }),
}));
