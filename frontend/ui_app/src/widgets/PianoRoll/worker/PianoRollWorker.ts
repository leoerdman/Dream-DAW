// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — PianoRoll OffscreenCanvas Worker
// ═══════════════════════════════════════════════════════════════════════════
//
// Runs the WebGL2 PianoRollGLRenderer on an OffscreenCanvas in a separate
// thread. The main thread communicates via postMessage with typed messages.
//
// This isolates all rendering from React's reconciliation cycle:
// - Grid drawing (procedural shader) → zero DOM elements
// - Note instancing → one GPU draw call for 10K+ notes
// - Playhead animation at 60fps without main thread involvement
//
// Render loop modes:
// - CONTINUOUS: When playhead is visible, rAF loops every frame (60fps)
// - ON-DEMAND:  When stopped, render only when state changes (dirty flag)
//
// ═══════════════════════════════════════════════════════════════════════════

import { PianoRollGLRenderer, type GridStyle, type ViewState } from './PianoRollGLRenderer';

// ── Message Types ───────────────────────────────────────────────────────

export type WorkerInMessage =
    | { type: 'init'; canvas: OffscreenCanvas; dpr: number }
    | { type: 'resize'; width: number; height: number; dpr: number }
    | { type: 'updateNotes'; data: Float32Array }
    | { type: 'updateView'; view: Partial<ViewState> }
    | { type: 'updateStyle'; style: Partial<GridStyle> }
    | { type: 'destroy' };

export type WorkerOutMessage =
    | { type: 'ready' }
    | { type: 'error'; message: string };

// ── Worker State ────────────────────────────────────────────────────────

let renderer: PianoRollGLRenderer | null = null;
let canvas: OffscreenCanvas | null = null;
let animFrameId: number | null = null;
let needsRedraw = true;
let continuousMode = false; // true when playhead is visible

function scheduleRender(): void {
    needsRedraw = true;
    if (animFrameId === null) {
        animFrameId = requestAnimationFrame(renderLoop);
    }
}

function renderLoop(): void {
    animFrameId = null;

    if (!renderer) return;

    if (needsRedraw) {
        needsRedraw = false;
        renderer.render();
    }

    // If playhead is visible, keep the loop running for smooth animation.
    // Otherwise, stop and wait for the next dirty flag.
    if (continuousMode) {
        animFrameId = requestAnimationFrame(renderLoop);
    }
}

// ── Message Handler ─────────────────────────────────────────────────────

self.onmessage = (event: MessageEvent<WorkerInMessage>) => {
    const msg = event.data;

    switch (msg.type) {
        case 'init': {
            try {
                canvas = msg.canvas;
                const dpr = msg.dpr || 1;
                canvas.width = Math.ceil(canvas.width * dpr);
                canvas.height = Math.ceil(canvas.height * dpr);

                const gl = canvas.getContext('webgl2', {
                    alpha: false,
                    antialias: false,
                    desynchronized: true,
                    powerPreference: 'high-performance',
                });

                if (!gl) {
                    (self as unknown as Worker).postMessage({
                        type: 'error',
                        message: 'WebGL2 not available',
                    } satisfies WorkerOutMessage);
                    return;
                }

                renderer = new PianoRollGLRenderer(gl);
                renderer.setView({ dpr });

                (self as unknown as Worker).postMessage({
                    type: 'ready',
                } satisfies WorkerOutMessage);
                scheduleRender();
            } catch (err) {
                (self as unknown as Worker).postMessage({
                    type: 'error',
                    message: String(err),
                } satisfies WorkerOutMessage);
            }
            break;
        }

        case 'resize': {
            if (canvas && renderer) {
                const dpr = msg.dpr || 1;
                canvas.width = Math.ceil(msg.width * dpr);
                canvas.height = Math.ceil(msg.height * dpr);
                renderer.setView({
                    canvasWidth: canvas.width,
                    canvasHeight: canvas.height,
                    dpr,
                });
                scheduleRender();
            }
            break;
        }

        case 'updateNotes': {
            if (renderer) {
                renderer.uploadNotes(msg.data);
                scheduleRender();
            }
            break;
        }

        case 'updateView': {
            if (renderer) {
                renderer.setView(msg.view);

                // Enable continuous mode when playhead is visible
                const playheadX = msg.view.playheadX;
                const shouldContinue = playheadX !== undefined && playheadX >= 0;
                if (shouldContinue !== continuousMode) {
                    continuousMode = shouldContinue;
                    if (continuousMode && animFrameId === null) {
                        animFrameId = requestAnimationFrame(renderLoop);
                    }
                }

                scheduleRender();
            }
            break;
        }

        case 'updateStyle': {
            if (renderer) {
                renderer.setStyle(msg.style);
                scheduleRender();
            }
            break;
        }

        case 'destroy': {
            continuousMode = false;
            if (animFrameId !== null) {
                cancelAnimationFrame(animFrameId);
                animFrameId = null;
            }
            renderer?.destroy();
            renderer = null;
            canvas = null;
            break;
        }
    }
};
