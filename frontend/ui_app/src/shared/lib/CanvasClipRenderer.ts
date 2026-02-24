
import type { ViewportMatrix, VisibleRange } from './ViewportMatrix';
import type { WaveformCache } from './WaveformCache';
import { getContrastColor, parseColorToRgb } from './colorUtils';

export interface TimelineClipData {
    id: string;
    name: string;
    trackIndex: number;
    startBeat: number;
    durationBeats: number;
    type: 'audio' | 'midi';
    color: string;
    selected?: boolean;
    primarySelected?: boolean;
    hovered?: boolean;
    filePath?: string;
    durationSamples?: number;
    sourceOffset?: number;
    fadeIn?: number;
    fadeOut?: number;
    fadeInCurve?: number;
    fadeOutCurve?: number;
    showFadeInCurvePoint?: boolean;
    showFadeOutCurvePoint?: boolean;
    isOffline?: boolean;
    muted?: boolean;
    trackMuted?: boolean;
    /** Whether this clip uses warp/time-stretch mode. */
    isWarped?: boolean;
    /** Source file duration in samples (used for warp rate computation). */
    warpSourceDurationFrames?: number;
    /** Pitch shift in semitones (used for source-domain waveform mapping). */
    pitchShiftSemitones?: number;
    midiNotes?: Array<{
        pitch: number;
        startBeat: number;
        durationBeats: number;
        velocity: number;
    }>;
}

export interface LoopRegion {
    start: number;
    end: number;
    enabled: boolean;
}

export interface GhostClipData {
    trackIndex: number;
    beat: number;
    widthBeats: number;
    name: string;
    type: 'audio' | 'midi';
}

