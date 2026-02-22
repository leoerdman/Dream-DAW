import { beatToFrame, frameToBeat, resolveSampleRate } from '@/shared/lib/audioMath';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import type { KeyboardShortcutsConfig, KeyboardShortcutRuntimeContext } from './types';

const isMac = (() => {
    if (typeof navigator === 'undefined') return false;
    const uad = (navigator as Navigator & { userAgentData?: { platform: string } }).userAgentData;
    if (uad?.platform) return uad.platform === 'macOS';
    return /mac/i.test(navigator.userAgent) && !/iphone|ipad/i.test(navigator.userAgent);
})();

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
    const pianoRollScope = getScopedEditorElement(e, 'piano-roll');
    const deviceRackScope = getScopedEditorElement(e, 'device-rack');
    const selectedTrackIndex = config.projectTracks.findIndex((t) => t.id === config.selectedTrackId);
    const insertAfterIndex =
        config.selectedTrackId &&
        config.selectedTrackId !== 'master' &&
        selectedTrackIndex >= 0
            ? selectedTrackIndex
            : null;

    return {
        ...config,
        playheadFrames,
        inPianoRoll: Boolean(pianoRollScope),
        inDeviceRack: Boolean(deviceRackScope),
        selectedDeviceId: deviceRackScope?.dataset?.selectedDeviceId ?? '',
        selectedTrackIndex,
        insertAfterIndex,
    };
}

export function resolveSplitFrame(playheadFrames: number, editCursorBeat: number | undefined): number {
    const store = useEngineStore.getState();
    const bpm = Math.max(1, store.projectBpm || store.transport.bpm || 120);
    const sampleRate = resolveSampleRate(store.projectSampleRate, store.transport.sample_rate);
    const splitBeat = Number.isFinite(editCursorBeat) && (editCursorBeat ?? -1) >= 0
        ? (editCursorBeat as number)
        : frameToBeat(playheadFrames, bpm, sampleRate);
    return Math.max(0, beatToFrame(splitBeat, bpm, sampleRate));
}

