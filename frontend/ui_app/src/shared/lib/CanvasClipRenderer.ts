import type { ViewportMatrix, VisibleRange } from './ViewportMatrix';
import type { WaveformCache } from './WaveformCache';
import { getContrastColor, parseColorToRgb } from './colorUtils';
import { clampMidiPitch, DEFAULT_BPM } from './audioMath';
import type { GhostClipData, LoopRegion, TimelineClipData, TimelineTheme } from './CanvasClipRenderer.types';
import { useSettingsStore } from '@/shared/stores/useSettingsStore';
import {
    applyAlphaMultiplier,
    CLIP_LABEL_FONT,
    CLIP_RADIUS,
    DROP_TARGET_BORDER,
    DROP_TARGET_COLOR,
    FADE_GRAB_RADIUS,
    GHOST_CLIP_ALPHA,
    HEADER_HEIGHT,
    hex,
    OFFLINE_STRIPE_COLOR,
    rgba,

    SELECTION_GLOW_COLOR,
} from './CanvasClipRenderer.constants';

export type { GhostClipData, LoopRegion, TimelineClipData } from './CanvasClipRenderer.types';

function snapPhysical(value: number): number {
    const dpr = window.devicePixelRatio || 1;
    return Math.round(value * dpr) / dpr;
}

export class CanvasClipRenderer {
    private readonly _waveformCache: WaveformCache;
    private _bpm = DEFAULT_BPM;

    private _theme: TimelineTheme | null = null;
    private _lastThemeSync = 0;
    private _waveformStyle: 'default' | 'classic' = 'default';

    // (removed: _editCursorPlacedMs / _prevEditCursorBeat — replaced by quantized blink P4)

    /** Reusable buffer for visible-clip filtering (avoids per-frame allocation). */
    private _filteredClips: TimelineClipData[] = [];
    /** PERF #4: Tracked flag — avoids O(N) clips.some(c => c.selected) scan per frame. */
    private _hasClipSelection = false;
    /** PERF #5: Contrast color cache — avoids parseColorToRgb + luminance calc per clip per frame. */
    private static _contrastColorCache = new Map<string, 'black' | 'white'>();
    /** PERF #8: Text width cache — avoids ctx.measureText() binary search per clip per frame. */
    private static _textWidthCache = new Map<string, number>();
    /** PERF #2: Reusable Float32Arrays for waveform blending (avoids per-frame allocation). */
    private _blendMins: Float32Array | null = null;
    private _blendMaxs: Float32Array | null = null;

    /** PERF #6: Pre-computed rgba/rgb color strings per hex color. */
    private static _clipColorStringCache = new Map<string, {
        header: string; divider: string; body: string;
        headerBorder: string; bodyBorder: string; bodyDisabled: string; headerDisabled: string;
    }>();

    /** PERF #6: Get pre-computed color strings for a clip color. */
    private _getClipColorStrings(hexColor: string) {
        const cached = CanvasClipRenderer._clipColorStringCache.get(hexColor);
        if (cached) return cached;
        const rgb = this._parseColor(hexColor);
        const r = rgb.r, g = rgb.g, b = rgb.b;
        const dR = Math.max(0, Math.round(r * 0.5)), dG = Math.max(0, Math.round(g * 0.5)), dB = Math.max(0, Math.round(b * 0.5));
        const bR = Math.max(0, Math.round(r * 0.60)), bG = Math.max(0, Math.round(g * 0.60)), bB = Math.max(0, Math.round(b * 0.60));
        const result = {
            header: `rgba(${r},${g},${b},0.95)`,
            divider: `rgba(${dR},${dG},${dB},0.8)`,
            body: `rgba(${bR},${bG},${bB},0.85)`,
            headerBorder: `rgb(${r},${g},${b})`,
            bodyBorder: `rgb(${bR},${bG},${bB})`,
            bodyDisabled: `rgba(${bR},${bG},${bB},0.85)`,
            headerDisabled: `rgba(${r},${g},${b},0.95)`,
        };
        CanvasClipRenderer._clipColorStringCache.set(hexColor, result);
        return result;
    }

    /** Group track metadata: maps group track index → child track indices */
    private _groupTracks: Map<number, number[]> = new Map();
    /** All track colors by index (for miniature rendering). */
    private _trackColors: Map<number, string> = new Map();
    /** PERF: Set of all child track indices across all groups — for O(1) membership check. */
    private _groupChildSet: Set<number> = new Set();



    constructor(waveformCache: WaveformCache) {
        this._waveformCache = waveformCache;
    }

    /** PERF #4: Update tracked selection flag (called from TimelineEngine.setClipSelection). */
    setHasClipSelection(has: boolean): void {
        this._hasClipSelection = has;
    }

