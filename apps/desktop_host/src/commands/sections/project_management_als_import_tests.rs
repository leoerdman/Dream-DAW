use super::*;
use dream_importers::ableton::clip_parser::{parse_clip_envelopes, parse_clip_time_signature};
use dream_importers::ableton::device_params::{
    collect_external_plugin_static_lanes, import_internal_device_static_params,
};
use dream_importers::ableton::plugin_mapper::{
    canonical_internal_plugin_for_import,
    make_missing_external_plugin_slot_with_metadata,
    parse_external_plugin_meta,
};
use dream_importers::ableton::rack_parser::parse_als_rack;
use dream_importers::ableton::xml_helpers::{collect_track_devices, parse_f64_value};

fn empty_external_plugin_index() -> ExternalPluginIndex {
    ExternalPluginIndex {
        by_name: std::collections::HashMap::new(),
        by_stem: std::collections::HashMap::new(),
        by_file_name: std::collections::HashMap::new(),
        by_normalized: std::collections::HashMap::new(),
    }
}


#[test]
fn nested_device_collector_finds_devices_inside_racks() {
    let xml = r#"
    <Track>
      <DeviceChain>
        <Devices>
          <AudioEffectGroupDevice Id="1">
            <DeviceChain>
              <Devices>
                <Eq8 Id="2"/>
                <PluginDevice Id="3"/>
              </Devices>
            </DeviceChain>
          </AudioEffectGroupDevice>
          <AutoFilter Id="4"/>
        </Devices>
      </DeviceChain>
    </Track>
    "#;
    let doc = roxmltree::Document::parse(xml).expect("valid xml");
    let track = doc
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("Track"))
        .expect("track");

    let names: Vec<String> = collect_track_devices(track)
        .into_iter()
        .map(|n| n.tag_name().name().to_string())
        .collect();

    assert!(names.iter().any(|n| n == "AudioEffectGroupDevice"));
    assert!(names.iter().any(|n| n == "Eq8"));
    assert!(names.iter().any(|n| n == "PluginDevice"));
    assert!(names.iter().any(|n| n == "AutoFilter"));
}

#[test]
fn collect_track_devices_reads_wrapper_root_chain_devices() {
    let xml = r#"
    <Track>
      <DeviceChain>
        <AudioToAudioDeviceChain>
          <Devices>
            <PluginDevice Id="11"/>
            <Compressor2 Id="12"/>
          </Devices>
        </AudioToAudioDeviceChain>
      </DeviceChain>
    </Track>
    "#;
    let doc = roxmltree::Document::parse(xml).expect("valid xml");
    let track = doc
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("Track"))
        .expect("track");

    let names: Vec<String> = collect_track_devices(track)
        .into_iter()
        .map(|n| n.tag_name().name().to_string())
        .collect();

    assert!(names.iter().any(|n| n == "PluginDevice"));
    assert!(names.iter().any(|n| n == "Compressor2"));
}

#[test]
fn collect_track_devices_reads_deeply_nested_root_chain_devices() {
    let xml = r#"
    <Track>
      <DeviceChain>
        <MainSequencer />
        <DeviceChain>
          <AudioToAudioDeviceChain>
            <Devices>
              <PluginDevice Id="21"/>
              <Eq8 Id="22"/>
            </Devices>
          </AudioToAudioDeviceChain>
        </DeviceChain>
      </DeviceChain>
    </Track>
    "#;
    let doc = roxmltree::Document::parse(xml).expect("valid xml");
    let track = doc
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("Track"))
        .expect("track");

    let names: Vec<String> = collect_track_devices(track)
        .into_iter()
        .map(|n| n.tag_name().name().to_string())
        .collect();

    assert!(names.iter().any(|n| n == "PluginDevice"));
    assert!(names.iter().any(|n| n == "Eq8"));
}

#[test]
fn import_track_devices_keeps_full_chain_from_wrapper_root() {
    let xml = r#"
    <AudioTrack>
      <DeviceChain>
        <AudioToAudioDeviceChain>
          <Devices>
            <PluginDevice Id="11">
              <UserName Value="Third Party FX" />
            </PluginDevice>
            <Compressor2 Id="12" />
            <AutoFilter Id="13" />
          </Devices>
        </AudioToAudioDeviceChain>
      </DeviceChain>
    </AudioTrack>
    "#;
    let doc = roxmltree::Document::parse(xml).expect("valid xml");
    let track_node = doc
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("AudioTrack"))
        .expect("track");
    let external_plugins = empty_external_plugin_index();
    let mut track = Track::with_type("Audio", TrackType::Audio, 0);
    import_track_devices(
        track_node,
        &mut track,
        &external_plugins,
        Path::new("/tmp/Test.als"),
    );

    assert_eq!(track.effects.len(), 3);
}

#[test]
fn parse_als_rack_supports_deep_branch_device_chain_wrappers() {
    let xml = r#"
    <AudioEffectGroupDevice Id="1">
      <Branches>
        <AudioEffectBranch Id="0">
          <Name Value="Chain A" />
          <DeviceChain>
            <DeviceChain>
              <AudioToAudioDeviceChain>
                <Devices>
                  <Eq8 Id="2"/>
                  <PluginDevice Id="3">
                    <UserName Value="Third Party Rack FX" />
                  </PluginDevice>
                </Devices>
              </AudioToAudioDeviceChain>
            </DeviceChain>
          </DeviceChain>
        </AudioEffectBranch>
      </Branches>
    </AudioEffectGroupDevice>
    "#;
    let doc = roxmltree::Document::parse(xml).expect("valid xml");
    let rack_node = doc
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("AudioEffectGroupDevice"))
        .expect("rack");
    let external_plugins = empty_external_plugin_index();
    let rack = parse_als_rack(rack_node, &external_plugins, Path::new("/tmp/Test.als"));
    assert_eq!(rack.chains.len(), 1);
    assert_eq!(rack.chains[0].devices.len(), 2);
}

#[test]
fn parse_als_rack_reads_extended_macro_metadata() {
    let xml = r#"
    <AudioEffectGroupDevice Id="1">
      <NumVisibleMacroControls Value="16" />
      <MacroControls.0>
        <Manual Value="12.5" />
      </MacroControls.0>
      <MacroControls.15>
        <Manual Value="88" />
      </MacroControls.15>
      <MacroDisplayNames.15 Value="Drive" />
      <MacroDefaults.15 Value="64" />
    </AudioEffectGroupDevice>
    "#;
    let doc = roxmltree::Document::parse(xml).expect("valid xml");
    let rack_node = doc
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("AudioEffectGroupDevice"))
        .expect("rack");

    let external_plugins = empty_external_plugin_index();
    let rack = parse_als_rack(rack_node, &external_plugins, Path::new("/tmp/Test.als"));

    assert_eq!(rack.macro_controls.len(), 16);
    assert!((rack.macro_controls[0].value - 12.5).abs() < 1e-9);
    assert!((rack.macro_controls[0].default_value - 12.5).abs() < 1e-9);
    assert!((rack.macro_controls[15].value - 88.0).abs() < 1e-9);
    assert!((rack.macro_controls[15].default_value - 64.0).abs() < 1e-9);
    assert_eq!(rack.macro_controls[15].name, "Drive");
}

#[test]
fn parse_als_rack_collects_macro_parameter_mappings() {
    let xml = r#"
    <AudioEffectGroupDevice Id="1">
      <NumVisibleMacroControls Value="8" />
      <MacroControls.0>
        <Manual Value="32" />
      </MacroControls.0>
      <Branches>
        <AudioEffectBranch Id="0">
          <Name Value="Chain A" />
          <DeviceChain>
            <AudioToAudioDeviceChain>
              <Devices>
                <Eq8 Id="42">
                  <BandStateA>
                    <ParameterName Value="Gain" />
                    <PowerMacroControlIndex Value="0" />
                    <PowerMacroMappingRange>
                      <Min Value="-12" />
                      <Max Value="6" />
                    </PowerMacroMappingRange>
                  </BandStateA>
                </Eq8>
              </Devices>
            </AudioToAudioDeviceChain>
          </DeviceChain>
        </AudioEffectBranch>
      </Branches>
    </AudioEffectGroupDevice>
    "#;
    let doc = roxmltree::Document::parse(xml).expect("valid xml");
    let rack_node = doc
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("AudioEffectGroupDevice"))
        .expect("rack");

    let external_plugins = empty_external_plugin_index();
    let rack = parse_als_rack(rack_node, &external_plugins, Path::new("/tmp/Test.als"));

    let m0 = &rack.macro_controls[0];
    assert_eq!(m0.mappings.len(), 1);
    assert_eq!(m0.mappings[0].param_id, "gain");
    assert!((m0.mappings[0].min_value + 12.0).abs() < 1e-9);
    assert!((m0.mappings[0].max_value - 6.0).abs() < 1e-9);
}

#[test]
fn audio_clip_source_path_prefers_sample_ref() {
    let xml = r#"
    <AudioClip>
      <SampleRef>
        <FileRef>
          <RelativePath Value="Samples/Imported/kick.wav"/>
        </FileRef>
      </SampleRef>
    </AudioClip>
    "#;
    let doc = roxmltree::Document::parse(xml).expect("valid xml");
    let clip = doc
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("AudioClip"))
        .expect("audio clip");

    let als_path = Path::new("/tmp/project/Test.als");
    let source = dream_importers::ableton::file_resolver::extract_audio_clip_source_path(clip, als_path);
    assert!(source.ends_with("Samples/Imported/kick.wav"));
}

