// ═══════════════════════════════════════════════════════════════
// Dream DAW — Global Type Declarations
// ═══════════════════════════════════════════════════════════════

// Auto-version plugin injects this at compile time (semver: "0.1.5")
declare const __APP_VERSION__: string

interface Window {
    __dreamInAppDrag?: boolean;
    __dreamFlushPendingEdits?: () => Promise<void>;
    __dreamSelectedTrackId?: string;
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
