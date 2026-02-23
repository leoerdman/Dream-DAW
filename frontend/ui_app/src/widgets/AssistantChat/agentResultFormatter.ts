export function formatToolResult(name: string, resultJson: string): string {
    try {
        const data = JSON.parse(resultJson);
        if (data.error) return `❌ ${data.error}`;

        switch (name) {
            case 'get_project_overview':
                return `📁 ${data.projectName} • ${data.bpm} BPM • ${data.sampleRate}Hz • ${data.trackCount} tracks • ${data.totalClips ?? 0} clips`;
            case 'get_track_clips':
                return Array.isArray(data) ? `Found ${data.length} clip${data.length !== 1 ? 's' : ''}` : resultJson;
            case 'get_transport_state':
                return `${data.isPlaying ? '▶ Playing' : '⏹ Stopped'} • ${data.bpm} BPM • Loop ${data.loopEnabled ? 'ON' : 'OFF'}`;
            case 'transport_play': return '▶ Playing';
            case 'transport_stop': return '⏹ Stopped';
            case 'set_bpm': return `BPM → ${data.bpm}`;
            case 'set_track_mute': return data.muted ? '🔇 Muted' : '🔊 Unmuted';
            case 'set_track_solo': return data.soloed ? '🔆 Soloed' : '○ Unsoloed';
            case 'set_track_volume': return `Volume → ${Math.round(data.volume * 100)}%`;
            case 'set_track_pan': return `Pan → ${data.pan > 0 ? `R${Math.round(data.pan * 100)}` : data.pan < 0 ? `L${Math.round(-data.pan * 100)}` : 'C'}`;
            case 'add_track': return '✅ Track added';
            case 'rename_track': return `✅ Renamed → "${data.name}"`;
            case 'delete_track': return '✅ Track deleted';
            case 'delete_clip': return '✅ Clip deleted';
            case 'select_clips': return `✅ Selected ${data.selected} clip(s)`;
            case 'select_all_clips_on_track': return `✅ Selected ${data.selected} clip(s) on track ${data.trackIndex}`;
            case 'undo': return '↩ Undone';
            case 'redo': return '↪ Redone';
            case 'set_master_volume': return `Master → ${Math.round(data.masterVolume * 100)}%`;
            case 'add_midi_track': return '✅ Track created';
            case 'create_midi_clip': return '✅ Clip created';
            case 'set_clip_notes': return `✅ ${data.notesWritten || 0} notes written`;
            case 'add_audio_clip': return `✅ Clip "${data.clipName}" at beat ${data.startBeat}`;
            case 'duplicate_clip': return `✅ Duplicated → ${data.duplicatedClipId?.slice(0, 8)}`;
            case 'split_clip': return '✅ Clip split';
            case 'merge_clips': return '✅ Clips merged';
            case 'move_clip': return `✅ Moved to beat ${data.newStartBeat}`;
            case 'resize_clip': return `✅ Resized to ${data.newDuration} beats`;
            case 'search_browser': return `🔍 ${data.matchesFound} results` + (data.results?.[0]?.name ? ` • "${data.results[0].name}"` : '');
            case 'add_sample_to_rack': return '✅ Sample loaded';
            case 'add_effect': return `✅ ${data.effectType || 'Effect'} added`;
            case 'remove_effect': return '✅ Effect removed';
            case 'bypass_effect': return data.bypassed ? '⏸ Bypassed' : '▶ Enabled';
            case 'set_device_param': return '✅ Param set';
            case 'set_track_color': return `🎨 Color → ${data.color}`;
            case 'set_loop_region': return `🔁 Loop ${data.loopEnabled ? 'ON' : 'OFF'} (${data.startBeat}–${data.endBeat})`;
            case 'quantize_notes': return `✅ ${data.notesQuantized || 0} notes quantized`;
            case 'humanize_velocity': return `✅ ${data.notesHumanized || 0} notes humanized`;
            case 'generate_chord': return `🎵 Chord: ${(data.notes || []).join(', ')}`;
            case 'generate_scale': return `🎵 Scale: ${(data.notes || []).length} notes`;
            case 'generate_arpeggio': return `🎵 Arpeggio: ${(data.notes || []).length} notes`;
            case 'preview_note': return '🔊 Note previewed';
            case 'set_pad_volume': return '✅ Pad volume set';
            case 'set_pad_mute': return data.muted ? '🔇 Pad muted' : '🔊 Pad unmuted';
            case 'set_pad_adsr': return '✅ ADSR set';
            case 'set_pad_filter_cutoff': return '✅ Cutoff set';
            case 'auto_gain_stage': return '✅ Gain staged';
            case 'auto_cleanup_mix': return '✅ Mix cleaned up';
            case 'get_metering': return '📊 Metering data received';
            case 'suggest_arrangement': return `📋 ${(data.sections || []).length} sections suggested`;
            case 'add_audio_clips_batch': return `✅ ${data.clipsCreated} clips added`;
            case 'delete_clips_batch': return `✅ ${data.deleted}/${data.total} clips deleted`;
            case 'delete_all_clips_on_track': return `✅ ${data.deleted} clips cleared on track ${data.trackIndex}`;
            default: return data.success ? '✅ Done' : JSON.stringify(data).slice(0, 80);
        }
    } catch {
        return resultJson.slice(0, 100);
    }
}