#[test]
fn parse_track_send_manual_values_reads_track_send_holders() {
    let xml = r#"
    <Mixer>
      <Sends>
        <TrackSendHolder Id="0">
          <Send>
            <Manual Value="0.25"/>
          </Send>
        </TrackSendHolder>
        <TrackSendHolder Id="1">
          <Send>
            <Manual Value="1.25"/>
          </Send>
        </TrackSendHolder>
      </Sends>
    </Mixer>
    "#;
    let doc = roxmltree::Document::parse(xml).expect("valid xml");
    let mixer = doc
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("Mixer"))
        .expect("mixer");

    let sends = parse_track_send_manual_values(mixer);
    assert_eq!(sends.len(), 2);
    assert!((sends[0].1 - 0.25).abs() < 1e-9);
    assert!((sends[1].1 - 1.25).abs() < 1e-9);
}

#[test]
fn parse_track_send_manual_values_prefers_holder_id_index() {
    let xml = r#"
    <Mixer>
      <Sends>
        <TrackSendHolder Id="2">
          <Send>
            <Manual Value="0.5"/>
          </Send>
        </TrackSendHolder>
        <TrackSendHolder Id="4">
          <Send>
            <Manual Value="0.75"/>
          </Send>
        </TrackSendHolder>
      </Sends>
    </Mixer>
    "#;
    let doc = roxmltree::Document::parse(xml).expect("valid xml");
    let mixer = doc
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("Mixer"))
        .expect("mixer");

    let sends = parse_track_send_manual_values(mixer);
    assert_eq!(sends.len(), 2);
    assert_eq!(sends[0].0, 2);
    assert_eq!(sends[1].0, 4);
    assert!((sends[0].1 - 0.5).abs() < 1e-9);
    assert!((sends[1].1 - 0.75).abs() < 1e-9);
}

#[test]
fn ableton_color_hex_matches_enum_mapping_for_common_indices() {
    assert_eq!(ableton_color_index_to_hex(17), Some("#4DC7B0"));
    assert_eq!(ableton_color_index_to_hex(24), Some("#4D7AE3"));
    assert_eq!(ableton_color_index_to_hex(56), Some("#8C949E"));
    assert_eq!(ableton_color_index_to_hex(-1), None);
    assert_eq!(ableton_color_index_to_hex(70), None);
}

#[test]
fn extract_ableton_color_index_supports_all_known_forms() {
    let xml = r#"
    <Root>
      <A><Color Value="12"/></A>
      <B><ColorIndex Value="24"/></B>
      <C Color="33" />
      <D ColorIndex="48" />
    </Root>
    "#;
    let doc = roxmltree::Document::parse(xml).expect("valid xml");
    let root = doc.root_element();
    let nodes: Vec<_> = root.children().filter(|n| n.is_element()).collect();
    assert_eq!(extract_ableton_color_index(nodes[0]), Some(12));
    assert_eq!(extract_ableton_color_index(nodes[1]), Some(24));
    assert_eq!(extract_ableton_color_index(nodes[2]), Some(33));
    assert_eq!(extract_ableton_color_index(nodes[3]), Some(48));
}

#[test]
fn als_color_regression_again_v117_tracks_are_stable() {
    use std::path::PathBuf;

    let Some(path_raw) = std::env::var("DREAM_DAW_ALS_COLOR_AUDIT_PATH").ok() else {
        eprintln!(
            "skip: set DREAM_DAW_ALS_COLOR_AUDIT_PATH=/abs/path/to/Again\\ V117.als"
        );
        return;
    };
    let als_path = PathBuf::from(path_raw);
    if !als_path.exists() {
        eprintln!("skip: ALS path not found: {}", als_path.display());
        return;
    }

    let project = import_als_project(&als_path).unwrap_or_else(|e| {
        panic!("import failed for {}: {e}", als_path.display());
    });
    assert!(
        !project.tracks.is_empty(),
        "no tracks imported from {}",
        als_path.display()
    );

    let drums = project
        .tracks
        .iter()
        .find(|t| t.name.trim().eq_ignore_ascii_case("DRUMS"))
        .expect("missing DRUMS track");
    let vox = project
        .tracks
        .iter()
        .find(|t| t.name.trim().eq_ignore_ascii_case("VOX"))
        .expect("missing VOX track");

    assert_eq!(drums.color, TrackColor::Teal);
    assert_eq!(drums.color_hex.as_deref(), Some(TrackColor::Teal.hex()));
    assert_eq!(vox.color, TrackColor::Blue);
    assert_eq!(vox.color_hex.as_deref(), Some(TrackColor::Blue.hex()));
}

#[test]
fn static_lane_if_missing_does_not_override_existing_lane() {
    let mut track = Track::new("Test");
    track.automation_lanes.push(dream_models::project::AutomationLane {
        param_id: "send.A".to_string(),
        points: vec![dream_models::project::AutomationPoint {
            beat: 0.0,
            value: 0.7,
            curve_type: "linear".to_string(),
            tension: None,
            bezier_cp1x: None, bezier_cp1y: None, bezier_cp2x: None, bezier_cp2y: None,
        }],
    });

    upsert_static_import_lane_if_missing(&mut track, "send.A", 0.1);
    assert_eq!(track.automation_lanes.len(), 1);
    assert!((track.automation_lanes[0].points[0].value - 0.7).abs() < 1e-9);
}

#[test]
fn parse_target_track_xml_id_extracts_track_segment() {
    assert_eq!(
        dream_importers::ableton::routing::parse_target_track_xml_id("AudioOut/Track.243"),
        Some("243".to_string())
    );
    assert_eq!(
        dream_importers::ableton::routing::parse_target_track_xml_id("MidiOut/Track.77"),
        Some("77".to_string())
    );
    assert_eq!(
        dream_importers::ableton::routing::parse_target_track_xml_id("AudioOut/ReturnTrack.81"),
        Some("81".to_string())
    );
    assert_eq!(
        dream_importers::ableton::routing::parse_target_track_xml_id("AudioOut/track.99"),
        Some("99".to_string())
    );
    assert_eq!(
        dream_importers::ableton::routing::parse_target_track_xml_id("AudioOut/Main"),
        None
    );
    assert_eq!(
        dream_importers::ableton::routing::parse_target_track_xml_id("AudioOut/GroupTrack"),
        None
    );
}

#[test]
fn normalize_input_routing_target_handles_no_input_variants() {
    assert_eq!(normalize_input_routing_target(""), None);
    assert_eq!(normalize_input_routing_target("AudioIn/NoInput"), None);
    assert_eq!(normalize_input_routing_target("AudioIn/no_input"), None);
    assert_eq!(normalize_input_routing_target("No Input"), None);
    assert_eq!(
        normalize_input_routing_target("AudioIn/Ext.1"),
        Some("AudioIn/Ext.1".to_string())
    );
    assert_eq!(
        normalize_input_routing_target("MidiIn/Track.42"),
        Some("MidiIn/Track.42".to_string())
    );
}

#[test]
fn parse_output_target_supports_nested_routing_and_display_fallback() {
    let xml = r#"
    <Track>
      <DeviceChain>
        <RoutingContainer>
          <AudioOutputRouting>
            <UpperDisplayString Value="AudioOut/Track.123"/>
          </AudioOutputRouting>
        </RoutingContainer>
        <AudioInputRouting>
          <Target Value="AudioIn/Ext.1"/>
        </AudioInputRouting>
      </DeviceChain>
    </Track>
    "#;
    let doc = roxmltree::Document::parse(xml).expect("valid xml");
    let track = doc
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("Track"))
        .expect("track");
    assert_eq!(
        parse_output_target(track, "AudioInputRouting").as_deref(),
        Some("AudioIn/Ext.1")
    );
    assert_eq!(
        parse_output_target(track, "AudioOutputRouting").as_deref(),
        Some("AudioOut/Track.123")
    );
}

#[test]
fn parse_output_target_supports_direct_track_level_routing_node() {
    let xml = r#"
    <Track>
      <AudioOutputRouting>
        <Target Value="AudioOut/Main"/>
      </AudioOutputRouting>
    </Track>
    "#;
    let doc = roxmltree::Document::parse(xml).expect("valid xml");
    let track = doc
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("Track"))
        .expect("track");
    assert_eq!(
        parse_output_target(track, "AudioOutputRouting").as_deref(),
        Some("AudioOut/Main")
    );
}

#[test]
fn parse_track_bool_flag_reads_nested_value() {
    let xml = r#"
    <Track>
      <DeviceChain>
        <Mixer>
          <IsAutoSelectEnabled Value="false" />
        </Mixer>
      </DeviceChain>
      <KeepRecordMonitoringLatency Value="true" />
    </Track>
    "#;
    let doc = roxmltree::Document::parse(xml).expect("valid xml");
    let track = doc
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("Track"))
        .expect("track");
    assert_eq!(parse_track_bool_flag(track, "IsAutoSelectEnabled"), Some(false));
    assert_eq!(
        parse_track_bool_flag(track, "KeepRecordMonitoringLatency"),
        Some(true)
    );
}

#[test]
fn parse_track_key_note_target_reads_nested_value() {
    let xml = r#"
    <MidiTrack>
      <ControllerLayoutCustomization>
        <KeyNoteTarget Value="64" />
      </ControllerLayoutCustomization>
    </MidiTrack>
    "#;
    let doc = roxmltree::Document::parse(xml).expect("valid xml");
    let track = doc
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("MidiTrack"))
        .expect("track");
    assert_eq!(parse_track_key_note_target(track), Some(64));
}

