use arc_swap::ArcSwap;
use dream_plugins::format::{PluginCategory, PluginFormat};
use dream_plugins::{
    PluginCrashEvent, PluginDescriptor, PluginHost, PluginRecoveryEvent, PluginSandboxConfig,
    PluginSandboxSnapshot, PluginSandboxSupervisor, PluginScanner,
};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use uuid::Uuid;
pub(crate) struct PluginHostState {
    pub(crate) host: Arc<Mutex<PluginHost>>,
    pub(crate) loaded_by_key: Mutex<HashMap<String, Uuid>>,
    pub(crate) loaded_sandbox_by_key: Mutex<HashMap<String, Uuid>>,
    pub(crate) slot_instance_map: Arc<ArcSwap<HashMap<Uuid, Uuid>>>,
    pub(crate) sandbox_supervisor: Mutex<PluginSandboxSupervisor>,
    pub(crate) cached_scan: Mutex<Option<Vec<PluginDescriptor>>>,
    pub(crate) plugin_registry: Option<Arc<dream_engine::driver::SharedPluginRegistry>>,
}
impl PluginHostState {
    const DEFAULT_HOST_SAMPLE_RATE: f64 = 44_100.0;
    fn normalize_plugin_lookup_key(input: &str) -> String {
        input
            .trim()
            .trim_end_matches(['/', '\\'])
            .to_ascii_lowercase()
    }
    fn external_scheme_name_hint(input: &str) -> Option<String> {
        let normalized = Self::normalize_plugin_lookup_key(input);
        let schemes = ["au://", "au:", "vst2://", "vst2:", "clap://", "clap:"];
        for scheme in schemes {
            if let Some(rest) = normalized.strip_prefix(scheme) {
                let tail = rest.rsplit(['/', '\\']).next().unwrap_or(rest).trim();
                if !tail.is_empty() {
                    return Some(tail.to_string());
                }
            }
        }
        None
    }
    fn normalize_runtime_redirect_name(raw: &str) -> String {
        let mut s = raw.trim().to_ascii_lowercase();
        for suffix in [
            " (audio unit)",
            " (au)",
            " audio unit",
            " audiounit",
            " au",
            ".component",
            ".vst3",
            ".vst",
        ] {
            if let Some(stripped) = s.strip_suffix(suffix) {
                s = stripped.trim().to_string();
            }
        }
        s
    }
    fn ensure_scan_cache(&self) -> Result<Vec<PluginDescriptor>, String> {
        let cached = self
            .cached_scan
            .lock()
            .map_err(|e| format!("cached_scan lock poisoned: {e}"))?;
        if let Some(ref cached_list) = *cached {
            return Ok(cached_list.clone());
        }
        drop(cached);
        let scanner = PluginScanner::new();
        let all = scanner.scan_all();
        *self
            .cached_scan
            .lock()
            .map_err(|e| format!("cached_scan lock poisoned: {e}"))? = Some(all.clone());
        Ok(all)
    }
    fn find_runtime_compatible_redirect(
        &self,
        descriptor: &PluginDescriptor,
    ) -> Result<Option<PluginDescriptor>, String> {
        if descriptor.format == PluginFormat::VST3 || descriptor.format == PluginFormat::VST2 {
            return Ok(Some(descriptor.clone()));
        }
        let scan_result = self.ensure_scan_cache()?;
        let name_lower = descriptor.name.to_lowercase();
        let name_normalized = Self::normalize_runtime_redirect_name(&descriptor.name);
        let stem_normalized = descriptor
            .path
            .file_stem()
            .and_then(|s| s.to_str())
            .map(Self::normalize_runtime_redirect_name)
            .unwrap_or_default();
        let is_name_match = |d: &PluginDescriptor| {
            let d_name = d.name.to_lowercase();
            if d_name == name_lower {
                return true;
            }
            let d_name_normalized = Self::normalize_runtime_redirect_name(&d.name);
            if !name_normalized.is_empty() && d_name_normalized == name_normalized {
                return true;
            }
            let d_stem_normalized = d
                .path
                .file_stem()
                .and_then(|s| s.to_str())
                .map(Self::normalize_runtime_redirect_name)
                .unwrap_or_default();
            !stem_normalized.is_empty() && d_stem_normalized == stem_normalized
        };
        let mut redirected = scan_result
            .iter()
            .find(|d| d.format == PluginFormat::VST3 && is_name_match(d))
            .or_else(|| {
                scan_result
                    .iter()
                    .find(|d| d.format == PluginFormat::VST2 && is_name_match(d))
            })
            .cloned();
        if redirected.is_none() {
            self.clear_scan_cache()?;
            let refreshed = self.ensure_scan_cache()?;
            redirected = refreshed
                .iter()
                .find(|d| d.format == PluginFormat::VST3 && is_name_match(d))
                .or_else(|| {
                    refreshed
                        .iter()
                        .find(|d| d.format == PluginFormat::VST2 && is_name_match(d))
                })
                .cloned();
        }
        if let Some(ref target) = redirected {
            log::info!(
                "[resolve_descriptor] {} plugin '{}' → auto-redirected to {} at {}",
                descriptor.format,
                descriptor.name,
                target.format,
                target.path.display(),
            );
        }
        Ok(redirected)
    }
    pub(crate) fn allow_unsandboxed_vst3() -> bool {
        let force_sandbox = std::env::var("DREAM_DAW_FORCE_SANDBOX_ONLY")
            .ok()
            .map(|v| {
                let s = v.trim().to_ascii_lowercase();
                matches!(s.as_str(), "1" | "true" | "yes" | "on")
            })
            .unwrap_or(false);
        !force_sandbox
    }
    pub(crate) fn try_enable_sandbox_if_available(&self) {
        if let Ok(mut sup) = self.sandbox_supervisor.lock() {
            sup.set_enabled(true);
            if sup.enabled() {
                log::info!("[PluginHost] Sandbox auto-enabled on startup");
            } else {
                log::warn!("[PluginHost] Sandbox auto-enable failed (daemon binary not found)");
            }
        }
    }
    pub(crate) fn new_with_io(sample_rate: f64, buffer_size: usize) -> Self {
        let safe_sample_rate = if sample_rate.is_finite() && sample_rate > 0.0 {
            sample_rate
        } else {
            Self::DEFAULT_HOST_SAMPLE_RATE
        };
        let safe_buffer_size = buffer_size.max(1);
        let sandbox_config = PluginSandboxConfig::from_env();
        Self {
            host: Arc::new(Mutex::new(PluginHost::new(
                safe_sample_rate,
                safe_buffer_size,
            ))),
            loaded_by_key: Mutex::new(HashMap::new()),
            loaded_sandbox_by_key: Mutex::new(HashMap::new()),
            slot_instance_map: Arc::new(ArcSwap::from_pointee(HashMap::new())),
            sandbox_supervisor: Mutex::new(PluginSandboxSupervisor::new(sandbox_config)),
            cached_scan: Mutex::new(None),
            plugin_registry: None,
        }
    }
    pub(crate) fn set_plugin_registry(
        &mut self,
        registry: Arc<dream_engine::driver::SharedPluginRegistry>,
    ) {
        self.plugin_registry = Some(registry);
    }
    pub(crate) fn publish_registry(&self) {
        let Some(registry) = &self.plugin_registry else {
            log::warn!("[publish_registry] plugin_registry not attached — skipping");
            return;
        };
        if let Ok(host) = self.host.lock() {
            let snapshot = host.snapshot_registry();
            let count = snapshot.len();
            registry.swap(snapshot);
            log::debug!(
                "[publish_registry] Published {} plugin instance(s) to audio thread",
                count
            );
        } else {
            log::warn!("[publish_registry] Failed to lock PluginHost — registry not updated");
        }
    }
    pub(crate) fn bind_slot_instance(&self, slot_id: Uuid, instance_id: Uuid) {
        let mut map = self.slot_instance_map.load_full().as_ref().clone();
        map.insert(slot_id, instance_id);
        self.slot_instance_map.store(Arc::new(map));
    }
    #[allow(dead_code)]
    pub(crate) fn clear_scan_cache(&self) -> Result<(), String> {
        *self
            .cached_scan
            .lock()
            .map_err(|e| format!("cached_scan lock poisoned: {e}"))? = None;
        Ok(())
    }
    /// Updates the PluginHost's internal audio configuration to match the
    /// actual cpal audio device's sample rate and buffer size.
    ///
    /// **CRITICAL FIX:** The PluginHost is initially constructed with values
    /// from user settings (e.g., 44100/512), but the actual audio device may
    /// run at different values (e.g., 48000/1024). If plugins are activated
    /// with a `max_buffer_size` smaller than the device's actual block size,
    /// the `process()` method's buffer guard (`num_frames > max_buffer_size`)
    /// will trigger on every call, silently falling through to passthrough —
    /// making the plugin produce no audible effect.
    ///
    /// This method MUST be called after `start_audio_thread_on_device()`
    /// returns, before any plugins are loaded, so that all future plugin
    /// activations use the correct device parameters.
    ///
    /// If plugins are already loaded (e.g., from project restore), they are
    /// reactivated with the new config via `reactivate_all()`.
    pub(crate) fn update_audio_config(
        &self,
        actual_sample_rate: f64,
        actual_buffer_size: usize,
    ) -> Result<(), String> {
        let mut host = self.host.lock().map_err(|e| e.to_string())?;
        let (current_sr, current_bs) = host.audio_config();
        let sr_changed = (current_sr - actual_sample_rate).abs() > 0.001;
        let bs_changed = current_bs != actual_buffer_size;
        if sr_changed || bs_changed {
            log::info!(
                "[PluginHostState] Syncing audio config: {}Hz/{}→{}Hz/{}",
                current_sr, current_bs, actual_sample_rate, actual_buffer_size,
            );
            host.reactivate_all(actual_sample_rate, actual_buffer_size);
        }
        Ok(())
    }
    #[allow(dead_code)]
    pub(crate) fn reactivate_all(
        &self,
        sample_rate: f64,
        buffer_size: usize,
    ) -> Result<(), String> {
        let mut host = self.host.lock().map_err(|e| e.to_string())?;
        host.reactivate_all(sample_rate, buffer_size);
        Ok(())
    }
    pub(crate) fn shutdown_all_plugins(&self) {
        log::info!("[PluginHostState] Initiating graceful plugin shutdown...");
        match self.host.lock() {
            Ok(mut host) => host.shutdown_all(),
            Err(e) => log::error!(
                "[PluginHostState] Failed to acquire plugin host lock for shutdown: {}",
                e
            ),
        }
        if let Ok(mut sup) = self.sandbox_supervisor.lock() {
            sup.set_enabled(false);
            log::info!("[PluginHostState] Sandbox supervisor disabled");
        }
        log::info!("[PluginHostState] Plugin shutdown complete");
    }
    pub(crate) fn unbind_slot_instance(&self, slot_id: Uuid) {
        let mut map = self.slot_instance_map.load_full().as_ref().clone();
        map.remove(&slot_id);
        self.slot_instance_map.store(Arc::new(map));
    }
    pub(crate) fn take_slot_instance(&self, slot_id: Uuid) -> Option<Uuid> {
        let mut map = self.slot_instance_map.load_full().as_ref().clone();
        let removed = map.remove(&slot_id);
        self.slot_instance_map.store(Arc::new(map));
        removed
    }
    pub(crate) fn slot_instance_snapshot(&self) -> Arc<HashMap<Uuid, Uuid>> {
        self.slot_instance_map.load_full()
    }
    pub(crate) fn slot_ids_for_instance_ids(&self, instance_ids: &HashSet<Uuid>) -> HashSet<Uuid> {
        self.slot_instance_map
            .load()
            .iter()
            .filter_map(|(slot_id, instance_id)| {
                if instance_ids.contains(instance_id) {
                    Some(*slot_id)
                } else {
                    None
                }
            })
            .collect()
    }
    pub(crate) fn clear_slot_instance_bindings(&self) {
        self.slot_instance_map.store(Arc::new(HashMap::new()));
    }
    pub(crate) fn unload_instance(&self, instance_id: Uuid) -> Result<(), String> {
        {
            let mut host = self.host.lock().map_err(|e| e.to_string())?;
            let _ = host.remove(instance_id);
        }
        self.publish_registry();
        {
            let mut map = self.loaded_by_key.lock().map_err(|e| e.to_string())?;
            map.retain(|_, id| *id != instance_id);
        }
        {
            let mut sandbox_map = self
                .loaded_sandbox_by_key
                .lock()
                .map_err(|e| e.to_string())?;
            let had_sandbox_entry = sandbox_map.values().any(|id| *id == instance_id);
            if had_sandbox_entry {
                sandbox_map.retain(|_, id| *id != instance_id);
                let mut supervisor = self.sandbox_supervisor.lock().map_err(|e| e.to_string())?;
                let _ = supervisor.send_close_editor(instance_id);
                supervisor.remove_instance(instance_id);
            }
        }
        let mut slot_map = self.slot_instance_map.load_full().as_ref().clone();
        slot_map.retain(|_, id| *id != instance_id);
        self.slot_instance_map.store(Arc::new(slot_map));
        Ok(())
    }
    pub(crate) fn unload_slot_instance(&self, slot_id: Uuid) -> Result<(), String> {
        if let Some(instance_id) = self.take_slot_instance(slot_id) {
            self.unload_instance(instance_id)?;
        }
        Ok(())
    }
    pub(crate) fn unload_all_instances(&self) -> Result<(), String> {
        let mut ids = HashSet::<Uuid>::new();
        {
            let map = self.loaded_by_key.lock().map_err(|e| e.to_string())?;
            ids.extend(map.values().copied());
        }
        {
            let map = self
                .loaded_sandbox_by_key
                .lock()
                .map_err(|e| e.to_string())?;
            ids.extend(map.values().copied());
        }
        ids.extend(self.slot_instance_map.load_full().values().copied());
        for id in ids {
            let _ = self.unload_instance(id);
        }
        self.loaded_by_key
            .lock()
            .map_err(|e| e.to_string())?
            .clear();
        self.loaded_sandbox_by_key
            .lock()
            .map_err(|e| e.to_string())?
            .clear();
        self.clear_slot_instance_bindings();
        Ok(())
    }
    pub(crate) fn capture_plugin_states_into_project(
        &self,
        project: &mut dream_models::project::Project,
    ) -> Result<(), String> {
        use base64::Engine;
        let slot_map = self.slot_instance_snapshot();
        log::info!(
            "[PluginState-Capture] slot_instance_map has {} entries: {:?}",
            slot_map.len(),
            slot_map.as_ref()
        );
        let host = self
            .host
            .lock()
            .map_err(|e| format!("PluginHost lock: {e}"))?;
        let instance_states = host.save_all_states();
        log::info!(
            "[PluginState-Capture] save_all_states returned {} instance states",
            instance_states.len()
        );
        for (id, bytes) in &instance_states {
            log::info!(
                "[PluginState-Capture]   instance {} → {} bytes",
                id,
                bytes.len()
            );
        }
        if instance_states.is_empty() {
            log::warn!("[PluginState-Capture] No instance states to save — returning early!");
            return Ok(());
        }
        let mut instance_to_slots: std::collections::HashMap<uuid::Uuid, Vec<uuid::Uuid>> =
            std::collections::HashMap::new();
        for (slot_id, instance_id) in slot_map.iter() {
            instance_to_slots
                .entry(*instance_id)
                .or_default()
                .push(*slot_id);
        }
        let mut updated_count = 0usize;
        for (instance_id, state_bytes) in &instance_states {
            let Some(slot_ids) = instance_to_slots.get(instance_id) else {
                log::warn!(
                    "[PluginState-Capture] Instance {} has state but NO slot mapping — skipping!",
                    instance_id
                );
                continue;
            };
            let b64 = base64::engine::general_purpose::STANDARD.encode(state_bytes);
            for slot_id in slot_ids {
                let mut found = false;
                for track in &mut project.tracks {
                    for device in &mut track.effects {
                        for slot in device.collect_plugin_slots_mut() {
                            if slot.id == *slot_id {
                                slot.external_state_blob = Some(b64.clone());
                                slot.external_state_blob_kind = Some("ProcessorState".to_string());
                                updated_count += 1;
                                found = true;
                                log::info!(
                                    "[PluginState-Capture] Updated effect slot '{}' (id={}) on track '{}' ({} bytes b64)",
                                    slot.name,
                                    slot_id,
                                    track.name,
                                    b64.len()
                                );
                            }
                        }
                    }
                    if let Some(inst) = &mut track.instrument {
                        for slot in inst.collect_plugin_slots_mut() {
                            if slot.id == *slot_id {
                                slot.external_state_blob = Some(b64.clone());
                                slot.external_state_blob_kind = Some("ProcessorState".to_string());
                                updated_count += 1;
                                found = true;
                                log::info!(
                                    "[PluginState-Capture] Updated instrument slot '{}' (id={}) on track '{}' ({} bytes b64)",
                                    slot.name,
                                    slot_id,
                                    track.name,
                                    b64.len()
                                );
                            }
                        }
                    }
                }
                for device in &mut project.master_track.effects {
                    for slot in device.collect_plugin_slots_mut() {
                        if slot.id == *slot_id {
                            slot.external_state_blob = Some(b64.clone());
                            slot.external_state_blob_kind = Some("ProcessorState".to_string());
                            updated_count += 1;
                            found = true;
                            log::info!(
                                "[PluginState-Capture] Updated master track slot '{}' (id={}) ({} bytes b64)",
                                slot.name,
                                slot_id,
                                b64.len()
                            );
                        }
                    }
                }
                if !found {
                    log::warn!(
                        "[PluginState-Capture] Slot {} mapped to instance {} but NOT found in any project track!",
                        slot_id,
                        instance_id
                    );
                }
            }
        }
        if updated_count > 0 {
            log::info!(
                "[PluginHost] Captured live state for {} plugin slot(s) ({} instances)",
                updated_count,
                instance_states.len()
            );
        } else {
            log::warn!(
                "[PluginState-Capture] 0 slots updated despite {} instance states! Check slot mapping.",
                instance_states.len()
            );
        }
        Ok(())
    }
    pub(crate) fn ensure_loaded_instance_for_slot(
        &self,
        slot_id: Uuid,
        plugin_id: &str,
    ) -> Result<Uuid, String> {
        self.try_enable_sandbox_if_available();
        if let Some(instance_id) = self.slot_instance_map.load().get(&slot_id).copied() {
            let in_process_present = self
                .host
                .lock()
                .map(|host| host.snapshot_registry().contains_key(&instance_id))
                .unwrap_or(false);
            let sandbox_present = self
                .loaded_sandbox_by_key
                .lock()
                .map(|map| map.values().any(|id| *id == instance_id))
                .unwrap_or(false);
            if in_process_present || sandbox_present {
                return Ok(instance_id);
            }
            log::warn!(
                "[PluginHostState] Stale slot binding detected for slot {} -> instance {} (plugin '{}'); rebinding",
                slot_id,
                instance_id,
                plugin_id
            );
            self.unbind_slot_instance(slot_id);
        }
        // CRITICAL MIDI/STATE ISOLATION FIX:
        // Never reuse an already-loaded runtime instance across different slots,
        // even when plugin_id matches. Shared instances cause cross-track state
        // bleed (e.g., MIDI from one track sounding on another track using the
        // same plugin model). Each slot must own an isolated plugin instance.
        let descriptor = self.resolve_descriptor(plugin_id)?;
        if descriptor.format == PluginFormat::CLAP {
            return Err(format!(
                "External runtime currently supports VST2/VST3/AU (got {})",
                descriptor.format
            ));
        }
        if descriptor.format == PluginFormat::VST3 && self.sandbox_enabled().unwrap_or(false) {
            match self.open_in_sandbox(plugin_id, descriptor.clone()) {
                Ok(instance_id) => {
                    self.bind_slot_instance(slot_id, instance_id);
                    self.loaded_by_key
                        .lock()
                        .map_err(|e| e.to_string())?
                        .entry(plugin_id.to_string())
                        .or_insert(instance_id);
                    self.publish_registry();
                    return Ok(instance_id);
                }
                Err(err) => {
                    if !Self::allow_unsandboxed_vst3() {
                        return Err(format!(
                            "Plugin sandbox failed for '{}': {}. In-process VST3 loading is disabled (DREAM_DAW_FORCE_SANDBOX_ONLY is active).",
                            descriptor.name, err
                        ));
                    }
                    log::warn!(
                        "[PluginSandbox] fallback to in-process load for '{}' due to error: {}",
                        descriptor.name,
                        err
                    );
                }
            }
        }
        if descriptor.format == PluginFormat::VST3 && !Self::allow_unsandboxed_vst3() {
            return Err(format!(
                "Plugin sandbox is unavailable for '{}'. In-process loading is disabled (DREAM_DAW_FORCE_SANDBOX_ONLY is active).",
                descriptor.name
            ));
        }
        let mut host = self.host.lock().map_err(|e| e.to_string())?;
        let instance_id = match descriptor.format {
            PluginFormat::VST3 => host
                .load_vst3(descriptor.clone())
                .map_err(|e| format!("Failed to load VST3 plugin '{}': {e}", descriptor.name))?,
            PluginFormat::VST2 => host
                .load_vst2(descriptor.clone())
                .map_err(|e| format!("Failed to load VST2 plugin '{}': {e}", descriptor.name))?,
            PluginFormat::AudioUnit => host.load_au(descriptor.clone()).map_err(|e| {
                format!("Failed to load AudioUnit plugin '{}': {e}", descriptor.name)
            })?,
            other => {
                return Err(format!(
                    "Unsupported plugin format '{}' for '{}'",
                    other, descriptor.name
                ));
            }
        };
        drop(host);
        self.bind_slot_instance(slot_id, instance_id);
        self.loaded_by_key
            .lock()
            .map_err(|e| e.to_string())?
            .entry(plugin_id.to_string())
            .or_insert(instance_id);
        self.publish_registry();
        Ok(instance_id)
    }
    fn is_runtime_instance_alive(&self, instance_id: Uuid) -> bool {
        let in_process_present = self
            .host
            .lock()
            .map(|host| host.snapshot_registry().contains_key(&instance_id))
            .unwrap_or(false);
        if in_process_present {
            return true;
        }
        self.loaded_sandbox_by_key
            .lock()
            .map(|map| map.values().any(|id| *id == instance_id))
            .unwrap_or(false)
    }
    #[allow(dead_code)]
    pub(crate) fn bind_slot_to_existing_instance_for_plugin_id(
        &self,
        slot_id: Uuid,
        plugin_id: &str,
    ) -> Result<Option<Uuid>, String> {
        let mut candidate_keys = std::collections::HashSet::<String>::new();
        candidate_keys.insert(Self::normalize_plugin_lookup_key(plugin_id));
        if let Ok(descriptor) = self.resolve_descriptor(plugin_id) {
            candidate_keys.insert(Self::normalize_plugin_lookup_key(
                &descriptor.path.to_string_lossy(),
            ));
            candidate_keys.insert(Self::normalize_plugin_lookup_key(&descriptor.name));
            candidate_keys.insert(Self::normalize_plugin_lookup_key(
                &descriptor.id.to_string(),
            ));
            if let Some(uid) = descriptor.unique_id.as_ref() {
                candidate_keys.insert(Self::normalize_plugin_lookup_key(uid));
            }
        }
        let mut loaded = self.loaded_by_key.lock().map_err(|e| e.to_string())?;
        let mut matched: Option<Uuid> = None;
        let mut stale_keys: Vec<String> = Vec::new();
        for (key, instance_id) in loaded.iter() {
            if !candidate_keys.contains(&Self::normalize_plugin_lookup_key(key)) {
                continue;
            }
            if self.is_runtime_instance_alive(*instance_id) {
                matched = Some(*instance_id);
                break;
            }
            stale_keys.push(key.clone());
        }
        for key in stale_keys {
            loaded.remove(&key);
        }
        drop(loaded);
        if let Some(instance_id) = matched {
            self.bind_slot_instance(slot_id, instance_id);
            log::info!(
                "[PluginHostState] Rebound slot {} to existing instance {} for plugin '{}'",
                slot_id,
                instance_id,
                plugin_id
            );
            return Ok(Some(instance_id));
        }
        Ok(None)
    }
    pub(crate) fn resolve_descriptor(&self, plugin_id: &str) -> Result<PluginDescriptor, String> {
        let mut path = PathBuf::from(plugin_id);
        if path.exists() {
            if !path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case("vst3"))
                .unwrap_or(false)
            {
                if let Some(bundle_root) = path
                    .ancestors()
                    .find(|p| {
                        p.extension()
                            .and_then(|e| e.to_str())
                            .map(|e| e.eq_ignore_ascii_case("vst3"))
                            .unwrap_or(false)
                    })
                    .map(|p| p.to_path_buf())
                {
                    path = bundle_root;
                }
            }
            let normalized_path = Self::normalize_plugin_lookup_key(&path.to_string_lossy());
            if let Ok(scan_result) = self.ensure_scan_cache()
                && let Some(found) = scan_result.into_iter().find(|desc| {
                    let desc_path = desc.path.to_string_lossy().to_string();
                    Self::normalize_plugin_lookup_key(&desc_path) == normalized_path
                })
            {
                if found.format == PluginFormat::CLAP {
                    if let Some(redirected) = self.find_runtime_compatible_redirect(&found)? {
                        return Ok(redirected);
                    }
                    return Err(format!(
                        "'{}' is a CLAP plugin. Dream DAW currently supports VST2/VST3/AU. \
                         No VST2 or VST3 version of this plugin was found on your system.",
                        found.name
                    ));
                }
                return Ok(found);
            }
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            let name = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("Unknown VST")
                .to_string();
            let format = match ext.as_str() {
                "vst3" => PluginFormat::VST3,
                "component" | "au" => PluginFormat::AudioUnit,
                "clap" => PluginFormat::CLAP,
                _ => PluginFormat::VST3,
            };
            let descriptor =
                PluginDescriptor::new(name, "Unknown Vendor", format, PluginCategory::Effect, path);
            if descriptor.format == PluginFormat::CLAP {
                if let Some(redirected) = self.find_runtime_compatible_redirect(&descriptor)? {
                    return Ok(redirected);
                }
                return Err(format!(
                    "'{}' is a CLAP plugin. Dream DAW currently supports VST2/VST3/AU. \
                     No VST2 or VST3 version of this plugin was found on your system.",
                    descriptor.name
                ));
            }
            return Ok(descriptor);
        }
        let scan_result = self.ensure_scan_cache()?;
        let normalized_plugin_id = Self::normalize_plugin_lookup_key(plugin_id);
        let name_hint = Self::external_scheme_name_hint(plugin_id);
        let descriptor = scan_result
            .into_iter()
            .find(|desc| {
                let desc_path = desc.path.to_string_lossy().to_string();
                let desc_path_norm = Self::normalize_plugin_lookup_key(&desc_path);
                let desc_name_norm = Self::normalize_plugin_lookup_key(&desc.name);
                let desc_id_norm = Self::normalize_plugin_lookup_key(&desc.id.to_string());
                let desc_uid_norm = desc
                    .unique_id
                    .as_ref()
                    .map(|u| Self::normalize_plugin_lookup_key(u));
                if desc_path_norm == normalized_plugin_id
                    || desc_name_norm == normalized_plugin_id
                    || desc_id_norm == normalized_plugin_id
                    || desc_uid_norm
                        .as_deref()
                        .map(|u| u == normalized_plugin_id)
                        .unwrap_or(false)
                {
                    return true;
                }
                if let Some(hint) = name_hint.as_deref() {
                    if desc_name_norm == hint {
                        return true;
                    }
                    if let Some(file_stem) = desc
                        .path
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .map(Self::normalize_plugin_lookup_key)
                    {
                        if file_stem == hint {
                            return true;
                        }
                    }
                }
                false
            })
            .ok_or_else(|| format!("Plugin not found: {plugin_id}"))?;
        if descriptor.format == PluginFormat::CLAP {
            if let Some(redirected) = self.find_runtime_compatible_redirect(&descriptor)? {
                return Ok(redirected);
            }
            return Err(format!(
                "'{}' is a CLAP plugin. Dream DAW currently supports VST2/VST3/AU. \
                 No VST2 or VST3 version of this plugin was found on your system.",
                descriptor.name,
            ));
        }
        Ok(descriptor)
    }
    pub(crate) fn sandbox_snapshot(&self) -> Result<PluginSandboxSnapshot, String> {
        let supervisor = self.sandbox_supervisor.lock().map_err(|e| e.to_string())?;
        Ok(supervisor.snapshot())
    }
    pub(crate) fn set_sandbox_enabled(
        &self,
        enabled: bool,
    ) -> Result<PluginSandboxSnapshot, String> {
        let mut supervisor = self.sandbox_supervisor.lock().map_err(|e| e.to_string())?;
        supervisor.set_enabled(enabled);
        Ok(supervisor.snapshot())
    }
    pub(crate) fn sandbox_enabled(&self) -> Result<bool, String> {
        let supervisor = self.sandbox_supervisor.lock().map_err(|e| e.to_string())?;
        Ok(supervisor.enabled())
    }
    pub(crate) fn open_in_sandbox(
        &self,
        plugin_key: &str,
        descriptor: PluginDescriptor,
    ) -> Result<Uuid, String> {
        let mut supervisor = self.sandbox_supervisor.lock().map_err(|e| e.to_string())?;
        let instance_id = supervisor
            .attach_plugin_process(descriptor.clone())
            .map_err(|e| format!("Sandbox spawn failed: {e}"))?;
        let shared_region = supervisor
            .shared_region_for_instance(instance_id)
            .ok_or_else(|| "Sandbox shared region was not created".to_string())?;
        drop(supervisor);
        {
            let mut host = self.host.lock().map_err(|e| e.to_string())?;
            host.load_vst3_sandboxed(
                instance_id,
                descriptor,
                PathBuf::from(shared_region.map_name.clone()),
                shared_region.num_inputs,
                shared_region.num_outputs,
                shared_region.max_frames,
            )
            .map_err(|e| format!("Sandbox plugin bridge registration failed: {e}"))?;
        }
        self.publish_registry();
        self.loaded_sandbox_by_key
            .lock()
            .map_err(|e| e.to_string())?
            .insert(plugin_key.to_string(), instance_id);
        {
            let mut supervisor = self.sandbox_supervisor.lock().map_err(|e| e.to_string())?;
            let _ = supervisor.send_open_editor(instance_id);
        }
        Ok(instance_id)
    }
    pub(crate) fn close_in_sandbox(&self, plugin_key: &str) -> Result<(), String> {
        let maybe_id = self
            .loaded_sandbox_by_key
            .lock()
            .map_err(|e| e.to_string())?
            .remove(plugin_key);
        if let Some(id) = maybe_id {
            if let Ok(mut supervisor) = self.sandbox_supervisor.lock() {
                let _ = supervisor.send_close_editor(id);
            }
            if let Ok(mut host) = self.host.lock() {
                let _ = host.remove(id);
            }
            self.publish_registry();
            let mut supervisor = self.sandbox_supervisor.lock().map_err(|e| e.to_string())?;
            supervisor.remove_instance(id);
        }
        Ok(())
    }
    pub(crate) fn tick_sandbox_watchdog_with_events(
        &self,
    ) -> Result<
        (
            PluginSandboxSnapshot,
            Vec<PluginCrashEvent>,
            Vec<PluginRecoveryEvent>,
        ),
        String,
    > {
        let mut supervisor = self.sandbox_supervisor.lock().map_err(|e| e.to_string())?;
        let timed_out = supervisor.tick_watchdog();
        if !timed_out.is_empty() {
            let mut reverse = HashMap::<Uuid, String>::new();
            if let Ok(map) = self.loaded_sandbox_by_key.lock() {
                for (k, v) in map.iter() {
                    reverse.insert(*v, k.clone());
                }
            }
            for id in timed_out {
                if let Some(key) = reverse.get(&id) {
                    log::error!(
                        "[PluginSandbox] Host unhealthy for key='{}' (instance={}) -> bypass requested",
                        key,
                        id
                    );
                } else {
                    log::error!(
                        "[PluginSandbox] Host unhealthy for instance={} -> bypass requested",
                        id
                    );
                }
            }
        }
        let crashes = supervisor.drain_crash_events();
        let recoveries = supervisor.drain_recovery_events();
        let snapshot = supervisor.snapshot();
        Ok((snapshot, crashes, recoveries))
    }
    pub(crate) fn tick_sandbox_watchdog(&self) -> Result<PluginSandboxSnapshot, String> {
        self.tick_sandbox_watchdog_with_events()
            .map(|(snapshot, _, _)| snapshot)
    }
    pub(crate) fn manual_restart_sandbox_instance(
        &self,
        instance_id: Uuid,
    ) -> Result<HashSet<Uuid>, String> {
        let slot_ids = self.slot_ids_for_instance_ids(&HashSet::from([instance_id]));
        if slot_ids.is_empty() {
            return Err(format!(
                "No plugin slots are bound to sandbox instance {}",
                instance_id
            ));
        }
        let mut supervisor = self.sandbox_supervisor.lock().map_err(|e| e.to_string())?;
        supervisor
            .manual_restart(instance_id)
            .map_err(|e| format!("Sandbox manual restart failed: {e}"))?;
        Ok(slot_ids)
    }
    pub(crate) fn open_sandbox_editor(&self, plugin_key: &str) -> Result<bool, String> {
        let maybe_id = self
            .loaded_sandbox_by_key
            .lock()
            .map_err(|e| e.to_string())?
            .get(plugin_key)
            .copied();
        let Some(id) = maybe_id else {
            return Ok(false);
        };
        let mut supervisor = self.sandbox_supervisor.lock().map_err(|e| e.to_string())?;
        match supervisor.send_open_editor(id) {
            Ok(()) => Ok(true),
            Err(err) => {
                log::warn!(
                    "[PluginSandbox] open_sandbox_editor failed for '{}' (instance={}): {}. Evicting stale sandbox entry.",
                    plugin_key,
                    id,
                    err
                );
                drop(supervisor);
                if let Ok(mut map) = self.loaded_sandbox_by_key.lock() {
                    map.remove(plugin_key);
                }
                Ok(false)
            }
        }
    }
    pub(crate) fn set_sandbox_parameter(
        &self,
        plugin_key: &str,
        param_index: u32,
        value: f64,
    ) -> Result<bool, String> {
        let maybe_id = self
            .loaded_sandbox_by_key
            .lock()
            .map_err(|e| e.to_string())?
            .get(plugin_key)
            .copied();
        let Some(id) = maybe_id else {
            return Ok(false);
        };
        let mut supervisor = self.sandbox_supervisor.lock().map_err(|e| e.to_string())?;
        supervisor
            .send_set_parameter(id, param_index, value)
            .map_err(|e| format!("Sandbox set parameter failed: {e}"))?;
        Ok(true)
    }
}
