import {
    TRACK_LEVEL_MIN,
    TRACK_LEVEL_MAX,
    TRACK_LEVEL_DEFAULT,
    TRACK_HEIGHT_SNAP_PX,
    snapToTrackHeightLevel,
} from '@/shared/config/trackHeightLevels';

export const DEFAULT_BPM = 120;

export const BROWSER_WIDTH_MIN_PX = 240;
export const BROWSER_WIDTH_MAX_PX = 520;
export const BROWSER_WIDTH_DEFAULT_PX = 320;

export const BOTTOM_PANEL_HEIGHT_DEFAULT_PX = 220;
export const BOTTOM_PANEL_HEIGHT_MIN_PX = 220;
export const BOTTOM_PANEL_HEIGHT_MAX_PX = 500;
/** 2-row expanded rack height — exactly 2× the default collapsed height. */
export const BOTTOM_PANEL_RACK_EXPANDED_PX = 440;

export const TRACK_HEIGHT_DEFAULT_PX = TRACK_LEVEL_DEFAULT;
export const TRACK_HEIGHT_MIN_PX = TRACK_LEVEL_MIN;
export const TRACK_HEIGHT_MAX_PX = TRACK_LEVEL_MAX;
export const TRACK_HEIGHT_STEP_PX = TRACK_HEIGHT_SNAP_PX;
export const TIMELINE_RULER_HEIGHT_PX = 28;

/** Snap a raw pixel height to the nearest discrete track height level. */
export const clampTrackHeightPx = (height: number): number =>
    snapToTrackHeightLevel(height).height;