#[test]
fn parse_track_i64_value_reads_nested_value() {
    let xml = r#"
    <MidiTrack>
      <PitchbendRange Value="96" />
    </MidiTrack>
    "#;
    let doc = roxmltree::Document::parse(xml).expect("valid xml");
    let track = doc
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("MidiTrack"))
        .expect("track");
    assert_eq!(parse_track_i64_value(track, "PitchbendRange"), Some(96));
}

#[test]
fn classify_output_routing_target_handles_main_none_group_and_track() {
    assert!(matches!(
        classify_output_routing_target("AudioOut/Main"),
        OutputRoutingTarget::Master
    ));
    assert!(matches!(
        classify_output_routing_target("Master"),
        OutputRoutingTarget::Master
    ));
    assert!(matches!(
        classify_output_routing_target("MidiOut/None"),
        OutputRoutingTarget::None
    ));
    assert!(matches!(
        classify_output_routing_target("No Output"),
        OutputRoutingTarget::None
    ));
    assert!(matches!(
        classify_output_routing_target("AudioOut/GroupTrack"),
        OutputRoutingTarget::GroupFallback
    ));
    match classify_output_routing_target("AudioOut/Track.243") {
        OutputRoutingTarget::TrackXmlId(id) => assert_eq!(id, "243"),
        _ => panic!("expected track xml id"),
    }
    assert!(matches!(
        classify_output_routing_target("AudioOut/External/S0"),
        OutputRoutingTarget::Unknown
    ));
}

#[test]
fn choose_preferred_output_target_prefers_audio_for_midi_tracks() {
    let out = choose_preferred_output_target(
        TrackType::Midi,
        Some("AudioOut/GroupTrack".to_string()),
        Some("MidiOut/None".to_string()),
    );
    assert_eq!(out.as_deref(), Some("AudioOut/GroupTrack"));
}

#[test]
fn collapse_split_stereo_pan_averages_channels() {
    let pan = collapse_split_stereo_pan(Some(-1.0), Some(1.0));
    assert_eq!(pan, Some(0.0));

    let pan = collapse_split_stereo_pan(Some(-0.6), Some(-0.2));
    assert_eq!(pan, Some(-0.4));
}

#[test]
fn collapse_split_stereo_pan_handles_partial_values() {
    assert_eq!(collapse_split_stereo_pan(Some(0.8), None), Some(0.8));
    assert_eq!(collapse_split_stereo_pan(None, Some(-0.5)), Some(-0.5));
    assert_eq!(collapse_split_stereo_pan(None, None), None);
}

#[test]
fn import_als_prefers_pan_over_split_stereo_pan() {
    let xml = r#"
    <Ableton>
      <LiveSet>
        <MainTrack>
          <Tempo><Manual Value="120"/></Tempo>
          <TimeSignature><Numerator Value="4"/><Denominator Value="4"/></TimeSignature>
          <DeviceChain><Mixer/></DeviceChain>
        </MainTrack>
        <Tracks>
          <AudioTrack Id="1">
            <Name><EffectiveName Value="PanTest"/></Name>
            <DeviceChain>
              <Mixer>
                <Pan><Manual Value="0.25"/></Pan>
                <SplitStereoPanL><Manual Value="-1.0"/></SplitStereoPanL>
                <SplitStereoPanR><Manual Value="1.0"/></SplitStereoPanR>
              </Mixer>
              <AudioToAudioDeviceChain>
                <Devices/>
              </AudioToAudioDeviceChain>
            </DeviceChain>
          </AudioTrack>
        </Tracks>
      </LiveSet>
    </Ableton>
    "#;

    let mut path = std::env::temp_dir();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("time")
        .as_nanos();
    path.push(format!("dream_daw_pan_precedence_{nanos}.als"));
    std::fs::write(&path, xml.as_bytes()).expect("write als");

    let project = import_als_project(&path).expect("import");
    let _ = std::fs::remove_file(&path);

    assert_eq!(project.tracks.len(), 1);
    let pan = project.tracks[0].pan;
    assert!(
        (pan - 0.25).abs() < 1e-9,
        "expected Pan=0.25 to win over split pan, got {pan}"
    );
}

#[test]
fn make_missing_external_slot_keeps_external_meta() {
    let meta = ExternalPluginMeta {
        format: Some("vst3".to_string()),
        uid: Some("1:2:3:4".to_string()),
        preset_name: Some("Init".to_string()),
        program_number: Some(0),
        parameter_count: Some(128),
        stored_all_parameters: Some(true),
        plugin_version: Some("2.1.0".to_string()),
        state_blob: Some("U1RBVEVfQkxPQg==".to_string()),
        state_blob_kind: Some("ProcessorState".to_string()),
        preset_blob: Some("UFJFU0VUX0JMT0I=".to_string()),
        preset_blob_kind: Some("Chunk".to_string()),
    };
    let node = make_missing_external_plugin_slot_with_metadata(
        "external",
        "Nectar 3",
        "Nectar 3",
        "Nectar 3",
        "",
        "Nectar 3",
        "",
        true,
        Some(&meta),
    );
    let slot = match node {
        DeviceNode::Single(slot) => slot,
        _ => panic!("expected single plugin slot"),
    };
    assert_eq!(slot.external_format.as_deref(), Some("vst3"));
    assert_eq!(slot.external_uid.as_deref(), Some("1:2:3:4"));
    assert_eq!(slot.external_preset_name.as_deref(), Some("Init"));
    assert_eq!(slot.external_state_blob_kind.as_deref(), Some("ProcessorState"));
    assert_eq!(slot.external_state_blob.as_deref(), Some("U1RBVEVfQkxPQg=="));
    assert_eq!(slot.external_preset_blob_kind.as_deref(), Some("Chunk"));
    assert_eq!(slot.external_preset_blob.as_deref(), Some("UFJFU0VUX0JMT0I="));
}

#[test]
fn build_pointee_map_captures_extended_mixer_targets() {
    let xml = r#"
    <Track>
      <DeviceChain>
        <Mixer>
          <CrossFadeState>
            <AutomationTarget Id="1001"/>
          </CrossFadeState>
          <Solo>
            <AutomationTarget Id="1002"/>
          </Solo>
          <Arm>
            <AutomationTarget Id="1003"/>
          </Arm>
          <Sends>
            <TrackSendHolder>
              <Send><AutomationTarget Id="1004"/></Send>
            </TrackSendHolder>
          </Sends>
        </Mixer>
      </DeviceChain>
    </Track>
    "#;
    let doc = roxmltree::Document::parse(xml).expect("valid xml");
    let track = doc
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("Track"))
        .expect("track");

    let map = build_pointee_map(track);
    assert_eq!(map.get("1001").map(String::as_str), Some("mixer.crossfade_state"));
    assert_eq!(map.get("1002").map(String::as_str), Some("mixer.solo"));
    assert_eq!(map.get("1003").map(String::as_str), Some("mixer.arm"));
    assert_eq!(map.get("1004").map(String::as_str), Some("send.A"));
}

#[test]
fn build_pointee_map_uses_track_send_holder_id() {
    let xml = r#"
    <Track>
      <DeviceChain>
        <Mixer>
          <Sends>
            <TrackSendHolder Id="2">
              <Send><AutomationTarget Id="2004"/></Send>
            </TrackSendHolder>
          </Sends>
        </Mixer>
      </DeviceChain>
    </Track>
    "#;
    let doc = roxmltree::Document::parse(xml).expect("valid xml");
    let track = doc
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("Track"))
        .expect("track");

    let map = build_pointee_map(track);
    assert_eq!(map.get("2004").map(String::as_str), Some("send.C"));
}

#[test]
fn parse_clip_envelopes_uses_pointee_map_param_id() {
    let xml = r#"
    <AudioClip>
      <Envelopes>
        <Envelopes>
          <AutomationEnvelope>
            <EnvelopeTarget><PointeeId Value="42"/></EnvelopeTarget>
            <Automation>
              <Events>
                <FloatEvent Time="0" Value="0.5"/>
              </Events>
            </Automation>
          </AutomationEnvelope>
        </Envelopes>
      </Envelopes>
    </AudioClip>
    "#;
    let doc = roxmltree::Document::parse(xml).expect("valid xml");
    let clip = doc
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("AudioClip"))
        .expect("clip");
    let mut map = std::collections::HashMap::new();
    map.insert("42".to_string(), "volume".to_string());
    let env = parse_clip_envelopes(clip, &map);
    assert_eq!(env.len(), 1);
    assert_eq!(env[0].param_id, "volume");
}

#[test]
fn collect_external_plugin_static_lanes_reads_parameter_manual_values() {
    let xml = r#"
    <PluginDevice Id="18">
      <UserName Value="FabFilter Pro-Q 3"/>
      <ParameterList>
        <PluginFloatParameter Id="0">
          <ParameterName Value="Band 8 Gain"/>
          <ParameterId Value="-1"/>
          <ParameterValue>
            <Manual Value="0.5265370011"/>
          </ParameterValue>
        </PluginFloatParameter>
        <PluginFloatParameter Id="1">
          <ParameterName Value="Band 8 Frequency"/>
          <ParameterId Value="-1"/>
          <ParameterValue>
            <Manual Value="0.6985535026"/>
          </ParameterValue>
        </PluginFloatParameter>
      </ParameterList>
    </PluginDevice>
    "#;
    let doc = roxmltree::Document::parse(xml).expect("valid xml");
    let device = doc
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("PluginDevice"))
        .expect("plugin device");
    let lanes = collect_external_plugin_static_lanes(device, 4, "fabfilterproq3");
    assert_eq!(lanes.len(), 2);
    assert_eq!(lanes[0].0, "plugin:4:fabfilterproq3:band8gain");
    assert!((lanes[0].1 - 0.5265370011).abs() < 1e-9);
    assert_eq!(lanes[1].0, "plugin:4:fabfilterproq3:band8frequency");
    assert!((lanes[1].1 - 0.6985535026).abs() < 1e-9);
}

