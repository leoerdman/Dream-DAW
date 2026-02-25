#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use dream_models::midi::{MidiClip, MidiNote};
    use dream_models::project::{AudioClip, Project, TrackType};
    use dream_models::time::AbsoluteTime;
    use uuid::Uuid;

    use crate::commands::{
        AddPluginToTrackCommand, AddTrackCommand, EffectTrackTarget, MoveEffectSlotCommand,
        PluginSlotPreference, RemovePluginFromTrackCommand, SetPluginSidechainSourceCommand,
        SetPluginSlotBypassCommand, SetTrackInputCommand, SetTrackRoutingCommand,
    };
    use crate::context::OrchestratorContext;

    const INTERNAL_EFFECTS: [(&str, &str); 8] = [
        ("internal://effect/eq-eight", "EQ Eight"),
        ("internal://effect/compressor", "Compressor"),
        ("internal://effect/delay", "Delay"),
        ("internal://effect/reverb", "Reverb"),
        ("internal://effect/chorus", "Chorus"),
        ("internal://effect/utility", "Utility"),
        ("internal://effect/gate", "Gate"),
        ("internal://effect/limiter", "Limiter"),
    ];

    const INTERNAL_INSTRUMENTS: [(&str, &str); 2] = [
        ("internal://instrument/sampler", "Sampler"),
        ("internal://instrument/wave-synth", "Wave Synth"),
    ];

    struct LcgRng {
        state: u64,
    }

    impl LcgRng {
        fn new(seed: u64) -> Self {
            Self {
                state: seed ^ 0x9E37_79B9_7F4A_7C15,
            }
        }

        fn next_u64(&mut self) -> u64 {
            self.state = self
                .state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            self.state
        }

        fn range(&mut self, max_exclusive: usize) -> usize {
            if max_exclusive <= 1 {
                return 0;
            }
            (self.next_u64() as usize) % max_exclusive
        }

        fn chance(&mut self, percent: usize) -> bool {
            self.range(100) < percent.min(100)
        }
    }

    fn list_tracks(ctx: &OrchestratorContext) -> Vec<(Uuid, TrackType)> {
        let project = ctx.lock_project().expect("lock project");
        project.tracks.iter().map(|t| (t.id, t.track_type)).collect()
    }

    fn snapshot_track_slots(ctx: &OrchestratorContext, track_id: Uuid) -> (Option<Uuid>, Vec<Uuid>) {
        let project = ctx.lock_project().expect("lock project");
        let track = project
            .tracks
            .iter()
            .find(|t| t.id == track_id)
            .expect("track exists");
        let instrument = track.instrument.as_ref().and_then(|d| d.as_single()).map(|s| s.id);
        let effects = track
            .effects
            .iter()
            .filter_map(|n| n.as_single().map(|s| s.id))
            .collect();
        (instrument, effects)
    }

    fn sidechain_candidates(ctx: &OrchestratorContext) -> Vec<(Uuid, Uuid)> {
        let project = ctx.lock_project().expect("lock project");
        let mut out = Vec::new();
        for track in &project.tracks {
            if let Some(inst) = &track.instrument
                && let Some(slot) = inst.as_single()
            {
                let unsupported_internal =
                    slot.supports_sidechain_input == Some(false) && slot.plugin_id.starts_with("internal://");
                if !unsupported_internal {
                    out.push((track.id, slot.id));
                }
            }
            for fx in &track.effects {
                if let Some(slot) = fx.as_single() {
                    let unsupported_internal =
                        slot.supports_sidechain_input == Some(false) && slot.plugin_id.starts_with("internal://");
                    if !unsupported_internal {
                        out.push((track.id, slot.id));
                    }
                }
            }
        }
        out
    }

    fn seed_clips(
        ctx: &OrchestratorContext,
        rng: &mut LcgRng,
        track_id: Uuid,
        track_type: TrackType,
        complexity: usize,
    ) {
        let mut project = ctx.lock_project().expect("lock project");
        let Some(track) = project.tracks.iter_mut().find(|t| t.id == track_id) else {
            return;
        };
        let audio_clip_count = 1 + rng.range(1 + complexity.min(4));
        let midi_clip_count = 1 + rng.range(1 + complexity.min(3));

        if track_type != TrackType::Midi && rng.chance(75) {
            for i in 0..audio_clip_count {
                let start = (i as i64) * 9_600 + (rng.range(2_000) as i64);
                let len = 4_800 + (rng.range(32_000) as i64);
                track.clips.push(AudioClip::new(
                    format!("A{track_id}-{i}"),
                    format!("/virtual/audio/{track_id}/{i}.wav"),
                    AbsoluteTime::new(start),
                    AbsoluteTime::new(len),
                ));
            }
        }

        if track_type == TrackType::Midi && rng.chance(85) {
            for i in 0..midi_clip_count {
                let start = (i as i64) * 7_200 + (rng.range(1_500) as i64);
                let len = 7_200 + (rng.range(28_800) as i64);
                let mut clip = MidiClip::new(
                    format!("M{track_id}-{i}"),
                    AbsoluteTime::new(start),
                    AbsoluteTime::new(len),
                );
                let note_count = 2 + rng.range(8 + complexity);
                for n in 0..note_count {
                    let note_start = ((n as i64) * 1_200).min(len.saturating_sub(2_000));
                    let note_len = 400 + (rng.range(2_200) as i64);
                    let pitch = (36 + rng.range(48)) as u8;
                    let velocity = (40 + rng.range(80)) as u8;
                    clip.notes
                        .push(MidiNote::new(pitch, velocity, note_start, note_len));
                }
                track.midi_clips.push(clip);
            }
        }
    }

    fn assert_project_invariants(ctx: &OrchestratorContext, scenario: usize) {
        let project = ctx.lock_project().expect("lock project");
        let all_track_ids: HashSet<Uuid> = project.tracks.iter().map(|t| t.id).collect();
        let mut all_slot_ids = HashSet::new();

        for track in &project.tracks {
            let mut slots = Vec::new();
            if let Some(inst) = &track.instrument {
                slots.extend(inst.collect_plugin_slots());
            }
            for fx in &track.effects {
                slots.extend(fx.collect_plugin_slots());
            }

            for slot in slots {
                assert!(
                    all_slot_ids.insert(slot.id),
                    "Scenario {scenario}: duplicate plugin slot id {}",
                    slot.id
                );
                if let Some(source) = &slot.sidechain_source_track_id {
                    let source_id = Uuid::parse_str(source).expect("valid source UUID");
                    assert!(
                        source_id != track.id,
                        "Scenario {scenario}: sidechain source points to same track"
                    );
                    assert!(
                        all_track_ids.contains(&source_id),
                        "Scenario {scenario}: sidechain source track missing"
                    );
                }
            }
        }
    }

    #[test]
    fn run_200_virtual_plugin_audio_chain_scenarios() {
        for scenario in 0..200usize {
            let mut rng = LcgRng::new((scenario as u64 + 1) * 17_171);
            let sample_rate = if scenario % 3 == 0 { 48_000.0 } else { 44_100.0 };
            let bpm = 96.0 + (scenario % 50) as f64;
            let project = Project::new(format!("VirtualScenario-{scenario}"), bpm, sample_rate);
            let ctx = OrchestratorContext::new(project);
            let complexity = 1 + scenario / 20;

            let track_count = 4 + rng.range(4 + complexity.min(5));
            for t in 0..track_count {
                let track_type = if t == 0 {
                    "audio"
                } else if t == 1 {
                    "midi"
                } else if rng.chance(20) {
                    "group"
                } else if rng.chance(45) {
                    "midi"
                } else {
                    "audio"
                };
                let add_track = AddTrackCommand {
                    name: Some(format!("S{scenario}-T{t}-{track_type}")),
                    track_type: Some(track_type.to_string()),
                    insert_after_index: None,
                    inherit_from_track_id: None,
                };
                ctx.execute(&add_track).unwrap_or_else(|e| {
                    panic!("Scenario {scenario}: AddTrackCommand failed at track {t}: {e}")
                });
            }

            for (track_id, track_type) in list_tracks(&ctx) {
                seed_clips(&ctx, &mut rng, track_id, track_type, complexity);
            }

            let steps = 24 + complexity * 10;
            for step in 0..steps {
                let tracks = list_tracks(&ctx);
                if tracks.is_empty() {
                    break;
                }
                let (track_id, track_type) = tracks[rng.range(tracks.len())];
                let action = rng.range(100);

                if action < 34 {
                    let (_, effects) = snapshot_track_slots(&ctx, track_id);
                    let add_instrument = track_type == TrackType::Midi && rng.chance(28);
                    let insert_index = if effects.is_empty() {
                        Some(0)
                    } else {
                        Some(rng.range(effects.len() + 2))
                    };

                    let cmd = if add_instrument {
                        let (plugin_id, plugin_name) =
                            INTERNAL_INSTRUMENTS[rng.range(INTERNAL_INSTRUMENTS.len())];
                        AddPluginToTrackCommand {
                            track_id,
                            plugin_id: plugin_id.to_string(),
                            plugin_name: plugin_name.to_string(),
                            slot_preference: PluginSlotPreference::Instrument,
                            canonical_slot_hint: Some("instrument".to_string()),
                            external_audio_inputs: None,
                            external_supports_sidechain_input: None,
                            insert_index: None,
                        }
                    } else if rng.chance(40) {
                        AddPluginToTrackCommand {
                            track_id,
                            plugin_id: format!("/virtual/plugins/s{scenario}/fx-{}.vst3", rng.range(64)),
                            plugin_name: format!("VirtualFX{}", rng.range(32)),
                            slot_preference: PluginSlotPreference::Effect,
                            canonical_slot_hint: Some("effect".to_string()),
                            external_audio_inputs: Some(4),
                            external_supports_sidechain_input: Some(true),
                            insert_index,
                        }
                    } else {
                        let (plugin_id, plugin_name) = INTERNAL_EFFECTS[rng.range(INTERNAL_EFFECTS.len())];
                        AddPluginToTrackCommand {
                            track_id,
                            plugin_id: plugin_id.to_string(),
                            plugin_name: plugin_name.to_string(),
                            slot_preference: PluginSlotPreference::Effect,
                            canonical_slot_hint: Some("effect".to_string()),
                            external_audio_inputs: None,
                            external_supports_sidechain_input: None,
                            insert_index,
                        }
                    };

                    ctx.execute(&cmd).unwrap_or_else(|e| {
                        panic!("Scenario {scenario} step {step}: AddPluginToTrack failed: {e}")
                    });
                } else if action < 52 {
                    let (_, effects) = snapshot_track_slots(&ctx, track_id);
                    if effects.len() >= 2 {
                        let slot_id = effects[rng.range(effects.len())];
                        let target = rng.range(effects.len() + 3);
                        let cmd = MoveEffectSlotCommand {
                            target: EffectTrackTarget::Track(track_id),
                            slot_id,
                            target_index: target,
                        };
                        ctx.execute(&cmd).unwrap_or_else(|e| {
                            panic!("Scenario {scenario} step {step}: MoveEffectSlot failed: {e}")
                        });
                    }
                } else if action < 68 {
                    let (instrument, effects) = snapshot_track_slots(&ctx, track_id);
                    let mut all_slots = effects.clone();
                    if let Some(inst) = instrument {
                        all_slots.push(inst);
                    }
                    if !all_slots.is_empty() {
                        let slot_id = all_slots[rng.range(all_slots.len())];
                        let cmd = SetPluginSlotBypassCommand {
                            track_id,
                            slot_id,
                            bypassed: rng.chance(50),
                        };
                        ctx.execute(&cmd).unwrap_or_else(|e| {
                            panic!("Scenario {scenario} step {step}: SetPluginSlotBypass failed: {e}")
                        });
                    }
                } else if action < 80 {
                    let (instrument, effects) = snapshot_track_slots(&ctx, track_id);
                    let target_slot = if !effects.is_empty() {
                        Some(effects[rng.range(effects.len())])
                    } else {
                        instrument
                    };
                    if let Some(slot_id) = target_slot {
                        let cmd = RemovePluginFromTrackCommand { track_id, slot_id };
                        ctx.execute(&cmd).unwrap_or_else(|e| {
                            panic!("Scenario {scenario} step {step}: RemovePlugin failed: {e}")
                        });
                    }
                } else if action < 90 {
                    let candidates = sidechain_candidates(&ctx);
                    if !candidates.is_empty() {
                        let (target_track_id, slot_id) = candidates[rng.range(candidates.len())];
                        let tracks = list_tracks(&ctx);
                        let sources: Vec<Uuid> = tracks
                            .iter()
                            .map(|(id, _)| *id)
                            .filter(|id| *id != target_track_id)
                            .collect();
                        if !sources.is_empty() {
                            let source_track_id = sources[rng.range(sources.len())];
                            let cmd = SetPluginSidechainSourceCommand {
                                track_id: target_track_id,
                                slot_id,
                                source_track_id: Some(source_track_id),
                            };
                            ctx.execute(&cmd).unwrap_or_else(|e| {
                                panic!(
                                    "Scenario {scenario} step {step}: SetPluginSidechainSource failed: {e}"
                                )
                            });
                        }
                    }
                } else if action < 96 {
                    let tracks = list_tracks(&ctx);
                    if !tracks.is_empty() {
                        let source_track = tracks[rng.range(tracks.len())].0;
                        let destinations: Vec<Uuid> = tracks
                            .iter()
                            .map(|(id, _)| *id)
                            .filter(|id| *id != source_track)
                            .collect();
                        let output_destination_id = if destinations.is_empty() || rng.chance(30) {
                            None
                        } else {
                            Some(destinations[rng.range(destinations.len())])
                        };
                        let cmd = SetTrackRoutingCommand {
                            track_id: source_track,
                            output_destination_id,
                        };
                        ctx.execute(&cmd).unwrap_or_else(|e| {
                            panic!("Scenario {scenario} step {step}: SetTrackRouting failed: {e}")
                        });
                    }
                } else if action < 99 {
                    let cmd = SetTrackInputCommand {
                        track_id,
                        input_source_id: if rng.chance(35) {
                            None
                        } else {
                            Some(format!("input_bus_{}", rng.range(8)))
                        },
                    };
                    ctx.execute(&cmd).unwrap_or_else(|e| {
                        panic!("Scenario {scenario} step {step}: SetTrackInput failed: {e}")
                    });
                } else {
                    seed_clips(&ctx, &mut rng, track_id, track_type, complexity);
                }
            }

            assert_project_invariants(&ctx, scenario);
        }
    }
}
