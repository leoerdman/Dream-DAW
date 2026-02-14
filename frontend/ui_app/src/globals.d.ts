// ═══════════════════════════════════════════════════════════════
// Dream DAW — Global Type Declarations
// ═══════════════════════════════════════════════════════════════

// Auto-version plugin injects these at compile time
declare const __APP_VERSION__: string       // "0.1.0 (Build 42)"
declare const __APP_VERSION_SHORT__: string // "0.1.0"
declare const __APP_BUILD__: number         // 42

interface Window {
    __dreamInAppDrag?: boolean;
    __dreamFlushPendingEdits?: () => Promise<void>;
}

declare module 'lodash.throttle' {
    export type ThrottledFunc<T extends (...args: unknown[]) => unknown> = T & {
        cancel: () => void;
        flush: () => ReturnType<T> | undefined;
    };
    export default function throttle<A extends unknown[], R>(
        func: (...args: A) => R,
        wait?: number,
    ): ThrottledFunc<(...args: A) => R>;
}
