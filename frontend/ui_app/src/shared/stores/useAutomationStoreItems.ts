import { clamp01 } from '@/shared/lib/audioMath';

type CurveType = 'linear' | 'bezier' | 'step';

interface AutomationBreakpointLike {
    id: string;
    beat: number;
    value: number;
    curve: CurveType;
    tension?: number;
    itemId?: string;
}

export interface AutomationLaneLike {
    id: string;
    trackId: string;
    breakpoints: AutomationBreakpointLike[];
}

interface AutomationStateLike<TLane extends AutomationLaneLike = AutomationLaneLike> {
    lanes: Record<string, TLane>;
}

const genBpId = () => `bp_${crypto.randomUUID().slice(0, 8)}`;
const genItemId = () => `item_${crypto.randomUUID().slice(0, 8)}`;

export function createAutomationItemMutation(
    lane: AutomationLaneLike,
    startBeat: number,
    lengthBeats: number,
    options?: { midOffset?: number; minLength?: number },
): { itemId: string; breakpoints: AutomationBreakpointLike[] } {
    const minLength = options?.minLength ?? 0.25;
    const midOffset = options?.midOffset ?? 0.2;
    const safeLength = Math.max(minLength, lengthBeats);
    const itemId = genItemId();
    const localBps = [...lane.breakpoints].sort((a, b) => a.beat - b.beat);
    let candidate = 0.5;
    for (const bp of localBps) {
        if (bp.beat <= startBeat + 1e-9) candidate = bp.value;
        else break;
    }
    const baseValue = clamp01(candidate);
    const midValue = clamp01(baseValue + midOffset);
    const nextBps = [
        ...localBps,
        { id: genBpId(), beat: startBeat, value: baseValue, curve: 'linear' as const, itemId },
        { id: genBpId(), beat: startBeat + safeLength * 0.5, value: midValue, curve: 'linear' as const, itemId },
        { id: genBpId(), beat: startBeat + safeLength, value: baseValue, curve: 'linear' as const, itemId },
    ].sort((a, b) => a.beat - b.beat);
    return { itemId, breakpoints: nextBps };
}

export function deleteNearestAutomationItemMutation(
    lane: AutomationLaneLike,
    anchorBeat: number,
): { changed: boolean; breakpoints: AutomationBreakpointLike[] } {
    if (lane.breakpoints.length === 0) return { changed: false, breakpoints: lane.breakpoints };
    const sorted = [...lane.breakpoints].sort((a, b) => a.beat - b.beat);
    let nearest = sorted[0];
    let minDistance = Math.abs(sorted[0].beat - anchorBeat);
    for (const bp of sorted) {
        const distance = Math.abs(bp.beat - anchorBeat);
        if (distance < minDistance) {
            minDistance = distance;
            nearest = bp;
        }
    }
    const nextBps = nearest.itemId
        ? sorted.filter((bp) => bp.itemId !== nearest.itemId)
        : sorted.filter((bp) => bp.id !== nearest.id);
    return { changed: true, breakpoints: nextBps };
}

export function moveAutomationItemMutation(
    lane: AutomationLaneLike,
    itemId: string,
    newStartBeat: number,
): { changed: boolean; breakpoints: AutomationBreakpointLike[] } {
    if (lane.breakpoints.length === 0) return { changed: false, breakpoints: lane.breakpoints };
    const itemBps = lane.breakpoints.filter((bp) => bp.itemId === itemId);
    if (itemBps.length === 0) return { changed: false, breakpoints: lane.breakpoints };
    const oldStart = Math.min(...itemBps.map((bp) => bp.beat));
    const delta = Math.max(0, newStartBeat) - oldStart;
    const moved = lane.breakpoints
        .map((bp) => (bp.itemId === itemId ? { ...bp, beat: Math.max(0, bp.beat + delta) } : bp))
        .sort((a, b) => a.beat - b.beat);
    return { changed: true, breakpoints: moved };
}

export function stretchAutomationItemMutation(
    lane: AutomationLaneLike,
    itemId: string,
    newLengthBeats: number,
): { changed: boolean; breakpoints: AutomationBreakpointLike[] } {
    if (lane.breakpoints.length === 0) return { changed: false, breakpoints: lane.breakpoints };
    const itemBps = lane.breakpoints.filter((bp) => bp.itemId === itemId);
    if (itemBps.length < 2) return { changed: false, breakpoints: lane.breakpoints };
    const oldStart = Math.min(...itemBps.map((bp) => bp.beat));
    const oldEnd = Math.max(...itemBps.map((bp) => bp.beat));
    const oldLength = Math.max(0.0001, oldEnd - oldStart);
    const nextLength = Math.max(0.125, newLengthBeats);
    const ratio = nextLength / oldLength;
    const stretched = lane.breakpoints
        .map((bp) => {
            if (bp.itemId !== itemId) return bp;
            const rel = bp.beat - oldStart;
            return { ...bp, beat: Math.max(0, oldStart + rel * ratio) };
        })
        .sort((a, b) => a.beat - b.beat);
    return { changed: true, breakpoints: stretched };
}

export function lanesForTrack<TLane extends AutomationLaneLike>(
    state: AutomationStateLike<TLane>,
    trackId: string,
): TLane[] {
    return Object.values(state.lanes).filter((lane) => lane.trackId === trackId);
}
