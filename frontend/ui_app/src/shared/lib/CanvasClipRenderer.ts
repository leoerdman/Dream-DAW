// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — CanvasClipRenderer
// ═══════════════════════════════════════════════════════════════════════════
//
// Draws timeline content directly on a Canvas 2D context.
// This replaces ALL DOM `<div>` clip elements, `<svg>` grid lines,
// and the `<div>` playhead.
//
// Visual design mirrors the WGSL shader in:
//   core/dream_renderer/src/shaders/timeline.wgsl
//
// Everything here is pure drawing — no React, no DOM nodes.
//
// Sections:
//   1. Grid (beat lines, bar lines, track dividers)
//   2. Clips (rounded rects, headers, waveforms, MIDI notes)
//   3. Selection glow, phantom/muted states
//   4. Playhead
//   5. Loop region overlay
//   6. Edit cursor
//   7. Drop target indicator
//   8. Ghost clip preview
//
// ═══════════════════════════════════════════════════════════════════════════

import type { ViewportMatrix, VisibleRange } from './ViewportMatrix';
import type { WaveformCache } from './WaveformCache';
import { getContrastColor, parseColorToRgb } from './colorUtils';

// ── Types ─────────────────────────────────────────────────────────────────

export interface TimelineClipData {
    id: string;
    name: string;
    trackIndex: number;
    startBeat: number;
    durationBeats: number;
    type: 'audio' | 'midi';
    color: string;
    selected?: boolean;
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
    /** TRUE when the parent track is muted — clips render darker. */
    trackMuted?: boolean;
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

// ── Constants ─────────────────────────────────────────────────────────────

const HEADER_HEIGHT = 20;
const CLIP_RADIUS = 4;
const FADE_GRAB_RADIUS = 3;
const SELECTION_BORDER_WIDTH = 2;
const SELECTION_GLOW_COLOR = 'rgba(255, 255, 255, 0.9)';
const DROP_TARGET_COLOR = 'rgba(255, 255, 255, 0.2)';
const DROP_TARGET_BORDER = 'rgba(255, 255, 255, 0.6)';
const GHOST_CLIP_ALPHA = 0.45;
const OFFLINE_STRIPE_COLOR = 'rgba(255, 80, 80, 0.3)';

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

// ── Class ─────────────────────────────────────────────────────────────────

export class CanvasClipRenderer {
    private readonly _waveformCache: WaveformCache;
    private _bpm = 120;

    private _theme: TimelineTheme | null = null;
    private _lastThemeSync = 0;

    /** Timestamp (ms) when the edit cursor was last repositioned. */
    private _editCursorPlacedMs = 0;
    /** Previous edit cursor beat for change detection. */
    private _prevEditCursorBeat = -999;

    constructor(waveformCache: WaveformCache) {
        this._waveformCache = waveformCache;
    }

    private _syncTheme(): void {
        const now = performance.now();
        if (this._theme && now - this._lastThemeSync < 1000) return; // Sync once per second max

        const s = getComputedStyle(document.documentElement);
        this._theme = {
            bg: s.getPropertyValue('--color-timeline-bg').trim() || '#0d0d1a',
            rulerBg: s.getPropertyValue('--color-timeline-ruler-bg').trim() || '#12121e',
            gridLine: s.getPropertyValue('--color-timeline-grid-line').trim() || 'rgba(255, 255, 255, 0.06)',
            gridBar: s.getPropertyValue('--color-timeline-grid-bar').trim() || 'rgba(74, 158, 255, 0.18)',
            trackDefault: s.getPropertyValue('--color-timeline-track-default').trim() || '#191919',
            trackSelected: s.getPropertyValue('--color-timeline-track-selected').trim() || '#262626',
            playhead: s.getPropertyValue('--color-timeline-playhead').trim() || '#ff3b30',
            playheadGlow: s.getPropertyValue('--color-timeline-playhead-glow').trim() || 'rgba(255, 59, 48, 0.4)',
            editCursor: s.getPropertyValue('--color-timeline-edit-cursor').trim() || 'rgba(255, 255, 255, 0.75)',
            loopFill: s.getPropertyValue('--color-timeline-loop-fill').trim() || 'rgba(74, 158, 255, 0.08)',
            loopBorder: s.getPropertyValue('--color-timeline-loop-border').trim() || 'rgba(74, 158, 255, 0.5)',
            rulerText: s.getPropertyValue('--color-timeline-ruler-text').trim() || 'rgba(255, 255, 255, 0.5)',
            trackDivider: s.getPropertyValue('--color-border-subtle').trim() || 'rgba(255, 255, 255, 0.08)',
        };
        this._lastThemeSync = now;
    }

