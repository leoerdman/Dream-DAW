use super::*;
use dream_importers::ableton::clip_parser::{parse_clip_envelopes, parse_clip_time_signature};
use dream_importers::ableton::device_params::{
    collect_external_plugin_static_lanes, import_internal_device_static_params,
};
use dream_importers::ableton::plugin_mapper::{
    MissingExternalPluginSlotSpec, canonical_internal_plugin_for_import,
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
    let node = make_missing_external_plugin_slot_with_metadata(MissingExternalPluginSlotSpec {
        kind: "external",
        preferred_name: "Nectar 3",
        user_name: "Nectar 3",
        vst2_name: "Nectar 3",
        vst2_path: "",
        vst3_name: "Nectar 3",
        vst3_path: "",
        is_placeholder: true,
        meta: Some(&meta),
    });
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


mod plugin_automation_tests;

mod live_set_and_audit_tests;