#[test]
fn collect_external_plugin_static_lanes_suffixes_numeric_parameter_id() {
    let xml = r#"
    <PluginDevice Id="18">
      <UserName Value="My FX"/>
      <ParameterList>
        <PluginFloatParameter Id="0">
          <ParameterName Value="Cutoff"/>
          <ParameterId Value="10"/>
          <ParameterValue><Manual Value="0.10"/></ParameterValue>
        </PluginFloatParameter>
        <PluginFloatParameter Id="1">
          <ParameterName Value="Cutoff"/>
          <ParameterId Value="11"/>
          <ParameterValue><Manual Value="0.20"/></ParameterValue>
        </PluginFloatParameter>
      </ParameterList>
    </PluginDevice>
    "#;
    let doc = roxmltree::Document::parse(xml).expect("valid xml");
    let device = doc
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("PluginDevice"))
        .expect("plugin device");
    let lanes = collect_external_plugin_static_lanes(device, 2, "myfx");
    assert_eq!(lanes.len(), 2);
    assert_eq!(lanes[0].0, "plugin:2:myfx:cutoff_id10");
    assert_eq!(lanes[1].0, "plugin:2:myfx:cutoff_id11");
}

#[test]
fn parse_external_plugin_meta_reads_vst_preset_info() {
    let xml = r#"
    <PluginDevice Id="18">
      <Vst3PluginInfo Id="0">
        <Name Value="SPAN" />
        <Uid>
          <Fields.0 Value="1" />
          <Fields.1 Value="2" />
          <Fields.2 Value="3" />
          <Fields.3 Value="4" />
        </Uid>
        <NumberOfParameters Value="345" />
      </Vst3PluginInfo>
      <Preset>
        <Vst3Preset Id="195">
          <StoredAllParameters Value="true" />
          <PluginVersion Value="1.2.3" />
          <Name Value="Mastering A" />
          <ProgramNumber Value="7" />
          <ParameterCount Value="382" />
          <Chunk Value="QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=" />
        </Vst3Preset>
      </Preset>
      <PluginState>
        <ProcessorState Value="QmFzZTY0U3RhdGVQYXlsb2FkXzEyMzQ1Njc4OTA=" />
      </PluginState>
    </PluginDevice>
    "#;
    let doc = roxmltree::Document::parse(xml).expect("valid xml");
    let device = doc
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("PluginDevice"))
        .expect("plugin device");
    let meta = parse_external_plugin_meta(device);
    assert_eq!(meta.format.as_deref(), Some("vst3"));
    assert_eq!(meta.uid.as_deref(), Some("1:2:3:4"));
    assert_eq!(meta.preset_name.as_deref(), Some("Mastering A"));
    assert_eq!(meta.program_number, Some(7));
    assert_eq!(meta.parameter_count, Some(382));
    assert_eq!(meta.stored_all_parameters, Some(true));
    assert_eq!(meta.plugin_version.as_deref(), Some("1.2.3"));
    assert_eq!(meta.preset_blob_kind.as_deref(), Some("Chunk"));
    assert_eq!(
        meta.preset_blob.as_deref(),
        Some("QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=")
    );
    assert_eq!(meta.state_blob_kind.as_deref(), Some("ProcessorState"));
    assert_eq!(
        meta.state_blob.as_deref(),
        Some("QmFzZTY0U3RhdGVQYXlsb2FkXzEyMzQ1Njc4OTA=")
    );
}

#[test]
fn external_plugin_index_resolves_common_aliases() {
    let index = ExternalPluginIndex {
        by_name: std::collections::HashMap::from([
            ("reastream".to_string(), "/VST/ReaStream.vst3".to_string()),
            ("nectar 3".to_string(), "/VST/Nectar 3.vst3".to_string()),
            (
                "synthesizer v studio".to_string(),
                "/VST/Synthesizer V Studio.vst3".to_string(),
            ),
        ]),
        by_stem: std::collections::HashMap::new(),
        by_file_name: std::collections::HashMap::new(),
        by_normalized: std::collections::HashMap::from([
            ("reastream".to_string(), "/VST/ReaStream.vst3".to_string()),
            ("nectar3".to_string(), "/VST/Nectar 3.vst3".to_string()),
            (
                "synthesizervstudio".to_string(),
                "/VST/Synthesizer V Studio.vst3".to_string(),
            ),
        ]),
    };

    assert_eq!(
        index.resolve_by_name("reastream-standalone").as_deref(),
        Some("/VST/ReaStream.vst3")
    );
    assert_eq!(
        index.resolve_by_name("Nectar 3 Plugin").as_deref(),
        Some("/VST/Nectar 3.vst3")
    );
    assert_eq!(
        index
            .resolve_by_name("Synthesizer V Studio 2 Plugin")
            .as_deref(),
        Some("/VST/Synthesizer V Studio.vst3")
    );
}

#[test]
fn import_internal_sampler_params_populates_sampler_config() {
    let xml = r#"
    <OriginalSimpler>
      <Volume><Manual Value="0.8"/></Volume>
      <Attack><Manual Value="0.02"/></Attack>
      <Decay><Manual Value="0.25"/></Decay>
      <Sustain><Manual Value="75"/></Sustain>
      <Release><Manual Value="0.4"/></Release>
      <Root><Manual Value="62"/></Root>
      <Filter_Frequency><Manual Value="1200"/></Filter_Frequency>
      <Filter_Resonance><Manual Value="0.33"/></Filter_Resonance>
      <Filter_Type><Manual Value="2"/></Filter_Type>
    </OriginalSimpler>
    "#;
    let doc = roxmltree::Document::parse(xml).expect("valid xml");
    let device = doc
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("OriginalSimpler"))
        .expect("device");
    let mut track = Track::with_type("MIDI", TrackType::Midi, 0);
    import_internal_device_static_params(&mut track, "internal://instrument/sampler", device);
    let cfg = track.sampler.expect("sampler cfg");
    assert!((cfg.volume - 0.8).abs() < 1e-9);
    assert!((cfg.attack - 0.02).abs() < 1e-9);
    assert!((cfg.decay - 0.25).abs() < 1e-9);
    assert!((cfg.sustain - 0.75).abs() < 1e-9);
    assert!((cfg.release - 0.4).abs() < 1e-9);
    assert_eq!(cfg.root_note, 62);
    assert!((cfg.filter_cutoff - 1200.0).abs() < 1e-9);
    assert!((cfg.filter_resonance - 0.33).abs() < 1e-9);
    assert_eq!(cfg.filter_type, 2);
}

#[test]
fn import_internal_sampler_params_populates_extended_sampler_fields() {
    let xml = r#"
    <OriginalSimpler>
      <Detune><Manual Value="-12"/></Detune>
      <Osc2Waveform><Manual Value="3"/></Osc2Waveform>
      <OscMix><Manual Value="40"/></OscMix>
      <Sub><Manual Value="45"/></Sub>
      <LfoRate><Manual Value="3.5"/></LfoRate>
      <LfoDepth><Manual Value="65"/></LfoDepth>
      <LfoTarget><Manual Value="2"/></LfoTarget>
      <PulseWidth><Manual Value="0.72"/></PulseWidth>
    </OriginalSimpler>
    "#;
    let doc = roxmltree::Document::parse(xml).expect("valid xml");
    let device = doc
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("OriginalSimpler"))
        .expect("device");
    let mut track = Track::with_type("MIDI", TrackType::Midi, 0);
    import_internal_device_static_params(&mut track, "internal://instrument/sampler", device);
    let cfg = track.sampler.expect("sampler cfg");
    assert!((cfg.detune_cents + 12.0).abs() < 1e-9);
    assert_eq!(cfg.osc2_waveform, 3);
    assert!((cfg.osc_mix - 0.4).abs() < 1e-9);
    assert!((cfg.sub_level - 0.45).abs() < 1e-9);
    assert!((cfg.lfo_rate - 3.5).abs() < 1e-9);
    assert!((cfg.lfo_depth - 0.65).abs() < 1e-9);
    assert_eq!(cfg.lfo_target, 2);
    assert!((cfg.pulse_width - 0.72).abs() < 1e-9);
}

#[test]
fn canonical_internal_plugin_for_import_maps_synthesizer_v_to_wave_synth() {
    let mapped = canonical_internal_plugin_for_import("PluginDevice", "Synthesizer V Studio 2 Plugin");
    assert_eq!(
        mapped,
        Some(("internal://instrument/wave-synth", "Wave Synth", "instrument"))
    );
}

#[test]
fn import_track_automation_adds_static_plugin_param_lane_when_no_envelope() {
    let xml = r#"
    <Track>
      <DeviceChain>
        <Devices>
          <PluginDevice>
            <UserName Value="My VST"/>
            <PluginFloatParameter>
              <ParameterName Value="Cutoff"/>
              <ParameterId Value="12"/>
              <Manual Value="0.66"/>
            </PluginFloatParameter>
          </PluginDevice>
        </Devices>
      </DeviceChain>
    </Track>
    "#;
    let doc = roxmltree::Document::parse(xml).expect("valid xml");
    let track_node = doc
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("Track"))
        .expect("track");
    let mut track = Track::new("Test");

    import_track_automation(track_node, &mut track);

    let lane = track
        .automation_lanes
        .iter()
        .find(|l| l.param_id == "plugin:0:myvst:cutoff_id12")
        .expect("static plugin lane");
    assert_eq!(lane.points.len(), 1);
    assert!((lane.points[0].value - 0.66).abs() < 1e-9);
}

