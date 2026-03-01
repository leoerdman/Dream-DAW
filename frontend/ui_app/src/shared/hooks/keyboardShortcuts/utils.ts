import { beatToFrame, frameToBeat, resolveBpm, resolveSampleRate } from '@/shared/lib/audioMath';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useFocusPanelStore } from '@/shared/stores/useFocusPanelStore';
import type { KeyboardShortcutsConfig, KeyboardShortcutRuntimeContext } from './types';
import type { ShortcutActionId } from '@/shared/lib/shortcutBindings';
import { DEFAULT_SHORTCUT_BINDINGS, isShortcutMatch } from '@/shared/lib/shortcutBindings';
import { useShortcutStore } from '@/shared/stores/useShortcutStore';
import { isMacDesktopPlatform } from '@/shared/lib/platform';

const isMac = isMacDesktopPlatform();

export function isModKey(e: KeyboardEvent): boolean {
    return isMac ? e.metaKey : e.ctrlKey;
}

export function getScopedEditorElement(e: KeyboardEvent, scope: string): HTMLElement | null {
    const target = e.target as HTMLElement | null;
    const closest = target?.closest?.(`[data-keyboard-scope="${scope}"]`) ?? null;
    if (closest) return closest as HTMLElement;
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    for (const node of path) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.dataset?.keyboardScope === scope) return node;
    }
    return null;
}




function isEditableTag(el: HTMLElement | null): boolean {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el.isContentEditable) return true;
    return Boolean(el.closest?.('input, textarea, select, [contenteditable="true"], [role="textbox"], [data-keyboard-scope="text-input"]'));
}

function insideAssistantChat(el: HTMLElement | null): boolean {
    if (!el) return false;
    if (el.closest?.('.assistant-chat-overlay')) return true;
    return Boolean(el.closest?.('[data-keyboard-scope="text-input"]'));
}

function selectionInEditable(): boolean {
    try {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return false;
        const node = sel.anchorNode;
        if (!node) return false;
        const parent = (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement) as HTMLElement | null;
        return isEditableTag(parent);
    } catch {
        // window.getSelection() may throw in detached iframes or restricted
        // security contexts (Tauri WKWebView sandboxing). Safe to return false.
        return false;
    }
}

export function shouldIgnoreKeyboardShortcut(e: KeyboardEvent): boolean {
    const target = e.target as HTMLElement;
    const active = document.activeElement as HTMLElement | null;
    return (
        isEditableTag(target) ||
        isEditableTag(active) ||
        selectionInEditable() ||
        insideAssistantChat(target) ||
        insideAssistantChat(active)
    );
}

export function buildRuntimeContext(config: KeyboardShortcutsConfig, e: KeyboardEvent): KeyboardShortcutRuntimeContext {
    const storeState = useEngineStore.getState();
    const posSeconds = storeState.transport.position_seconds ?? 0;
    const sampleRate = resolveSampleRate(storeState.projectSampleRate, storeState.transport.sample_rate);
    const playheadFrames = Math.round(posSeconds * sampleRate);

    // ── Focus-follows-click panel detection ──
    // Use the global focus panel store (set by each panel's onMouseDown) to
    // determine which editor panel "owns" the current keyboard shortcut.
    // This replaces the brittle DOM-based e.target / document.activeElement
    // checking that failed with canvas elements (which don't receive focus).
    const activePanel = useFocusPanelStore.getState().activePanel;

    // For device-rack we still need to read selectedDeviceId from the DOM
    // data attribute, as the rack component writes it there.
    const deviceRackScope = activePanel === 'device-rack' ? getScopedEditorElement(e, 'device-rack') ?? document.querySelector('[data-keyboard-scope="device-rack"]') as HTMLElement | null : null;

    const selectedTrackIndex = config.selectedTrackId
        ? storeState.tracks.allIds.indexOf(config.selectedTrackId)
        : -1;
    const insertAfterIndex =
        config.selectedTrackId &&
            config.selectedTrackId !== 'master' &&
            selectedTrackIndex >= 0
            ? selectedTrackIndex
            : null;

    return {
        ...config,
        playheadFrames,
        activePanel,
        selectedDeviceId: deviceRackScope?.dataset?.selectedDeviceId ?? '',
        selectedTrackIndex,
        insertAfterIndex,
    };
}

export function resolveSplitFrame(playheadFrames: number, editCursorBeat: number | undefined): number {
    const store = useEngineStore.getState();
    const bpm = resolveBpm(store.transport.bpm);
    const sampleRate = resolveSampleRate(store.projectSampleRate, store.transport.sample_rate);
    const splitBeat = Number.isFinite(editCursorBeat) && (editCursorBeat ?? -1) >= 0
        ? (editCursorBeat as number)
        : frameToBeat(playheadFrames, bpm, sampleRate);
    return Math.max(0, beatToFrame(splitBeat, bpm, sampleRate));
}

export function matchesShortcutAction(e: KeyboardEvent, actionId: ShortcutActionId): boolean {
    const binding = useShortcutStore.getState().getBinding(actionId) || DEFAULT_SHORTCUT_BINDINGS[actionId];
    return isShortcutMatch(e, binding);
}
