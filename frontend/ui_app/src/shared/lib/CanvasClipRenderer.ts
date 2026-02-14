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
    filePath?: string;
    durationSamples?: number;
    sourceOffset?: number;
    fadeIn?: number;
    fadeOut?: number;
    fadeInCurve?: number;
    fadeOutCurve?: number;
    isOffline?: boolean;
    muted?: boolean;
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

const HEADER_HEIGHT = 22;
const CLIP_RADIUS = 5;
const CLIP_BODY_ALPHA = 0.65;
const CLIP_HEADER_ALPHA = 1.0;
const SELECTION_BORDER_WIDTH = 2;
const SELECTION_GLOW_COLOR = 'rgba(255, 255, 255, 0.9)';
const DROP_TARGET_COLOR = 'rgba(255, 255, 255, 0.2)';
const DROP_TARGET_BORDER = 'rgba(255, 255, 255, 0.6)';
const GHOST_CLIP_ALPHA = 0.45;
const WAVEFORM_COLOR = 'rgba(255, 255, 255, 0.7)';
const WAVEFORM_COLOR_SELECTED = 'rgba(255, 255, 255, 0.9)';
const MIDI_NOTE_COLOR = 'rgba(255, 255, 255, 0.5)';
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
        editCursorTrack: number,
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

        this._drawTrackBackgrounds(ctx, vp, theme, editCursorTrack);
        this._drawGrid(ctx, vp, range, beatsPerBar, snapBeats, theme);
        this._drawLoopRegion(ctx, vp, loop, theme);
        this._drawClips(ctx, vp, clips, range, sampleRate);
        this._drawMarquee(ctx, vp, marquee);
        this._drawDropTarget(ctx, vp, dropTarget);
        this._drawGhostClip(ctx, vp, ghost);
        this._drawPlayhead(ctx, vp, playheadBeat, h, theme);
        this._drawEditCursor(ctx, vp, editCursorBeat, editCursorTrack, theme);

        ctx.restore();

        // Draw ruler on top (always visible)
        this._drawRuler(ctx, vp, range, beatsPerBar, playheadBeat, editCursorBeat, loop, theme);

        ctx.restore(); // ← Pop DPR scale (matches ctx.save() above)
    }

    private _drawTrackBackgrounds(ctx: CanvasRenderingContext2D, vp: ViewportMatrix, theme: TimelineTheme, selectedTrack: number): void {
        const rulerH = vp.rulerHeight;
        const trackH = vp.trackHeight;

        // Fill the entire track area with the default track color
        ctx.fillStyle = theme.trackDefault;
        ctx.fillRect(0, rulerH, vp.viewportWidth, vp.viewportHeight - rulerH);

        // Highlight only the selected track
        if (selectedTrack >= 0) {
            const y = rulerH + selectedTrack * trackH - vp.scrollY;
            if (y + trackH >= rulerH && y <= vp.viewportHeight) {
                ctx.fillStyle = theme.trackSelected;
                ctx.fillRect(0, Math.max(rulerH, y), vp.viewportWidth, trackH);
            }
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
        const ppb = vp.pixelsPerBeat;
        const trackH = vp.trackHeight;
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

        // ── Horizontal track dividers (+1 for master track) ────────────
        ctx.strokeStyle = theme.trackDivider;
        ctx.lineWidth = 1;
        for (let i = 0; i <= vp.trackCount + 1; i++) {
            const y = rulerH + i * trackH - vp.scrollY;
            if (y < rulerH - 1 || y > vp.viewportHeight + 1) continue;
            ctx.beginPath();
            ctx.moveTo(0, Math.round(y));
            ctx.lineTo(vp.viewportWidth, Math.round(y));
            ctx.stroke();
        }
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
        ctx.textBaseline = 'bottom';
        ctx.textAlign = 'center';

        const startMark = Math.floor(range.startBeat / markStep) * markStep;
        const endMark = Math.ceil(range.endBeat / markStep) * markStep;

        for (let beat = startMark; beat <= endMark; beat += markStep) {
            const x = vp.beatsToScreenX(beat);
            if (x < -50 || x > vp.viewportWidth + 10) continue;

            // Bar number
            const barNumber = Math.floor(beat / beatsPerBar) + 1;
            ctx.fillText(String(barNumber), x, rulerH - 4);

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

        // Sort: non-selected first, then selected (so selection glow is on top)
        filtered.sort((a, b) => (a.selected ? 1 : 0) - (b.selected ? 1 : 0));

        for (const clip of filtered) {
            this._drawSingleClip(ctx, vp, clip, sampleRate);
        }
    }

    private _drawSingleClip(
        ctx: CanvasRenderingContext2D,
        vp: ViewportMatrix,
        clip: TimelineClipData,
        sampleRate: number,
    ): void {
        const ppb = vp.pixelsPerBeat;
        const trackH = vp.trackHeight;

        const x = vp.beatsToScreenX(clip.startBeat);
        const y = vp.rulerHeight + clip.trackIndex * trackH - vp.scrollY;
        const w = clip.durationBeats * ppb;
        const h = trackH - 2; // 1px gap top and bottom

        // Skip if completely off-screen
        if (x + w < -10 || x > vp.viewportWidth + 10) return;
        if (y + h < vp.rulerHeight || y > vp.viewportHeight + 10) return;

        ctx.save();

        // ── 1. Rounded rectangle path ─────────────────────────────────
        const r = Math.min(CLIP_RADIUS, w / 2, h / 2);
        this._roundRect(ctx, x, y + 1, w, h, r);
        ctx.clip();

        // ── 2. Parse color ────────────────────────────────────────────
        const rgb = this._parseColor(clip.color);

        // ── 3. Header band ────────────────────────────────────────────
        const headerH = Math.min(HEADER_HEIGHT, h);
        ctx.fillStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${CLIP_HEADER_ALPHA})`;
        ctx.fillRect(x, y + 1, w, headerH);

        // Header divider
        ctx.strokeStyle = `rgba(${Math.max(0, rgb.r - 50)}, ${Math.max(0, rgb.g - 50)}, ${Math.max(0, rgb.b - 50)}, 0.6)`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, y + 1 + headerH);
        ctx.lineTo(x + w, y + 1 + headerH);
        ctx.stroke();

        // ── 4. Body ───────────────────────────────────────────────────
        if (h > headerH) {
            ctx.fillStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${CLIP_BODY_ALPHA})`;
            ctx.fillRect(x, y + 1 + headerH, w, h - headerH);
        }

        // ── 5. Muted state ────────────────────────────────────────────
        if (clip.muted) {
            ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
            ctx.fillRect(x, y + 1, w, h);
        }

        // ── 6. Offline indicator (diagonal stripes) ───────────────────
        if (clip.isOffline) {
            this._drawOfflineStripes(ctx, x, y + 1, w, h);
        }

        // ── 7. Waveform or MIDI notes ─────────────────────────────────
        if (h > headerH + 8) {
            const bodyY = y + 1 + headerH;
            const bodyH = h - headerH;

            if (clip.type === 'audio' && clip.filePath && clip.durationSamples) {
                this._drawWaveform(ctx, vp, clip, bodyY, bodyH, sampleRate);
            } else if (clip.type === 'midi' && clip.midiNotes && clip.midiNotes.length > 0) {
                this._drawMidiNotes(ctx, vp, clip, bodyY, bodyH);
            }
        }

        // ── 8. Fade overlays ──────────────────────────────────────────
        if (clip.fadeIn && clip.fadeIn > 0) {
            this._drawFade(
                ctx,
                x,
                y + 1,
                w * clip.fadeIn,
                h,
                'in',
                clip.fadeInCurve ?? 0.5,
            );
        }
        if (clip.fadeOut && clip.fadeOut > 0) {
            this._drawFade(
                ctx,
                x + w - w * clip.fadeOut,
                y + 1,
                w * clip.fadeOut,
                h,
                'out',
                clip.fadeOutCurve ?? 0.5,
            );
        }

        // ── 9. Clip name ──────────────────────────────────────────────
        if (w > 30) {
            ctx.font = '11px Inter, -apple-system, sans-serif';
            ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
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
            ctx.strokeStyle = `rgba(${Math.min(255, rgb.r + 60)}, ${Math.min(255, rgb.g + 60)}, ${Math.min(255, rgb.b + 60)}, 0.5)`;
            ctx.lineWidth = 1;
            this._roundRect(ctx, x, y + 1, w, h, r);
            ctx.stroke();
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
    ): void {
        if (!clip.filePath || !clip.durationSamples) return;

        const ppb = vp.pixelsPerBeat;
        const clipX = vp.beatsToScreenX(clip.startBeat);
        const clipW = clip.durationBeats * ppb;

        // Calculate samples per pixel for mip-level selection
        const samplesPerBeat = sampleRate * 60 / this._bpm;
        const samplesPerPixel = samplesPerBeat / ppb;

        const drawData = this._waveformCache.getDrawData(
            clip.filePath,
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

        ctx.fillStyle = clip.selected ? WAVEFORM_COLOR_SELECTED : WAVEFORM_COLOR;

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
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
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
    ): void {
        if (!clip.midiNotes || clip.midiNotes.length === 0) return;

        const ppb = vp.pixelsPerBeat;
        const clipX = vp.beatsToScreenX(clip.startBeat);

        // Find pitch range
        let minPitch = 127, maxPitch = 0;
        for (const note of clip.midiNotes) {
            if (note.pitch < minPitch) minPitch = note.pitch;
            if (note.pitch > maxPitch) maxPitch = note.pitch;
        }
        const pitchRange = Math.max(1, maxPitch - minPitch + 1);
        const noteH = Math.max(1, Math.min(4, bodyH / pitchRange));

        ctx.fillStyle = MIDI_NOTE_COLOR;

        for (const note of clip.midiNotes) {
            const noteX = clipX + note.startBeat * ppb;
            const noteW = Math.max(1, note.durationBeats * ppb);
            const pitchFrac = 1 - (note.pitch - minPitch) / pitchRange;
            const noteY = bodyY + pitchFrac * (bodyH - noteH);

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

        // Core playhead line
        ctx.strokeStyle = theme.playhead;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(Math.round(x), rulerH);
        ctx.lineTo(Math.round(x), canvasH);
        ctx.stroke();
    }

    // ═══════════════════════════════════════════════════════════════════
    // 8. EDIT CURSOR
    // ═══════════════════════════════════════════════════════════════════

    private _drawEditCursor(
        ctx: CanvasRenderingContext2D,
        vp: ViewportMatrix,
        beat: number,
        track: number,
        theme: TimelineTheme,
    ): void {
        if (beat < 0) return; // Hidden when clip is selected (mutual exclusivity)
        const x = vp.beatsToScreenX(beat);
        if (x < -2 || x > vp.viewportWidth + 2) return;

        const y = vp.rulerHeight + track * vp.trackHeight - vp.scrollY;

        // Thin white line across selected track with slow, smooth breathing alpha.
        const t = performance.now() / 1000;
        const blink = 0.52 + 0.28 * (0.5 + 0.5 * Math.sin(t * Math.PI * 0.6));
        ctx.strokeStyle = theme.editCursor.replace(/[\d.]+\)$/, `${blink.toFixed(3)})`); // Dynamic alpha
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(Math.round(x), Math.max(vp.rulerHeight, y));
        ctx.lineTo(Math.round(x), y + vp.trackHeight);
        ctx.stroke();
        ctx.setLineDash([]);
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
        const y = vp.rulerHeight + target.track * vp.trackHeight - vp.scrollY;
        const w = vp.pixelsPerBeat * 4; // 1 bar default width
        const h = vp.trackHeight;

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
        const y1 = vp.rulerHeight + minTrack * vp.trackHeight - vp.scrollY;
        const y2 = vp.rulerHeight + (maxTrack + 1) * vp.trackHeight - vp.scrollY;

        // Fill
        ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
        ctx.fillRect(x1, y1, x2 - x1, y2 - y1);

        // Dashed border
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
        ctx.setLineDash([]);
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
        const y = vp.rulerHeight + ghost.trackIndex * vp.trackHeight - vp.scrollY;
        const w = ghost.widthBeats * vp.pixelsPerBeat;
        const h = vp.trackHeight - 2;
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
            ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
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

    /** Parse CSS hex/rgb color string to {r, g, b}. */
    private _parseColor(color: string): { r: number; g: number; b: number } {
        if (color.startsWith('#')) {
            const hex = color.slice(1);
            const bigint = parseInt(hex, 16);
            if (hex.length === 6) {
                return {
                    r: (bigint >> 16) & 255,
                    g: (bigint >> 8) & 255,
                    b: bigint & 255,
                };
            }
            if (hex.length === 3) {
                return {
                    r: ((bigint >> 8) & 15) * 17,
                    g: ((bigint >> 4) & 15) * 17,
                    b: (bigint & 15) * 17,
                };
            }
        }
        // Fallback: try rgb()
        const match = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
        if (match) {
            return { r: +match[1], g: +match[2], b: +match[3] };
        }
        // Default to a neutral blue
        return { r: 80, g: 120, b: 200 };
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

    /** Draw fade overlay (linear gradient). */
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
            gradient.addColorStop(0, 'rgba(0, 0, 0, 0.6)');
            gradient.addColorStop(1, 'rgba(0, 0, 0, 0.0)');
        } else {
            gradient.addColorStop(0, 'rgba(0, 0, 0, 0.0)');
            gradient.addColorStop(1, 'rgba(0, 0, 0, 0.6)');
        }
        ctx.fillStyle = gradient;
        ctx.fillRect(x, y, w, h);

        const cpX = direction === 'in' ? x + w * t : x + w * (1 - t);
        const startX = direction === 'in' ? x : x + w;
        const endX = direction === 'in' ? x + w : x;
        ctx.strokeStyle = 'rgba(255, 190, 85, 0.9)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(startX, y + h);
        ctx.quadraticCurveTo(cpX, y, endX, y + h);
        ctx.stroke();

        ctx.restore();
    }
}
