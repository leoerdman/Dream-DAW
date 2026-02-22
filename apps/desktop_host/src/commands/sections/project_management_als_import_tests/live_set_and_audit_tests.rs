use super::*;

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
