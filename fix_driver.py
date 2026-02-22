import re

with open("core/dream_engine/src/driver.rs", "r") as f:
    text = f.read()

start_marker = "                                    let post_sum_processed = post_sum_processing_mask"
end_marker = "                                    }"
# the end block is at 3122
match_start = text.find(start_marker)
# Find the exact end of metering
metering_end = text.find("meter_r.store_peak(peak_r.max(meter_r.load_peak()));\n                                    }", match_start)

if match_start == -1 or metering_end == -1:
    print("Makers not found!")
    exit(1)

end_pos = metering_end + len("meter_r.store_peak(peak_r.max(meter_r.load_peak()));\n                                    }")

# Read the original block to salvage the VST MIDI code
original_block = text[match_start:end_pos]

vst_midi_start_str = "                                                let transport = TransportContext {"
vst_midi_end_str = "/* end of vst midi*/" # Let's find exactly the call to host.process_with_sidechain

vst_call_start = original_block.find("let mut out_slices: [&mut [f32]; 2] = [")
vst_call_str = original_block[original_block.find(vst_midi_start_str):vst_call_start]

new_block = f"""{start_marker}
                                        .get(track_idx)
                                        .copied()
                                        .unwrap_or(false);

                                    // 1. Unify Working Buffer
                                    // GraphRenderer clears `left/right` before calling track_processor.
                                    // For group tracks (post_sum_processed), GraphRenderer ALREADY summed the upstream 
                                    // routing edges into `left/right` before calling us.
                                    // For source tracks, we must inject their pre-rendered audio (clips/synths) into `left/right`.
                                    if !post_sum_processed {{
                                        left[..c].copy_from_slice(&slot.buf_left[..c]);
                                        right[..c].copy_from_slice(&slot.buf_right[..c]);
                                    }}

                                    // 2. Process Inserts (Native FX + VSTs in chain order) 
                                    // All inserts now operate in-place on the graph's `left/right` buffer.
                                    if let Some(runtime_slots) = external_fx_map.get(track_idx) {{
                                        if !runtime_slots.is_empty() {{
                                            for (runtime_slot_idx, runtime_slot) in runtime_slots.iter().enumerate() {{
                                                let source_slot = runtime_slot
                                                    .sidechain_track_index
                                                    .and_then(|src_idx| {{
                                                        if src_idx < track_idx {{
                                                            left_tracks.get(src_idx)
                                                        }} else if src_idx == track_idx {{
                                                            None
                                                        }} else {{
                                                            right_tracks_rest.get(
                                                                src_idx - track_idx - 1,
                                                            )
                                                        }}
                                                    }});
                                                let (sc_l, sc_r) = source_slot
                                                    .map(|src_slot| {{
                                                        (
                                                            Some(&src_slot.buf_left[..c]),
                                                            Some(&src_slot.buf_right[..c]),
                                                        )
                                                    }})
                                                    .unwrap_or((None, None));

                                                if let Some(internal_idx) =
                                                    runtime_slot.internal_slot_index
                                                {{
                                                    slot.device_chain
                                                        .process_slot_with_sidechain(
                                                            internal_idx,
                                                            &mut left[..c],
                                                            &mut right[..c],
                                                            sc_l,
                                                            sc_r,
                                                            sample_rate_f64 as f32,
                                                        );
                                                    continue;
                                                }}

                                                if let Some(instance_id) =
                                                    runtime_slot.instance_id
                                                    && let Some(host) =
                                                        plugin_host_guard.as_deref_mut()
                                                {{
                                                    apply_external_plugin_param_automation_block(
                                                        host,
                                                        automation.get(track_idx),
                                                        runtime_slot,
                                                        runtime_slot_idx,
                                                        playhead_pos,
                                                    );
                                                    external_left[..c]
                                                        .copy_from_slice(&left[..c]);
                                                    external_right[..c]
                                                        .copy_from_slice(&right[..c]);
                                                    let main_inputs: [&[f32]; 2] =
                                                        [&left[..c], &right[..c]];
                                                    let sc_pair = source_slot.map(|src| {{
                                                        [
                                                            &src.buf_left[..c],
                                                            &src.buf_right[..c],
                                                        ]
                                                    }});
{vst_call_str}
                                                let mut out_slices: [&mut [f32]; 2] = [
                                                    &mut external_left[..c],
                                                    &mut external_right[..c],
                                                ];
                                                let _ = host.process_with_sidechain(
                                                    instance_id,
                                                    &main_inputs,
                                                    sc_pair
                                                        .as_ref()
                                                        .map(|pair| pair.as_slice()),
                                                    &mut out_slices,
                                                    c,
                                                    &vst3_midi_scratch,
                                                );
                                                left[..c].copy_from_slice(
                                                    &external_left[..c],
                                                );
                                                right[..c].copy_from_slice(
                                                    &external_right[..c],
                                                );
                                                }}
                                            }}
                                        }} else {{
                                            if !slot.device_chain.is_empty() {{
                                                slot.device_chain.process_stereo(
                                                    &mut left[..c],
                                                    &mut right[..c],
                                                    sample_rate_f64 as f32,
                                                );
                                            }}
                                        }}
                                    }} else {{
                                        if !slot.device_chain.is_empty() {{
                                            slot.device_chain.process_stereo(
                                                &mut left[..c],
                                                &mut right[..c],
                                                sample_rate_f64 as f32,
                                            );
                                        }}
                                    }}

                                    // 3. Process Mixer Strip (Volume, Pan, Mute, Solo output gate)
                                    if slot.strip.is_output_enabled() {{
                                        slot.strip.process_stereo(
                                            &mut left[..c],
                                            &mut right[..c],
                                        );
                                    }} else {{
                                        left[..c].fill(0.0);
                                        right[..c].fill(0.0);
                                    }}

                                    if let Some(lane) = automation.get(track_idx) {{
                                        apply_track_mixer_automation_sample_accurate(
                                            &mut left[..c],
                                            &mut right[..c],
                                            playhead_pos,
                                            (!lane.volume.is_empty())
                                                .then_some(lane.volume.as_slice()),
                                            (!lane.pan.is_empty())
                                                .then_some(lane.pan.as_slice()),
                                        );
                                    }}

                                    // 4. Per-track metering (graph pass)
                                    if let Some((meter_l, meter_r)) =
                                        render_ctx.meter_bank.track(track_idx)
                                    {{
                                        let rms_l = linear_to_db(compute_rms(&left[..c]));
                                        let rms_r = linear_to_db(compute_rms(&right[..c]));
                                        let peak_l = linear_to_db(compute_peak(&left[..c]));
                                        let peak_r = linear_to_db(compute_peak(&right[..c]));
                                        meter_l.store_rms(rms_l);
                                        meter_r.store_rms(rms_r);
                                        meter_l.store_peak(peak_l.max(meter_l.load_peak()));
                                        meter_r.store_peak(peak_r.max(meter_r.load_peak()));
                                    }}"""

text = text[:match_start] + new_block + text[end_pos:]

# Remove skip_device_chain_mask definition and loop

text = re.sub(r"^\s*let mut skip_device_chain_mask.*?\n", "", text, flags=re.MULTILINE)
text = re.sub(r"^\s*skip_device_chain_mask\[\.\.track_count\]\.fill\(false\);\n", "", text, flags=re.MULTILINE)

fx_loop = """                        // When a track has entries in the external FX map,
                        // the graph render callback handles all device slots
                        // (internal + external) in user-defined chain order.
                        // Skip the bulk device_chain.process_stereo() in
                        // render_callback to prevent double-processing.
                        for (track_idx, runtime_slots) in external_fx_map.iter().enumerate() {
                            if track_idx < track_count && !runtime_slots.is_empty() {
                                skip_device_chain_mask[track_idx] = true;
                            }
                        }"""
text = text.replace(fx_loop, "")

with open("core/dream_engine/src/driver.rs", "w") as f:
    f.write(text)