#[test]
fn plugin_param_lane_key_uses_parameter_id_for_stable_uniqueness() {
    let k1 = plugin_param_lane_key(0, "My VST", "Cutoff", "12");
    let k2 = plugin_param_lane_key(0, "My VST", "Cutoff", "13");
    let k3 = plugin_param_lane_key(0, "My VST", "Cutoff", "-1");
    assert_eq!(k1, "plugin:0:myvst:cutoff_id12");
    assert_eq!(k2, "plugin:0:myvst:cutoff_id13");
    assert_eq!(k3, "plugin:0:myvst:cutoff");
}

#[test]
fn import_track_automation_keeps_envelope_for_plugin_param() {
    let xml = r#"
    <Track>
      <DeviceChain>
        <Devices>
          <PluginDevice>
            <UserName Value="My VST"/>
            <PluginFloatParameter>
              <ParameterName Value="Cutoff"/>
              <ParameterId Value="12"/>
              <Manual Value="0.80"/>
              <AutomationTarget Id="777"/>
            </PluginFloatParameter>
          </PluginDevice>
        </Devices>
      </DeviceChain>
      <AutomationEnvelopes>
        <Envelopes>
          <AutomationEnvelope>
            <EnvelopeTarget>
              <PointeeId Value="777"/>
            </EnvelopeTarget>
            <Automation>
              <Events>
                <FloatEvent Time="0" Value="0.25"/>
                <FloatEvent Time="1" Value="0.50"/>
              </Events>
            </Automation>
          </AutomationEnvelope>
        </Envelopes>
      </AutomationEnvelopes>
    </Track>
    "#;
    let doc = roxmltree::Document::parse(xml).expect("valid xml");
    let track_node = doc
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("Track"))
        .expect("track");
    let mut track = Track::new("Test");

    import_track_automation(track_node, &mut track);

    let lane = track
        .automation_lanes
        .iter()
        .find(|l| l.param_id == "plugin:0:myvst:cutoff_id12")
        .expect("plugin lane");
    assert_eq!(lane.points.len(), 2);
    assert!((lane.points[0].value - 0.25).abs() < 1e-9);
    assert!((lane.points[1].value - 0.50).abs() < 1e-9);
}

#[test]
fn import_main_track_mixer_snapshot_reads_master_mixer_values() {
    let xml = r#"
    <MainTrack>
      <DeviceChain>
        <Mixer>
          <Volume><Manual Value="1.25"/></Volume>
          <Pan><Manual Value="-0.2"/></Pan>
          <On><Manual Value="false"/></On>
        </Mixer>
        <AudioOutputRouting>
          <Target Value="AudioOut/None"/>
        </AudioOutputRouting>
      </DeviceChain>
    </MainTrack>
    "#;
    let doc = roxmltree::Document::parse(xml).expect("valid xml");
    let main_track = doc
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("MainTrack"))
        .expect("main track");

    let mut master = Track::with_type("Master", TrackType::Master, 0);
    import_main_track_mixer_snapshot(main_track, &mut master);
    assert!((master.volume - 1.25).abs() < 1e-9);
    assert!((master.pan + 0.2).abs() < 1e-9);
    assert!(
        master
            .automation_lanes
            .iter()
            .any(|l| l.param_id == "mixer.output_enabled" && (l.points[0].value - 0.0).abs() < 1e-9)
    );
}

#[test]
fn import_main_track_mixer_snapshot_marks_unknown_output_as_enabled() {
    let xml = r#"
    <MainTrack>
      <DeviceChain>
        <AudioOutputRouting>
          <Target Value="AudioOut/External/S0"/>
        </AudioOutputRouting>
      </DeviceChain>
    </MainTrack>
    "#;
    let doc = roxmltree::Document::parse(xml).expect("valid xml");
    let main_track = doc
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("MainTrack"))
        .expect("main track");

    let mut master = Track::with_type("Master", TrackType::Master, 0);
    import_main_track_mixer_snapshot(main_track, &mut master);
    assert!(
        master
            .automation_lanes
            .iter()
            .any(|l| l.param_id == "mixer.output_enabled" && (l.points[0].value - 1.0).abs() < 1e-9)
    );
}