    private _truncateTextToWidth(
        ctx: CanvasRenderingContext2D,
        text: string,
        maxWidth: number,
    ): string {
        if (!text || maxWidth <= 0) return '';
        // PERF #8: Cache measured text widths to avoid ctx.measureText() per clip per frame.
        const fullW = this._measureTextCached(ctx, text);
        if (fullW <= maxWidth) return text;

        const ellipsis = '...';
        const ellipsisW = this._measureTextCached(ctx, ellipsis);
        if (ellipsisW >= maxWidth) return '';

        let lo = 0;
        let hi = text.length;
        while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            const candidate = `${text.slice(0, mid)}${ellipsis}`;
            if (this._measureTextCached(ctx, candidate) <= maxWidth) {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        return lo > 0 ? `${text.slice(0, lo)}${ellipsis}` : '';
    }

    /** PERF #8: Cached text measurement — avoids repeated ctx.measureText() for same strings. */
    private _measureTextCached(ctx: CanvasRenderingContext2D, text: string): number {
        const cached = CanvasClipRenderer._textWidthCache.get(text);
        if (cached !== undefined) return cached;
        const w = ctx.measureText(text).width;
        CanvasClipRenderer._textWidthCache.set(text, w);
        // Prevent unbounded cache growth
        if (CanvasClipRenderer._textWidthCache.size > 2000) {
            CanvasClipRenderer._textWidthCache.clear();
        }
        return w;
    }

    /** PERF #5: Cached contrast color — avoids hex parse + luminance per clip per frame. */
    private _getContrastColorCached(hexColor: string): 'black' | 'white' {
        const cached = CanvasClipRenderer._contrastColorCache.get(hexColor);
        if (cached !== undefined) return cached;
        const result = getContrastColor(hexColor);
        CanvasClipRenderer._contrastColorCache.set(hexColor, result);
        return result;
    }

    private _syncTheme(): void {
        const now = performance.now();
        if (this._theme && now - this._lastThemeSync < 1000) return; // Sync once per second max

        const s = getComputedStyle(document.documentElement);
        const gridIntensityRaw = Number.parseFloat(s.getPropertyValue('--timeline-grid-intensity') || '100');
        const gridIntensity = Number.isFinite(gridIntensityRaw) ? Math.max(20, Math.min(250, gridIntensityRaw)) : 100;
        const gridAlphaMultiplier = gridIntensity / 100;
        const rawGridLine = s.getPropertyValue('--color-timeline-grid-line').trim() || rgba(255, 255, 255, 0.06);
        const rawGridBar = s.getPropertyValue('--color-timeline-grid-bar').trim() || rgba(74, 158, 255, 0.18);
        this._theme = {
            bg: s.getPropertyValue('--color-timeline-bg').trim() || hex(13, 13, 26),
            rulerBg: s.getPropertyValue('--color-timeline-ruler-bg').trim() || hex(18, 18, 30),
            gridLine: applyAlphaMultiplier(rawGridLine, gridAlphaMultiplier),
            gridBar: applyAlphaMultiplier(rawGridBar, gridAlphaMultiplier),
            trackDefault: s.getPropertyValue('--color-timeline-track-default').trim() || hex(25, 25, 25),
            trackSelected: s.getPropertyValue('--color-timeline-track-selected').trim() || hex(38, 38, 38),
            playhead: s.getPropertyValue('--color-timeline-playhead').trim() || hex(255, 59, 48),
            playheadGlow: s.getPropertyValue('--color-timeline-playhead-glow').trim() || rgba(255, 59, 48, 0.4),
            editCursor: s.getPropertyValue('--color-timeline-edit-cursor').trim() || rgba(255, 255, 255, 0.75),
            loopFill: s.getPropertyValue('--color-timeline-loop-fill').trim() || rgba(74, 158, 255, 0.08),
            loopBorder: s.getPropertyValue('--color-timeline-loop-border').trim() || rgba(74, 158, 255, 0.5),
            rulerText: s.getPropertyValue('--color-timeline-ruler-text').trim() || rgba(255, 255, 255, 0.5),
            trackDivider: s.getPropertyValue('--color-border-subtle').trim() || rgba(255, 255, 255, 0.08),
        };
        // BUG-061 FIX: Cache waveformStyle here (max 1x/sec) instead of per-clip in _drawWaveform
        this._waveformStyle = useSettingsStore.getState().settings.waveformStyle as 'default' | 'classic';
        this._lastThemeSync = now;
    }

    drawFrame(
        ctx: CanvasRenderingContext2D,
        vp: ViewportMatrix,
        clips: TimelineClipData[],
        playheadBeat: number,
        editCursorBeat: number,
        editCursorTrackStart: number,
        editCursorTrackEnd: number,
        selectedTrack: number,
        selectedTracks: number[],
        loop: LoopRegion | null,
        beatsPerBar: number,
        snapBeats: number,
        marquee: { startBeat: number; endBeat: number; startTrack: number; endTrack: number } | null,
        ghost: GhostClipData | null,
        dropTarget: { track: number; beat: number } | null,
        sampleRate: number,
        bpm: number,
        automationVisible: boolean,
    ): void {
        this._syncTheme();
        const theme = this._theme!;

        this._bpm = bpm;
        const w = vp.viewportWidth;
        const h = vp.viewportHeight;
        if (w <= 0 || h <= 0) return;

        const dpr = window.devicePixelRatio || 1;

        ctx.clearRect(0, 0, w * dpr, h * dpr);

        ctx.save();
        ctx.scale(dpr, dpr);

        ctx.fillStyle = theme.bg;
        ctx.fillRect(0, 0, w, h);

        const range = vp.getVisibleRange();

        ctx.save();
        ctx.beginPath();
        ctx.rect(0, vp.rulerHeight, w, h - vp.rulerHeight);
        ctx.clip();

        this._drawTrackBackgrounds(ctx, vp, theme, selectedTrack, selectedTracks);
        this._drawGrid(ctx, vp, range, beatsPerBar, snapBeats, theme);
        this._drawLoopRegion(ctx, vp, loop, theme);
        this._drawClips(ctx, vp, clips, range, sampleRate, automationVisible);
        this._drawGroupMiniatures(ctx, vp, clips, range);
        this._drawMarquee(ctx, vp, marquee);
        this._drawDropTarget(ctx, vp, dropTarget);
        this._drawGhostClip(ctx, vp, ghost);
        this._drawPlayhead(ctx, vp, playheadBeat, h, theme);

        // FIX-3: Hide edit cursor when marquee is active OR clips are selected.
        // PERF #4: Use pre-tracked flag instead of O(N) clips.some() scan per frame.
        const hasClipSelection = this._hasClipSelection;
        if (!hasClipSelection && !marquee) {
            this._drawEditCursor(ctx, vp, editCursorBeat, editCursorTrackStart, editCursorTrackEnd);
        }

        ctx.restore();

        this._drawRuler(ctx, vp, range, beatsPerBar, playheadBeat, editCursorBeat, loop, theme, hasClipSelection);

        ctx.restore(); // ← Pop DPR scale (matches ctx.save() above)
    }

    private _drawTrackBackgrounds(
        ctx: CanvasRenderingContext2D,
        vp: ViewportMatrix,
        theme: TimelineTheme,
        selectedTrack: number,
        selectedTracks: number[],
    ): void {
        const rulerH = vp.rulerHeight;

        ctx.fillStyle = theme.trackDefault;
        ctx.fillRect(0, rulerH, vp.viewportWidth, vp.viewportHeight - rulerH);

        const list = (selectedTracks && selectedTracks.length > 0) ? selectedTracks : (selectedTrack >= 0 ? [selectedTrack] : []);
        for (const t of list) {
            if (t < 0) continue;
            const y = rulerH + vp.trackOffsetY(t) - vp.scrollY;
            const h = vp.trackHeightAt(t);
            if (y + h < rulerH || y > vp.viewportHeight) continue;
            const clippedTop = Math.max(rulerH, y);
            const clippedBottom = Math.min(vp.viewportHeight, y + h);
            const clippedH = clippedBottom - clippedTop;
            if (clippedH <= 0) continue;
            ctx.save();
            ctx.globalAlpha = (t === selectedTrack) ? 1.0 : 0.55;
            ctx.fillStyle = theme.trackSelected;
            ctx.fillRect(0, clippedTop, vp.viewportWidth, clippedH);
            ctx.restore();
        }
    }

    private _drawGrid(
        ctx: CanvasRenderingContext2D,
        vp: ViewportMatrix,
        range: VisibleRange,
        beatsPerBar: number,
        snapBeats: number,
        theme: TimelineTheme,
    ): void {
        ctx.save();
        const ppb = vp.pixelsPerBeat;
        const rulerH = vp.rulerHeight;
        const vpW = vp.viewportWidth;
        const vpH = vp.viewportHeight;

        let gridStep = snapBeats;
        if (gridStep <= 0) {
            if (ppb < 8) gridStep = beatsPerBar * 4;
            else if (ppb < 15) gridStep = beatsPerBar;
            else if (ppb < 40) gridStep = beatsPerBar;
            else if (ppb < 80) gridStep = 1;
            else gridStep = 0.5;
        }

        // ═══════════════════════════════════════════════════════════════════
        // ENTERPRISE: Pixel-spacing–based adaptive grid density.
        //
        // Standard DAW approach (Ableton, Logic, FL Studio): coarsen the
        // grid step until lines are at least MIN_GRID_PX apart. Sub-pixel
        // lines are invisible and waste CPU. At 1/128 grid fully zoomed
        // out, this reduces line count from millions to a few hundred.
        //
        // The grid step always doubles (power-of-2), preserving musical
        // alignment: 1/128 → 1/64 → 1/32 → 1/16 → 1/8 → 1/4 → 1/2 → 1.
        // ═══════════════════════════════════════════════════════════════════
        const MIN_GRID_PX = 3; // Minimum pixel spacing between grid lines
        while (gridStep > 0 && (gridStep * ppb) < MIN_GRID_PX) {
            gridStep *= 2;
        }

        const startBeat = Math.floor(range.startBeat / gridStep) * gridStep;
        const endBeat = Math.ceil(range.endBeat / gridStep) * gridStep;

        // ── BUG-034 FIX: Single pass for both subdivisions and bar lines ──
        const gridLineColor = theme.gridLine;
        const gridBarColor = theme.gridBar;
        ctx.beginPath();
        const subPath = new Path2D();
        const barPath = new Path2D();
        for (let beat = startBeat; beat <= endBeat; beat += gridStep) {
            const barPhase = beat / beatsPerBar;
            const isBar = Math.abs(barPhase - Math.round(barPhase)) < 1e-6;
            const x = snapPhysical(beat * ppb - vp.scrollX);
            if (x < -1 || x > vpW + 1) continue;
            if (isBar) {
                barPath.rect(x, rulerH, 1, vpH - rulerH);
            } else {
                subPath.rect(x, rulerH, 1, vpH - rulerH);
            }
        }
        ctx.fillStyle = gridLineColor;
        ctx.fill(subPath);
        ctx.fillStyle = gridBarColor;
        ctx.fill(barPath);

        // ── P2: Batch track dividers into one path ──
        ctx.fillStyle = theme.trackDivider;
        ctx.beginPath();
        for (let i = 0; i <= vp.trackCount; i++) {
            const y = snapPhysical(rulerH + vp.trackBoundaryOffsetY(i) - vp.scrollY);
            if (y < rulerH - 1 || y > vpH + 1) continue;
            ctx.rect(0, y, vpW, 1);
        }
        ctx.fill();

        ctx.restore();
    }

    private _drawRuler(
        ctx: CanvasRenderingContext2D,
        vp: ViewportMatrix,
        range: VisibleRange,
        beatsPerBar: number,
        playheadBeat: number,
        editCursorBeat: number,
        loop: LoopRegion | null,
        theme: TimelineTheme,
        hasClipSelection: boolean,
    ): void {
        ctx.save();
        const rulerH = vp.rulerHeight;

        ctx.fillStyle = theme.rulerBg;
        ctx.fillRect(0, 0, vp.viewportWidth, rulerH);

        ctx.fillStyle = theme.trackDivider;
        ctx.fillRect(0, rulerH, vp.viewportWidth, 1);

        let markStep = beatsPerBar;
        if (vp.pixelsPerBeat < 12) markStep = beatsPerBar * 4;
        else if (vp.pixelsPerBeat >= 120) markStep = 0.5;
        else if (vp.pixelsPerBeat >= 40) markStep = 1;

        ctx.font = '10px Inter, -apple-system, sans-serif';
        ctx.fillStyle = theme.rulerText;
        ctx.textBaseline = 'top';
        ctx.textAlign = 'center';

        const startMark = Math.floor(range.startBeat / markStep) * markStep;
        const endMark = Math.ceil(range.endBeat / markStep) * markStep;

        for (let beat = startMark; beat <= endMark; beat += markStep) {
            const x = vp.beatsToScreenX(beat);
            if (x < -50 || x > vp.viewportWidth + 10) continue;

            const roundedX = snapPhysical(x);
            const remainder = beat % beatsPerBar;
            const isBarMark = Math.abs(remainder) < 1e-6;
            const isWholeBeat = Math.abs(remainder - Math.round(remainder)) < 1e-6;

            const barNumber = Math.floor(beat / beatsPerBar) + 1;
            const beatWithinBar = Math.floor(remainder) + 1;

            let label = '';
            let lineH = 8;
            if (isBarMark) {
                label = String(barNumber);
                ctx.fillStyle = theme.rulerText;
                lineH = 10;
            } else if (isWholeBeat) {
                label = `${barNumber}.${beatWithinBar}`;
                ctx.fillStyle = applyAlphaMultiplier(theme.rulerText, 0.7);
                lineH = 6;
            } else {
                // Ableton-style: compute actual tick number within the beat
                const fractionalBeat = beat - Math.floor(beat);
                const ticksPerBeat = Math.round(1 / markStep);
                const tickNumber = Math.round(fractionalBeat * ticksPerBeat) + 1;
                label = `${barNumber}.${beatWithinBar}.${tickNumber}`;
                ctx.fillStyle = applyAlphaMultiplier(theme.rulerText, 0.5);
                lineH = 4;
            }

            // Only draw text if it's a bar or if we have enough space
            const showText = isBarMark || (isWholeBeat && vp.pixelsPerBeat >= 40) || (!isWholeBeat && vp.pixelsPerBeat >= 120);
            if (showText) {
                ctx.fillText(label, roundedX, 2);
            }

            ctx.fillRect(roundedX, rulerH - lineH, 1, lineH);
        }

        const phX = snapPhysical(vp.beatsToScreenX(playheadBeat));
        if (phX >= -5 && phX <= vp.viewportWidth + 5) {
            ctx.fillStyle = theme.playhead;
            ctx.beginPath();
            ctx.moveTo(phX, rulerH);
            ctx.lineTo(phX - 5, rulerH - 8);
            ctx.lineTo(phX + 5, rulerH - 8);
            ctx.closePath();
            ctx.fill();
        }

        // PERF FIX: hasClipSelection is now pre-computed in drawFrame (avoids second O(N) scan).
        if (!hasClipSelection) {
            const ecX = snapPhysical(vp.beatsToScreenX(editCursorBeat));
            if (ecX >= -5 && ecX <= vp.viewportWidth + 5) {
                ctx.fillStyle = theme.editCursor;
                ctx.beginPath();
                ctx.moveTo(ecX, rulerH);
                ctx.lineTo(ecX - 5, rulerH - 6);
                ctx.lineTo(ecX + 5, rulerH - 6);
                ctx.closePath();
                ctx.fill();
            }
        }

        if (loop) {
            const lStart = snapPhysical(vp.beatsToScreenX(loop.start));
            const lEnd = snapPhysical(vp.beatsToScreenX(loop.end));

            ctx.fillStyle = theme.loopBorder;

            if (lStart >= -10 && lStart <= vp.viewportWidth + 10) {
                ctx.save();
                ctx.beginPath();
                ctx.moveTo(lStart, 0);
                ctx.lineTo(lStart + 8, 0);
                ctx.lineTo(lStart + 8, 8);
                ctx.lineTo(lStart, 16);
                ctx.closePath();
                ctx.fill();

                if (loop.enabled) {
                    ctx.fillStyle = theme.loopBorder;
                    ctx.fillRect(lStart, 0, 1, rulerH);
                }
                ctx.restore();
            }

            if (lEnd >= -10 && lEnd <= vp.viewportWidth + 10) {
                ctx.save();
                ctx.beginPath();
                ctx.moveTo(lEnd, 0);
                ctx.lineTo(lEnd - 8, 0);
                ctx.lineTo(lEnd - 8, 8);
                ctx.lineTo(lEnd, 16);
                ctx.closePath();
                ctx.fill();

                if (loop.enabled) {
                    ctx.fillStyle = theme.loopBorder;
                    ctx.fillRect(lEnd, 0, 1, rulerH);
                }
                ctx.restore();
            }
        }
        ctx.restore();
    }

    private _drawClips(
        ctx: CanvasRenderingContext2D,
        vp: ViewportMatrix,
        clips: TimelineClipData[],
        range: VisibleRange,
        sampleRate: number,
        automationVisible: boolean,
    ): void {
        const bufferBeats = 2;
        // ── P5: Reuse pre-allocated buffer instead of filter() ──
        const filtered = this._filteredClips;
        filtered.length = 0;
        let hasAnySelected = false;
        for (let i = 0, len = clips.length; i < len; i++) {
            const c = clips[i];
            const endBeat = c.startBeat + c.durationBeats;
            if (endBeat < range.startBeat - bufferBeats) continue;
            if (c.startBeat > range.endBeat + bufferBeats) continue;
            if (c.trackIndex < range.startTrack - 1) continue;
            if (c.trackIndex > range.endTrack + 1) continue;
            filtered.push(c);
            if (c.selected || c.primarySelected) hasAnySelected = true;
        }

        // BUG-N05 FIX: Skip O(N·logN) sort when no clips have selection priority
        // (common case during playback). Selection changes are infrequent.
        if (hasAnySelected) {
            filtered.sort((a, b) => {
                const aPriority = a.primarySelected ? 2 : (a.selected ? 1 : 0);
                const bPriority = b.primarySelected ? 2 : (b.selected ? 1 : 0);
                return aPriority - bPriority;
            });
        }

        for (const clip of filtered) {
            this._drawSingleClip(ctx, vp, clip, sampleRate, automationVisible);
        }
    }

    private _drawSingleClip(
        ctx: CanvasRenderingContext2D,
        vp: ViewportMatrix,
        clip: TimelineClipData,
        sampleRate: number,
        automationVisible: boolean,
    ): void {
        const ppb = vp.pixelsPerBeat;
        const trackH = vp.trackHeightAt(clip.trackIndex);

        // ── 1px inset so clip doesn't overlap grid lines or track borders ──
        // The user specifically requested clips to sit exactly *between* grid lines.
        // If grid lines are 1px on whole pixels, clips should occupy exact bounds without arbitrary insets.
        const inset = 0;
        const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
        const px = 1 / dpr; // 1 physical device pixel

        const rawX = snapPhysical(clip.startBeat * ppb - vp.scrollX);
        const rawW = snapPhysical((clip.startBeat + clip.durationBeats) * ppb - vp.scrollX) - rawX;

        // Push left edge by 1 pixel to reveal the grid line underneath without overlapping the adjacent clip.
        const x = rawX + px;
        const w = Math.max(px * 2, rawW - px);

        const y = snapPhysical(vp.rulerHeight + vp.trackOffsetY(clip.trackIndex) - vp.scrollY) + inset;
        const h = trackH - (inset * 2);

        if (x + w < -10 || x > vp.viewportWidth + 10) return;
        if (y + h < vp.rulerHeight || y > vp.viewportHeight + 10) return;

        // ═══════════════════════════════════════════════════════════════════
        // ENTERPRISE PERF: Micro-clip fast path.
        //
        // At full zoom out (e.g. 1/128 grid), clips may be 1–3px wide.
        // The full rendering pipeline per clip involves: ctx.clip() (rasterizes
        // the clip path — the most expensive Canvas 2D op), roundRect path
        // construction, waveform/MIDI rendering, fade overlays, text layout,
        // and 2× border clip zones with separate save/restore/stroke sequences.
        //
        // For sub-4px clips, none of that detail is visible. Drawing a single
        // colored fillRect is visually indistinguishable and ~50× faster.
        // ═══════════════════════════════════════════════════════════════════
        if (w < 4) {
            const isTrackDisabled = clip.trackDisabled === true;
            const rgbBase = this._parseColor(clip.color);
            const rgb = clip.muted ? this._toMutedGray(rgbBase) : rgbBase;
            const alpha = isTrackDisabled ? 0.25 : (clip.muted ? 0.5 : 0.85);
            ctx.fillStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},${alpha})`;
            ctx.fillRect(x, y, Math.max(px, w), h);
            if (clip.selected) {
                ctx.strokeStyle = SELECTION_GLOW_COLOR;
                ctx.lineWidth = 1;
                ctx.strokeRect(x, y, Math.max(px, w), h);
            }
            return;
        }

        ctx.save();

        const isTrackDisabled = clip.trackDisabled === true;
        if (isTrackDisabled) {
            ctx.globalAlpha = 0.25;
        } else if (automationVisible) {
            // BUG-052 FIX: 0.35 was too dim — clips were unreadable.
            // 0.55 keeps automation visible while keeping clip content legible.
            ctx.globalAlpha = 0.55;
        }

        // Premium Ableton-style borders and colors
        // Rounding the radius so it does not result in float bounding boxes
        const r = Math.floor(Math.min(CLIP_RADIUS, w / 2, h / 2));
        ctx.beginPath();
        if (r > 0) {
            ctx.moveTo(x + r, y);
            ctx.lineTo(x + w - r, y);
            ctx.quadraticCurveTo(x + w, y, x + w, y + r);
            ctx.lineTo(x + w, y + h - r);
            ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
            ctx.lineTo(x + r, y + h);
            ctx.quadraticCurveTo(x, y + h, x, y + h - r);
            ctx.lineTo(x, y + r);
            ctx.quadraticCurveTo(x, y, x + r, y);
        } else {
            ctx.rect(x, y, w, h);
        }
        ctx.closePath();
        ctx.clip();

        const rgbBase = this._parseColor(clip.color);
        const rgb = clip.muted ? this._toMutedGray(rgbBase) : rgbBase;
        // PERF #6: Use pre-computed color strings (avoids per-frame rgba() string creation)
        const colorStrings = clip.muted ? null : this._getClipColorStrings(clip.color);

        const headerH = Math.min(HEADER_HEIGHT, h);
        const headerR = rgb.r, headerG = rgb.g, headerB = rgb.b;
        ctx.fillStyle = colorStrings ? colorStrings.header : `rgba(${headerR},${headerG},${headerB},0.95)`;
        ctx.fillRect(x, y, w, headerH);

        // Crisp 1px dark divider
        ctx.fillStyle = colorStrings ? colorStrings.divider : `rgba(${Math.max(0, Math.round(headerR * 0.5))},${Math.max(0, Math.round(headerG * 0.5))},${Math.max(0, Math.round(headerB * 0.5))},0.8)`;
        ctx.fillRect(x, y + headerH, w, 1);

        if (h > headerH + 1) {
            // Sleek darker body background
            ctx.fillStyle = colorStrings ? colorStrings.body : `rgba(${Math.max(0, Math.round(headerR * 0.60))},${Math.max(0, Math.round(headerG * 0.60))},${Math.max(0, Math.round(headerB * 0.60))},0.85)`;
            ctx.fillRect(x, y + 1 + headerH, w, h - headerH - 1);
        }

        if (clip.muted) {
            ctx.fillStyle = rgba(80, 85, 95, 0.45);
            ctx.fillRect(x, y, w, h);
        }

        if (clip.isOffline) {
            this._drawOfflineStripes(ctx, x, y, w, h);
        }

        const bodyY = y + headerH;
        const bodyH = Math.max(0, h - headerH);

        if (bodyH > 8) {
            if (clip.type === 'audio' && clip.durationSamples) {
                this._drawWaveform(ctx, vp, clip, bodyY, bodyH, sampleRate, clip.muted === true, x, w);
            } else if (clip.type === 'midi' && clip.midiNotes && clip.midiNotes.length > 0) {
                this._drawMidiNotes(ctx, vp, clip, bodyY, bodyH, clip.muted === true, x);
            }
        }

        const showFadeUi = Boolean(clip.hovered);

        // FADE-VIS FIX: Always draw fade overlay + curve when values > 0.
        // The handles and curve-point dots remain hover-only below (line ~662).
        if (clip.fadeIn && clip.fadeIn > 0) {
            this._drawFade(
                ctx,
                x,
                bodyY,
                w * clip.fadeIn,
                bodyH,
                'in',
                clip.fadeInCurve ?? 0.5,
                showFadeUi,
            );
        }
        if (clip.fadeOut && clip.fadeOut > 0) {
            this._drawFade(
                ctx,
                x + w - w * clip.fadeOut,
                bodyY,
                w * clip.fadeOut,
                bodyH,
                'out',
                clip.fadeOutCurve ?? 0.5,
                showFadeUi,
            );
        }

        const textPad = 3;
        const maxTextW = w - textPad * 2;
        if (maxTextW > 4 && headerH > 8) {
            const contrastColor = this._getContrastColorCached(clip.color);
            const isDisabledVisual = clip.muted || isTrackDisabled;
            ctx.font = CLIP_LABEL_FONT;
            const label = this._truncateTextToWidth(ctx, clip.name, maxTextW);
            if (label) {
                ctx.fillStyle = isDisabledVisual
                    ? rgba(210, 215, 223, 1)
                    : (contrastColor === 'black' ? rgba(0, 0, 0, 1) : rgba(255, 255, 255, 1));
                ctx.globalAlpha *= isDisabledVisual ? 0.95 : 0.9;
                ctx.textBaseline = 'middle';
                ctx.textAlign = 'left';
                const textX = x + textPad;
                const textY = y + headerH / 2;
                ctx.fillText(label, textX, textY);
            }
        }

        ctx.restore();

        // ── Dual-color 1px inset border via stroke() ──
        // PERF #3: Eliminated 2× extra ctx.clip() (the most expensive Canvas 2D op).
        // Previously: clip to header zone → stroke full roundRect, clip to body zone →
        // stroke full roundRect. Now: two simple rect strokes within the existing
        // main body clip from line 555. Reduces ctx.clip() from 3× to 1× per clip.
        {
            const bw = 1;
            const inset = bw / 2;
            const borderR = Math.max(0, r - inset);

            if (clip.selected && !isTrackDisabled) {
                // Single white stroke
                ctx.save();
                ctx.strokeStyle = SELECTION_GLOW_COLOR;
                ctx.lineWidth = bw;
                this._roundRect(ctx, x + inset, y + inset, w - bw, h - bw, borderR);
                ctx.stroke();
                ctx.restore();
            } else {
                // PERF #6: Use pre-computed color strings for borders
                const hdrColor = clip.muted
                    ? 'rgba(110, 115, 125, 0.8)'
                    : (isTrackDisabled ? (colorStrings ? colorStrings.headerDisabled : `rgba(${headerR},${headerG},${headerB},0.95)`)
                        : (colorStrings ? colorStrings.headerBorder : `rgb(${headerR},${headerG},${headerB})`));
                const bR = Math.max(0, Math.round(headerR * 0.60)), bG = Math.max(0, Math.round(headerG * 0.60)), bB = Math.max(0, Math.round(headerB * 0.60));
                const bdyColor = clip.muted
                    ? 'rgba(80, 85, 95, 0.8)'
                    : (isTrackDisabled ? (colorStrings ? colorStrings.bodyDisabled : `rgba(${bR},${bG},${bB},0.85)`)
                        : (colorStrings ? colorStrings.bodyBorder : `rgb(${bR},${bG},${bB})`));

                ctx.save();
                if (isTrackDisabled) ctx.globalAlpha = 0.25;
                ctx.lineWidth = bw;

                // Step 1: Full roundRect stroke with body color (no clip needed)
                ctx.strokeStyle = bdyColor;
                this._roundRect(ctx, x + inset, y + inset, w - bw, h - bw, borderR);
                ctx.stroke();

                // Step 2: Overdraw header portion with header color (1 clip — was 2)
                ctx.beginPath();
                ctx.rect(x - 1, y - 1, w + 2, headerH + 2);
                ctx.clip();
                ctx.strokeStyle = hdrColor;
                this._roundRect(ctx, x + inset, y + inset, w - bw, h - bw, borderR);
                ctx.stroke();

                ctx.restore();
            }
        }

        if (showFadeUi && w >= 14 && bodyH >= 10) {
            const handleY = bodyY + 6;
            const fadeInWidth = w * Math.max(0, Math.min(0.5, clip.fadeIn ?? 0));
            const fadeOutWidth = w * Math.max(0, Math.min(0.5, clip.fadeOut ?? 0));
            const leftX = x + Math.max(4, Math.min(w - 4, fadeInWidth));
            const rightX = x + w - Math.max(4, Math.min(w - 4, fadeOutWidth));

            ctx.save();
            if (isTrackDisabled) ctx.globalAlpha = 0.25;
            ctx.fillStyle = clip.selected ? rgba(255, 255, 255, 0.98) : rgba(238, 245, 255, 0.9);
            ctx.strokeStyle = rgba(0, 0, 0, 0.65);
            ctx.lineWidth = 1;

            ctx.beginPath();
            ctx.arc(leftX, handleY, FADE_GRAB_RADIUS, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(rightX, handleY, FADE_GRAB_RADIUS, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();

            const curveIn = Math.max(0.05, Math.min(0.95, clip.fadeInCurve ?? 0.5));
            const curveOut = Math.max(0.05, Math.min(0.95, clip.fadeOutCurve ?? 0.5));
            const bodyBottom = bodyY + bodyH - 2;

            if (clip.showFadeInCurvePoint && fadeInWidth > 0) {
                const pX = x + fadeInWidth * curveIn;
                const pY = bodyBottom - (bodyH * curveIn);
                ctx.beginPath();
                ctx.arc(pX, pY, 3.2, 0, Math.PI * 2);
                ctx.fillStyle = rgba(255, 196, 96, 0.98);
                ctx.fill();
                ctx.strokeStyle = rgba(0, 0, 0, 0.75);
                ctx.stroke();
            }

            if (clip.showFadeOutCurvePoint && fadeOutWidth > 0) {
                const pX = x + w - fadeOutWidth * curveOut;
                const pY = bodyY + bodyH * curveOut;
                ctx.beginPath();
                ctx.arc(pX, pY, 3.2, 0, Math.PI * 2);
                ctx.fillStyle = rgba(255, 196, 96, 0.98);
                ctx.fill();
                ctx.strokeStyle = rgba(0, 0, 0, 0.75);
                ctx.stroke();
            }
            ctx.restore();
        }
    }

    private _drawWaveform(
        ctx: CanvasRenderingContext2D,
        vp: ViewportMatrix,
        clip: TimelineClipData,
        bodyY: number,
        bodyH: number,
        sampleRate: number,
        muted: boolean,
        clipX: number,
        clipW: number,
    ): void {
        if (!clip.durationSamples) return;

        const ppb = vp.pixelsPerBeat;
        if (ppb <= 0) return;

        const samplesPerBeat = sampleRate * 60 / this._bpm;
        const samplesPerPixel = samplesPerBeat / ppb;

        // BUG-G01 FIX: For non-warped clips, if pitch is shifted,
        // durationSamples is in timeline-domain but the source file was read
        // at a different rate. Scale by pitchShift to get source-domain window.
        let sourceWindowSamples: number;
        if (clip.isWarped && (clip.warpSourceDurationFrames ?? 0) > 0) {
            sourceWindowSamples = clip.warpSourceDurationFrames as number;
        } else {
            const pitchSemitones = clip.pitchShiftSemitones ?? 0;
            const pitchMultiplier = Math.pow(2, pitchSemitones / 12);
            // Source samples consumed = timeline_samples * pitch_multiplier
            sourceWindowSamples = Math.round(clip.durationSamples * pitchMultiplier);
        }

        // ═══════════════════════════════════════════════════════════════════
        // ENTERPRISE: Ableton-style dual-mip blended waveform rendering.
        //
        // Instead of abruptly switching between mip levels (which causes
        // visible height pops), we fetch TWO adjacent levels and interpolate
        // min/max values between them using a logarithmic blend factor.
        //
        // This produces perfectly stable waveform height during zoom
        // transitions — identical to Ableton Live's rendering approach.
        // ═══════════════════════════════════════════════════════════════════
        // ENTERPRISE FIX: Ghost clips (Cmd+Drag) have IDs like `__ghost_<clipId>`.
        // The waveform cache is keyed by original clip ID. Resolve ghost prefix
        // so ghost clips render the source clip's waveform during drag.
        const waveformLookupId = clip.id.startsWith('__ghost_')
            ? clip.id.slice(8) // strip '__ghost_' prefix (8 chars)
            : clip.id;

        const blendedData = this._waveformCache.getBlendedDrawData(
            waveformLookupId,
            samplesPerPixel,
            clip.sourceOffset ?? 0,
            sourceWindowSamples,
        );

        if (!blendedData) return; // Still loading

        const { fine, coarse, blendFactor } = blendedData;
        const { mins: fineMins, maxs: fineMaxs } = fine;
        const peakCount = fineMins.length;
        if (peakCount === 0) return;

        // ── Blend peaks from two mip levels ──────────────────────────────
        // The fine level has more peaks (higher resolution) than coarse.
        // We resample the coarse level to match the fine level's count,
        // then linearly interpolate between them.
        let renderMins: Float32Array | number[];
        let renderMaxs: Float32Array | number[];

        if (coarse && blendFactor > 0.001) {
            const { mins: coarseMins, maxs: coarseMaxs } = coarse;
            const coarseCount = coarseMins.length;

            // PERF #2: Reuse Float32Array buffers for waveform blending
            if (!this._blendMins || this._blendMins.length < peakCount) {
                this._blendMins = new Float32Array(peakCount);
                this._blendMaxs = new Float32Array(peakCount);
            }
            renderMins = this._blendMins;
            renderMaxs = this._blendMaxs!;
            const bf = blendFactor;
            const invBf = 1 - bf;

            for (let i = 0; i < peakCount; i++) {
                // Map fine-level index to coarse-level position
                const coarsePos = coarseCount > 0 ? (i / peakCount) * coarseCount : 0;
                const coarseIdx = Math.min(Math.floor(coarsePos), coarseCount - 1);
                const coarseNextIdx = Math.min(coarseIdx + 1, coarseCount - 1);
                const coarseFrac = coarsePos - coarseIdx;

                // Linearly interpolate within coarse level for sub-peak precision
                const cMin = coarseMins[coarseIdx] * (1 - coarseFrac) + coarseMins[coarseNextIdx] * coarseFrac;
                const cMax = coarseMaxs[coarseIdx] * (1 - coarseFrac) + coarseMaxs[coarseNextIdx] * coarseFrac;

                // Blend between fine and interpolated coarse
                renderMins[i] = fineMins[i] * invBf + cMin * bf;
                renderMaxs[i] = fineMaxs[i] * invBf + cMax * bf;
            }
        } else {
            // No blending needed — use fine level directly
            renderMins = fineMins;
            renderMaxs = fineMaxs;
        }

        const centerY = bodyY + bodyH / 2;
        const halfH = bodyH / 2;

        // ── Choose fill style ────────────────────────────────────────────
        const contrastColor = this._getContrastColorCached(clip.color);

        if (this._waveformStyle === 'classic') {
            ctx.fillStyle = muted
                ? rgba(40, 44, 52, 0.4)
                : (clip.selected ? rgba(0, 0, 0, 0.85) : rgba(0, 0, 0, 0.65));
        } else {
            if (muted) {
                ctx.fillStyle = clip.selected
                    ? rgba(186, 192, 202, 0.72)
                    : rgba(162, 168, 178, 0.62);
            } else {
                ctx.fillStyle = contrastColor === 'black'
                    ? (clip.selected ? rgba(0, 0, 0, 0.76) : rgba(0, 0, 0, 0.62))
                    : (clip.selected ? rgba(255, 255, 255, 0.9) : rgba(255, 255, 255, 0.72));
            }
        }

        const pixelsPerPeak = clipW / peakCount;

        if (pixelsPerPeak >= 1) {
            // ── Bar mode (zoomed in — each peak gets ≥1px) ───────────────
            for (let i = 0; i < peakCount; i++) {
                const px = clipX + (i / peakCount) * clipW;
                const barW = Math.max(1, pixelsPerPeak);
                const minVal = renderMins[i];
                const maxVal = renderMaxs[i];
                const top = centerY - maxVal * halfH;
                const bottom = centerY - minVal * halfH;
                const barH = Math.max(1, bottom - top);
                ctx.fillRect(px, top, barW, barH);
            }
        } else {
            // ── Path mode (zoomed out — multiple peaks per pixel) ─────────
            ctx.beginPath();
            ctx.moveTo(clipX, centerY);

            for (let i = 0; i < peakCount; i++) {
                const px = clipX + (i / peakCount) * clipW;
                ctx.lineTo(px, centerY - renderMaxs[i] * halfH);
            }

            for (let i = peakCount - 1; i >= 0; i--) {
                const px = clipX + (i / peakCount) * clipW;
                ctx.lineTo(px, centerY - renderMins[i] * halfH);
            }

            ctx.closePath();
            ctx.fill();
        }

        // ── Center line ──────────────────────────────────────────────────
        if (this._waveformStyle === 'classic') {
            ctx.strokeStyle = muted
                ? rgba(40, 44, 52, 0.2)
                : rgba(0, 0, 0, 0.25);
        } else {
            ctx.strokeStyle = muted
                ? rgba(132, 138, 148, 0.36)
                : (contrastColor === 'black' ? rgba(0, 0, 0, 0.2) : rgba(255, 255, 255, 0.15));
        }
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(clipX, centerY);
        ctx.lineTo(clipX + clipW, centerY);
        ctx.stroke();
    }

    private _drawMidiNotes(
        ctx: CanvasRenderingContext2D,
        vp: ViewportMatrix,
        clip: TimelineClipData,
        bodyY: number,
        bodyH: number,
        muted: boolean,
        clipX: number,
    ): void {
        if (!clip.midiNotes || clip.midiNotes.length === 0) return;

        const ppb = vp.pixelsPerBeat;
        const midiRowStep = bodyH / 128;
        const noteH = Math.max(1, midiRowStep);

        const contrastColor = this._getContrastColorCached(clip.color);
        ctx.fillStyle = muted
            ? rgba(156, 163, 173, 0.62)
            : (contrastColor === 'black' ? rgba(0, 0, 0, 0.5) : rgba(255, 255, 255, 0.5));

        // PERF #9: Batch notes by velocity bucket (8 buckets → 8 globalAlpha changes
        // instead of N per-note changes). Visual difference is imperceptible —
        // velocity quantized to 16-step increments.
        ctx.save();
        const VELOCITY_BUCKETS = 8;
        const bucketSize = 128 / VELOCITY_BUCKETS; // 16
        for (let bucket = 0; bucket < VELOCITY_BUCKETS; bucket++) {
            const minVel = bucket * bucketSize;
            const maxVel = minVel + bucketSize - 1;
            const avgVel = (minVel + maxVel) / 2;
            ctx.globalAlpha = 0.3 + (avgVel / 127) * 0.7;

            for (const note of clip.midiNotes) {
                if (note.velocity < minVel || note.velocity > maxVel) continue;
                const clampedPitch = clampMidiPitch(note.pitch);
                const noteX = clipX + note.startBeat * ppb;
                const noteW = Math.max(1, note.durationBeats * ppb);
                const pitchIndexFromTop = 127 - clampedPitch;
                const noteY = bodyY + pitchIndexFromTop * midiRowStep;
                ctx.fillRect(noteX, noteY, noteW, noteH);
            }
        }
        ctx.restore();
    }

    private _drawPlayhead(
        ctx: CanvasRenderingContext2D,
        vp: ViewportMatrix,
        playheadBeat: number,
        canvasH: number,
        theme: TimelineTheme,
    ): void {
        const x = snapPhysical(playheadBeat * vp.pixelsPerBeat - vp.scrollX);
        if (x < -10 || x > vp.viewportWidth + 10) return;

        const rulerH = vp.rulerHeight;

        // Single clean 1px playhead line — no glow
        // snapPhysical ensures the line sits perfectly on the physical device pixel grid.
        ctx.save();
        ctx.fillStyle = theme.playhead;
        const finalX = snapPhysical(x);
        ctx.fillRect(finalX, rulerH, 1, Math.max(0, canvasH - rulerH));
        ctx.restore();
    }

    private _drawEditCursor(
        ctx: CanvasRenderingContext2D,
        vp: ViewportMatrix,
        beat: number,
        trackStart: number,
        trackEnd: number,
    ): void {
        if (beat < 0) return; // Hidden when clip is selected (mutual exclusivity)
        const cursorX = snapPhysical(beat * vp.pixelsPerBeat - vp.scrollX);
        if (cursorX < -2 || cursorX > vp.viewportWidth + 2) return;

        const yStart = vp.rulerHeight + vp.trackOffsetY(Math.min(trackStart, trackEnd)) - vp.scrollY;
        const yEnd = vp.rulerHeight + vp.trackOffsetY(Math.max(trackStart, trackEnd)) - vp.scrollY + vp.trackHeightAt(Math.max(trackStart, trackEnd));


        // Smooth pulse to avoid hard on/off flicker.
        const cycleMs = 2600;
        const t = (performance.now() % cycleMs) / cycleMs;
        const eased = 0.5 - 0.5 * Math.cos(t * Math.PI * 2);
        const blink = 0.34 + eased * 0.48;
        ctx.save();
        ctx.setLineDash([]);
        ctx.globalCompositeOperation = 'screen';
        ctx.shadowColor = rgba(255, 255, 255, 0.7);
        ctx.shadowBlur = 3;
        ctx.fillStyle = rgba(255, 255, 255, Number(blink.toFixed(3)));
        const finalYStart = Math.max(vp.rulerHeight, yStart);
        const finalYEnd = Math.max(vp.rulerHeight, yEnd);
        ctx.fillRect(cursorX, finalYStart, 1, Math.max(0, finalYEnd - finalYStart));
        ctx.restore();
    }

    private _drawLoopRegion(
        ctx: CanvasRenderingContext2D,
        vp: ViewportMatrix,
        loop: LoopRegion | null,
        theme: TimelineTheme,
    ): void {
        if (!loop || !loop.enabled) return;

        const x1 = snapPhysical(loop.start * vp.pixelsPerBeat - vp.scrollX);
        const x2 = snapPhysical(loop.end * vp.pixelsPerBeat - vp.scrollX);
        const y = vp.rulerHeight;
        const h = vp.viewportHeight - y;

        ctx.fillStyle = theme.loopFill;
        ctx.fillRect(x1, y, x2 - x1, h);

        ctx.fillStyle = theme.loopBorder;
        ctx.fillRect(x1, y, 1, Math.max(0, h));
        ctx.fillRect(x2, y, 1, Math.max(0, h));
    }

    private _drawDropTarget(
        ctx: CanvasRenderingContext2D,
        vp: ViewportMatrix,
        target: { track: number; beat: number } | null,
    ): void {
        if (!target) return;

        const x = snapPhysical(target.beat * vp.pixelsPerBeat - vp.scrollX);
        const y = snapPhysical(vp.rulerHeight + vp.trackOffsetY(target.track) - vp.scrollY);
        const w = snapPhysical(4 * vp.pixelsPerBeat); // 1 bar default width
        const h = vp.trackHeightAt(target.track);

        ctx.fillStyle = DROP_TARGET_COLOR;
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = DROP_TARGET_BORDER;
        ctx.lineWidth = 1;
        ctx.strokeRect(x, y, w, h);
    }

    private _drawMarquee(
        ctx: CanvasRenderingContext2D,
        vp: ViewportMatrix,
        marquee: { startBeat: number; endBeat: number; startTrack: number; endTrack: number } | null,
    ): void {
        if (!marquee) return;

        const x1 = snapPhysical(Math.min(marquee.startBeat, marquee.endBeat) * vp.pixelsPerBeat - vp.scrollX);
        const x2 = snapPhysical(Math.max(marquee.startBeat, marquee.endBeat) * vp.pixelsPerBeat - vp.scrollX);
        const minTrack = Math.min(marquee.startTrack, marquee.endTrack);
        const maxTrack = Math.max(marquee.startTrack, marquee.endTrack);
        const y1 = snapPhysical(vp.rulerHeight + vp.trackBoundaryOffsetY(minTrack) - vp.scrollY);
        const y2 = snapPhysical(vp.rulerHeight + vp.trackBoundaryOffsetY(maxTrack + 1) - vp.scrollY);

        ctx.fillStyle = rgba(255, 255, 255, 0.06);
        ctx.fillRect(x1, y1, x2 - x1, y2 - y1);

        const sx1 = snapPhysical(x1);
        const sx2 = snapPhysical(x2);
        const sy1 = snapPhysical(y1);
        const sy2 = snapPhysical(y2);
        ctx.fillStyle = rgba(255, 255, 255, 0.78);
        ctx.fillRect(sx1, sy1, sx2 - sx1, 1);
        ctx.fillRect(sx1, sy2 - 1, sx2 - sx1, 1);
        ctx.fillRect(sx1, sy1, 1, sy2 - sy1);
        ctx.fillRect(sx2 - 1, sy1, 1, sy2 - sy1);
    }

    private _drawGhostClip(
        ctx: CanvasRenderingContext2D,
        vp: ViewportMatrix,
        ghost: GhostClipData | null,
    ): void {
        if (!ghost) return;

        const x = snapPhysical(ghost.beat * vp.pixelsPerBeat - vp.scrollX);
        const y = snapPhysical(vp.rulerHeight + vp.trackOffsetY(ghost.trackIndex) - vp.scrollY);
        const w = snapPhysical((ghost.beat + ghost.widthBeats) * vp.pixelsPerBeat - vp.scrollX) - x;
        const h = vp.trackHeightAt(ghost.trackIndex) - 2;
        const r = Math.min(CLIP_RADIUS, w / 2, h / 2);

        ctx.save();
        ctx.globalAlpha = GHOST_CLIP_ALPHA;
        ctx.fillStyle = ghost.type === 'audio'
            ? rgba(100, 200, 255, 0.6)
            : rgba(100, 255, 150, 0.6);
        this._roundRect(ctx, x, y + 1, w, h, r);
        ctx.fill();

        if (w > 30) {
            const ghostColor = ghost.type === 'audio' ? hex(100, 200, 255) : hex(100, 255, 150);
            const contrastColor = getContrastColor(ghostColor);
            ctx.fillStyle = contrastColor === 'black' ? rgba(0, 0, 0, 0.7) : rgba(255, 255, 255, 0.7);
            ctx.font = '11px Inter, -apple-system, sans-serif';
            ctx.textBaseline = 'middle';
            ctx.textAlign = 'left';
            const pad = 3;

            ctx.save();
            ctx.beginPath();
            ctx.rect(x + pad, y + 1, Math.max(0, w - pad * 2), h);
            ctx.clip();
            if (ghost.name) {
                ctx.fillText(ghost.name, x + pad, y + 1 + h / 2);
            }
            ctx.restore();
        }

        ctx.restore();
    }

    private _roundRect(
        ctx: CanvasRenderingContext2D,
        x: number, y: number, w: number, h: number, r: number,
    ): void {
        ctx.beginPath();
        if (r > 0) {
            ctx.moveTo(x + r, y);
            ctx.lineTo(x + w - r, y);
            ctx.quadraticCurveTo(x + w, y, x + w, y + r);
            ctx.lineTo(x + w, y + h - r);
            ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
            ctx.lineTo(x + r, y + h);
            ctx.quadraticCurveTo(x, y + h, x, y + h - r);
            ctx.lineTo(x, y + r);
            ctx.quadraticCurveTo(x, y, x + r, y);
        } else {
            ctx.rect(x, y, w, h);
        }
        ctx.closePath();
    }

    private static _colorCache = new Map<string, { r: number; g: number; b: number }>();
    private _parseColor(color: string): { r: number; g: number; b: number } {
        const cached = CanvasClipRenderer._colorCache.get(color);
        if (cached) return cached;
        const result = parseColorToRgb(color) ?? { r: 80, g: 120, b: 200 };
        CanvasClipRenderer._colorCache.set(color, result);
        return result;
    }

    private _toMutedGray(rgb: { r: number; g: number; b: number }): { r: number; g: number; b: number } {
        const luma = Math.round(rgb.r * 0.2126 + rgb.g * 0.7152 + rgb.b * 0.0722);
        const gray = Math.max(78, Math.min(168, luma));
        return { r: gray, g: gray, b: gray };
    }

    private _drawOfflineStripes(
        ctx: CanvasRenderingContext2D,
        x: number, y: number, w: number, h: number,
    ): void {
        ctx.save();
        ctx.fillStyle = OFFLINE_STRIPE_COLOR;
        const step = 12;
        for (let i = -h; i < w; i += step) {
            ctx.beginPath();
            ctx.moveTo(x + i, y + h);
            ctx.lineTo(x + i + step / 2, y + h);
            ctx.lineTo(x + i + h + step / 2, y);
            ctx.lineTo(x + i + h, y);
            ctx.closePath();
            ctx.fill();
        }
        ctx.restore();
    }

    // PERF #7: Pre-built fade gradient textures (created once, reused every frame)
    private _fadeInCanvas: HTMLCanvasElement | null = null;
    private _fadeOutCanvas: HTMLCanvasElement | null = null;

    private _ensureFadeTextures(): void {
        if (this._fadeInCanvas) return;
        const SIZE = 256;

        // Fade-in: dark→transparent
        this._fadeInCanvas = document.createElement('canvas');
        this._fadeInCanvas.width = SIZE;
        this._fadeInCanvas.height = 1;
        const ctxIn = this._fadeInCanvas.getContext('2d')!;
        const gi = ctxIn.createLinearGradient(0, 0, SIZE, 0);
        gi.addColorStop(0, rgba(0, 0, 0, 0.58));
        gi.addColorStop(0.55, rgba(0, 0, 0, 0.22));
        gi.addColorStop(1, rgba(0, 0, 0, 0));
        ctxIn.fillStyle = gi;
        ctxIn.fillRect(0, 0, SIZE, 1);

        // Fade-out: transparent→dark
        this._fadeOutCanvas = document.createElement('canvas');
        this._fadeOutCanvas.width = SIZE;
        this._fadeOutCanvas.height = 1;
        const ctxOut = this._fadeOutCanvas.getContext('2d')!;
        const go = ctxOut.createLinearGradient(0, 0, SIZE, 0);
        go.addColorStop(0, rgba(0, 0, 0, 0));
        go.addColorStop(0.45, rgba(0, 0, 0, 0.22));
        go.addColorStop(1, rgba(0, 0, 0, 0.58));
        ctxOut.fillStyle = go;
        ctxOut.fillRect(0, 0, SIZE, 1);
    }

    private _drawFade(
        ctx: CanvasRenderingContext2D,
        x: number, y: number, w: number, h: number,
        direction: 'in' | 'out',
        curve: number,
        isHovered: boolean = true,
    ): void {
        if (w <= 0 || h <= 0) return;
        const t = Math.max(0.05, Math.min(0.95, curve));

        // FADE-VIS: Gradient overlay opacity adapts to hover state.
        const gradientAlpha = isHovered ? 1.0 : 0.55;
        const curveAlpha = isHovered ? 0.96 : 0.50;

        // PERF #7: Use pre-built gradient texture instead of createLinearGradient per frame
        this._ensureFadeTextures();
        const tex = direction === 'in' ? this._fadeInCanvas! : this._fadeOutCanvas!;
        ctx.save();
        ctx.globalAlpha *= gradientAlpha;
        ctx.drawImage(tex, 0, 0, tex.width, 1, x, y, w, h);
        ctx.restore();

        // Bezier fade curve line
        ctx.save();
        const startX = x;
        const endX = x + w;
        const startY = direction === 'in' ? y + h : y;
        const endY = direction === 'in' ? y : y + h;
        const cpX = direction === 'in' ? x + w * t : x + w * (1 - t);
        const cpY = direction === 'in' ? y + h * (1 - t) : y + h * t;
        ctx.strokeStyle = rgba(255, 193, 92, curveAlpha);
        if (isHovered) {
            ctx.shadowColor = rgba(255, 190, 85, 0.32);
            ctx.shadowBlur = 3;
        }
        ctx.lineWidth = isHovered ? 1.5 : 1.0;
        ctx.beginPath();
        ctx.moveTo(startX, startY);
        ctx.quadraticCurveTo(cpX, cpY, endX, endY);
        ctx.stroke();
        ctx.restore();
    }

    // ── Group Track Miniatures ─────────────────────────────────────────

    /**
     * Update group track metadata for miniature rendering.
     * @param groupTracks Map of group-track-index → array of child-track-indices
     * @param trackColors Map of track-index → hex color string
     */
    setGroupTracks(
        groupTracks: Map<number, number[]>,
        trackColors: Map<number, string>,
    ): void {
        this._groupTracks = groupTracks;
        this._trackColors = trackColors;
        // PERF: Pre-build flat set of all child track indices for O(1) membership check
        this._groupChildSet.clear();
        for (const children of groupTracks.values()) {
            for (const idx of children) this._groupChildSet.add(idx);
        }
    }

    /**
     * Draw clip miniatures on group tracks.
     *
     * PERF: Zero per-frame allocations. No Map/Array creation. Direct nested
     * loop over groups → children → clips with inline visibility culling.
     */
    private _drawGroupMiniatures(
        ctx: CanvasRenderingContext2D,
        vp: ViewportMatrix,
        clips: TimelineClipData[],
        range: VisibleRange,
    ): void {
        if (this._groupTracks.size === 0) return;

        const ppb = vp.pixelsPerBeat;
        const rulerH = vp.rulerHeight;
        const vpW = vp.viewportWidth;
        const vpH = vp.viewportHeight;
        const scrollX = vp.scrollX;
        const bufferBeats = 2;
        const rangeStart = range.startBeat - bufferBeats;
        const rangeEnd = range.endBeat + bufferBeats;

        for (const [groupIdx, childIndices] of this._groupTracks) {
            const childCount = childIndices.length;
            if (childCount === 0) continue;
            if (groupIdx < range.startTrack - 1 || groupIdx > range.endTrack + 1) continue;

            const trackH = vp.trackHeightAt(groupIdx);
            const groupY = rulerH + vp.trackOffsetY(groupIdx) - vp.scrollY;
            if (groupY + trackH < rulerH || groupY > vpH) continue;

            const paddingTop = 3;
            const paddingBottom = 2;
            const usableH = trackH - paddingTop - paddingBottom;
            if (usableH < 2) continue;

            const laneH = Math.max(2, Math.floor(usableH / childCount));
            const laneGap = childCount > 1 ? 1 : 0;
            const totalLaneH = laneH * childCount + laneGap * (childCount - 1);
            const laneStartY = groupY + paddingTop + Math.max(0, (usableH - totalLaneH) >> 1);

            ctx.save();
            ctx.beginPath();
            ctx.rect(0, Math.max(rulerH, groupY), vpW, trackH);
            ctx.clip();

            // Direct iteration: for each child lane, scan clips array inline
            for (let ci = 0; ci < childCount; ci++) {
                const childIdx = childIndices[ci];
                const laneY = laneStartY + ci * (laneH + laneGap);

                for (let k = 0, len = clips.length; k < len; k++) {
                    const clip = clips[k];
                    if (clip.trackIndex !== childIdx) continue;

                    const clipEnd = clip.startBeat + clip.durationBeats;
                    if (clipEnd < rangeStart || clip.startBeat > rangeEnd) continue;

                    const x = snapPhysical(clip.startBeat * ppb - scrollX);
                    const endX = snapPhysical(clipEnd * ppb - scrollX);
                    const w = Math.max(1, endX - x);
                    if (x + w < 0 || x > vpW) continue;

                    const rawColor = clip.color || this._trackColors.get(childIdx) || '#6a8ccc';
                    const rawRgb = this._parseColor(rawColor);
                    // Muted clips → grey; disabled tracks → original color but more transparent
                    const rgb = clip.muted ? this._toMutedGray(rawRgb) : rawRgb;
                    const alpha = clip.muted ? 0.175
                        : clip.trackDisabled ? 0.15
                            : 0.375;

                    ctx.fillStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},${alpha})`;
                    ctx.fillRect(x, laneY, w, laneH);

                    if (laneH >= 3) {
                        ctx.fillStyle = `rgba(${Math.min(255, rgb.r + 40)},${Math.min(255, rgb.g + 40)},${Math.min(255, rgb.b + 40)},${alpha * 0.6})`;
                        ctx.fillRect(x, laneY, w, 1);
                    }
                }
            }

            ctx.restore();
        }
    }
}
