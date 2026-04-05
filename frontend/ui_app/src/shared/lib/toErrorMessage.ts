/**
 * BUG-076–080: Unified error message extraction utility.
 *
 * Provides consistent error-to-string conversion across the entire codebase.
 * Replaces inconsistent patterns like `String(e)`, `err instanceof Error ? err.message : String(err)`, etc.
 */

/** ENTERPRISE TYPE GUARD: Safely narrows `unknown` to an error-like object with `message` and optional `name`. */
function isErrorLike(err: unknown): err is { message: string; name?: string } {
    return (
        err != null &&
        typeof err === 'object' &&
        'message' in err &&
        typeof (err as { message: unknown }).message === 'string'
    );
}

/**
 * Extracts a human-readable error message from any thrown value.
 *
 * @param err - The caught error value (can be Error, string, unknown).
 * @param fallback - Fallback message if extraction fails.
 * @returns A clean, user-facing error string.
 */
export function toErrorMessage(err: unknown, fallback = 'Unknown error'): string {
    if (err instanceof Error) {
        return err.name && err.name !== 'Error' ? `${err.name}: ${err.message}` : err.message;
    }
    if (typeof err === 'string') return err;
    if (isErrorLike(err)) {
        const name = err.name;
        if (typeof name === 'string' && name && name !== 'Error') {
            return `${name}: ${err.message}`;
        }
        return err.message;
    }
    try {
        const str = String(err);
        return str === '[object Object]' ? fallback : str;
    } catch {
        return fallback;
    }
}
