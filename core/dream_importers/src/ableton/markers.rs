// ═══════════════════════════════════════════════════════════════════════
// Markers & Scenes — Project locator and scene extraction from ALS XML
// ═══════════════════════════════════════════════════════════════════════

use crate::ableton::color_map::{ableton_color_to_track_color, extract_ableton_color_index};
use crate::ableton::xml_helpers::*;
use dream_models::project;
use uuid::Uuid;

pub fn parse_project_markers(live_set: roxmltree::Node<'_, '_>) -> Vec<project::ProjectMarker> {
    let mut out = Vec::<project::ProjectMarker>::new();
    let mut idx = 0usize;

    for locator in live_set
        .descendants()
        .filter(|n| n.is_element() && n.has_tag_name("Locator"))
    {
        let position_beats = first_child_f64(locator, "Time")
            .or_else(|| locator.attribute("Time").and_then(parse_f64_value))
            .unwrap_or(0.0)
            .max(0.0);
        let name = first_child_value(locator, "Name")
            .or_else(|| {
                locator
                    .descendants()
                    .find(|n| n.is_element() && n.has_tag_name("EffectiveName"))
                    .and_then(|n| n.attribute("Value"))
                    .map(|s| s.to_string())
            })
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| format!("Marker {}", idx + 1));
        let color =
            extract_ableton_color_index(locator).map(|v| ableton_color_to_track_color(v, idx));
        out.push(project::ProjectMarker {
            id: Uuid::new_v4(),
            name,
            position_beats,
            color,
        });
        idx += 1;
    }

    for cue in live_set
        .descendants()
        .filter(|n| n.is_element() && n.has_tag_name("CuePoint"))
    {
        let position_beats = cue
            .attribute("Time")
            .and_then(parse_f64_value)
            .or_else(|| first_child_f64(cue, "Time"))
            .unwrap_or(0.0)
            .max(0.0);
        let name = cue
            .attribute("Name")
            .map(|s| s.to_string())
            .or_else(|| first_child_value(cue, "Name"))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| format!("Cue {}", idx + 1));
        let color = extract_ableton_color_index(cue).map(|v| ableton_color_to_track_color(v, idx));
        out.push(project::ProjectMarker {
            id: Uuid::new_v4(),
            name,
            position_beats,
            color,
        });
        idx += 1;
    }

    out.sort_by(|a, b| a.position_beats.total_cmp(&b.position_beats));
    out.dedup_by(|a, b| {
        ((a.position_beats - b.position_beats).abs() < 1e-6)
            && a.name.trim().eq_ignore_ascii_case(b.name.trim())
    });

    out
}

pub fn parse_project_scenes(live_set: roxmltree::Node<'_, '_>) -> Vec<project::ProjectScene> {
    let mut out = Vec::<project::ProjectScene>::new();

    let Some(scenes_root) = live_set
        .children()
        .find(|n| n.is_element() && n.has_tag_name("Scenes"))
        .or_else(|| {
            live_set
                .descendants()
                .find(|n| n.is_element() && n.has_tag_name("Scenes"))
        })
    else {
        return out;
    };

    for (fallback_idx, scene) in scenes_root
        .children()
        .filter(|n| n.is_element() && n.has_tag_name("Scene"))
        .enumerate()
    {
        let index = scene
            .attribute("Id")
            .and_then(parse_i64_value)
            .map(|v| v.clamp(i32::MIN as i64, i32::MAX as i64) as i32)
            .unwrap_or(fallback_idx as i32);

        let name = first_child_value(scene, "Name")
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| format!("Scene {}", index + 1));

        let color = extract_ableton_color_index(scene)
            .and_then(|v| (v >= 0).then_some(ableton_color_to_track_color(v, fallback_idx)));

        let tempo = first_child_f64(scene, "Tempo").filter(|v| v.is_finite() && *v > 0.0);
        let tempo_enabled = first_child_bool(scene, "IsTempoEnabled").unwrap_or(false);
        let time_signature_id = first_child_i32(scene, "TimeSignatureId");
        let time_signature_enabled =
            first_child_bool(scene, "IsTimeSignatureEnabled").unwrap_or(false);
        let time_signature_numerator = scene
            .descendants()
            .find(|n| n.is_element() && n.has_tag_name("Numerator"))
            .and_then(|n| n.attribute("Value"))
            .and_then(parse_i64_value)
            .map(|v| v.clamp(1, 32) as u8);
        let time_signature_denominator = scene
            .descendants()
            .find(|n| n.is_element() && n.has_tag_name("Denominator"))
            .and_then(|n| n.attribute("Value"))
            .and_then(parse_i64_value)
            .map(|v| v.clamp(1, 32) as u8);
        let follow_action = scene
            .children()
            .find(|n| n.is_element() && n.has_tag_name("FollowAction"));
        let follow_action_enabled = follow_action
            .and_then(|f| first_child_bool(f, "FollowActionEnabled"))
            .unwrap_or(false);
        let follow_time = follow_action.and_then(|f| first_child_f64(f, "FollowTime"));
        let follow_action_a = follow_action.and_then(|f| first_child_i32(f, "FollowActionA"));
        let follow_action_b = follow_action.and_then(|f| first_child_i32(f, "FollowActionB"));
        let follow_chance_a = follow_action.and_then(|f| first_child_f64(f, "FollowChanceA"));
        let follow_chance_b = follow_action.and_then(|f| first_child_f64(f, "FollowChanceB"));

        out.push(project::ProjectScene {
            index,
            name,
            color,
            tempo,
            tempo_enabled,
            time_signature_id,
            time_signature_enabled,
            time_signature_numerator,
            time_signature_denominator,
            follow_action_enabled,
            follow_time,
            follow_action_a,
            follow_action_b,
            follow_chance_a,
            follow_chance_b,
        });
    }

    out.sort_by_key(|s| s.index);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use dream_models::project::TrackColor;

    #[test]
    fn parses_marker_colors_from_colorindex_forms() {
        let xml = r#"
        <LiveSet>
          <Locators>
            <Locator>
              <Name Value="L1"/>
              <Time Value="4"/>
              <ColorIndex Value="24"/>
            </Locator>
          </Locators>
          <CuePoint Name="C1" Time="8" ColorIndex="17"/>
        </LiveSet>
        "#;
        let doc = roxmltree::Document::parse(xml).expect("valid xml");
        let live_set = doc.root_element();
        let markers = parse_project_markers(live_set);
        assert_eq!(markers.len(), 2);
        assert_eq!(markers[0].color, Some(TrackColor::Indigo));
        assert_eq!(markers[1].color, Some(TrackColor::Yellow));
    }

    #[test]
    fn parses_scene_color_from_colorindex() {
        let xml = r#"
        <LiveSet>
          <Scenes>
            <Scene Id="0">
              <Name Value="Scene A"/>
              <ColorIndex Value="24"/>
            </Scene>
          </Scenes>
        </LiveSet>
        "#;
        let doc = roxmltree::Document::parse(xml).expect("valid xml");
        let live_set = doc.root_element();
        let scenes = parse_project_scenes(live_set);
        assert_eq!(scenes.len(), 1);
        assert_eq!(scenes[0].color, Some(TrackColor::Indigo));
    }
}