    // ═══════════════════════════════════════════════════════════════════
    // 1. FULL FRAME DRAW
    // ═══════════════════════════════════════════════════════════════════

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

        // Clear entire canvas
        ctx.clearRect(0, 0, w * dpr, h * dpr);

        ctx.save();
        ctx.scale(dpr, dpr);

        // Draw background
        ctx.fillStyle = theme.bg;
        ctx.fillRect(0, 0, w, h);

        const range = vp.getVisibleRange();

        // Draw track area (below ruler)
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

        // Draw ruler on top (always visible)
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

        // Fill the entire track area with the default track color
        ctx.fillStyle = theme.trackDefault;
        ctx.fillRect(0, rulerH, vp.viewportWidth, vp.viewportHeight - rulerH);

        // Highlight selected tracks (primary gets stronger)
        // The highlight must be clipped to the actual track bounds so it scrolls
        // with the track and disappears under the ruler / below the viewport edge.
        const list = (selectedTracks && selectedTracks.length > 0) ? selectedTracks : (selectedTrack >= 0 ? [selectedTrack] : []);
        for (const t of list) {
            if (t < 0) continue;
            const y = rulerH + vp.trackOffsetY(t) - vp.scrollY;
            const h = vp.trackHeightAt(t);
            // Fully off-screen — skip
            if (y + h < rulerH || y > vp.viewportHeight) continue;
            // Clip top to ruler and bottom to viewport
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

    // ═══════════════════════════════════════════════════════════════════
    // 2. GRID
    // ═══════════════════════════════════════════════════════════════════

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

        // ── Vertical grid lines ──────────────────────────────────────
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

        for (let beat = startBeat; beat <= endBeat; beat += gridStep) {
            const x = vp.beatsToScreenX(beat);
            if (x < -1 || x > vp.viewportWidth + 1) continue;

            const barPhase = beat / beatsPerBar;
            const isBar = Math.abs(barPhase - Math.round(barPhase)) < 1e-6;
            ctx.strokeStyle = isBar ? theme.gridBar : theme.gridLine;
            ctx.lineWidth = isBar ? 1 : 0.5;
            ctx.beginPath();
            ctx.moveTo(Math.round(x), rulerH);
            ctx.lineTo(Math.round(x), vp.viewportHeight);
            ctx.stroke();
        }

        // ── Horizontal track dividers ───────────────────────────────────
        ctx.strokeStyle = theme.trackDivider;
        ctx.lineWidth = 1;
        for (let i = 0; i <= vp.trackCount; i++) {
            const y = rulerH + vp.trackBoundaryOffsetY(i) - vp.scrollY;
            if (y < rulerH - 1 || y > vp.viewportHeight + 1) continue;
            ctx.beginPath();
            ctx.moveTo(0, Math.round(y));
            ctx.lineTo(vp.viewportWidth, Math.round(y));
            ctx.stroke();
        }
        ctx.restore();
    }

    // ═══════════════════════════════════════════════════════════════════
    // 3. RULER
    // ═══════════════════════════════════════════════════════════════════

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

        // Ruler background
        ctx.fillStyle = theme.rulerBg;
        ctx.fillRect(0, 0, vp.viewportWidth, rulerH);

        // Bottom border
        ctx.strokeStyle = theme.trackDivider;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, rulerH);
        ctx.lineTo(vp.viewportWidth, rulerH);
        ctx.stroke();

        // Beat/bar marks
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