#[test]
fn parse_live_set_global_modes() {
    let xml = r#"
    <LiveSet>
      <AutomationMode Value="1"/>
      <SnapAutomationToGrid Value="false"/>
      <ArrangementOverdub Value="true"/>
      <SoloInPlace Value="0"/>
      <CrossfadeCurve Value="3"/>
      <LatencyCompensation Value="1"/>
      <SelectedDocumentViewInMainWindow Value="2"/>
      <ViewStateFxSlotCount Value="4"/>
      <ViewStateSessionMixerVolumeSectionHeight Value="283"/>
      <ViewStateArrangerMixerVolumeSectionHeight Value="120"/>
      <ViewStateSessionTrackWidth Value="74"/>
      <ViewStateMainWindowClipDetailOpen Value="false"/>
      <ViewStateMainWindowDeviceDetailOpen Value="true"/>
      <ViewStateSecondWindowClipDetailOpen Value="true"/>
      <ViewStateSecondWindowDeviceDetailOpen Value="false"/>
      <ShouldSceneTempoAndTimeSignatureBeVisible Value="true"/>
      <WaveformVerticalZoomFactor Value="1.25"/>
      <IsWaveformVerticalZoomActive Value="true"/>
      <HighlightedTrackIndex Value="34"/>
      <TrackHeaderWidth Value="102"/>
      <ResetNonautomatedMidiControllersOnClipStarts Value="true"/>
      <MidiFoldIn Value="true"/>
      <MidiFoldMode Value="-99"/>
      <MultiClipFocusMode Value="true"/>
      <MultiClipLoopBarHeight Value="16"/>
      <MidiPrelisten Value="1"/>
      <UseWarperLegacyHiQMode Value="false"/>
      <ShowVideoWindow Value="true"/>
      <SoloOrPflSavedValue Value="true"/>
      <ColorSequenceIndex Value="7"/>
      <NoteSpellingPreference Value="0"/>
      <AccidentalSpellingPreference Value="3"/>
      <PreferFlatRootNote Value="false"/>
      <ViewStateMainWindowHiddenOtherDocViewTypeClipDetailOpen Value="false"/>
      <ViewStateMainWindowHiddenOtherDocViewTypeDeviceDetailOpen Value="true"/>
      <Annotation Value="Project note"/>
      <SmpteFormat Value="0"/>
      <AutoColorPickerForPlayerAndGroupTracks>
        <NextColorIndex Value="6"/>
      </AutoColorPickerForPlayerAndGroupTracks>
      <AutoColorPickerForReturnAndMainTracks>
        <NextColorIndex Value="16"/>
      </AutoColorPickerForReturnAndMainTracks>
      <GroovePool>
        <DefaultGrooveId Value="3"/>
        <Grooves>
          <Groove Id="0" />
          <Groove Id="1" />
        </Grooves>
      </GroovePool>
      <LinkedTrackGroups>
        <LinkedTrackGroup Id="1" />
      </LinkedTrackGroups>
      <TuningSystems>
        <TuningSystem Id="0" />
      </TuningSystems>
      <NoteAlgorithms>
        <QuantizeAlgorithm Id="0" />
        <RandomizeAlgorithm Id="1" />
      </NoteAlgorithms>
      <VideoWindowRect Top="-10" Left="-20" Bottom="1080" Right="1920" />
      <ViewStates>
        <MixerInArrangement Value="0"/>
        <ArrangerMixerIO Value="1"/>
        <ArrangerMixerSends Value="1"/>
        <ArrangerMixerReturns Value="1"/>
        <ArrangerMixerVolume Value="1"/>
        <ArrangerMixerTrackOptions Value="0"/>
        <ArrangerMixerCrossFade Value="0"/>
        <ArrangerMixerTrackPerformanceImpactMeter Value="0"/>
        <MixerInSession Value="1"/>
        <SessionIO Value="1"/>
        <SessionSends Value="1"/>
        <SessionReturns Value="1"/>
        <SessionVolume Value="1"/>
        <SessionTrackOptions Value="0"/>
        <SessionCrossFade Value="0"/>
        <SessionTrackPerformanceImpactMeter Value="0"/>
        <SessionShowOverView Value="0"/>
        <ArrangerIO Value="1"/>
        <ArrangerReturns Value="1"/>
        <ArrangerVolume Value="1"/>
        <ArrangerTrackOptions Value="0"/>
        <ArrangerShowOverView Value="1"/>
      </ViewStates>
    </LiveSet>
    "#;
    let doc = roxmltree::Document::parse(xml).expect("valid xml");
    let live_set = doc
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("LiveSet"))
        .expect("live set");

    assert_eq!(parse_live_set_bool(live_set, "AutomationMode"), Some(true));
    assert_eq!(parse_live_set_bool(live_set, "SnapAutomationToGrid"), Some(false));
    assert_eq!(parse_live_set_bool(live_set, "ArrangementOverdub"), Some(true));
    assert_eq!(parse_live_set_bool(live_set, "SoloInPlace"), Some(false));
    assert_eq!(parse_live_set_i32(live_set, "CrossfadeCurve"), Some(3));
    assert_eq!(parse_live_set_i32(live_set, "LatencyCompensation"), Some(1));
    assert_eq!(parse_live_set_i32(live_set, "SelectedDocumentViewInMainWindow"), Some(2));
    assert_eq!(parse_live_set_i32(live_set, "ViewStateFxSlotCount"), Some(4));
    assert_eq!(
        first_child_value(live_set, "ViewStateSessionMixerVolumeSectionHeight")
            .as_deref()
            .and_then(parse_f64_value),
        Some(283.0)
    );
    assert_eq!(
        first_child_value(live_set, "ViewStateArrangerMixerVolumeSectionHeight")
            .as_deref()
            .and_then(parse_f64_value),
        Some(120.0)
    );
    assert_eq!(
        first_child_value(live_set, "ViewStateSessionTrackWidth")
            .as_deref()
            .and_then(parse_f64_value),
        Some(74.0)
    );
    assert_eq!(parse_live_set_bool(live_set, "ViewStateMainWindowClipDetailOpen"), Some(false));
    assert_eq!(parse_live_set_bool(live_set, "ViewStateMainWindowDeviceDetailOpen"), Some(true));
    assert_eq!(parse_live_set_bool(live_set, "ViewStateSecondWindowClipDetailOpen"), Some(true));
    assert_eq!(parse_live_set_bool(live_set, "ViewStateSecondWindowDeviceDetailOpen"), Some(false));
    assert_eq!(parse_live_set_bool(live_set, "ShouldSceneTempoAndTimeSignatureBeVisible"), Some(true));
    assert_eq!(
        first_child_value(live_set, "WaveformVerticalZoomFactor")
            .as_deref()
            .and_then(parse_f64_value),
        Some(1.25)
    );
    assert_eq!(parse_live_set_bool(live_set, "IsWaveformVerticalZoomActive"), Some(true));
    assert_eq!(parse_live_set_i32(live_set, "HighlightedTrackIndex"), Some(34));
    assert_eq!(
        first_child_value(live_set, "TrackHeaderWidth")
            .as_deref()
            .and_then(parse_f64_value),
        Some(102.0)
    );
    assert_eq!(
        parse_live_set_bool(live_set, "ResetNonautomatedMidiControllersOnClipStarts"),
        Some(true)
    );
    assert_eq!(parse_live_set_bool(live_set, "MidiFoldIn"), Some(true));
    assert_eq!(parse_live_set_i32(live_set, "MidiFoldMode"), Some(-99));
    assert_eq!(parse_live_set_bool(live_set, "MultiClipFocusMode"), Some(true));
    assert_eq!(
        first_child_value(live_set, "MultiClipLoopBarHeight")
            .as_deref()
            .and_then(parse_f64_value),
        Some(16.0)
    );
    assert_eq!(parse_live_set_bool(live_set, "MidiPrelisten"), Some(true));
    assert_eq!(parse_live_set_bool(live_set, "UseWarperLegacyHiQMode"), Some(false));
    assert_eq!(parse_live_set_bool(live_set, "ShowVideoWindow"), Some(true));
    assert_eq!(parse_live_set_bool(live_set, "SoloOrPflSavedValue"), Some(true));
    assert_eq!(parse_live_set_i32(live_set, "ColorSequenceIndex"), Some(7));
    assert_eq!(parse_live_set_i32(live_set, "NoteSpellingPreference"), Some(0));
    assert_eq!(parse_live_set_i32(live_set, "AccidentalSpellingPreference"), Some(3));
    assert_eq!(parse_live_set_bool(live_set, "PreferFlatRootNote"), Some(false));
    assert_eq!(
        parse_live_set_bool(live_set, "ViewStateMainWindowHiddenOtherDocViewTypeClipDetailOpen"),
        Some(false)
    );
    assert_eq!(
        parse_live_set_bool(live_set, "ViewStateMainWindowHiddenOtherDocViewTypeDeviceDetailOpen"),
        Some(true)
    );
    assert_eq!(first_child_value(live_set, "Annotation"), Some("Project note".to_string()));
    assert_eq!(parse_live_set_i32(live_set, "SmpteFormat"), Some(0));
    assert_eq!(
        live_set
            .children()
            .find(|n| n.is_element() && n.has_tag_name("AutoColorPickerForPlayerAndGroupTracks"))
            .and_then(|n| first_child_i32(n, "NextColorIndex")),
        Some(6)
    );
    assert_eq!(
        live_set
            .children()
            .find(|n| n.is_element() && n.has_tag_name("AutoColorPickerForReturnAndMainTracks"))
            .and_then(|n| first_child_i32(n, "NextColorIndex")),
        Some(16)
    );
    assert_eq!(
        live_set
            .children()
            .find(|n| n.is_element() && n.has_tag_name("GroovePool"))
            .and_then(|n| first_child_i32(n, "DefaultGrooveId")),
        Some(3)
    );
    assert_eq!(
        live_set
            .children()
            .find(|n| n.is_element() && n.has_tag_name("GroovePool"))
            .map(|n| n.descendants().filter(|d| d.is_element() && d.has_tag_name("Groove")).count()),
        Some(2)
    );
    assert_eq!(
        live_set
            .children()
            .find(|n| n.is_element() && n.has_tag_name("LinkedTrackGroups"))
            .map(|n| n.children().filter(|c| c.is_element()).count()),
        Some(1)
    );
    assert_eq!(
        live_set
            .children()
            .find(|n| n.is_element() && n.has_tag_name("TuningSystems"))
            .map(|n| n.children().filter(|c| c.is_element()).count()),
        Some(1)
    );
    assert_eq!(
        live_set
            .children()
            .find(|n| n.is_element() && n.has_tag_name("NoteAlgorithms"))
            .map(|n| n.children().filter(|c| c.is_element()).count()),
        Some(2)
    );
    let video_rect = live_set
        .children()
        .find(|n| n.is_element() && n.has_tag_name("VideoWindowRect"))
        .expect("video rect");
    assert_eq!(video_rect.attribute("Top").and_then(parse_i64_value), Some(-10));
    assert_eq!(video_rect.attribute("Left").and_then(parse_i64_value), Some(-20));
    assert_eq!(video_rect.attribute("Bottom").and_then(parse_i64_value), Some(1080));
    assert_eq!(video_rect.attribute("Right").and_then(parse_i64_value), Some(1920));
    assert_eq!(parse_view_states_bool(live_set, "MixerInArrangement"), Some(false));
    assert_eq!(parse_view_states_bool(live_set, "ArrangerMixerIO"), Some(true));
    assert_eq!(parse_view_states_bool(live_set, "SessionIO"), Some(true));
    assert_eq!(parse_view_states_bool(live_set, "SessionShowOverView"), Some(false));
    assert_eq!(parse_view_states_bool(live_set, "ArrangerIO"), Some(true));
    assert_eq!(parse_view_states_bool(live_set, "ArrangerReturns"), Some(true));
    assert_eq!(parse_view_states_bool(live_set, "ArrangerVolume"), Some(true));
    assert_eq!(parse_view_states_bool(live_set, "ArrangerTrackOptions"), Some(false));
    assert_eq!(parse_view_states_bool(live_set, "ArrangerShowOverView"), Some(true));
}

#[test]
fn parse_clip_grid_accepts_root_grid_node() {
    let xml = r#"
    <Grid>
      <FixedNumerator Value="8" />
      <FixedDenominator Value="1" />
      <Ntoles Value="2" />
      <SnapToGrid Value="true" />
      <Fixed Value="false" />
    </Grid>
    "#;
    let doc = roxmltree::Document::parse(xml).expect("valid xml");
    let grid = doc
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("Grid"))
        .expect("grid");
    let parsed = parse_clip_grid(grid).expect("parsed");
    assert_eq!(parsed, (8, 1, 2, true, false));
}

#[test]
fn parse_clip_time_signature_reads_remoteable_signature() {
    let xml = r#"
    <MidiClip>
      <TimeSignature>
        <TimeSignatures>
          <RemoteableTimeSignature Id="0">
            <Numerator Value="7" />
            <Denominator Value="8" />
            <Time Value="0" />
          </RemoteableTimeSignature>
        </TimeSignatures>
      </TimeSignature>
    </MidiClip>
    "#;
    let doc = roxmltree::Document::parse(xml).expect("valid xml");
    let clip = doc
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("MidiClip"))
        .expect("clip");
    let (num, den) = parse_clip_time_signature(clip);
    assert_eq!(num, Some(7));
    assert_eq!(den, Some(8));
}

#[test]
fn parse_transport_values_from_live_set_transport_node() {
    let xml = r#"
    <LiveSet>
      <Transport>
        <PhaseNudgeTempo Value="10" />
        <LoopOn Value="true" />
        <LoopStart Value="16" />
        <LoopLength Value="8" />
        <LoopIsSongStart Value="false" />
        <CurrentTime Value="18.5" />
        <PunchIn Value="1" />
        <PunchOut Value="0" />
        <MetronomeTickDuration Value="0.25" />
        <DrawMode Value="true" />
      </Transport>
    </LiveSet>
    "#;
    let doc = roxmltree::Document::parse(xml).expect("valid xml");
    let live_set = doc
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("LiveSet"))
        .expect("live set");
    let transport = live_set
        .children()
        .find(|n| n.is_element() && n.has_tag_name("Transport"))
        .expect("transport");
    assert_eq!(first_child_bool(transport, "LoopOn"), Some(true));
    assert_eq!(first_child_f64(transport, "LoopStart"), Some(16.0));
    assert_eq!(first_child_f64(transport, "LoopLength"), Some(8.0));
    assert_eq!(first_child_f64(transport, "PhaseNudgeTempo"), Some(10.0));
    assert_eq!(first_child_f64(transport, "CurrentTime"), Some(18.5));
    assert_eq!(first_child_bool(transport, "PunchIn"), Some(true));
    assert_eq!(first_child_bool(transport, "PunchOut"), Some(false));
    assert_eq!(first_child_bool(transport, "LoopIsSongStart"), Some(false));
    assert_eq!(first_child_f64(transport, "MetronomeTickDuration"), Some(0.25));
    assert_eq!(first_child_bool(transport, "DrawMode"), Some(true));
}

