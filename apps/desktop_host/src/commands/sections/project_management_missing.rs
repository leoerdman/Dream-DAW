fn decode_missing_meta_value(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let h1 = bytes[i + 1] as char;
            let h2 = bytes[i + 2] as char;
            if h1.is_ascii_hexdigit() && h2.is_ascii_hexdigit() {
                let hi = h1.to_digit(16).unwrap_or(0) as u8;
                let lo = h2.to_digit(16).unwrap_or(0) as u8;
                out.push((hi << 4) | lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn parse_missing_query(plugin_id: &str) -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::new();
    let Some(query) = plugin_id.split('?').nth(1) else {
        return out;
    };
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let mut it = pair.splitn(2, '=');
        let key = it.next().unwrap_or_default().trim().to_ascii_lowercase();
        let value = decode_missing_meta_value(it.next().unwrap_or_default().trim());
        if !key.is_empty() && !value.is_empty() {
            out.insert(key, value);
        }
    }
    out
}

fn normalize_lookup_key(raw: &str) -> String {
    raw.trim()
        .trim_end_matches(['/', '\\'])
        .to_ascii_lowercase()
}

fn normalize_lookup_key_compact(raw: &str) -> String {
    raw.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

fn strip_missing_display_wrappers(raw: &str) -> String {
    let trimmed = raw.trim();
    let without_prefix = trimmed
        .strip_prefix("Plugin Not Found:")
        .unwrap_or(trimmed)
        .trim();
    without_prefix
        .split_once('[')
        .map(|(left, _)| left.trim().to_string())
        .unwrap_or_else(|| without_prefix.to_string())
}

fn collect_name_variants(raw: &str) -> Vec<String> {
    fn push_unique(out: &mut Vec<String>, value: &str) {
        let v = value.trim();
        if v.is_empty() {
            return;
        }
        if out.iter().any(|x| x.eq_ignore_ascii_case(v)) {
            return;
        }
        out.push(v.to_string());
    }

    let mut out = Vec::<String>::new();
    let base = strip_missing_display_wrappers(raw);
    push_unique(&mut out, &base);

    let no_ext = std::path::Path::new(base.trim())
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(base.as_str())
        .trim()
        .to_string();
    push_unique(&mut out, &no_ext);

    for token in base.replace('\\', "/").split('/') {
        let t = token.trim();
        if t.is_empty() {
            continue;
        }
        push_unique(&mut out, t);
        let token_no_ext = std::path::Path::new(t)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(t)
            .trim()
            .to_string();
        push_unique(&mut out, &token_no_ext);
    }

    out
}

fn normalize_runtime_external_plugin_slots(
    project: &mut dream_models::project::Project,
    plugin_host_state: &PluginHostState,
) {
    let mut updated = 0usize;
    let mut normalize_slot = |slot: &mut dream_models::project::PluginSlot| {
        let plugin_id = slot.plugin_id.trim();
        if plugin_id.is_empty()
            || plugin_id.starts_with("internal://")
            || plugin_id.starts_with("missing://")
        {
            return;
        }

        let Ok(desc) = plugin_host_state.resolve_descriptor(plugin_id) else {
            return;
        };
        let resolved_id = desc.path.to_string_lossy().to_string();
        let mut changed = false;

        if normalize_lookup_key(plugin_id) != normalize_lookup_key(&resolved_id) {
            slot.plugin_id = resolved_id;
            changed = true;
        }
        if slot.name.trim().is_empty() || slot.name != desc.name {
            slot.name = desc.name.clone();
            changed = true;
        }
        let resolved_format = desc.format.to_string().to_lowercase();
        if slot.external_format.as_deref() != Some(resolved_format.as_str()) {
            slot.external_format = Some(resolved_format);
            changed = true;
        }
        if slot.external_uid.is_none() && desc.unique_id.is_some() {
            slot.external_uid = desc.unique_id.clone();
            changed = true;
        }
        if slot.external_plugin_version.is_none() && desc.version.is_some() {
            slot.external_plugin_version = desc.version.clone();
            changed = true;
        }
        if slot.external_audio_inputs != Some(desc.audio_inputs) {
            slot.external_audio_inputs = Some(desc.audio_inputs);
            changed = true;
        }
        if changed {
            updated = updated.saturating_add(1);
        }
    };

    for track in &mut project.tracks {
        let mut slots = Vec::new();
        if let Some(instr) = track.instrument.as_mut() {
            slots.extend(instr.collect_plugin_slots_mut());
        }
        for fx in &mut track.effects {
            slots.extend(fx.collect_plugin_slots_mut());
        }

        for slot in slots {
            normalize_slot(slot);
        }
    }
    {
        let mut slots = Vec::new();
        if let Some(instr) = project.master_track.instrument.as_mut() {
            slots.extend(instr.collect_plugin_slots_mut());
        }
        for fx in &mut project.master_track.effects {
            slots.extend(fx.collect_plugin_slots_mut());
        }
        for slot in slots {
            normalize_slot(slot);
        }
    }

    if updated > 0 {
        log::info!(
            "[Project open] Normalized {} external plugin slot(s) to runtime descriptors",
            updated
        );
    }
}

#[derive(Debug, Clone, Copy, Default)]
struct MissingPluginAutoResolveStats {
    replaced_internal: usize,
    replaced_external: usize,
}

#[derive(Debug, Clone, serde::Serialize)]
struct AlsImportSummaryPayload {
    project_name: String,
    track_count: usize,
    missing_slots_before: usize,
    missing_slots_after: usize,
    auto_resolved_internal: usize,
    auto_resolved_external: usize,
    warped_clip_count: usize,
    warp_marker_count: usize,
    warped_with_source_frames: usize,
    unresolved_missing_labels: Vec<String>,
}

fn count_missing_plugin_slots(project: &dream_models::project::Project) -> usize {
    let mut count = 0usize;
    for track in &project.tracks {
        if let Some(instr) = &track.instrument {
            count = count.saturating_add(
                instr.collect_plugin_slots()
                    .iter()
                    .filter(|slot| slot.plugin_id.starts_with("missing://"))
                    .count(),
            );
        }
        for fx in &track.effects {
            count = count.saturating_add(
                fx.collect_plugin_slots()
                    .iter()
                    .filter(|slot| slot.plugin_id.starts_with("missing://"))
                    .count(),
            );
        }
    }
    if let Some(inst) = &project.master_track.instrument {
        count = count.saturating_add(
            inst.collect_plugin_slots()
                .iter()
                .filter(|slot| slot.plugin_id.starts_with("missing://"))
                .count(),
        );
    }
    for fx in &project.master_track.effects {
        count = count.saturating_add(
            fx.collect_plugin_slots()
                .iter()
                .filter(|slot| slot.plugin_id.starts_with("missing://"))
                .count(),
        );
    }
    count
}

fn collect_missing_slot_labels(
    project: &dream_models::project::Project,
    limit: usize,
) -> Vec<String> {
    let mut out = Vec::new();
    let push_slot = |out: &mut Vec<String>, track_name: &str, slot: &dream_models::project::PluginSlot| {
        if slot.plugin_id.starts_with("missing://") {
            let label = if slot.name.trim().is_empty() {
                format!("{track_name}: <missing-plugin>")
            } else {
                format!("{track_name}: {}", slot.name.trim())
            };
            out.push(label);
        }
    };

    for track in &project.tracks {
        if let Some(inst) = &track.instrument {
            for slot in inst.collect_plugin_slots() {
                push_slot(&mut out, &track.name, slot);
                if out.len() >= limit {
                    return out;
                }
            }
        }
        for fx in &track.effects {
            for slot in fx.collect_plugin_slots() {
                push_slot(&mut out, &track.name, slot);
                if out.len() >= limit {
                    return out;
                }
            }
        }
    }
    if let Some(inst) = &project.master_track.instrument {
        for slot in inst.collect_plugin_slots() {
            push_slot(&mut out, "Master", slot);
            if out.len() >= limit {
                return out;
            }
        }
    }
    for fx in &project.master_track.effects {
        for slot in fx.collect_plugin_slots() {
            push_slot(&mut out, "Master", slot);
            if out.len() >= limit {
                return out;
            }
        }
    }
    out
}

fn auto_resolve_missing_external_plugin_slots(
    project: &mut dream_models::project::Project,
) -> MissingPluginAutoResolveStats {
    use dream_plugins::PluginScanner;

    fn resolve_best_compact_fuzzy(
        compact: &str,
        by_name_compact: &std::collections::HashMap<String, dream_plugins::descriptor::PluginDescriptor>,
        by_stem_compact: &std::collections::HashMap<String, dream_plugins::descriptor::PluginDescriptor>,
    ) -> Option<dream_plugins::descriptor::PluginDescriptor> {
        if compact.len() < 5 {
            return None;
        }

        let mut best: Option<(usize, usize, String, String, dream_plugins::descriptor::PluginDescriptor)> =
            None;
        for (key, desc) in by_name_compact.iter().chain(by_stem_compact.iter()) {
            let relation_score = if key == compact {
                1_000usize
            } else if key.starts_with(compact) || compact.starts_with(key) {
                850usize
            } else if key.contains(compact) || compact.contains(key) {
                700usize
            } else {
                continue;
            };

            let distance_penalty = key.len().abs_diff(compact.len());
            let score = relation_score.saturating_sub(distance_penalty.min(128));
            let path_key = desc.path.to_string_lossy().to_ascii_lowercase();
            let tie_key = key.clone();
            let candidate = (score, distance_penalty, tie_key, path_key, desc.clone());
            let should_replace = match &best {
                None => true,
                Some(current) => {
                    candidate.0 > current.0
                        || (candidate.0 == current.0 && candidate.1 < current.1)
                        || (candidate.0 == current.0
                            && candidate.1 == current.1
                            && candidate.2 < current.2)
                        || (candidate.0 == current.0
                            && candidate.1 == current.1
                            && candidate.2 == current.2
                            && candidate.3 < current.3)
                }
            };
            if should_replace {
                best = Some(candidate);
            }
        }

        best.map(|(_, _, _, _, desc)| desc)
    }

    fn resolve_internal_from_missing_meta(
        slot: &dream_models::project::PluginSlot,
        meta: &std::collections::HashMap<String, String>,
    ) -> Option<(&'static str, &'static str)> {
        let mut candidates: Vec<String> = Vec::new();
        if !slot.name.trim().is_empty() {
            candidates.extend(collect_name_variants(slot.name.as_str()));
        }
        for key in ["name", "user", "vst3", "vst2", "au", "auname"] {
            if let Some(value) = meta.get(key) {
                candidates.extend(collect_name_variants(value));
            }
        }
        for key in ["vst3path", "vst2path", "aupath"] {
            if let Some(value) = meta.get(key) {
                candidates.extend(collect_name_variants(value));
            }
        }

        let mut seen = std::collections::HashSet::<String>::new();
        for candidate in candidates {
            let normalized = candidate.trim().to_ascii_lowercase();
            if normalized.is_empty() || !seen.insert(normalized) {
                continue;
            }
            if let Some((plugin_id, display_name, kind)) =
                dream_importers::ableton::plugin_mapper::canonical_internal_plugin_for_import(
                    &candidate, &candidate,
                )
                && kind == "effect"
            {
                return Some((plugin_id, display_name));
            }
            let normalized =
                dream_importers::ableton::plugin_mapper::normalize_plugin_key(&candidate);
            if !normalized.is_empty()
                && let Some((plugin_id, display_name, kind)) =
                    dream_importers::ableton::plugin_mapper::canonical_internal_plugin_for_import(
                        &normalized,
                        &candidate,
                    )
                && kind == "effect"
            {
                return Some((plugin_id, display_name));
            }
        }
        None
    }

    let scanned = PluginScanner::new().scan_all();
    if scanned.is_empty() {
        // Even with no scanned external plugins we still want to repair
        // internal placeholders imported as missing://.
    }

    let mut by_path = std::collections::HashMap::new();
    let mut by_name = std::collections::HashMap::new();
    let mut by_stem = std::collections::HashMap::new();
    let mut by_name_compact = std::collections::HashMap::new();
    let mut by_stem_compact = std::collections::HashMap::new();
    let mut by_uid = std::collections::HashMap::new();
    for desc in &scanned {
        let path = desc.path.to_string_lossy().to_string();
        by_path
            .entry(normalize_lookup_key(&path))
            .or_insert_with(|| desc.clone());
        by_name
            .entry(normalize_lookup_key(&desc.name))
            .or_insert_with(|| desc.clone());
        let compact_name = normalize_lookup_key_compact(&desc.name);
        if !compact_name.is_empty() {
            by_name_compact
                .entry(compact_name)
                .or_insert_with(|| desc.clone());
        }
        if let Some(stem) = desc.path.file_stem().and_then(|s| s.to_str()) {
            by_stem
                .entry(normalize_lookup_key(stem))
                .or_insert_with(|| desc.clone());
            let compact_stem = normalize_lookup_key_compact(stem);
            if !compact_stem.is_empty() {
                by_stem_compact
                    .entry(compact_stem)
                    .or_insert_with(|| desc.clone());
            }
        }
        if let Some(uid) = &desc.unique_id {
            by_uid
                .entry(normalize_lookup_key(uid))
                .or_insert_with(|| desc.clone());
        }
    }

    let mut replaced_internal = 0usize;
    let mut replaced_external = 0usize;
    for track in &mut project.tracks {
        let mut slots = Vec::new();
        if let Some(instr) = track.instrument.as_mut() {
            slots.extend(instr.collect_plugin_slots_mut());
        }
        for fx in &mut track.effects {
            slots.extend(fx.collect_plugin_slots_mut());
        }

        for slot in slots {
            if !slot.plugin_id.starts_with("missing://") {
                continue;
            }

            let meta = parse_missing_query(&slot.plugin_id);
            if let Some((internal_id, internal_name)) = resolve_internal_from_missing_meta(slot, &meta) {
                slot.plugin_id = internal_id.to_string();
                slot.name = internal_name.to_string();
                slot.external_uid = None;
                slot.external_format = None;
                slot.external_audio_inputs = None;
                slot.external_plugin_version = None;
                slot.supports_sidechain_input = Some(false);
                slot.is_bypassed = false;
                replaced_internal += 1;
                continue;
            }

            let mut resolved = None;

            if resolved.is_none() && let Some(uid) = slot.external_uid.as_ref() {
                resolved = by_uid.get(&normalize_lookup_key(uid)).cloned();
            }
            if resolved.is_none() {
                for key in ["vst3path", "vst2path", "aupath"] {
                    if let Some(path) = meta.get(key) {
                        let normalized = normalize_lookup_key(path);
                        if let Some(desc) = by_path.get(&normalized) {
                            resolved = Some(desc.clone());
                            break;
                        }
                        if let Some(stem) = std::path::Path::new(path)
                            .file_stem()
                            .and_then(|s| s.to_str())
                            .map(normalize_lookup_key)
                            && let Some(desc) = by_stem.get(&stem)
                        {
                            resolved = Some(desc.clone());
                            break;
                        }
                    }
                }
            }
            if resolved.is_none() {
                for key in ["vst3", "vst2", "au", "auname", "user", "name"] {
                    if let Some(name) = meta.get(key) {
                        for candidate in collect_name_variants(name) {
                            let normalized = normalize_lookup_key(&candidate);
                            if let Some(desc) =
                                by_name.get(&normalized).or_else(|| by_stem.get(&normalized))
                            {
                                resolved = Some(desc.clone());
                                break;
                            }
                            let compact = normalize_lookup_key_compact(&candidate);
                            if let Some(desc) = by_name_compact
                                .get(&compact)
                                .or_else(|| by_stem_compact.get(&compact))
                            {
                                resolved = Some(desc.clone());
                                break;
                            }
                            if resolved.is_none()
                                && let Some(desc) = resolve_best_compact_fuzzy(
                                    &compact,
                                    &by_name_compact,
                                    &by_stem_compact,
                                )
                            {
                                resolved = Some(desc);
                                break;
                            }
                        }
                        if resolved.is_some() {
                            break;
                        }
                    }
                }
            }

            if resolved.is_none() {
                for candidate in collect_name_variants(&slot.name) {
                    let normalized = normalize_lookup_key(&candidate);
                    if let Some(desc) = by_name.get(&normalized).or_else(|| by_stem.get(&normalized)) {
                        resolved = Some(desc.clone());
                        break;
                    }
                    let compact = normalize_lookup_key_compact(&candidate);
                    if let Some(desc) = by_name_compact
                        .get(&compact)
                        .or_else(|| by_stem_compact.get(&compact))
                    {
                        resolved = Some(desc.clone());
                        break;
                    }
                    if let Some(desc) = resolve_best_compact_fuzzy(
                        &compact,
                        &by_name_compact,
                        &by_stem_compact,
                    )
                    {
                        resolved = Some(desc);
                        break;
                    }
                }
            }

            let Some(desc) = resolved else {
                continue;
            };
            slot.plugin_id = desc.path.to_string_lossy().to_string();
            slot.name = desc.name.clone();
            slot.external_format = Some(desc.format.to_string().to_lowercase());
            if slot.external_uid.is_none() {
                slot.external_uid = desc.unique_id.clone();
            }
            if slot.external_plugin_version.is_none() {
                slot.external_plugin_version = desc.version.clone();
            }
            if slot.external_audio_inputs.is_none() {
                slot.external_audio_inputs = Some(desc.audio_inputs);
            }
            slot.supports_sidechain_input = Some(desc.audio_inputs > 2);
            slot.is_bypassed = false;
            replaced_external += 1;
        }
    }
    {
        let mut slots = Vec::new();
        if let Some(instr) = project.master_track.instrument.as_mut() {
            slots.extend(instr.collect_plugin_slots_mut());
        }
        for fx in &mut project.master_track.effects {
            slots.extend(fx.collect_plugin_slots_mut());
        }

        for slot in slots {
            if !slot.plugin_id.starts_with("missing://") {
                continue;
            }

            let meta = parse_missing_query(&slot.plugin_id);
            if let Some((internal_id, internal_name)) = resolve_internal_from_missing_meta(slot, &meta) {
                slot.plugin_id = internal_id.to_string();
                slot.name = internal_name.to_string();
                slot.external_uid = None;
                slot.external_format = None;
                slot.external_audio_inputs = None;
                slot.external_plugin_version = None;
                slot.supports_sidechain_input = Some(false);
                slot.is_bypassed = false;
                replaced_internal += 1;
                continue;
            }

            let mut resolved = None;
            if resolved.is_none() && let Some(uid) = slot.external_uid.as_ref() {
                resolved = by_uid.get(&normalize_lookup_key(uid)).cloned();
            }
            if resolved.is_none() {
                for key in ["vst3path", "vst2path", "aupath"] {
                    if let Some(path) = meta.get(key) {
                        let normalized = normalize_lookup_key(path);
                        if let Some(desc) = by_path.get(&normalized) {
                            resolved = Some(desc.clone());
                            break;
                        }
                        if let Some(stem) = std::path::Path::new(path)
                            .file_stem()
                            .and_then(|s| s.to_str())
                            .map(normalize_lookup_key)
                            && let Some(desc) = by_stem.get(&stem)
                        {
                            resolved = Some(desc.clone());
                            break;
                        }
                    }
                }
            }
            if resolved.is_none() {
                for key in ["vst3", "vst2", "au", "auname", "user", "name"] {
                    if let Some(name) = meta.get(key) {
                        for candidate in collect_name_variants(name) {
                            let normalized = normalize_lookup_key(&candidate);
                            if let Some(desc) =
                                by_name.get(&normalized).or_else(|| by_stem.get(&normalized))
                            {
                                resolved = Some(desc.clone());
                                break;
                            }
                            let compact = normalize_lookup_key_compact(&candidate);
                            if let Some(desc) = by_name_compact
                                .get(&compact)
                                .or_else(|| by_stem_compact.get(&compact))
                            {
                                resolved = Some(desc.clone());
                                break;
                            }
                            if resolved.is_none()
                                && let Some(desc) = resolve_best_compact_fuzzy(
                                    &compact,
                                    &by_name_compact,
                                    &by_stem_compact,
                                )
                            {
                                resolved = Some(desc);
                                break;
                            }
                        }
                        if resolved.is_some() {
                            break;
                        }
                    }
                }
            }

            if resolved.is_none() {
                for candidate in collect_name_variants(&slot.name) {
                    let normalized = normalize_lookup_key(&candidate);
                    if let Some(desc) = by_name.get(&normalized).or_else(|| by_stem.get(&normalized)) {
                        resolved = Some(desc.clone());
                        break;
                    }
                    let compact = normalize_lookup_key_compact(&candidate);
                    if let Some(desc) = by_name_compact
                        .get(&compact)
                        .or_else(|| by_stem_compact.get(&compact))
                    {
                        resolved = Some(desc.clone());
                        break;
                    }
                    if let Some(desc) = resolve_best_compact_fuzzy(
                        &compact,
                        &by_name_compact,
                        &by_stem_compact,
                    )
                    {
                        resolved = Some(desc);
                        break;
                    }
                }
            }

            let Some(desc) = resolved else {
                continue;
            };
            slot.plugin_id = desc.path.to_string_lossy().to_string();
            slot.name = desc.name.clone();
            slot.external_format = Some(desc.format.to_string().to_lowercase());
            if slot.external_uid.is_none() {
                slot.external_uid = desc.unique_id.clone();
            }
            if slot.external_plugin_version.is_none() {
                slot.external_plugin_version = desc.version.clone();
            }
            if slot.external_audio_inputs.is_none() {
                slot.external_audio_inputs = Some(desc.audio_inputs);
            }
            slot.supports_sidechain_input = Some(desc.audio_inputs > 2);
            slot.is_bypassed = false;
            replaced_external += 1;
        }
    }

    if replaced_internal > 0 {
        log::info!(
            "[ALS import] Auto-resolved {} internal missing plugin slot(s)",
            replaced_internal
        );
    }

    if replaced_external > 0 {
        log::info!(
            "[ALS import] Auto-resolved {} missing plugin slot(s) using scanned plugin descriptors",
            replaced_external
        );
    }

    MissingPluginAutoResolveStats {
        replaced_internal,
        replaced_external,
    }
}
