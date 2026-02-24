const APP_SCALE_KEY = 'dreamdaw.ui.appScalePercent';
const GRID_INTENSITY_KEY = 'dreamdaw.ui.timelineGridIntensity';

export const APP_SCALE_OPTIONS = [80, 90, 100, 110, 120] as const;
export const DEFAULT_APP_SCALE_PERCENT = 100;
export const DEFAULT_GRID_INTENSITY_PERCENT = 100;

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function readStoredInt(key: string, fallback: number): number {
    if (typeof window === 'undefined') return fallback;
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function writeStoredInt(key: string, value: number): void {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(key, String(Math.round(value)));
}

export function getAppScalePercent(): number {
    const stored = readStoredInt(APP_SCALE_KEY, DEFAULT_APP_SCALE_PERCENT);
    return clamp(stored, APP_SCALE_OPTIONS[0], APP_SCALE_OPTIONS[APP_SCALE_OPTIONS.length - 1]);
}

export function getTimelineGridIntensityPercent(): number {
    const stored = readStoredInt(GRID_INTENSITY_KEY, DEFAULT_GRID_INTENSITY_PERCENT);
    return clamp(stored, 50, 150);
}

function applyAppScale(scalePercent: number): void {
    if (typeof document === 'undefined') return;
    const clamped = clamp(scalePercent, APP_SCALE_OPTIONS[0], APP_SCALE_OPTIONS[APP_SCALE_OPTIONS.length - 1]);
    document.documentElement.style.zoom = `${clamped}%`;
}

function applyGridIntensity(gridIntensityPercent: number): void {
    if (typeof document === 'undefined') return;
    const clamped = clamp(gridIntensityPercent, 50, 150);
    const root = document.documentElement;
    root.style.setProperty('--timeline-grid-intensity', String(clamped));
    root.style.setProperty('--timeline-master-grid-sub-opacity', String(clamp(0.42 * (clamped / 100), 0.08, 1)));
    root.style.setProperty('--timeline-master-grid-bar-opacity', String(clamp(0.95 * (clamped / 100), 0.12, 1)));
}

export function setAppScalePercent(scalePercent: number): number {
    const clamped = clamp(scalePercent, APP_SCALE_OPTIONS[0], APP_SCALE_OPTIONS[APP_SCALE_OPTIONS.length - 1]);
    writeStoredInt(APP_SCALE_KEY, clamped);
    applyAppScale(clamped);
    return clamped;
}

export function setTimelineGridIntensityPercent(gridIntensityPercent: number): number {
    const clamped = clamp(gridIntensityPercent, 50, 150);
    writeStoredInt(GRID_INTENSITY_KEY, clamped);
    applyGridIntensity(clamped);
    return clamped;
}

export function applyUiDisplayPrefs(): void {
    applyAppScale(getAppScalePercent());
    applyGridIntensity(getTimelineGridIntensityPercent());
}