#[test]
fn import_demo_als_smoke_keeps_multi_device_tracks() {
    use std::fs;
    use std::path::PathBuf;

    if std::env::var("DREAM_DAW_ALS_SMOKE").ok().as_deref() != Some("1") {
        eprintln!("skip: set DREAM_DAW_ALS_SMOKE=1 to run heavy ALS smoke import");
        return;
    }

    let workspace_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..");
    let demo_dir = workspace_root.join("Demo/51. Rainbow");
    if !demo_dir.exists() {
        eprintln!("skip: demo folder not found: {}", demo_dir.display());
        return;
    }

    let mut als_files = fs::read_dir(&demo_dir)
        .expect("read demo dir")
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|p| {
            p.extension()
                .and_then(|s| s.to_str())
                .map(|s| s.eq_ignore_ascii_case("als"))
                .unwrap_or(false)
        })
        .collect::<Vec<_>>();
    als_files.sort();
    if als_files.is_empty() {
        eprintln!("skip: no .als files in {}", demo_dir.display());
        return;
    }

    // Keep default test runtime deterministic and fast.
    // Set DREAM_DAW_LONG_TESTS=1 to run the full corpus locally.
    if std::env::var("DREAM_DAW_LONG_TESTS").ok().as_deref() != Some("1") {
        als_files.truncate(1);
    }

    for als_path in als_files {
        let project = import_als_project(&als_path).unwrap_or_else(|e| {
            panic!("import failed for {}: {e}", als_path.display());
        });

        assert!(
            !project.tracks.is_empty(),
            "no tracks imported from {}",
            als_path.display()
        );

        let mut max_devices_on_track = 0usize;
        let mut tracks_with_any_device = 0usize;
        for track in &project.tracks {
            let device_count =
                usize::from(track.instrument.is_some()) + track.effects.len();
            if device_count > 0 {
                tracks_with_any_device += 1;
            }
            max_devices_on_track = max_devices_on_track.max(device_count);
        }

        assert!(
            tracks_with_any_device > 0,
            "no devices imported from {}",
            als_path.display()
        );
        assert!(
            max_devices_on_track >= 2,
            "all tracks collapsed to <=1 device in {}",
            als_path.display()
        );
    }
}

#[test]
fn audit_als_device_chain_depth_vs_xml() {
    use std::path::PathBuf;

    fn count_device_tree_nodes(node: &DeviceNode) -> usize {
        match node {
            DeviceNode::Single(_) => 1,
            DeviceNode::Rack(rack) => {
                1 + rack
                    .chains
                    .iter()
                    .map(|chain| chain.devices.iter().map(count_device_tree_nodes).sum::<usize>())
                    .sum::<usize>()
            }
        }
    }

    let Some(als_path_raw) = std::env::var("DREAM_DAW_ALS_DEVICE_AUDIT_PATH").ok() else {
        eprintln!(
            "skip: set DREAM_DAW_ALS_DEVICE_AUDIT_PATH=/abs/path/to/project.als to run device-depth audit"
        );
        return;
    };
    let als_path = PathBuf::from(als_path_raw);
    if !als_path.exists() {
        eprintln!("skip: ALS path not found: {}", als_path.display());
        return;
    }

    let project = import_als_project(&als_path).unwrap_or_else(|e| {
        panic!("import failed for {}: {e}", als_path.display());
    });
    assert!(
        !project.tracks.is_empty(),
        "no tracks imported from {}",
        als_path.display()
    );

    let xml_text = read_als_xml_text_from_importer(&als_path).expect("als text");
    let doc = parse_als_document_from_importer(&xml_text).expect("als doc");
    let live_set = find_live_set_from_importer(&doc).expect("live set");
    let tracks_node = live_set
        .children()
        .find(|n| n.is_element() && n.has_tag_name("Tracks"))
        .or_else(|| {
            live_set
                .descendants()
                .find(|n| n.is_element() && n.has_tag_name("Tracks"))
        })
        .expect("tracks node");

    let xml_track_nodes: Vec<roxmltree::Node<'_, '_>> = tracks_node
        .children()
        .filter(|n| n.is_element())
        .filter(|n| {
            matches!(
                n.tag_name().name(),
                "AudioTrack" | "MidiTrack" | "GroupTrack" | "ReturnTrack"
            )
        })
        .collect();

    assert_eq!(
        xml_track_nodes.len(),
        project.tracks.len(),
        "xml/imported track count mismatch in {}",
        als_path.display()
    );

    let mut xml_multi_device_tracks = 0usize;
    let mut imported_multi_device_tracks = 0usize;
    let mut severe_collapses: Vec<(usize, usize, usize, String)> = Vec::new();
    let mut hard_left_tracks = 0usize;
    let mut hard_right_tracks = 0usize;
    let mut near_center_tracks = 0usize;

    for (idx, (track_node, imported_track)) in xml_track_nodes.iter().zip(project.tracks.iter()).enumerate() {
        let xml_nodes = collect_track_devices(*track_node).len();
        let imported_nodes = imported_track
            .instrument
            .as_ref()
            .map(count_device_tree_nodes)
            .unwrap_or(0)
            + imported_track
                .effects
                .iter()
                .map(count_device_tree_nodes)
                .sum::<usize>();

        if xml_nodes >= 2 {
            xml_multi_device_tracks += 1;
        }
        if imported_nodes >= 2 {
            imported_multi_device_tracks += 1;
        }

        if xml_nodes >= 2 && imported_nodes <= 1 {
            severe_collapses.push((idx, xml_nodes, imported_nodes, imported_track.name.clone()));
        }

        let pan = imported_track.pan;
        if pan <= -0.99 {
            hard_left_tracks += 1;
        } else if pan >= 0.99 {
            hard_right_tracks += 1;
        } else if pan.abs() <= 0.10 {
            near_center_tracks += 1;
        }
    }

    eprintln!(
        "[ALS Device Audit] file='{}' tracks={} xml_multi={} imported_multi={} severe_collapses={} pan_hard_left={} pan_hard_right={} pan_near_center={}",
        als_path.display(),
        project.tracks.len(),
        xml_multi_device_tracks,
        imported_multi_device_tracks,
        severe_collapses.len(),
        hard_left_tracks,
        hard_right_tracks,
        near_center_tracks,
    );

    for (idx, xml_nodes, imported_nodes, name) in severe_collapses.iter().take(20) {
        eprintln!(
            "[ALS Device Audit] collapse track={} name='{}' xml_nodes={} imported_nodes={}",
            idx,
            name,
            xml_nodes,
            imported_nodes
        );
    }

    assert!(
        xml_multi_device_tracks > 0,
        "no multi-device tracks found in xml for {}",
        als_path.display()
    );
    assert!(
        severe_collapses.is_empty(),
        "found {} severe device-chain collapses in {}",
        severe_collapses.len(),
        als_path.display()
    );
}

