/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { MidiNote } from '@/widgets/PianoRoll/model/pianoRollConfig';

type GpuState = {
    device: any;
    context: any;
    pipeline: any;
    format: string;
    buffer: any | null;
};
const GPU_BUFFER_USAGE_VERTEX = 0x0020;
const GPU_BUFFER_USAGE_COPY_DST = 0x0008;

function parseColorToRgb(input: string): [number, number, number] {
    const raw = (input ?? '').trim();
    const resolved = raw.startsWith('var(')
        ? (() => {
            const varName = raw.slice(4, -1).trim();
            return getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
        })()
        : raw;
    if (/^#[0-9a-f]{6}$/i.test(resolved)) {
        const c = resolved.replace('#', '');
        return [
            Number.parseInt(c.slice(0, 2), 16) / 255,
            Number.parseInt(c.slice(2, 4), 16) / 255,
            Number.parseInt(c.slice(4, 6), 16) / 255,
        ];
    }
    const rgb = resolved.match(/^rgba?\((.+)\)$/i);
    if (rgb) {
        const parts = rgb[1].split(/[,\s/]+/).filter(Boolean).slice(0, 3).map(Number.parseFloat);
        if (parts.length === 3 && parts.every(Number.isFinite)) {
            return [parts[0] / 255, parts[1] / 255, parts[2] / 255];
        }
    }
    return [0.29, 0.62, 1.0];
}

function pushQuad(
    out: number[],
    canvasWidth: number,
    canvasHeight: number,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
    g: number,
    b: number,
    a: number,
): void {
    const x0 = (x / canvasWidth) * 2 - 1;
    const x1 = ((x + w) / canvasWidth) * 2 - 1;
    const y0 = 1 - (y / canvasHeight) * 2;
    const y1 = 1 - ((y + h) / canvasHeight) * 2;
    out.push(
        x0, y0, r, g, b, a,
        x1, y0, r, g, b, a,
        x0, y1, r, g, b, a,
        x1, y0, r, g, b, a,
        x1, y1, r, g, b, a,
        x0, y1, r, g, b, a,
    );
}

export interface UsePianoRollWebGPUCanvasEngineProps {
    notes: MidiNote[];
    ghostNotes: MidiNote[];
    selectedNotes: Set<string>;
    canvasWidth: number;
    canvasHeight: number;
    pixelsPerBeat: number;
    noteHeight: number;
    color: string;
    pitchToY: (pitch: number) => number;
}

