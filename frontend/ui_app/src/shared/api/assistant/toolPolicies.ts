export const READ_ONLY_TOOLS = new Set([
    'get_project_overview', 'get_track_clips', 'get_clip_details',
    'get_transport_state', 'select_clips', 'select_all_clips_on_track',
    'generate_chord', 'generate_scale', 'suggest_arrangement', 'get_metering',
    'generate_beat_pattern', 'get_midi_clip_notes', 'get_audio_file_duration',
    'get_arrangement_overview', 'preview_audio_file', 'stop_preview',
    'search_browser',
]);

export const NO_PROJECT_REFRESH_TOOLS = new Set([
    'transport_play',
    'transport_stop',
    'seek_to_beat',
    'set_master_volume',
    'preview_note',
    'preview_audio_file',
    'stop_preview',
]);

export const DELTA_APPLIED_TOOLS = new Set([
    'set_bpm',
    'add_track',
    'add_midi_track',
    'rename_track',
    'delete_track',
    'delete_tracks_batch',
    'move_track',
    'move_clip',
    'resize_clip',
    'split_clip',
    'delete_clip',
    'delete_clips_batch',
    'delete_all_clips_on_track',
    'set_clip_muted',
    'set_clips_muted_batch',
    'duplicate_clip',
    'merge_clips',
    'set_track_volume',
    'set_track_pan',
    'set_track_mute',
    'set_track_solo',
    'set_track_color',
    'set_track_instrument',
    'create_midi_clip',
    'add_audio_clip',
    'add_audio_clips_batch',
    'remove_effect',
    'set_loop_region',
    'bypass_effect',
    'set_clip_notes',
    'set_clip_fade',
    'set_clip_warp',
    'set_clip_source_offset',
    'quantize_notes',
    'humanize_velocity',
    'generate_arpeggio',
    'auto_gain_stage',
    'set_track_routing',
    'arm_track',
    'set_automation_points',
    'set_arrangement_grid',
    'set_key_signature',
    'duplicate_tracks',
    'set_synth_param',
    'add_effect',
    'set_effect_parameter',
    'create_track_group',
]);

export function shouldFetchProjectAfterTool(name: string): boolean {
    return !READ_ONLY_TOOLS.has(name)
        && !NO_PROJECT_REFRESH_TOOLS.has(name)
        && !DELTA_APPLIED_TOOLS.has(name);
}
