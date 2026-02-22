use super::*;

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