export function usePianoRollWebGPUCanvasEngine({
    notes,
    ghostNotes,
    selectedNotes,
    canvasWidth,
    canvasHeight,
    pixelsPerBeat,
    noteHeight,
    color,
    pitchToY,
}: UsePianoRollWebGPUCanvasEngineProps) {
    const gpuCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const gpuRef = useRef<GpuState | null>(null);
    const [active, setActive] = useState(false);
    const canInit = canvasWidth > 0 && canvasHeight > 0;

    const baseColor = useMemo(() => parseColorToRgb(color), [color]);

    useEffect(() => {
        let disposed = false;
        const init = async () => {
            const canvas = gpuCanvasRef.current;
            const navGpu = (navigator as Navigator & { gpu?: any }).gpu;
            if (!canInit || !canvas || !navGpu) {
                setActive(false);
                return;
            }
            try {
                const adapter = await navGpu.requestAdapter();
                if (!adapter || disposed) {
                    setActive(false);
                    return;
                }
                const device = await adapter.requestDevice();
                if (disposed) return;
                const context = canvas.getContext('webgpu') as GPUCanvasContext | null;
                if (!context) {
                    setActive(false);
                    return;
                }
                const format = navGpu.getPreferredCanvasFormat();
                const dpr = window.devicePixelRatio || 1;
                canvas.width = Math.max(1, Math.ceil(canvasWidth * dpr));
                canvas.height = Math.max(1, Math.ceil(canvasHeight * dpr));
                canvas.style.width = `${canvasWidth}px`;
                canvas.style.height = `${canvasHeight}px`;
                context.configure({
                    device,
                    format,
                    alphaMode: 'premultiplied',
                });

                const shader = device.createShaderModule({
                    code: `
                        struct VertexOut {
                            @builtin(position) position : vec4<f32>,
                            @location(0) color : vec4<f32>,
                        };
                        @vertex
                        fn vs_main(@location(0) pos : vec2<f32>, @location(1) color : vec4<f32>) -> VertexOut {
                            var out : VertexOut;
                            out.position = vec4<f32>(pos, 0.0, 1.0);
                            out.color = color;
                            return out;
                        }
                        @fragment
                        fn fs_main(@location(0) color : vec4<f32>) -> @location(0) vec4<f32> {
                            return color;
                        }
                    `,
                });

                const pipeline = device.createRenderPipeline({
                    layout: 'auto',
                    vertex: {
                        module: shader,
                        entryPoint: 'vs_main',
                        buffers: [{
                            arrayStride: 24,
                            attributes: [
                                { shaderLocation: 0, offset: 0, format: 'float32x2' },
                                { shaderLocation: 1, offset: 8, format: 'float32x4' },
                            ],
                        }],
                    },
                    fragment: {
                        module: shader,
                        entryPoint: 'fs_main',
                        targets: [{ format }],
                    },
                    primitive: { topology: 'triangle-list' },
                });

                gpuRef.current = { device, context, pipeline, format, buffer: null };
                setActive(true);
            } catch (err) {
                // BUG-H02 FIX: Log error instead of silently swallowing.
                // Blank PianoRoll canvas was impossible to diagnose without this.
                console.warn('[Dream] PianoRoll GPU init failed, falling back to Canvas2D:', err);
                setActive(false);
            }
        };
        void init();
        return () => {
            disposed = true;
            if (gpuRef.current?.buffer) gpuRef.current.buffer.destroy();
            gpuRef.current = null;
        };
    }, [canInit, canvasHeight, canvasWidth]);

    useEffect(() => {
        const gpu = gpuRef.current;
        const canvas = gpuCanvasRef.current;
        if (!active || !gpu || !canvas || canvasWidth <= 0 || canvasHeight <= 0) return;
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.max(1, Math.ceil(canvasWidth * dpr));
        canvas.height = Math.max(1, Math.ceil(canvasHeight * dpr));
        canvas.style.width = `${canvasWidth}px`;
        canvas.style.height = `${canvasHeight}px`;
        gpu.context.configure({
            device: gpu.device,
            format: gpu.format,
            alphaMode: 'premultiplied',
        });
    }, [active, canvasWidth, canvasHeight]);

    useEffect(() => {
        const gpu = gpuRef.current;
        if (!active || !gpu || canvasWidth <= 0 || canvasHeight <= 0) return;

        const vertices: number[] = [];
        for (const note of ghostNotes) {
            const x = note.startBeat * pixelsPerBeat;
            const y = pitchToY(note.pitch);
            if (y < 0) continue;
            const w = Math.max(3, note.durationBeats * pixelsPerBeat);
            const h = Math.max(1, noteHeight);
            pushQuad(vertices, canvasWidth, canvasHeight, x, y, w, h, 0.56, 0.66, 0.86, 0.14);
        }

        for (const note of notes) {
            const x = note.startBeat * pixelsPerBeat;
            const y = pitchToY(note.pitch);
            if (y < 0) continue;
            const w = Math.max(4, note.durationBeats * pixelsPerBeat);
            const h = Math.max(1, noteHeight);
            const vel = Math.max(0.15, Math.min(1, 0.15 + (note.velocity / 127) * 0.85));
            const selectedBoost = selectedNotes.has(note.id) ? 0.2 : 0;
            pushQuad(
                vertices,
                canvasWidth,
                canvasHeight,
                x,
                y,
                w,
                h,
                Math.min(1, baseColor[0] + selectedBoost),
                Math.min(1, baseColor[1] + selectedBoost),
                Math.min(1, baseColor[2] + selectedBoost),
                vel,
            );
        }

        const data = new Float32Array(vertices);
        if (gpu.buffer) gpu.buffer.destroy();
        gpu.buffer = gpu.device.createBuffer({
            size: Math.max(4, data.byteLength),
            usage: GPU_BUFFER_USAGE_VERTEX | GPU_BUFFER_USAGE_COPY_DST,
            mappedAtCreation: false,
        });
        gpu.device.queue.writeBuffer(gpu.buffer, 0, data);

        const encoder = gpu.device.createCommandEncoder();
        const view = gpu.context.getCurrentTexture().createView();
        const pass = encoder.beginRenderPass({
            colorAttachments: [{
                view,
                clearValue: { r: 0, g: 0, b: 0, a: 0 },
                loadOp: 'clear',
                storeOp: 'store',
            }],
        });
        pass.setPipeline(gpu.pipeline);
        pass.setVertexBuffer(0, gpu.buffer);
        pass.draw(data.length / 6, 1, 0, 0);
        pass.end();
        gpu.device.queue.submit([encoder.finish()]);
    }, [active, baseColor, canvasWidth, canvasHeight, ghostNotes, noteHeight, notes, pixelsPerBeat, pitchToY, selectedNotes]);

    return {
        gpuCanvasRef,
        webGpuActive: active,
    };
}
