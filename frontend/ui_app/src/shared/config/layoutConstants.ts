export const DEFAULT_BPM = 120;

export const BROWSER_WIDTH_MIN_PX = 240;
export const BROWSER_WIDTH_MAX_PX = 520;
export const BROWSER_WIDTH_DEFAULT_PX = 320;

export const BOTTOM_PANEL_HEIGHT_DEFAULT_PX = 220;
export const BOTTOM_PANEL_HEIGHT_MIN_PX = 220;
export const BOTTOM_PANEL_HEIGHT_MAX_PX = 500;

export const TRACK_HEIGHT_DEFAULT_PX = 48;
export const TRACK_HEIGHT_MIN_PX = 24;
export const TRACK_HEIGHT_MAX_PX = 120;
export const TRACK_HEIGHT_STEP_PX = 1;
export const TIMELINE_RULER_HEIGHT_PX = 28;

export const clampTrackHeightPx = (height: number): number =>
    Math.max(TRACK_HEIGHT_MIN_PX, Math.min(TRACK_HEIGHT_MAX_PX, Math.round(height)));