const HEADER_HEIGHT = 20;
const CLIP_RADIUS = 4;
const FADE_GRAB_RADIUS = 3;
const SELECTION_BORDER_WIDTH = 2;
const rgba = (r: number, g: number, b: number, a: number): string => `rgba(${r}, ${g}, ${b}, ${a})`;
const hex = (r: number, g: number, b: number): string =>
    `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
const SELECTION_GLOW_COLOR = rgba(255, 255, 255, 0.9);
const DROP_TARGET_COLOR = rgba(255, 255, 255, 0.2);
const DROP_TARGET_BORDER = rgba(255, 255, 255, 0.6);
const GHOST_CLIP_ALPHA = 0.45;
const OFFLINE_STRIPE_COLOR = rgba(255, 80, 80, 0.3);
const CLIP_LABEL_FONT = '10px Inter, -apple-system, sans-serif';

interface TimelineTheme {
    bg: string;
    rulerBg: string;
    gridLine: string;
    gridBar: string;
    trackDefault: string;
    trackSelected: string;
    playhead: string;
    playheadGlow: string;
    editCursor: string;
    loopFill: string;
    loopBorder: string;
    rulerText: string;
    trackDivider: string;
}

function applyAlphaMultiplier(color: string, multiplier: number): string {
    const m = color.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/i);
    if (!m) return color;
    const r = Number(m[1]);
    const g = Number(m[2]);
    const b = Number(m[3]);
    const baseA = m[4] != null ? Number(m[4]) : 1;
    const a = Math.max(0, Math.min(1, baseA * multiplier));
    return rgba(r, g, b, a);
}

export class CanvasClipRenderer {
    private readonly _waveformCache: WaveformCache;
    private _bpm = 120;

    private _theme: TimelineTheme | null = null;
    private _lastThemeSync = 0;

    // (removed: _editCursorPlacedMs / _prevEditCursorBeat — replaced by quantized blink P4)

    /** Reusable buffer for visible-clip filtering (avoids per-frame allocation). */
    private _filteredClips: TimelineClipData[] = [];

    /** Cached highlight gradient (reused across clips within a frame). */
    private _highlightGrad: CanvasGradient | null = null;
    private _highlightGradCtx: CanvasRenderingContext2D | null = null;

    constructor(waveformCache: WaveformCache) {
        this._waveformCache = waveformCache;
    }

    private _truncateTextToWidth(
        ctx: CanvasRenderingContext2D,
        text: string,
        maxWidth: number,
    ): string {
        if (!text || maxWidth <= 0) return '';
        if (ctx.measureText(text).width <= maxWidth) return text;

        const ellipsis = '...';
        const ellipsisW = ctx.measureText(ellipsis).width;
        if (ellipsisW >= maxWidth) return '';

        let lo = 0;
        let hi = text.length;
        while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            const candidate = `${text.slice(0, mid)}${ellipsis}`;
            if (ctx.measureText(candidate).width <= maxWidth) {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        return lo > 0 ? `${text.slice(0, lo)}${ellipsis}` : '';
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
        this._drawClips(ctx, vp, clips, range, sampleRate);
        this._drawMarquee(ctx, vp, marquee);
        this._drawDropTarget(ctx, vp, dropTarget);
        this._drawGhostClip(ctx, vp, ghost);
        this._drawPlayhead(ctx, vp, playheadBeat, h, theme);
        this._drawEditCursor(ctx, vp, editCursorBeat, editCursorTrackStart, editCursorTrackEnd);

        ctx.restore();

        this._drawRuler(ctx, vp, range, beatsPerBar, playheadBeat, editCursorBeat, loop, theme);

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

        const startBeat = Math.floor(range.startBeat / gridStep) * gridStep;
        const endBeat = Math.ceil(range.endBeat / gridStep) * gridStep;

        // ── P1: Batch subdivision lines into one path ──
        ctx.beginPath();
        for (let beat = startBeat; beat <= endBeat; beat += gridStep) {
            const barPhase = beat / beatsPerBar;
            if (Math.abs(barPhase - Math.round(barPhase)) < 1e-6) continue; // skip bar lines
            const x = Math.round(vp.beatsToScreenX(beat));
            if (x < -1 || x > vpW + 1) continue;
            ctx.moveTo(x, rulerH);
            ctx.lineTo(x, vpH);
        }
        ctx.strokeStyle = theme.gridLine;
        ctx.lineWidth = 0.5;
        ctx.stroke();

        // ── P1: Batch bar lines into one path ──
        ctx.beginPath();
        for (let beat = startBeat; beat <= endBeat; beat += gridStep) {
            const barPhase = beat / beatsPerBar;
            if (Math.abs(barPhase - Math.round(barPhase)) >= 1e-6) continue; // skip subdivisions
            const x = Math.round(vp.beatsToScreenX(beat));
            if (x < -1 || x > vpW + 1) continue;
            ctx.moveTo(x, rulerH);
            ctx.lineTo(x, vpH);
        }
        ctx.strokeStyle = theme.gridBar;
        ctx.lineWidth = 1;
        ctx.stroke();

        // ── P2: Batch track dividers into one path ──
        ctx.beginPath();
        for (let i = 0; i <= vp.trackCount; i++) {
            const y = Math.round(rulerH + vp.trackBoundaryOffsetY(i) - vp.scrollY);
            if (y < rulerH - 1 || y > vpH + 1) continue;
            ctx.moveTo(0, y);
            ctx.lineTo(vpW, y);
        }
        ctx.strokeStyle = theme.trackDivider;
        ctx.lineWidth = 1;
        ctx.stroke();

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
    ): void {
        ctx.save();
        const rulerH = vp.rulerHeight;

        ctx.fillStyle = theme.rulerBg;
        ctx.fillRect(0, 0, vp.viewportWidth, rulerH);

        ctx.strokeStyle = theme.trackDivider;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, rulerH);
        ctx.lineTo(vp.viewportWidth, rulerH);
        ctx.stroke();

        let markStep = beatsPerBar;
        if (vp.pixelsPerBeat < 12) markStep = beatsPerBar * 4;

        ctx.font = '10px Inter, -apple-system, sans-serif';
        ctx.fillStyle = theme.rulerText;
        ctx.textBaseline = 'top';
        ctx.textAlign = 'center';

        const startMark = Math.floor(range.startBeat / markStep) * markStep;
        const endMark = Math.ceil(range.endBeat / markStep) * markStep;

        for (let beat = startMark; beat <= endMark; beat += markStep) {
            const x = vp.beatsToScreenX(beat);
            if (x < -50 || x > vp.viewportWidth + 10) continue;

            const barNumber = Math.floor(beat / beatsPerBar) + 1;
            ctx.fillText(String(barNumber), x, 2);

            ctx.strokeStyle = theme.rulerText;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(Math.round(x), rulerH - 8);
            ctx.lineTo(Math.round(x), rulerH);
            ctx.stroke();
        }

        const phX = vp.beatsToScreenX(playheadBeat);
        if (phX >= -5 && phX <= vp.viewportWidth + 5) {
            ctx.fillStyle = theme.playhead;
            ctx.beginPath();
            ctx.moveTo(phX, rulerH);
            ctx.lineTo(phX - 5, rulerH - 8);
            ctx.lineTo(phX + 5, rulerH - 8);
            ctx.closePath();
            ctx.fill();
        }

        const ecX = vp.beatsToScreenX(editCursorBeat);
        if (ecX >= -5 && ecX <= vp.viewportWidth + 5) {
            ctx.fillStyle = theme.editCursor;
            ctx.beginPath();
            ctx.moveTo(ecX, rulerH);
            ctx.lineTo(ecX - 5, rulerH - 6);
            ctx.lineTo(ecX + 5, rulerH - 6);
            ctx.closePath();
            ctx.fill();
        }

        if (loop) {
            const lStart = vp.beatsToScreenX(loop.start);
            const lEnd = vp.beatsToScreenX(loop.end);

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
                    ctx.strokeStyle = theme.loopBorder;
                    ctx.lineWidth = 1.5;
                    ctx.beginPath();
                    ctx.moveTo(lStart, 0);
                    ctx.lineTo(lStart, rulerH);
                    ctx.stroke();
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
                    ctx.strokeStyle = theme.loopBorder;
                    ctx.lineWidth = 1.5;
                    ctx.beginPath();
                    ctx.moveTo(lEnd, 0);
                    ctx.lineTo(lEnd, rulerH);
                    ctx.stroke();
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
    ): void {
        const bufferBeats = 2;
        // ── P5: Reuse pre-allocated buffer instead of filter() ──
        const filtered = this._filteredClips;
        filtered.length = 0;
        for (let i = 0, len = clips.length; i < len; i++) {
            const c = clips[i];
            const endBeat = c.startBeat + c.durationBeats;
            if (endBeat < range.startBeat - bufferBeats) continue;
            if (c.startBeat > range.endBeat + bufferBeats) continue;
            if (c.trackIndex < range.startTrack - 1) continue;
            if (c.trackIndex > range.endTrack + 1) continue;
            filtered.push(c);
        }

        const trackPitchRange = new Map<number, { min: number; max: number }>();
        for (const c of filtered) {
            if (c.type !== 'midi' || !c.midiNotes || c.midiNotes.length === 0) continue;
            let existing = trackPitchRange.get(c.trackIndex);
            if (!existing) {
                existing = { min: 127, max: 0 };
                trackPitchRange.set(c.trackIndex, existing);
            }
            for (const n of c.midiNotes) {
                if (n.pitch < existing.min) existing.min = n.pitch;
                if (n.pitch > existing.max) existing.max = n.pitch;
            }
        }
        for (const [, pr] of trackPitchRange) {
            const span = pr.max - pr.min + 1;
            if (span < 12) {
                const pad = Math.ceil((12 - span) / 2);
                pr.min = Math.max(0, pr.min - pad);
                pr.max = Math.min(127, pr.max + pad);
            }
        }

        filtered.sort((a, b) => {
            const aPriority = a.primarySelected ? 2 : (a.selected ? 1 : 0);
            const bPriority = b.primarySelected ? 2 : (b.selected ? 1 : 0);
            return aPriority - bPriority;
        });

        for (const clip of filtered) {
            this._drawSingleClip(ctx, vp, clip, sampleRate, trackPitchRange.get(clip.trackIndex));
        }
    }

    private _drawSingleClip(
        ctx: CanvasRenderingContext2D,
        vp: ViewportMatrix,
        clip: TimelineClipData,
        sampleRate: number,
        trackPitch?: { min: number; max: number },
    ): void {
        const ppb = vp.pixelsPerBeat;
        const trackH = vp.trackHeightAt(clip.trackIndex);

        const x = vp.beatsToScreenX(clip.startBeat);
        const y = vp.rulerHeight + vp.trackOffsetY(clip.trackIndex) - vp.scrollY;
        const w = clip.durationBeats * ppb;
        const h = trackH - 2; // 1px gap top and bottom

        if (x + w < -10 || x > vp.viewportWidth + 10) return;
        if (y + h < vp.rulerHeight || y > vp.viewportHeight + 10) return;

        ctx.save();

        const isTrackMuted = clip.trackMuted === true;
        if (isTrackMuted) {
            ctx.globalAlpha = 0.25;
        }

        const r = Math.min(CLIP_RADIUS, w / 2, h / 2);
        this._roundRect(ctx, x, y + 1, w, h, r);
        ctx.clip();

        const rgbBase = this._parseColor(clip.color);
        const rgb = clip.muted ? this._toMutedGray(rgbBase) : rgbBase;

        const headerH = Math.min(HEADER_HEIGHT, h);
        const headerR = rgb.r, headerG = rgb.g, headerB = rgb.b;
        ctx.fillStyle = `rgba(${headerR}, ${headerG}, ${headerB}, 1)`;
        ctx.fillRect(x, y + 1, w, headerH);

        const dividerR = Math.max(0, Math.round(headerR * 0.72)), dividerG = Math.max(0, Math.round(headerG * 0.72)), dividerB = Math.max(0, Math.round(headerB * 0.72));
        ctx.strokeStyle = `rgba(${dividerR}, ${dividerG}, ${dividerB}, 0.62)`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, y + 1 + headerH);
        ctx.lineTo(x + w, y + 1 + headerH);
        ctx.stroke();

        if (h > headerH) {
            const bodyR = Math.max(0, Math.round(headerR * 0.84)), bodyG = Math.max(0, Math.round(headerG * 0.84)), bodyB = Math.max(0, Math.round(headerB * 0.84));
            ctx.fillStyle = `rgba(${bodyR}, ${bodyG}, ${bodyB}, 0.8)`;
            ctx.fillRect(x, y + 1 + headerH, w, h - headerH);
        }

        if (clip.muted) {
            ctx.fillStyle = rgba(116, 122, 132, 0.42);
            ctx.fillRect(x, y + 1, w, h);
        }

        if (clip.isOffline) {
            this._drawOfflineStripes(ctx, x, y + 1, w, h);
        }

        const bodyY = y + 1 + headerH;
        const bodyH = Math.max(0, h - headerH);

        if (bodyH > 8) {
            if (clip.type === 'audio' && clip.durationSamples) {
                this._drawWaveform(ctx, vp, clip, bodyY, bodyH, sampleRate, clip.muted === true || isTrackMuted);
            } else if (clip.type === 'midi' && clip.midiNotes && clip.midiNotes.length > 0) {
                this._drawMidiNotes(ctx, vp, clip, bodyY, bodyH, clip.muted === true || isTrackMuted, trackPitch);
            }
        }

        const showFadeUi = Boolean(clip.hovered);

        if (showFadeUi && clip.fadeIn && clip.fadeIn > 0) {
            this._drawFade(
                ctx,
                x,
                bodyY,
                w * clip.fadeIn,
                bodyH,
                'in',
                clip.fadeInCurve ?? 0.5,
            );
        }
        if (showFadeUi && clip.fadeOut && clip.fadeOut > 0) {
            this._drawFade(
                ctx,
                x + w - w * clip.fadeOut,
                bodyY,
                w * clip.fadeOut,
                bodyH,
                'out',
                clip.fadeOutCurve ?? 0.5,
            );
        }

        const textPad = 3;
        const maxTextW = w - textPad * 2;
        if (maxTextW > 4 && headerH > 8) {
            const contrastColor = getContrastColor(clip.color);
            const isMutedVisual = clip.muted || isTrackMuted;
            ctx.font = CLIP_LABEL_FONT;
            const label = this._truncateTextToWidth(ctx, clip.name, maxTextW);
            if (label) {
                ctx.fillStyle = isMutedVisual
                    ? rgba(210, 215, 223, 1)
                    : (contrastColor === 'black' ? rgba(0, 0, 0, 1) : rgba(255, 255, 255, 1));
                ctx.globalAlpha *= isMutedVisual ? 0.95 : 0.9;
                ctx.textBaseline = 'middle';
                ctx.textAlign = 'left';
                const textX = x + textPad;
                const textY = y + 1 + headerH / 2;
                ctx.fillText(label, textX, textY);
            }
        }

        // ── P3: Reuse cached highlight gradient (avoids createLinearGradient per clip) ──
        if (!this._highlightGrad || this._highlightGradCtx !== ctx) {
            this._highlightGrad = ctx.createLinearGradient(0, 0, 0, 3);
            this._highlightGrad.addColorStop(0, rgba(255, 255, 255, 0.25));
            this._highlightGrad.addColorStop(1, rgba(255, 255, 255, 0));
            this._highlightGradCtx = ctx;
        }
        ctx.save();
        ctx.translate(x, y + 1);
        ctx.fillStyle = this._highlightGrad;
        ctx.fillRect(0, 0, w, 3);
        ctx.restore();

        ctx.restore();

        if (clip.selected) {
            ctx.save();
            if (isTrackMuted) ctx.globalAlpha = 0.25;
            ctx.strokeStyle = SELECTION_GLOW_COLOR;
            ctx.lineWidth = SELECTION_BORDER_WIDTH;
            ctx.shadowColor = rgba(255, 255, 255, 0.5);
            ctx.shadowBlur = 6;
            this._roundRect(ctx, x, y + 1, w, h, r);
            ctx.stroke();
            ctx.restore();
        }

        if (!clip.selected) {
            ctx.save();
            if (isTrackMuted) ctx.globalAlpha = 0.25;
            ctx.strokeStyle = `rgba(${Math.min(255, rgb.r + 60)}, ${Math.min(255, rgb.g + 60)}, ${Math.min(255, rgb.b + 60)}, 0.5)`;
            ctx.lineWidth = 1;
            this._roundRect(ctx, x, y + 1, w, h, r);
            ctx.stroke();
            ctx.restore();
        }

        if (showFadeUi && w >= 14 && bodyH >= 10) {
            const handleY = bodyY + 6;
            const fadeInWidth = w * Math.max(0, Math.min(0.5, clip.fadeIn ?? 0));
            const fadeOutWidth = w * Math.max(0, Math.min(0.5, clip.fadeOut ?? 0));
            const leftX = x + Math.max(4, Math.min(w - 4, fadeInWidth));
            const rightX = x + w - Math.max(4, Math.min(w - 4, fadeOutWidth));

            ctx.save();
            if (isTrackMuted) ctx.globalAlpha = 0.25;
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
    ): void {
        if (!clip.durationSamples) return;

        const ppb = vp.pixelsPerBeat;
        if (ppb <= 0) return;
        const clipX = vp.beatsToScreenX(clip.startBeat);
        const clipW = clip.durationBeats * ppb;

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

        const drawData = this._waveformCache.getDrawData(
            clip.id,
            samplesPerPixel,
            clip.sourceOffset ?? 0,
            sourceWindowSamples,
        );

        if (!drawData) return; // Still loading

        const { mins, maxs } = drawData;
        const peakCount = mins.length;
        if (peakCount === 0) return;

        const centerY = bodyY + bodyH / 2;
        const halfH = bodyH / 2;

        const contrastColor = getContrastColor(clip.color);
        if (muted) {
            ctx.fillStyle = clip.selected
                ? rgba(186, 192, 202, 0.72)
                : rgba(162, 168, 178, 0.62);
        } else {
            ctx.fillStyle = contrastColor === 'black'
                ? (clip.selected ? rgba(0, 0, 0, 0.76) : rgba(0, 0, 0, 0.62))
                : (clip.selected ? rgba(255, 255, 255, 0.9) : rgba(255, 255, 255, 0.72));
        }

        const pixelsPerPeak = clipW / peakCount;

        if (pixelsPerPeak >= 1) {
            for (let i = 0; i < peakCount; i++) {
                const px = clipX + (i / peakCount) * clipW;
                const barW = Math.max(1, pixelsPerPeak);
                const minVal = mins[i];
                const maxVal = maxs[i];
                const top = centerY - maxVal * halfH;
                const bottom = centerY - minVal * halfH;
                const barH = Math.max(1, bottom - top);
                ctx.fillRect(px, top, barW, barH);
            }
        } else {
            ctx.beginPath();
            ctx.moveTo(clipX, centerY);

            for (let i = 0; i < peakCount; i++) {
                const px = clipX + (i / peakCount) * clipW;
                ctx.lineTo(px, centerY - maxs[i] * halfH);
            }

            for (let i = peakCount - 1; i >= 0; i--) {
                const px = clipX + (i / peakCount) * clipW;
                ctx.lineTo(px, centerY - mins[i] * halfH);
            }

            ctx.closePath();
            // BUG-G06 FIX: Respect track-mute dimming in path-based rendering.
            // Previously hardcoded to 0.6, overriding the track-mute alpha (0.25).
            ctx.globalAlpha = muted ? 0.15 : 0.6;
            ctx.fill();
            ctx.globalAlpha = muted ? 0.25 : 1.0;
        }

        ctx.strokeStyle = muted
            ? rgba(132, 138, 148, 0.36)
            : (contrastColor === 'black' ? rgba(0, 0, 0, 0.2) : rgba(255, 255, 255, 0.15));
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
        trackPitch?: { min: number; max: number },
    ): void {
        if (!clip.midiNotes || clip.midiNotes.length === 0) return;

        const ppb = vp.pixelsPerBeat;
        const clipX = vp.beatsToScreenX(clip.startBeat);

        const minPitch = trackPitch?.min ?? 60;
        const maxPitch = trackPitch?.max ?? 72;
        const pitchSlots = Math.max(1, maxPitch - minPitch + 1);

        const noteH = Math.max(1, Math.min(4, Math.floor(bodyH / Math.max(1, pitchSlots))));
        const rowGap = pitchSlots > 1
            ? Math.max(0, Math.min(1, (bodyH - pitchSlots * noteH) / (pitchSlots - 1)))
            : 0;
        const contentH = pitchSlots * noteH + Math.max(0, pitchSlots - 1) * rowGap;
        const topOffset = Math.max(0, (bodyH - contentH) / 2);

        const contrastColor = getContrastColor(clip.color);
        ctx.fillStyle = muted
            ? rgba(156, 163, 173, 0.62)
            : (contrastColor === 'black' ? rgba(0, 0, 0, 0.5) : rgba(255, 255, 255, 0.5));

        for (const note of clip.midiNotes) {
            const clampedPitch = Math.max(minPitch, Math.min(maxPitch, note.pitch));
            const noteX = clipX + note.startBeat * ppb;
            const noteW = Math.max(1, note.durationBeats * ppb);
            const pitchIndexFromTop = maxPitch - clampedPitch;
            const noteY = bodyY + topOffset + pitchIndexFromTop * (noteH + rowGap);

            ctx.globalAlpha = 0.3 + (note.velocity / 127) * 0.7;
            ctx.fillRect(noteX, noteY, noteW, noteH);
        }
        ctx.globalAlpha = 1.0;
    }

    private _drawPlayhead(
        ctx: CanvasRenderingContext2D,
        vp: ViewportMatrix,
        playheadBeat: number,
        canvasH: number,
        theme: TimelineTheme,
    ): void {
        const x = vp.beatsToScreenX(playheadBeat);
        if (x < -10 || x > vp.viewportWidth + 10) return;

        const rulerH = vp.rulerHeight;

        ctx.save();
        ctx.strokeStyle = theme.playheadGlow;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(Math.round(x), rulerH);
        ctx.lineTo(Math.round(x), canvasH);
        ctx.stroke();
        ctx.restore();

        ctx.save();
        ctx.strokeStyle = theme.playhead;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(x), rulerH);
        ctx.lineTo(Math.round(x), canvasH);
        ctx.stroke();
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
        const x = vp.beatsToScreenX(beat);
        if (x < -2 || x > vp.viewportWidth + 2) return;

        const yStart = vp.rulerHeight + vp.trackOffsetY(Math.min(trackStart, trackEnd)) - vp.scrollY;
        const yEnd = vp.rulerHeight + vp.trackOffsetY(Math.max(trackStart, trackEnd)) - vp.scrollY + vp.trackHeightAt(Math.max(trackStart, trackEnd));
        const cursorX = Math.round(x) + 0.5;


        // ── P4: Quantized blink — matches _drawFrameNow's 500ms cycle ──
        // Previously used continuous cos() which changed every frame,
        // conflicting with the 500ms redraw guard and causing visual stutter.
        const blinkOn = (Math.floor(performance.now() / 500) % 2) === 0;
        const blink = blinkOn ? 0.9 : 0.22;
        ctx.save();
        ctx.setLineDash([]);
        ctx.globalCompositeOperation = 'screen';
        ctx.shadowColor = rgba(255, 255, 255, 0.7);
        ctx.shadowBlur = 3;
        ctx.strokeStyle = rgba(255, 255, 255, Number(blink.toFixed(3)));
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cursorX, Math.max(vp.rulerHeight, yStart));
        ctx.lineTo(cursorX, Math.max(vp.rulerHeight, yEnd));
        ctx.stroke();
        ctx.restore();
    }

    private _drawLoopRegion(
        ctx: CanvasRenderingContext2D,
        vp: ViewportMatrix,
        loop: LoopRegion | null,
        theme: TimelineTheme,
    ): void {
        if (!loop || !loop.enabled) return;

        const x1 = vp.beatsToScreenX(loop.start);
        const x2 = vp.beatsToScreenX(loop.end);
        const y = vp.rulerHeight;
        const h = vp.viewportHeight - y;

        ctx.fillStyle = theme.loopFill;
        ctx.fillRect(x1, y, x2 - x1, h);

        ctx.strokeStyle = theme.loopBorder;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(x1), y);
        ctx.lineTo(Math.round(x1), y + h);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(Math.round(x2), y);
        ctx.lineTo(Math.round(x2), y + h);
        ctx.stroke();
    }

    private _drawDropTarget(
        ctx: CanvasRenderingContext2D,
        vp: ViewportMatrix,
        target: { track: number; beat: number } | null,
    ): void {
        if (!target) return;

        const x = vp.beatsToScreenX(target.beat);
        const y = vp.rulerHeight + vp.trackOffsetY(target.track) - vp.scrollY;
        const w = vp.pixelsPerBeat * 4; // 1 bar default width
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

        const x1 = vp.beatsToScreenX(Math.min(marquee.startBeat, marquee.endBeat));
        const x2 = vp.beatsToScreenX(Math.max(marquee.startBeat, marquee.endBeat));
        const minTrack = Math.min(marquee.startTrack, marquee.endTrack);
        const maxTrack = Math.max(marquee.startTrack, marquee.endTrack);
        const y1 = vp.rulerHeight + vp.trackBoundaryOffsetY(minTrack) - vp.scrollY;
        const y2 = vp.rulerHeight + vp.trackBoundaryOffsetY(maxTrack + 1) - vp.scrollY;

        ctx.fillStyle = rgba(255, 255, 255, 0.06);
        ctx.fillRect(x1, y1, x2 - x1, y2 - y1);

        const sx1 = Math.round(x1) + 0.5;
        const sx2 = Math.round(x2) + 0.5;
        const sy1 = Math.round(y1) + 0.5;
        const sy2 = Math.round(y2) + 0.5;
        ctx.save();
        ctx.setLineDash([]);
        ctx.strokeStyle = rgba(255, 255, 255, 0.78);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(sx1, sy1);
        ctx.lineTo(sx2, sy1);
        ctx.lineTo(sx2, sy2);
        ctx.lineTo(sx1, sy2);
        ctx.closePath();
        ctx.stroke();
        ctx.restore();
    }

    private _drawGhostClip(
        ctx: CanvasRenderingContext2D,
        vp: ViewportMatrix,
        ghost: GhostClipData | null,
    ): void {
        if (!ghost) return;

        const x = vp.beatsToScreenX(ghost.beat);
        const y = vp.rulerHeight + vp.trackOffsetY(ghost.trackIndex) - vp.scrollY;
        const w = ghost.widthBeats * vp.pixelsPerBeat;
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
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.arcTo(x + w, y, x + w, y + r, r);
        ctx.lineTo(x + w, y + h - r);
        ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
        ctx.lineTo(x + r, y + h);
        ctx.arcTo(x, y + h, x, y + h - r, r);
        ctx.lineTo(x, y + r);
        ctx.arcTo(x, y, x + r, y, r);
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

    private _drawFade(
        ctx: CanvasRenderingContext2D,
        x: number, y: number, w: number, h: number,
        direction: 'in' | 'out',
        curve: number,
    ): void {
        if (w <= 0 || h <= 0) return;
        const t = Math.max(0.05, Math.min(0.95, curve));

        ctx.save();
        const gradient = ctx.createLinearGradient(x, y, x + w, y);
        if (direction === 'in') {
            gradient.addColorStop(0, rgba(0, 0, 0, 0.58));
            gradient.addColorStop(0.55, rgba(0, 0, 0, 0.22));
            gradient.addColorStop(1, rgba(0, 0, 0, 0));
        } else {
            gradient.addColorStop(0, rgba(0, 0, 0, 0));
            gradient.addColorStop(0.45, rgba(0, 0, 0, 0.22));
            gradient.addColorStop(1, rgba(0, 0, 0, 0.58));
        }
        ctx.fillStyle = gradient;
        ctx.fillRect(x, y, w, h);

        const startX = x;
        const endX = x + w;
        const startY = direction === 'in' ? y + h : y;
        const endY = direction === 'in' ? y : y + h;
        const cpX = direction === 'in' ? x + w * t : x + w * (1 - t);
        const cpY = direction === 'in' ? y + h * (1 - t) : y + h * t;
        ctx.strokeStyle = rgba(255, 193, 92, 0.96);
        ctx.shadowColor = rgba(255, 190, 85, 0.32);
        ctx.shadowBlur = 3;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(startX, startY);
        ctx.quadraticCurveTo(cpX, cpY, endX, endY);
        ctx.stroke();

        ctx.restore();
    }
}
