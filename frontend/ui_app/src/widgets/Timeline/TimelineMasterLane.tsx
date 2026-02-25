import { TimelineRegionOverlay } from './TimelineRegionOverlay';

type TimelineRegion = { startBeat: number; endBeat: number } | null;

interface TimelineMasterLaneProps {
    masterLaneRef: React.RefObject<HTMLDivElement | null>;
    trackHeight: number;
    masterLaneGridStyle: React.CSSProperties;
    masterGridViewportWidth: number;
    masterLaneGridLines: {
        subLines: number[];
        barLines: number[];
    };
    loopVisible: boolean;
    loopLeftX: number;
    loopRightX: number;
    loopStartLineX: number;
    loopEndLineX: number;
    playheadVisible: boolean;
    playheadLineX: number;
    regionEdit: {
        trackHeight: number;
        regionA: TimelineRegion;
        regionB: TimelineRegion;
        regionALineX: number | null;
        regionBLineX: number | null;
        regionAEndLineX: number | null;
        regionBEndLineX: number | null;
        regionALengthBeats: number;
        regionBLengthBeats: number;
        regionsSwapCompatible: boolean;
        beginRegionDrag: (which: 'A' | 'B', mode: 'move' | 'resize-start' | 'resize-end', e: React.MouseEvent) => void;
        setRegionFromMarquee: (which: 'A' | 'B') => void;
        runDuplicateRegion: () => Promise<void>;
        runMoveRegion: (direction: -1 | 1) => Promise<void>;
        runSwapRegions: () => Promise<void>;
        clearRegions: () => void;
    };
}

export function TimelineMasterLane({
    masterLaneRef,
    trackHeight,
    masterLaneGridStyle,
    masterGridViewportWidth,
    masterLaneGridLines,
    loopVisible,
    loopLeftX,
    loopRightX,
    loopStartLineX,
    loopEndLineX,
    playheadVisible,
    playheadLineX,
    regionEdit,
}: TimelineMasterLaneProps) {
    const lineLeft = (x: number, width: number): number => x - width / 2;
    return (
        <div
            ref={masterLaneRef}
            data-testid="timeline-master-lane"
            className="timeline-layer-overlays"
            style={{
                height: trackHeight,
                flexShrink: 0,
                borderTop: 'none',
                boxShadow: 'inset 0 var(--space-px) 0 var(--color-border-subtle)',
                ...masterLaneGridStyle,
                pointerEvents: 'none',
                position: 'relative',
                zIndex: 'var(--z-timeline-overlays)' as unknown as number,
            }}
        >
            {masterLaneGridLines.subLines.map((x) => (
                <div
                    key={`master-sub-${x}`}
                    style={{
                        position: 'absolute',
                        left: lineLeft(x, 1),
                        top: 0,
                        bottom: 0,
                        width: 1,
                        background: 'var(--color-timeline-grid-line)',
                        opacity: 0.42,
                        pointerEvents: 'none',
                    }}
                />
            ))}
            {masterLaneGridLines.barLines.map((x) => (
                <div
                    key={`master-bar-${x}`}
                    style={{
                        position: 'absolute',
                        left: lineLeft(x, 1),
                        top: 0,
                        bottom: 0,
                        width: 1,
                        background: 'var(--color-timeline-grid-bar)',
                        opacity: 0.95,
                        pointerEvents: 'none',
                    }}
                />
            ))}
            {loopVisible && (
                <>
                    <div
                        style={{
                            position: 'absolute',
                            top: 0,
                            bottom: 0,
                            left: Math.max(0, loopLeftX),
                            width: Math.max(0, Math.min(masterGridViewportWidth, loopRightX) - Math.max(0, loopLeftX)),
                            background: 'var(--color-timeline-loop-fill)',
                        }}
                    />
                    <div
                        style={{
                            position: 'absolute',
                            top: 0,
                            bottom: 0,
                            left: lineLeft(loopStartLineX, 1),
                            width: 1,
                            background: 'var(--color-timeline-loop-border)',
                            opacity: 0.9,
                        }}
                    />
                    <div
                        style={{
                            position: 'absolute',
                            top: 0,
                            bottom: 0,
                            left: lineLeft(loopEndLineX, 1),
                            width: 1,
                            background: 'var(--color-timeline-loop-border)',
                            opacity: 0.9,
                        }}
                    />
                </>
            )}
            {playheadVisible && (
                <>
                    <div
                        style={{
                            position: 'absolute',
                            top: 0,
                            bottom: 0,
                            left: lineLeft(playheadLineX, 3),
                            width: 3,
                            background: 'var(--color-timeline-playhead-glow)',
                            pointerEvents: 'none',
                        }}
                    />
                    <div
                        style={{
                            position: 'absolute',
                            top: 0,
                            bottom: 0,
                            left: lineLeft(playheadLineX, 1),
                            width: 1,
                            background: 'var(--color-timeline-playhead)',
                            pointerEvents: 'none',
                        }}
                    />
                </>
            )}
            <TimelineRegionOverlay
                trackHeight={regionEdit.trackHeight}
                regionA={regionEdit.regionA}
                regionB={regionEdit.regionB}
                regionALineX={regionEdit.regionALineX}
                regionBLineX={regionEdit.regionBLineX}
                regionAEndLineX={regionEdit.regionAEndLineX}
                regionBEndLineX={regionEdit.regionBEndLineX}
                regionALengthBeats={regionEdit.regionALengthBeats}
                regionBLengthBeats={regionEdit.regionBLengthBeats}
                regionsSwapCompatible={regionEdit.regionsSwapCompatible}
                beginRegionDrag={regionEdit.beginRegionDrag}
                setRegionFromMarquee={regionEdit.setRegionFromMarquee}
                runDuplicateRegion={regionEdit.runDuplicateRegion}
                runMoveRegion={regionEdit.runMoveRegion}
                runSwapRegions={regionEdit.runSwapRegions}
                clearRegions={regionEdit.clearRegions}
            />
        </div>
    );
}
