/**
 * BUG-076–080: Unified error message extraction utility.
 *
 * Provides consistent error-to-string conversion across the entire codebase.
 * Replaces inconsistent patterns like `String(e)`, `err instanceof Error ? err.message : String(err)`, etc.
 */

/**
 * Extracts a human-readable error message from any thrown value.
 *
 * @param err - The caught error value (can be Error, string, unknown).
 * @param fallback - Fallback message if extraction fails.
 * @returns A clean, user-facing error string.
 */
export function toErrorMessage(err: unknown, fallback = 'Unknown error'): string {
    if (err instanceof Error) return err.message;
    if (typeof err === 'string') return err;
    if (err != null && typeof (err as Record<string, unknown>).message === 'string') {
        return (err as Record<string, unknown>).message as string;
    }
    try {
        const str = String(err);
        return str === '[object Object]' ? fallback : str;
    } catch {
        return fallback;
    }
}
