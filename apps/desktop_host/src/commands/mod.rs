use super::*;

include!("sections/transport.rs");
include!("sections/track_control.rs");
include!("sections/device_chain.rs");
include!("sections/state_queries.rs");
include!("sections/audio_import.rs");
include!("sections/midi_clip.rs");
include!("sections/waveform.rs");
include!("sections/clip_mutators.rs");
include!("sections/undo_redo.rs");
include!("sections/track_management.rs");
include!("sections/splash.rs");
include!("sections/project_management.rs");
include!("sections/settings.rs");
include!("sections/browser_scan.rs");
include!("sections/browser_folders.rs");
include!("sections/project_extended.rs");
include!("sections/audio_devices.rs");
include!("sections/plugins_routing.rs");
include!("sections/midi_input.rs");
include!("sections/device_rack.rs");

// ═══════════════════════════════════════════════════════════════════════

pub(crate) fn invoke_handler()
-> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        // Transport
        play,
        stop,
        toggle_playback,
        seek,
        seek_seconds,
        seek_to_beat,
        set_bpm,
        set_loop,
        // Track Control
        set_track_volume,
        set_track_pan,
        set_master_volume,
        set_track_mute,
        set_track_solo,
        update_track,
        // State Queries
        get_state,
        get_transport,
        get_meters,
        get_project_history,
        // Project Management
        new_project,
        save_project,
        save_project_as,
        open_project,
        import_ableton_project,
        get_recent_projects,
        get_project,
        get_project_status,
        set_arrangement_grid_cmd,
        // Settings
        get_settings,
        update_settings,
        get_samples_path,
        // File Browser
        generate_demo_samples_cmd,
        scan_audio_folder,
        scan_all_audio_sources,
        scan_folder_all,
        scan_plugin_folders,
        get_browser_folders,
        add_browser_folder,
        remove_browser_folder,
        preview_audio_file_cmd,
        stop_preview_cmd,
        get_audio_file_duration,
        pick_folder,
        pick_project_file,
        save_project_dialog,
        // Splash
        expand_window,
        // Legacy
        set_frequency,
        // Audio Import
        import_audio_file,
        create_midi_clip_cmd,
        update_midi_clip_cmd,
        generate_midi_variation_cmd,
        // Waveform
        get_waveform_peaks,
        get_waveform_peaks_binary,
        get_waveform_peaks_lod_binary,
        // Track Management
        add_track_cmd,
        delete_track_cmd,
        rename_track_cmd,
        create_group_cmd,
        set_group_expanded_cmd,
        move_track_to_index_cmd,
        move_track_with_parent_cmd,
        set_track_group_cmd,
        ungroup_track_cmd,
        move_track_block_to_index_cmd,
        duplicate_tracks_cmd,
        // Clip Editing
        move_clip_cmd,
        split_clip_cmd,
        duplicate_clip_cmd,
        merge_clips_cmd,
        delete_clip_cmd,
        resize_clip_cmd,
        set_clip_fades_cmd,
        set_clip_source_offset_cmd,
        set_clip_muted_cmd,
        resolve_missing_file_cmd,
        // Automation / recording / export
        set_automation_points_cmd,
        arm_track_cmd,
        start_recording_cmd,
        stop_recording_cmd,
        export_mix_cmd,
        cancel_export_cmd,
        // Undo/Redo
        undo_cmd,
        redo_cmd,
        // Audio Device Management
        get_audio_devices,
        set_audio_device,
        restart_audio_engine,
        // MIDI input
        get_midi_inputs,
        connect_midi_input,
        // Epic 2: plugin windows + routing
        open_plugin_window,
        can_open_plugin_editor,
        close_plugin_window,
        get_external_plugin_params,
        get_plugin_sandbox_runtime,
        set_plugin_sandbox_enabled,
        tick_plugin_sandbox_watchdog,
        log_frontend_error,
        get_routing_targets,
        set_track_routing_cmd,
        set_track_input_cmd,
        add_plugin_to_track_cmd,
        remove_plugin_from_track_cmd,
        set_internal_plugin_param_cmd,
        set_external_plugin_param_cmd,
        set_sampler_sample_cmd,
        eager_activate_external_plugins,
        // Device Chain
        add_device_cmd,
        remove_device_cmd,
        bypass_device_cmd,
        set_device_param_cmd,
        // Device Rack
        create_rack_from_devices_cmd,
        add_chain_to_rack_cmd,
        add_device_to_rack_chain_cmd,
        remove_device_from_rack_cmd,
        save_device_preset_cmd,
        load_device_preset_cmd,
        // Project Management (extended)
        create_backup_cmd,
        mark_dirty_cmd,
        sync_title_cmd,
    ]
}
