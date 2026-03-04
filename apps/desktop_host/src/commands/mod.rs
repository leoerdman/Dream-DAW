use super::*;
use std::time::Duration;
use tauri::{Emitter, Manager};
use crate::state_managers::project_registry::active_project;

type DeviceNode = dream_models::project::DeviceNode;

fn execute_orchestrator_command<C: dream_orchestrator::Command>(
    project_state: &ProjectState,
    cmd: &C,
) -> Result<C::Result, String> {
    let ctx = dream_orchestrator::OrchestratorContext::new(
        project_state
            .project
            .lock()
            .map_err(|e| e.to_string())?
            .clone(),
    );
    let result = ctx.execute(cmd).map_err(|e| e.to_string())?;
    *project_state.project.lock().map_err(|_| "Application state error. Please restart Dream DAW.".to_string())? =
        ctx.lock_project().map_err(|e| e.to_string())?.clone();
    Ok(result)
}

fn execute_orchestrator_query<Q: dream_orchestrator::Query>(
    project_state: &ProjectState,
    query: &Q,
) -> Result<Q::Result, String> {
    let ctx = dream_orchestrator::OrchestratorContext::new(
        project_state
            .project
            .lock()
            .map_err(|e| e.to_string())?
            .clone(),
    );
    ctx.query(query).map_err(|e| e.to_string())
}

pub mod payloads;
pub use payloads::*;

include!("sections/transport.rs");
include!("sections/track_control.rs");
include!("sections/device_chain.rs");
include!("sections/state_queries.rs");
include!("sections/audio_import.rs");
include!("sections/midi_clip.rs");
include!("sections/waveform.rs");
include!("sections/clip_mutators.rs");
include!("sections/undo_redo.rs");
include!("sections/track_crud.rs");
include!("sections/track_group_color.rs");
include!("sections/track_routing.rs");
include!("sections/splash.rs");
include!("sections/project_management.rs");
include!("sections/settings.rs");
include!("sections/browser_scan.rs");
include!("sections/browser_folders.rs");
include!("sections/project_extended.rs");
include!("sections/audio_devices.rs");
include!("sections/plugins_routing.rs");
include!("sections/plugin_sandbox_commands.rs");
include!("sections/routing_commands.rs");
include!("sections/midi_input.rs");
include!("sections/device_rack.rs");
include!("sections/spectrum.rs");
include!("sections/sample_rack.rs");
include!("sections/flow_synth.rs");

// ═══════════════════════════════════════════════════════════════════════