#[test]
fn audit_rainbow_latest_v14_import_deep() {
    use std::fs;
    use std::path::{Path, PathBuf};

    fn count_device_tree(
        node: &DeviceNode,
        total_nodes: &mut usize,
        total_single: &mut usize,
        missing_single: &mut usize,
        internal_single: &mut usize,
        external_single: &mut usize,
    ) {
        *total_nodes += 1;
        match node {
            DeviceNode::Single(slot) => {
                *total_single += 1;
                let pid = slot.plugin_id.to_ascii_lowercase();
                if pid.starts_with("missing://") {
                    *missing_single += 1;
                } else if pid.starts_with("internal://") {
                    *internal_single += 1;
                } else {
                    *external_single += 1;
                }
            }
            DeviceNode::Rack(rack) => {
                for chain in &rack.chains {
                    for child in &chain.devices {
                        count_device_tree(
                            child,
                            total_nodes,
                            total_single,
                            missing_single,
                            internal_single,
                            external_single,
                        );
                    }
                }
            }
        }
    }

    fn parse_rainbow_version(path: &Path) -> Option<u32> {
        let name = path.file_name()?.to_str()?;
        let rest = name.strip_prefix("Rainbow V")?;
        let num = rest.strip_suffix(".als")?;
        num.parse::<u32>().ok()
    }

    if std::env::var("DREAM_DAW_RAINBOW_AUDIT")
        .ok()
        .as_deref()
        != Some("1")
    {
        eprintln!("skip: set DREAM_DAW_RAINBOW_AUDIT=1 to run deep Rainbow audit");
        return;
    }

    let workspace_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let demo_dir = workspace_root.join("Demo/51. Rainbow");
    assert!(
        demo_dir.exists(),
        "demo folder missing: {}",
        demo_dir.display()
    );

    let mut latest: Option<(u32, PathBuf)> = None;
    for entry in fs::read_dir(&demo_dir).expect("read demo dir") {
        let path = match entry {
            Ok(e) => e.path(),
            Err(_) => continue,
        };
        if let Some(ver) = parse_rainbow_version(&path) {
            match &latest {
                Some((cur, _)) if *cur >= ver => {}
                _ => latest = Some((ver, path)),
            }
        }
    }

    let (version, als_path) = latest.expect("Rainbow V*.als not found");
    let project = import_als_project(&als_path).unwrap_or_else(|e| {
        panic!("import failed for {}: {e}", als_path.display());
    });

    let mut tracks_with_any_device = 0usize;
    let mut tracks_with_multi_device = 0usize;
    let mut max_nodes_on_track = 0usize;
    let mut total_nodes = 0usize;
    let mut total_single = 0usize;
    let mut missing_single = 0usize;
    let mut internal_single = 0usize;
    let mut external_single = 0usize;
    let mut pan_out_of_range = 0usize;
    let mut audio_clip_count = 0usize;
    let mut midi_clip_count = 0usize;

    for track in &project.tracks {
        if !(-1.0..=1.0).contains(&track.pan) {
            pan_out_of_range += 1;
        }
        audio_clip_count += track.clips.len();
        midi_clip_count += track.midi_clips.len();

        let mut nodes_on_track = 0usize;
        if let Some(inst) = &track.instrument {
            count_device_tree(
                inst,
                &mut total_nodes,
                &mut total_single,
                &mut missing_single,
                &mut internal_single,
                &mut external_single,
            );
            nodes_on_track += 1;
            if let DeviceNode::Rack(r) = inst {
                for chain in &r.chains {
                    nodes_on_track += chain.devices.len();
                }
            }
        }
        for fx in &track.effects {
            count_device_tree(
                fx,
                &mut total_nodes,
                &mut total_single,
                &mut missing_single,
                &mut internal_single,
                &mut external_single,
            );
            nodes_on_track += 1;
            if let DeviceNode::Rack(r) = fx {
                for chain in &r.chains {
                    nodes_on_track += chain.devices.len();
                }
            }
        }

        if nodes_on_track > 0 {
            tracks_with_any_device += 1;
        }
        if nodes_on_track >= 2 {
            tracks_with_multi_device += 1;
        }
        max_nodes_on_track = max_nodes_on_track.max(nodes_on_track);
    }

    eprintln!(
        "[RainbowAudit] file='{}' version={} tracks={} audio_clips={} midi_clips={} tracks_with_devices={} tracks_with_multi_device={} max_nodes_track={} total_nodes={} total_single={} missing_single={} internal_single={} external_single={} pan_out_of_range={}",
        als_path.display(),
        version,
        project.tracks.len(),
        audio_clip_count,
        midi_clip_count,
        tracks_with_any_device,
        tracks_with_multi_device,
        max_nodes_on_track,
        total_nodes,
        total_single,
        missing_single,
        internal_single,
        external_single,
        pan_out_of_range
    );

    assert!(!project.tracks.is_empty(), "no tracks imported");
    assert!(
        audio_clip_count + midi_clip_count > 0,
        "no clips imported from Rainbow"
    );
    assert!(
        tracks_with_any_device > 0,
        "no devices imported from Rainbow"
    );
    assert!(
        tracks_with_multi_device > 0,
        "all tracks collapsed to <=1 device"
    );
    assert_eq!(pan_out_of_range, 0, "imported pan outside [-1..1]");
    assert!(
        total_single > 0,
        "no single plugin nodes imported"
    );
    assert!(
        internal_single + external_single > 0,
        "all imported plugins are missing placeholders"
    );
}

#[test]
fn parse_live_set_session_scroll_and_breakpoint() {
    let xml = r#"
    <LiveSet>
      <SessionScrollPos X="-5582" Y="17" />
      <SelectedBreakpointValue Value="1308.18286" />
      <TimeSelection>
        <AnchorTime Value="120" />
        <OtherTime Value="124" />
      </TimeSelection>
      <SequencerNavigator>
        <BeatTimeHelper>
          <CurrentZoom Value="0.250933532486930566" />
        </BeatTimeHelper>
        <ScrollerPos X="-41" Y="-896" />
        <ClientSize X="908" Y="598" />
      </SequencerNavigator>
      <IsContentSplitterOpen Value="true" />
      <IsExpressionSplitterOpen Value="false" />
      <ExpressionLanes>
        <MidiEditorLaneModel Id="4">
          <Type Value="5" />
          <Size Value="41" />
          <IsMinimized Value="true" />
        </MidiEditorLaneModel>
        <MidiEditorLaneModel Id="0">
          <Type Value="0" />
          <Size Value="41" />
          <IsMinimized Value="false" />
        </MidiEditorLaneModel>
      </ExpressionLanes>
      <ContentLanes>
        <MidiEditorLaneModel Id="2">
          <Type Value="3" />
          <Size Value="25" />
          <IsMinimized Value="true" />
        </MidiEditorLaneModel>
      </ContentLanes>
      <ViewData Value="{&quot;layout&quot;:&quot;arrangement&quot;}" />
    </LiveSet>
    "#;
    let doc = roxmltree::Document::parse(xml).expect("valid xml");
    let live_set = doc
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("LiveSet"))
        .expect("live set");
    let session_scroll = live_set
        .children()
        .find(|n| n.is_element() && n.has_tag_name("SessionScrollPos"))
        .expect("session scroll");
    assert_eq!(
        session_scroll.attribute("X").and_then(parse_i64_value),
        Some(-5582)
    );
    assert_eq!(
        session_scroll.attribute("Y").and_then(parse_i64_value),
        Some(17)
    );
    assert_eq!(
        first_child_f64(live_set, "SelectedBreakpointValue"),
        Some(1308.18286)
    );
    let time_selection = live_set
        .children()
        .find(|n| n.is_element() && n.has_tag_name("TimeSelection"))
        .expect("time selection");
    assert_eq!(first_child_f64(time_selection, "AnchorTime"), Some(120.0));
    assert_eq!(first_child_f64(time_selection, "OtherTime"), Some(124.0));
    let seq = live_set
        .children()
        .find(|n| n.is_element() && n.has_tag_name("SequencerNavigator"))
        .expect("sequencer navigator");
    let zoom = seq
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("CurrentZoom"))
        .and_then(|n| n.attribute("Value"))
        .and_then(parse_f64_value);
    assert_eq!(zoom, Some(0.250933532486930566));
    let scroller_pos = seq
        .children()
        .find(|n| n.is_element() && n.has_tag_name("ScrollerPos"))
        .expect("scroller pos");
    assert_eq!(scroller_pos.attribute("X").and_then(parse_i64_value), Some(-41));
    assert_eq!(scroller_pos.attribute("Y").and_then(parse_i64_value), Some(-896));
    let client_size = seq
        .children()
        .find(|n| n.is_element() && n.has_tag_name("ClientSize"))
        .expect("client size");
    assert_eq!(client_size.attribute("X").and_then(parse_i64_value), Some(908));
    assert_eq!(client_size.attribute("Y").and_then(parse_i64_value), Some(598));
    assert_eq!(parse_live_set_bool(live_set, "IsContentSplitterOpen"), Some(true));
    assert_eq!(parse_live_set_bool(live_set, "IsExpressionSplitterOpen"), Some(false));
    let expression_lanes = parse_root_midi_editor_lanes(live_set, "ExpressionLanes");
    assert_eq!(expression_lanes.len(), 2);
    assert_eq!(expression_lanes[0].id, 0);
    assert_eq!(expression_lanes[1].id, 4);
    assert_eq!(expression_lanes[1].lane_type, 5);
    let content_lanes = parse_root_midi_editor_lanes(live_set, "ContentLanes");
    assert_eq!(content_lanes.len(), 1);
    assert_eq!(content_lanes[0].id, 2);
    assert_eq!(content_lanes[0].size, 25.0);
    assert_eq!(
        first_child_value(live_set, "ViewData"),
        Some("{\"layout\":\"arrangement\"}".to_string())
    );
}

#[test]
fn parse_project_markers_includes_cue_points() {
    let xml = r#"
    <LiveSet>
      <Locators>
        <Locators>
          <Locator><Name Value="Verse"/><Time Value="8"/></Locator>
        </Locators>
      </Locators>
      <CuePoints>
        <CuePoint Name="Drop" Time="16" Color="2"/>
      </CuePoints>
    </LiveSet>
    "#;
    let doc = roxmltree::Document::parse(xml).expect("valid xml");
    let live_set = doc
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("LiveSet"))
        .expect("live set");
    let markers = parse_project_markers(live_set);
    assert_eq!(markers.len(), 2);
    assert_eq!(markers[0].name, "Verse");
    assert_eq!(markers[1].name, "Drop");
    assert!((markers[1].position_beats - 16.0).abs() < 1e-9);
}

#[test]
fn parse_project_scenes_reads_follow_and_time_signature_details() {
    let xml = r#"
    <LiveSet>
      <Scenes>
        <Scene Id="3">
          <Name Value="Build" />
          <Tempo Value="128" />
          <IsTempoEnabled Value="true" />
          <TimeSignatureId Value="201" />
          <IsTimeSignatureEnabled Value="true" />
          <TimeSignature>
            <TimeSignatures>
              <RemoteableTimeSignature Id="0">
                <Numerator Value="7" />
                <Denominator Value="8" />
              </RemoteableTimeSignature>
            </TimeSignatures>
          </TimeSignature>
          <FollowAction>
            <FollowActionEnabled Value="true" />
            <FollowTime Value="2" />
            <FollowActionA Value="4" />
            <FollowActionB Value="2" />
            <FollowChanceA Value="75" />
            <FollowChanceB Value="25" />
          </FollowAction>
        </Scene>
      </Scenes>
    </LiveSet>
    "#;
    let doc = roxmltree::Document::parse(xml).expect("valid xml");
    let live_set = doc
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("LiveSet"))
        .expect("live set");
    let scenes = parse_project_scenes(live_set);
    assert_eq!(scenes.len(), 1);
    let s = &scenes[0];
    assert_eq!(s.index, 3);
    assert_eq!(s.name, "Build");
    assert_eq!(s.time_signature_numerator, Some(7));
    assert_eq!(s.time_signature_denominator, Some(8));
    assert!(s.follow_action_enabled);
    assert_eq!(s.follow_action_a, Some(4));
    assert_eq!(s.follow_action_b, Some(2));
}
