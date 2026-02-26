import type { BrowserDragItem } from '@/shared/lib/arrangementTypes';

export type TimelineCommand =
    | { type: 'seek'; beat: number }
    | { type: 'edit-cursor'; beat: number; trackIndex: number }
    | { type: 'clip-select'; clipId: string; isShift: boolean; isCtrl: boolean }
    | { type: 'clip-selection'; clipIds: string[] }
    | { type: 'clip-move'; clipId: string; beat: number; trackIndex: number }
    | { type: 'clip-resize'; clipId: string; startBeat: number; duration: number; allowStretch: boolean }
    | { type: 'track-dblclick'; trackIndex: number; beat: number }
    | { type: 'clip-dblclick'; clipId: string; trackIndex: number }
    | { type: 'marquee-start' }
    | { type: 'marquee-change'; marquee: { startBeat: number; endBeat: number; startTrack: number; endTrack: number } | null }
    | { type: 'track-select'; trackIndex: number }
    | { type: 'drop'; item: BrowserDragItem; trackIndex: number; beat: number }
    | { type: 'scroll-top'; value: number };

type Listener = (command: TimelineCommand) => void;

export class TimelineCommandBus {
    private readonly listeners = new Set<Listener>();

    emit(command: TimelineCommand): void {
        this.listeners.forEach((l) => {
            try {
                l(command);
            } catch (err) {
                console.error('[TimelineCommandBus] Listener error:', err);
            }
        });
    }

    subscribe(listener: Listener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
}