            // Bar number
            const barNumber = Math.floor(beat / beatsPerBar) + 1;
            ctx.fillText(String(barNumber), x, 2);

            // Tick mark
            ctx.strokeStyle = theme.rulerText;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(Math.round(x), rulerH - 8);
            ctx.lineTo(Math.round(x), rulerH);
            ctx.stroke();
        }

        // Playhead marker on ruler
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

        // Edit cursor marker on ruler (blinking triangle)
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

        // Loop markers on ruler (triangles with bars)
        if (loop) {
            const lStart = vp.beatsToScreenX(loop.start);
            const lEnd = vp.beatsToScreenX(loop.end);

            ctx.fillStyle = theme.loopBorder;

            // Start marker handle (flag-like)
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
                    // Vertical anchor line on ruler
                    ctx.strokeStyle = theme.loopBorder;
                    ctx.lineWidth = 1.5;
                    ctx.beginPath();
                    ctx.moveTo(lStart, 0);
                    ctx.lineTo(lStart, rulerH);
                    ctx.stroke();
                }
                ctx.restore();
            }

            // End marker handle (flag-like)
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
                    // Vertical anchor line on ruler
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

    // ═══════════════════════════════════════════════════════════════════
    // 4. CLIPS
    // ═══════════════════════════════════════════════════════════════════

    private _drawClips(
        ctx: CanvasRenderingContext2D,
        vp: ViewportMatrix,
        clips: TimelineClipData[],
        range: VisibleRange,
        sampleRate: number,
    ): void {
        // Cull clips outside visible range (with a buffer)
        const bufferBeats = 2;
        const filtered = clips.filter(c => {
            const endBeat = c.startBeat + c.durationBeats;
            if (endBeat < range.startBeat - bufferBeats) return false;
            if (c.startBeat > range.endBeat + bufferBeats) return false;
            if (c.trackIndex < range.startTrack - 1) return false;
            if (c.trackIndex > range.endTrack + 1) return false;
            return true;
        });

        // ── Compute per-track pitch range across ALL MIDI clips ──────
        // This ensures octave differences between clips on the same track
        // are visually represented (higher octave = higher position).
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
        // Enforce minimum range of 12 semitones (1 octave) for readable rendering.
        // Center the padding around the actual note range.
        for (const [, pr] of trackPitchRange) {
            const span = pr.max - pr.min + 1;
            if (span < 12) {
                const pad = Math.ceil((12 - span) / 2);
                pr.min = Math.max(0, pr.min - pad);
                pr.max = Math.min(127, pr.max + pad);
            }
        }

        // Sort: non-selected first, then selected (so selection glow is on top)
        filtered.sort((a, b) => (a.selected ? 1 : 0) - (b.selected ? 1 : 0));

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

        // Skip if completely off-screen
        if (x + w < -10 || x > vp.viewportWidth + 10) return;
        if (y + h < vp.rulerHeight || y > vp.viewportHeight + 10) return;

        ctx.save();

        // Track-muted dimming — significantly reduce opacity for clips on muted tracks
        const isTrackMuted = clip.trackMuted === true;
        if (isTrackMuted) {
            ctx.globalAlpha = 0.25;
        }

        // ── 1. Rounded rectangle path ─────────────────────────────────
        const r = Math.min(CLIP_RADIUS, w / 2, h / 2);
        this._roundRect(ctx, x, y + 1, w, h, r);
        ctx.clip();

        // ── 2. Parse color ────────────────────────────────────────────
        const rgbBase = this._parseColor(clip.color);
        const rgb = clip.muted ? this._toMutedGray(rgbBase) : rgbBase;

        // ── 3. Header band ────────────────────────────────────────────
        const headerH = Math.min(HEADER_HEIGHT, h);
        const headerR = rgb.r, headerG = rgb.g, headerB = rgb.b;
        ctx.fillStyle = `rgba(${headerR}, ${headerG}, ${headerB}, 1)`;
        ctx.fillRect(x, y + 1, w, headerH);

        // Header divider
        const dividerR = Math.max(0, Math.round(rgb.r * 0.72)), dividerG = Math.max(0, Math.round(rgb.g * 0.72)), dividerB = Math.max(0, Math.round(rgb.b * 0.72));
        ctx.strokeStyle = `rgba(${dividerR}, ${dividerG}, ${dividerB}, 0.62)`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, y + 1 + headerH);
        ctx.lineTo(x + w, y + 1 + headerH);
        ctx.stroke();

        // ── 4. Body ───────────────────────────────────────────────────
        if (h > headerH) {
            const bodyR = Math.max(0, Math.round(rgb.r * 0.88)), bodyG = Math.max(0, Math.round(rgb.g * 0.88)), bodyB = Math.max(0, Math.round(rgb.b * 0.88));
            ctx.fillStyle = `rgba(${bodyR}, ${bodyG}, ${bodyB}, 0.92)`;
            ctx.fillRect(x, y + 1 + headerH, w, h - headerH);
        }

        // ── 5. Muted state ────────────────────────────────────────────
        if (clip.muted) {
            ctx.fillStyle = 'rgba(116, 122, 132, 0.42)';
            ctx.fillRect(x, y + 1, w, h);
        }

        // ── 6. Offline indicator (diagonal stripes) ───────────────────
        if (clip.isOffline) {
            this._drawOfflineStripes(ctx, x, y + 1, w, h);
        }

        const bodyY = y + 1 + headerH;
        const bodyH = Math.max(0, h - headerH);

        // ── 7. Waveform or MIDI notes ─────────────────────────────────
        if (bodyH > 8) {

            if (clip.type === 'audio' && clip.durationSamples) {
                this._drawWaveform(ctx, vp, clip, bodyY, bodyH, sampleRate, clip.muted === true || isTrackMuted);
            } else if (clip.type === 'midi' && clip.midiNotes && clip.midiNotes.length > 0) {
                this._drawMidiNotes(ctx, vp, clip, bodyY, bodyH, clip.muted === true || isTrackMuted, trackPitch);
            }
        }

        const showFadeUi = Boolean(clip.hovered);

        // ── 8. Fade overlays ──────────────────────────────────────────
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

        // ── 9. Clip name ──────────────────────────────────────────────
        if (w > 30) {
            ctx.font = '11px Inter, -apple-system, sans-serif';
            const contrastColor = getContrastColor(clip.color);
            const isMutedVisual = clip.muted || isTrackMuted;
            ctx.fillStyle = isMutedVisual
                ? 'rgba(210, 215, 223, 0.95)'
                : (contrastColor === 'black' ? 'rgba(0, 0, 0, 0.85)' : 'rgba(255, 255, 255, 0.9)');
            ctx.textBaseline = 'middle';
            ctx.textAlign = 'left';
            const maxTextW = w - 6;
            const textX = x + 3;
            const textY = y + 1 + headerH / 2;
            ctx.save();
            ctx.beginPath();
            ctx.rect(textX, y + 1, maxTextW, headerH);
            ctx.clip();
            ctx.fillText(clip.name, textX, textY);
            ctx.restore();
        }

        // ── 10. Top highlight (Liquid Glass) ──────────────────────────
        const gradient = ctx.createLinearGradient(x, y + 1, x, y + 4);
        gradient.addColorStop(0, 'rgba(255, 255, 255, 0.25)');
        gradient.addColorStop(1, 'rgba(255, 255, 255, 0.0)');
        ctx.fillStyle = gradient;
        ctx.fillRect(x, y + 1, w, 3);

        ctx.restore();

        // ── 11. Selection glow (drawn OUTSIDE the clip) ───────────────
        if (clip.selected) {
            ctx.save();
            if (isTrackMuted) ctx.globalAlpha = 0.25;
            ctx.strokeStyle = SELECTION_GLOW_COLOR;
            ctx.lineWidth = SELECTION_BORDER_WIDTH;
            ctx.shadowColor = 'rgba(255, 255, 255, 0.5)';
            ctx.shadowBlur = 6;
            this._roundRect(ctx, x, y + 1, w, h, r);
            ctx.stroke();
            ctx.restore();
        }

        // ── 12. Border (non-selected) ─────────────────────────────────
        if (!clip.selected) {
            ctx.save();
            if (isTrackMuted) ctx.globalAlpha = 0.25;
            ctx.strokeStyle = `rgba(${Math.min(255, rgb.r + 60)}, ${Math.min(255, rgb.g + 60)}, ${Math.min(255, rgb.b + 60)}, 0.5)`;
            ctx.lineWidth = 1;
            this._roundRect(ctx, x, y + 1, w, h, r);
            ctx.stroke();
            ctx.restore();
        }

        // ── 13. Fade grab points (on clip body) ───────────────────────
        if (showFadeUi && w >= 14 && bodyH >= 10) {
            const handleY = bodyY + 6;
            const fadeInWidth = w * Math.max(0, Math.min(0.5, clip.fadeIn ?? 0));
            const fadeOutWidth = w * Math.max(0, Math.min(0.5, clip.fadeOut ?? 0));
            const leftX = x + Math.max(4, Math.min(w - 4, fadeInWidth));
            const rightX = x + w - Math.max(4, Math.min(w - 4, fadeOutWidth));

            ctx.save();
            if (isTrackMuted) ctx.globalAlpha = 0.25;
            ctx.fillStyle = clip.selected ? 'rgba(255, 255, 255, 0.98)' : 'rgba(238, 245, 255, 0.9)';
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.65)';
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
                ctx.fillStyle = 'rgba(255, 196, 96, 0.98)';
                ctx.fill();
                ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
                ctx.stroke();
            }

            if (clip.showFadeOutCurvePoint && fadeOutWidth > 0) {
                const pX = x + w - fadeOutWidth * curveOut;
                const pY = bodyY + bodyH * curveOut;
                ctx.beginPath();
                ctx.arc(pX, pY, 3.2, 0, Math.PI * 2);
                ctx.fillStyle = 'rgba(255, 196, 96, 0.98)';
                ctx.fill();
                ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
                ctx.stroke();
            }
            ctx.restore();
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // 5. WAVEFORM DRAWING
    // ═══════════════════════════════════════════════════════════════════

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
        // Guard divide-by-zero: a zero-width viewport hasn't laid out yet.
        if (ppb <= 0) return;
        const clipX = vp.beatsToScreenX(clip.startBeat);
        const clipW = clip.durationBeats * ppb;

        // Calculate samples per pixel for mip-level selection
        const samplesPerBeat = sampleRate * 60 / this._bpm;
        const samplesPerPixel = samplesPerBeat / ppb;

        const drawData = this._waveformCache.getDrawData(
            clip.id,
            samplesPerPixel,
            clip.sourceOffset ?? 0,
            clip.durationSamples,
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
                ? 'rgba(186, 192, 202, 0.72)'
                : 'rgba(162, 168, 178, 0.62)';
        } else {
            ctx.fillStyle = contrastColor === 'black'
                ? (clip.selected ? 'rgba(0, 0, 0, 0.76)' : 'rgba(0, 0, 0, 0.62)')
                : (clip.selected ? 'rgba(255, 255, 255, 0.9)' : 'rgba(255, 255, 255, 0.72)');
        }

        // Map peaks to clip pixel range
        const pixelsPerPeak = clipW / peakCount;

        if (pixelsPerPeak >= 1) {
            // High zoom: draw individual peak bars
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
            // Low zoom: path-based overview
            ctx.beginPath();
            ctx.moveTo(clipX, centerY);

            // Top line (maxima)
            for (let i = 0; i < peakCount; i++) {
                const px = clipX + (i / peakCount) * clipW;
                ctx.lineTo(px, centerY - maxs[i] * halfH);
            }

            // Bottom line (minima, reversed)
            for (let i = peakCount - 1; i >= 0; i--) {
                const px = clipX + (i / peakCount) * clipW;
                ctx.lineTo(px, centerY - mins[i] * halfH);
            }

            ctx.closePath();
            ctx.globalAlpha = 0.6;
            ctx.fill();
            ctx.globalAlpha = 1.0;
        }

        // Center line
        ctx.strokeStyle = muted
            ? 'rgba(132, 138, 148, 0.36)'
            : (contrastColor === 'black' ? 'rgba(0, 0, 0, 0.2)' : 'rgba(255, 255, 255, 0.15)');
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(clipX, centerY);
        ctx.lineTo(clipX + clipW, centerY);
        ctx.stroke();
    }

    // ═══════════════════════════════════════════════════════════════════
    // 6. MIDI NOTE DRAWING
    // ═══════════════════════════════════════════════════════════════════

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

        // Use track-wide pitch range for octave-aware positioning.
        // Notes in higher octaves appear higher, lower octaves appear lower,
        // consistent across all clips on the same track.
        const minPitch = trackPitch?.min ?? 60;
        const maxPitch = trackPitch?.max ?? 72;
        const pitchSlots = Math.max(1, maxPitch - minPitch + 1);

        // Adaptive note height: thicker bars when few pitch slots, thinner when many
        const noteH = Math.max(1, Math.min(4, Math.floor(bodyH / Math.max(1, pitchSlots))));
        const rowGap = pitchSlots > 1
            ? Math.max(0, Math.min(1, (bodyH - pitchSlots * noteH) / (pitchSlots - 1)))
            : 0;
        const contentH = pitchSlots * noteH + Math.max(0, pitchSlots - 1) * rowGap;
        const topOffset = Math.max(0, (bodyH - contentH) / 2);

        const contrastColor = getContrastColor(clip.color);
        ctx.fillStyle = muted
            ? 'rgba(156, 163, 173, 0.62)'
            : (contrastColor === 'black' ? 'rgba(0, 0, 0, 0.5)' : 'rgba(255, 255, 255, 0.5)');

        for (const note of clip.midiNotes) {
            // Clamp pitch to track range to avoid rendering outside clip body
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

    // ═══════════════════════════════════════════════════════════════════
    // 7. PLAYHEAD
    // ═══════════════════════════════════════════════════════════════════

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

        // Subtle glow/shadow for the playhead line
        ctx.save();
        ctx.strokeStyle = theme.playheadGlow;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(Math.round(x), rulerH);
        ctx.lineTo(Math.round(x), canvasH);
        ctx.stroke();
        ctx.restore();

        // Core playhead line (save/restore to avoid leaking strokeStyle/lineWidth)
        ctx.save();
        ctx.strokeStyle = theme.playhead;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(x), rulerH);
        ctx.lineTo(Math.round(x), canvasH);
        ctx.stroke();
        ctx.restore();
    }

    // ═══════════════════════════════════════════════════════════════════
    // 8. EDIT CURSOR
    // ═══════════════════════════════════════════════════════════════════

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

        // Track cursor placement so blink always starts at full brightness.
        if (Math.abs(beat - this._prevEditCursorBeat) > 0.0001) {
            this._editCursorPlacedMs = performance.now();
            this._prevEditCursorBeat = beat;
        }

        // Solid bright white line with slow, smooth breathing alpha.
        // Phase is offset by placement time so the sine wave always
        // starts at its peak (full brightness) when the cursor is moved.
        const elapsed = (performance.now() - this._editCursorPlacedMs) / 1000;
        const blink = 0.22 + 0.68 * (0.5 + 0.5 * Math.cos(elapsed * Math.PI * 0.34));
        ctx.save();
        ctx.setLineDash([]);
        ctx.globalCompositeOperation = 'screen';
        ctx.shadowColor = 'rgba(255, 255, 255, 0.7)';
        ctx.shadowBlur = 3;
        ctx.strokeStyle = `rgba(255, 255, 255, ${blink.toFixed(3)})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cursorX, Math.max(vp.rulerHeight, yStart));
        ctx.lineTo(cursorX, Math.max(vp.rulerHeight, yEnd));
        ctx.stroke();
        ctx.restore();
    }

    // ═══════════════════════════════════════════════════════════════════
    // 9. LOOP REGION
    // ═══════════════════════════════════════════════════════════════════

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

        // Fill overlay
        ctx.fillStyle = theme.loopFill;
        ctx.fillRect(x1, y, x2 - x1, h);

        // Left and right borders
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

    // ═══════════════════════════════════════════════════════════════════
    // 10. DROP TARGET
    // ═══════════════════════════════════════════════════════════════════

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

    // ═══════════════════════════════════════════════════════════════════
    // 11. MARQUEE SELECTION
    // ═══════════════════════════════════════════════════════════════════

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

        // Fill
        ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
        ctx.fillRect(x1, y1, x2 - x1, y2 - y1);

        // Solid white border (force non-dashed + pixel aligned).
        const sx1 = Math.round(x1) + 0.5;
        const sx2 = Math.round(x2) + 0.5;
        const sy1 = Math.round(y1) + 0.5;
        const sy2 = Math.round(y2) + 0.5;
        ctx.save();
        ctx.setLineDash([]);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.78)';
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

    // ═══════════════════════════════════════════════════════════════════
    // 12. GHOST CLIP
    // ═══════════════════════════════════════════════════════════════════

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
            ? 'rgba(100, 200, 255, 0.6)'
            : 'rgba(100, 255, 150, 0.6)';
        this._roundRect(ctx, x, y + 1, w, h, r);
        ctx.fill();

        // Ghost name
        if (w > 30) {
            const ghostColor = ghost.type === 'audio' ? '#64c8ff' : '#64ff96';
            const contrastColor = getContrastColor(ghostColor);
            ctx.fillStyle = contrastColor === 'black' ? 'rgba(0, 0, 0, 0.7)' : 'rgba(255, 255, 255, 0.7)';
            ctx.font = '11px Inter, -apple-system, sans-serif';
            ctx.textBaseline = 'middle';
            ctx.textAlign = 'left';
            const pad = 3;

            // Hard clip text to clip bounds so it never spills visually.
            ctx.save();
            ctx.beginPath();
            ctx.rect(x + pad, y + 1, Math.max(0, w - pad * 2), h);
            ctx.clip();
            if (ghost.name) {
                // Draw raw label and rely on clip bounds, so text uses maximum width
                // instead of collapsing to "x..." too early.
                ctx.fillText(ghost.name, x + pad, y + 1 + h / 2);
            }
            ctx.restore();
        }

        ctx.restore();
    }

    // ═══════════════════════════════════════════════════════════════════
    // UTILITY
    // ═══════════════════════════════════════════════════════════════════

    /** Draw a rounded rectangle path (does NOT stroke or fill). */
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

    /** Parse CSS hex/rgb color string to {r, g, b} with hot-path cache. */
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

    /** Draw diagonal stripes for offline media indicator. */
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

    /** Draw one-sided fade envelope overlay. */
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
            gradient.addColorStop(0, 'rgba(0, 0, 0, 0.58)');
            gradient.addColorStop(0.55, 'rgba(0, 0, 0, 0.22)');
            gradient.addColorStop(1, 'rgba(0, 0, 0, 0.0)');
        } else {
            gradient.addColorStop(0, 'rgba(0, 0, 0, 0.0)');
            gradient.addColorStop(0.45, 'rgba(0, 0, 0, 0.22)');
            gradient.addColorStop(1, 'rgba(0, 0, 0, 0.58)');
        }
        ctx.fillStyle = gradient;
        ctx.fillRect(x, y, w, h);

        const startX = x;
        const endX = x + w;
        const startY = direction === 'in' ? y + h : y;
        const endY = direction === 'in' ? y : y + h;
        const cpX = direction === 'in' ? x + w * t : x + w * (1 - t);
        const cpY = direction === 'in' ? y + h * (1 - t) : y + h * t;
        ctx.strokeStyle = 'rgba(255, 193, 92, 0.96)';
        ctx.shadowColor = 'rgba(255, 190, 85, 0.32)';
        ctx.shadowBlur = 3;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(startX, startY);
        ctx.quadraticCurveTo(cpX, cpY, endX, endY);
        ctx.stroke();

        ctx.restore();
    }
}
