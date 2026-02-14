// ═══════════════════════════════════════════════════════════════
// Dream DAW — Global Type Declarations
// ═══════════════════════════════════════════════════════════════

// Auto-version plugin injects these at compile time
declare const __APP_VERSION__: string       // "0.1.0 (Build 42)"
declare const __APP_VERSION_SHORT__: string // "0.1.0"
declare const __APP_BUILD__: number         // 42

declare module 'lodash.throttle' {
    export type ThrottledFunc<T extends (...args: any[]) => any> = T & { cancel: () => void; flush: () => ReturnType<T> | undefined };
    export default function throttle<T extends (...args: any[]) => any>(func: T, wait?: number): ThrottledFunc<T>;
}