pub(crate) fn invoke_handler()
-> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        // Transport
        play,
        play_from_beat,
        stop,
        toggle_playback,
        seek,
        seek_seconds,
        seek_to_beat,
        set_bpm,
        set_bpm_with_deltas,
        set_time_signature,
        set_time_signature_with_deltas,
        set_loop,
        set_loop_with_deltas,
        // Track Control
        set_track_volume,
        set_track_volume_with_deltas,
        set_track_pan,
        set_track_pan_with_deltas,
        set_master_volume,
        set_track_disabled,
        set_track_disabled_with_deltas,
        set_track_solo,
        set_track_solo_with_deltas,
        set_track_send_level,
        set_track_send_level_with_deltas,
        preview_sampler_note_on_cmd,
        preview_sampler_note_off_cmd,
        set_flow_enabled_cmd,
        sync_flow_graph_cmd,
        update_flow_node_param_cmd,
        save_flow_synth_config_cmd,
        update_track,
        // State Queries
        get_state,
        get_transport,
        get_meters,
        get_meters_binary,
        get_project_history,
        get_project_snapshot_delta,
        get_active_project_id,
        get_audio_chain_audit,
        get_pdc_debug_snapshot,
        get_rt_debug_snapshot,
        set_rt_debug_enabled,
        // Project Management
        new_project,
        save_project,
        save_project_as,
        open_project,
        import_ableton_project,
        get_recent_projects,
        get_project_status,
         auto_resolve_missing_plugins_with_deltas_cmd,
        auto_resolve_missing_plugins_report_with_deltas_cmd,
        set_arrangement_viewport_cmd,
        get_arrangement_viewport_cmd,
        set_arrangement_grid_cmd,
        set_arrangement_grid_with_deltas_cmd,
        // Multi-Project Tabs
        create_project_tab,
        switch_project_tab,
        close_project_tab,
        list_open_projects,
        // Cross-Project Global Clipboard
        copy_clips_to_global_clipboard,
        paste_clips_from_global_clipboard,
        copy_track_to_global_clipboard,
        paste_track_from_global_clipboard,
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
        close_splashscreen,
        // Legacy
        set_frequency,
        // Audio Import
        import_audio_file,
        import_audio_file_with_deltas,
        create_midi_clip_cmd,
        create_midi_clip_with_deltas_cmd,
        update_midi_clip_cmd,
        update_midi_clip_with_deltas_cmd,
        set_midi_clip_envelopes_cmd,
        generate_midi_variation_cmd,
        // Waveform
        get_waveform_peaks,
        get_waveform_peaks_binary,
        get_waveform_peaks_lod_binary,
        get_peaks,
        get_peaks_by_clip_id,
        get_peaks_binary,
        // Track Management
        add_track_cmd,
        add_track_with_deltas_cmd,
        delete_track_cmd,
        delete_track_with_deltas_cmd,
        delete_tracks_cmd,
        rename_track_cmd,
        rename_track_with_deltas_cmd,
        set_track_height_cmd,
        set_track_height_with_deltas_cmd,
        set_track_color_cmd,
        set_track_color_with_deltas_cmd,
        create_group_cmd,
        create_group_with_deltas_cmd,
        set_group_expanded_cmd,
        set_group_expanded_with_deltas_cmd,
        move_track_to_index_cmd,
        move_track_to_index_with_deltas_cmd,
        move_track_with_parent_cmd,
        move_track_with_parent_with_deltas_cmd,
        set_track_group_cmd,
        set_track_group_with_deltas_cmd,
        ungroup_track_cmd,
        ungroup_track_with_deltas_cmd,
        move_track_block_to_index_cmd,
        move_track_block_to_index_with_deltas_cmd,
        duplicate_tracks_cmd,
        duplicate_tracks_with_deltas_cmd,
        // Clip Editing
        move_clip_cmd,
        move_clip_with_deltas_cmd,
        move_multiple_clips_with_deltas_cmd,
        split_clip_cmd,
        split_clip_with_deltas_cmd,
        duplicate_clip_cmd,
        duplicate_clip_with_deltas_cmd,
        duplicate_multiple_clips_with_deltas_cmd,
        merge_clips_cmd,
        merge_clips_with_deltas_cmd,
        consolidate_midi_region_with_deltas_cmd,
        duplicate_clip_cmd,
        delete_clip_cmd,
        delete_clip_with_deltas_cmd,
        resize_clip_cmd,
        resize_clip_with_deltas_cmd,
        set_clip_fades_cmd,
        set_clip_fades_with_deltas_cmd,
        set_clip_source_offset_cmd,
        set_clip_source_offset_with_deltas_cmd,
        set_clip_warp_cmd,
        set_clip_warp_with_deltas_cmd,
        set_clip_pitch_cmd,
        set_clip_pitch_with_deltas_cmd,
        set_clip_muted_cmd,
        set_clip_muted_with_deltas_cmd,
        set_clips_muted_cmd,
        set_clips_muted_with_deltas_cmd,
        paint_track_clips_with_track_color_cmd,
        paint_track_clips_with_track_color_with_deltas_cmd,
        resolve_missing_file_cmd,
        resolve_missing_file_with_deltas_cmd,
        // Automation / recording / export
        set_automation_points_cmd,
        set_automation_points_with_deltas_cmd,
        arm_track_cmd,
        arm_track_with_deltas_cmd,
        start_recording_cmd,
        stop_recording_cmd,
        export_mix_cmd,
        cancel_export_cmd,
        list_background_jobs_cmd,
        cancel_background_job_cmd,
        clear_finished_background_jobs_cmd,
        bounce_selection_to_track_cmd,
        bounce_selection_to_track_with_deltas_cmd,
        bounce_track_cmd,
        bounce_track_with_deltas_cmd,
        bounce_group_cmd,
        bounce_group_with_deltas_cmd,
        split_track_to_stems_cmd,
        split_track_to_stems_with_deltas_cmd,
        consolidate_selection_cmd,
        consolidate_selection_with_deltas_cmd,
        // Undo/Redo
        undo_cmd,
        redo_cmd,
        undo_with_deltas_cmd,
        redo_with_deltas_cmd,
        // Audio Device Management
        get_audio_devices,
        set_audio_device,
        restart_audio_engine,
        // MIDI input
        get_midi_inputs,
        connect_midi_input,
        // Epic 2: plugin windows + routing
        open_plugin_window,
        open_plugin_window_for_slot,
        can_open_plugin_editor,
        can_open_plugin_editor_for_slot,
        get_plugin_slot_runtime_status_cmd,
        ensure_plugin_slot_active_cmd,
        unload_plugin_slot_cmd,
        replace_missing_plugin_slot_cmd,
        replace_missing_plugin_slot_with_deltas_cmd,
        close_plugin_window_cmd,
        close_plugin_window_for_slot,
        get_external_plugin_params,
        get_external_plugin_params_for_slot,
        get_plugin_sandbox_runtime,
        set_plugin_sandbox_enabled,
        tick_plugin_sandbox_watchdog,
        reload_plugin_sandbox_instance,
        reload_unhealthy_plugin_sandboxes,
        log_frontend_error,
        signal_frontend_ready,
        get_routing_targets,
        set_track_routing_cmd,
        set_track_routing_with_deltas_cmd,
        set_track_input_cmd,
        set_track_input_with_deltas_cmd,
        set_plugin_sidechain_source_cmd,
        set_plugin_sidechain_source_with_deltas_cmd,
        add_plugin_to_track_cmd,
        add_plugin_to_track_with_deltas_cmd,
        remove_plugin_from_track_cmd,
        remove_plugin_from_track_with_deltas_cmd,
        set_internal_plugin_param_cmd,
        set_internal_plugin_param_with_deltas_cmd,
        set_internal_plugin_param_batch_with_deltas_cmd,
        set_external_plugin_param_cmd,
        set_external_plugin_param_for_slot_cmd,
        set_external_plugin_param_for_slot_runtime_cmd,
        set_external_plugin_param_for_slot_with_deltas_cmd,
        set_sampler_sample_cmd,
        set_sampler_sample_with_deltas_cmd,
        eager_activate_external_plugins,
        set_slot_bypass_cmd,
        set_slot_bypass_with_deltas_cmd,
        move_effect_slot_cmd,
        move_effect_slot_with_deltas_cmd,
        copy_device_from_track_cmd,
        paste_device_to_track_cmd,
        paste_device_to_track_with_deltas_cmd,
        // Device Chain
        add_device_cmd,
        remove_device_cmd,
        bypass_device_cmd,
        set_device_param_cmd,
        set_device_param_runtime_cmd,
        set_device_params_runtime_cmd,
        // Device Rack
        create_rack_from_devices_cmd,
        add_chain_to_rack_cmd,
        add_device_to_rack_chain_cmd,
        remove_device_from_rack_cmd,
        save_device_preset_cmd,
        load_device_preset_cmd,
        // Project Management (extended)
        auto_save_if_dirty,
        create_backup_cmd,
        mark_dirty_cmd,
        sync_title_cmd,
        set_key_signature_cmd,
        set_key_signature_with_deltas_cmd,
        get_project_notes,
        set_project_notes,
        // Spectrum Analyzer
        get_spectrum_data,
        get_spectrum_data_for_track,
        // Sample Rack
        set_sample_rack_pad_volume_cmd,
        set_sample_rack_pad_volume_with_deltas_cmd,
        set_sample_rack_pad_mute_cmd,
        set_sample_rack_pad_mute_with_deltas_cmd,
        set_sample_rack_pad_solo_cmd,
        set_sample_rack_pad_solo_with_deltas_cmd,
        set_sample_rack_pad_adsr_cmd,
        set_sample_rack_pad_adsr_with_deltas_cmd,
        set_sample_rack_pad_filter_cutoff_cmd,
        set_sample_rack_pad_filter_cutoff_with_deltas_cmd,
        set_sample_rack_pad_sample_cmd,
        set_sample_rack_pad_sample_with_deltas_cmd,
    ]
}
