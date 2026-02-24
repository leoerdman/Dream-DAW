// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Plugin Host State Manager
// ═══════════════════════════════════════════════════════════════════════════
//
// Manages the lifecycle of all loaded VST3 plugin instances:
//   - In-process (unsandboxed) loading via PluginHost
//   - Out-of-process (sandboxed) loading via PluginSandboxSupervisor
//   - Slot ↔ instance binding (slot_instance_map, ArcSwap)
//   - Plugin state capture into project for serialization
//   - Descriptor resolution (path or scan-based)
// ═══════════════════════════════════════════════════════════════════════════

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use arc_swap::ArcSwap;
use dream_plugins::format::{PluginCategory, PluginFormat};
use dream_plugins::{
    PluginCrashEvent, PluginDescriptor, PluginHost, PluginRecoveryEvent, PluginSandboxConfig,
    PluginSandboxSnapshot, PluginSandboxSupervisor, PluginScanner,
};
use uuid::Uuid;

/// Runtime plugin host state for native VST instance lifecycle.
pub(crate) struct PluginHostState {
    pub(crate) host: Arc<Mutex<PluginHost>>,
    pub(crate) loaded_by_key: Mutex<HashMap<String, Uuid>>,
    pub(crate) loaded_sandbox_by_key: Mutex<HashMap<String, Uuid>>,
    pub(crate) slot_instance_map: Arc<ArcSwap<HashMap<Uuid, Uuid>>>,
    pub(crate) sandbox_supervisor: Mutex<PluginSandboxSupervisor>,
    /// Cached plugin scan results to avoid re-scanning the filesystem on every
    /// `resolve_descriptor` call. Cleared on explicit rescan request.
    pub(crate) cached_scan: Mutex<Option<Vec<PluginDescriptor>>>,
    /// Shared reference to the audio thread's plugin registry.
    /// Used by `publish_registry()` to publish loaded `PluginInstanceArc`s
    /// so the RT driver can call `process()` on VST3 instruments/FX.
    pub(crate) plugin_registry: Option<Arc<dream_engine::driver::SharedPluginRegistry>>,
}

