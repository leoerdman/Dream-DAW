/**
 * ═══════════════════════════════════════════════════════════════════════
 * Enterprise Track Height Level System
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Defines discrete track height levels for snapped resizing.
 * Tracks snap between these levels during drag and Option+Scroll resize.
 * Each level progressively reveals more controls in the track row.
 *
 *   Level 1 (32px)  — Compact: name + M/S + VU
 *   Level 2 (48px)  — Default: + volume/pan faders + output routing
 *   Level 3 (72px)  — Expanded: + input routing + arm
 *   Level 4 (96px)  — Full: + In/Auto/Off row + placeholder controls
 *   Level 5 (128px) — Maximum: all controls + send placeholders
 */

// ── Height Level Definitions ─────────────────────────────────────────

/** Ordered array of discrete track height levels in pixels. */
export const TRACK_HEIGHT_LEVELS: readonly number[] = [32, 48, 72, 96, 128] as const;

/** The snap grid granularity (in px) used during intermediate drag feedback. */
export const TRACK_HEIGHT_SNAP_PX = 8;

/** Minimum valid track height (Level 1). */
export const TRACK_LEVEL_MIN = TRACK_HEIGHT_LEVELS[0];

/** Maximum valid track height (Level 5). */
export const TRACK_LEVEL_MAX = TRACK_HEIGHT_LEVELS[TRACK_HEIGHT_LEVELS.length - 1];

/** Default track height (Level 2). */
export const TRACK_LEVEL_DEFAULT = TRACK_HEIGHT_LEVELS[1];

// ── Helper Utilities ─────────────────────────────────────────────────

/**
 * Snap a raw pixel height to the nearest discrete track height level.
 * Uses nearest-neighbor snapping with bias toward the current level
 * (hysteresis at midpoints favors not moving).
 */
export function snapToTrackHeightLevel(rawPx: number): { level: number; height: number } {
    let minDist = Infinity;
    let bestIdx = 0;
    for (let i = 0; i < TRACK_HEIGHT_LEVELS.length; i++) {
        const dist = Math.abs(rawPx - TRACK_HEIGHT_LEVELS[i]);
        if (dist < minDist) {
            minDist = dist;
            bestIdx = i;
        }
    }
    return { level: bestIdx + 1, height: TRACK_HEIGHT_LEVELS[bestIdx] };
}

/**
 * Get the 1-based level index for a given height.
 * If the height doesn't exactly match a level, snaps to nearest.
 */
export function getTrackHeightLevel(height: number): number {
    return snapToTrackHeightLevel(height).level;
}

/**
 * Step to the next or previous track height level.
 * Returns the new level's height, clamped to the valid range.
 *
 * @param currentHeight - Current track height in pixels
 * @param direction     - +1 to grow, -1 to shrink
 */
export function nextTrackHeightLevel(currentHeight: number, direction: 1 | -1): number {
    const { level } = snapToTrackHeightLevel(currentHeight);
    const nextIdx = Math.max(0, Math.min(TRACK_HEIGHT_LEVELS.length - 1, level - 1 + direction));
    return TRACK_HEIGHT_LEVELS[nextIdx];
}
