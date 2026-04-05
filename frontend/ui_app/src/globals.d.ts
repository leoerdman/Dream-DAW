// ═══════════════════════════════════════════════════════════════
// Dream DAW — Global Type Declarations
// ═══════════════════════════════════════════════════════════════

// Auto-version plugin injects this at compile time (semver: "0.1.5")
declare const __APP_VERSION__: string

interface Window {
    __dreamInAppDrag?: boolean;
    __dreamFlushPendingEdits?: () => Promise<void>;
    __dreamSelectedTrackId?: string;
    __dreamOpenExportModal?: () => void;
    __dreamSaveProject?: () => Promise<void>;
    __dreamSaveAsProject?: () => Promise<void>;
    // BUG-056 FIX: Declared here so Tauri guards don't need `as any` casts.
    __TAURI__?: unknown;
    __TAURI_INTERNALS__?: unknown;
    // Web Speech API — may not exist in all WebView environments.
    SpeechRecognition?: new () => unknown;
    webkitSpeechRecognition?: new () => unknown;
}

declare module 'lodash.throttle' {
    export type ThrottledFunc<T extends (...args: unknown[]) => unknown> = T & {
        cancel: () => void;
        flush: () => ReturnType<T> | undefined;
    };
    export interface ThrottleOptions {
        leading?: boolean;
        trailing?: boolean;
    }
    export default function throttle<A extends unknown[], R>(
        func: (...args: A) => R,
        wait?: number,
        options?: ThrottleOptions,
    ): ThrottledFunc<(...args: A) => R>;
}

// ═══════════════════════════════════════════════════════════════
// BUG-A036 FIX: Minimal WebGPU type stubs
// Only the APIs actually used by Dream DAW's PianoRoll GPU renderer.
// Replace with `@webgpu/types` when WebGPU stabilizes in WKWebView.
// ═══════════════════════════════════════════════════════════════

type GPUTextureFormat = string;

interface GPUBuffer {
    destroy(): void;
}

interface GPUDevice {
    createShaderModule(descriptor: { code: string }): GPUShaderModule;
    createRenderPipeline(descriptor: Record<string, unknown>): GPURenderPipeline;
    createBuffer(descriptor: { size: number; usage: number; mappedAtCreation?: boolean }): GPUBuffer;
    createCommandEncoder(): GPUCommandEncoder;
    queue: GPUQueue;
}

interface GPUShaderModule { }

interface GPURenderPipeline { }

interface GPUQueue {
    writeBuffer(buffer: GPUBuffer, offset: number, data: Float32Array): void;
    submit(commandBuffers: GPUCommandBuffer[]): void;
}

interface GPUCommandEncoder {
    beginRenderPass(descriptor: Record<string, unknown>): GPURenderPassEncoder;
    finish(): GPUCommandBuffer;
}

interface GPUCommandBuffer { }

interface GPURenderPassEncoder {
    setPipeline(pipeline: GPURenderPipeline): void;
    setVertexBuffer(slot: number, buffer: GPUBuffer): void;
    draw(vertexCount: number, instanceCount?: number, firstVertex?: number, firstInstance?: number): void;
    end(): void;
}

interface GPUCanvasContext {
    configure(config: { device: GPUDevice; format: GPUTextureFormat; alphaMode?: string }): void;
    getCurrentTexture(): GPUTexture;
}

interface GPUTexture {
    createView(): GPUTextureView;
}

interface GPUTextureView { }

interface GPUAdapter {
    requestDevice(): Promise<GPUDevice>;
}

interface GPU {
    requestAdapter(): Promise<GPUAdapter | null>;
    getPreferredCanvasFormat(): GPUTextureFormat;
}

interface Navigator {
    gpu?: GPU;
}