impl PluginHostState {
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
                let tail = rest
                    .rsplit(['/', '\\'])
                    .next()
                    .unwrap_or(rest)
                    .trim();
                if !tail.is_empty() {
                    return Some(tail.to_string());
                }
            }
        }
        None
    }

    /// Returns `true` when in-process (unsandboxed) VST3 loading is permitted.
    ///
    /// Default: **true** — in-process loading is the primary path for native
    /// plugin editors. Set `DREAM_DAW_FORCE_SANDBOX_ONLY=1` to disable
    /// in-process loading (useful for crash-isolation testing with the
    /// sandbox daemon).
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

    pub(crate) fn new() -> Self {
        let sandbox_config = PluginSandboxConfig::from_env();
        Self {
            host: Arc::new(Mutex::new(PluginHost::new(44100.0, 1024))),
            loaded_by_key: Mutex::new(HashMap::new()),
            loaded_sandbox_by_key: Mutex::new(HashMap::new()),
            slot_instance_map: Arc::new(ArcSwap::from_pointee(HashMap::new())),
            sandbox_supervisor: Mutex::new(PluginSandboxSupervisor::new(sandbox_config)),
            cached_scan: Mutex::new(None),
            plugin_registry: None,
        }
    }

    /// Attaches the audio thread's plugin registry to this state object.
    /// Must be called once during engine setup, before any plugins are loaded.
    pub(crate) fn set_plugin_registry(
        &mut self,
        registry: Arc<dream_engine::driver::SharedPluginRegistry>,
    ) {
        self.plugin_registry = Some(registry);
    }

    /// Publishes all loaded plugin instances from `PluginHost` to the audio
    /// thread's `SharedPluginRegistry`. Call after every plugin load/unload.
    ///
    /// Without this, `plugin_registry` remains empty and `driver.rs`
    /// `plugin_registry_ref.get(&instance_id)` always returns `None`,
    /// causing "DAW suspended processing" in VST3 instruments.
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

    /// Invalidates the cached plugin scan results, forcing a fresh
    /// filesystem scan on the next `resolve_descriptor` call.
    #[allow(dead_code)]
    pub(crate) fn clear_scan_cache(&self) -> Result<(), String> {
        *self
            .cached_scan
            .lock()
            .map_err(|e| format!("cached_scan lock poisoned: {e}"))? = None;
        Ok(())
    }

    /// Reactivates all loaded plugin instances with a new sample rate
    /// and buffer size. Used when the audio device configuration changes.
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

    /// Gracefully shuts down all loaded plugin instances.
    ///
    /// Must be called before the process exits to prevent SIGSEGV crashes
    /// from third-party plugins whose C++ static destructors access
    /// released resources during `exit()` teardown.
    pub(crate) fn shutdown_all_plugins(&self) {
        log::info!("[PluginHostState] Initiating graceful plugin shutdown...");
        match self.host.lock() {
            Ok(mut host) => host.shutdown_all(),
            Err(e) => log::error!(
                "[PluginHostState] Failed to acquire plugin host lock for shutdown: {}",
                e
            ),
        }
        // Also shut down sandbox supervisor to clean up any out-of-process
        // plugin daemons that may be running.
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

        // Build reverse map: instance_id → Vec<slot_id>
        // (multiple slots can share the same instance)
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
                // Find the slot in the project's device trees and update its state blob
                let mut found = false;
                for track in &mut project.tracks {
                    // Walk effects chain (Vec<DeviceNode>)
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
                    // Walk instrument (Option<DeviceNode>)
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
                // Also check master_track effects
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
            return Ok(instance_id);
        }

        let descriptor = self.resolve_descriptor(plugin_id)?;
        if descriptor.format != PluginFormat::VST3 && descriptor.format != PluginFormat::VST2 {
            return Err(format!(
                "External runtime currently supports VST2 and VST3 (got {})",
                descriptor.format
            ));
        }

        if self.sandbox_enabled().unwrap_or(false) {
            match self.open_in_sandbox(plugin_id, descriptor.clone()) {
                Ok(instance_id) => {
                    self.bind_slot_instance(slot_id, instance_id);
                    self.loaded_by_key
                        .lock()
                        .map_err(|e| e.to_string())?
                        .entry(plugin_id.to_string())
                        .or_insert(instance_id);
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

        if !Self::allow_unsandboxed_vst3() {
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

        Ok(instance_id)
    }

    pub(crate) fn resolve_descriptor(&self, plugin_id: &str) -> Result<PluginDescriptor, String> {
        let mut path = PathBuf::from(plugin_id);
        if path.exists() {
            // If caller passed an inner binary path from a .vst3 bundle
            // (e.g. .../Foo.vst3/Contents/MacOS/Foo), normalize to the bundle root.
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

            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            // VST2 (.vst) bundles are now supported via Vst2Instance host.
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
            return Ok(PluginDescriptor::new(
                name,
                "Unknown Vendor",
                format,
                PluginCategory::Effect,
                path,
            ));
        }

        // Use cached scan results to avoid expensive filesystem traversal on every call.
        let cached = self
            .cached_scan
            .lock()
            .map_err(|e| format!("cached_scan lock poisoned: {e}"))?;
        let scan_result = if let Some(ref cached_list) = *cached {
            cached_list.clone()
        } else {
            drop(cached);
            let scanner = PluginScanner::new();
            let all = scanner.scan_all();
            *self
                .cached_scan
                .lock()
                .map_err(|e| format!("cached_scan lock poisoned: {e}"))? = Some(all.clone());
            all
        };
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

        // ── AU/CLAP → VST3/VST2 auto-fallback ──
        // If the resolved descriptor is AudioUnit (or CLAP), the runtime cannot
        // host it natively yet. Try to find a VST3 or VST2 version with the same name.
        if descriptor.format != PluginFormat::VST3 && descriptor.format != PluginFormat::VST2 {
            let name_lower = descriptor.name.to_lowercase();
            let cached = self.cached_scan.lock().map_err(|e| format!("lock: {e}"))?;
            // Prefer VST3, fall back to VST2
            let alt = cached.as_ref().and_then(|list| {
                list.iter()
                    .find(|d| d.format == PluginFormat::VST3 && d.name.to_lowercase() == name_lower)
                    .or_else(|| {
                        list.iter().find(|d| {
                            d.format == PluginFormat::VST2 && d.name.to_lowercase() == name_lower
                        })
                    })
            }).cloned();
            drop(cached);
            if let Some(redirected) = alt {
                log::info!(
                    "[resolve_descriptor] {} plugin '{}' → auto-redirected to {} at {}",
                    descriptor.format,
                    descriptor.name,
                    redirected.format,
                    redirected.path.display(),
                );
                return Ok(redirected);
            }
            return Err(format!(
                "'{}' is an {} plugin. Dream DAW currently supports VST2/VST3. \
                 No VST2 or VST3 version of this plugin was found on your system.",
                descriptor.name,
                descriptor.format,
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
                // Sandbox daemon is unhealthy or crashed — evict the stale
                // entry so the caller can fall through to in-process loading.
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
