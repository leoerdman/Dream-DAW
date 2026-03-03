use arc_swap::ArcSwap;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, mpsc};

use dream_clip_engine::pool::{ClipAudio, ClipPool};
use dream_engine::driver::{
    SharedClipSnapshot, SharedExternalPluginSnapshot, SharedPreparedGraphSnapshot,
    SharedRoutingSnapshot, SharedSidechainSnapshot,
};
use dream_engine::render_callback::MAX_TRACKS;
use dream_io::audio_reader::AudioReader;
use dream_models::project::{
    AudioClip, DeviceNode, PluginSlot, Project, builtin_effect_type_from_plugin_id,
};
use uuid::Uuid;

use crate::ProjectState; // Cross-dependency to the main state wrapper in lib.rs

// ── Clip Pool State (shared between UI and audio thread) ────────────

/// Thread-safe handle to the shared clip pool and project clip snapshot.
///
/// The clip pool stores decoded audio data (pre-loaded into RAM).
/// The clip snapshot provides a lock-free view of project clips for
/// the audio thread.
pub struct ClipPoolState {
    /// Decoded audio samples (UI thread writes, audio thread reads via Arc).
    pub pool: Arc<Mutex<ClipPool>>,

    /// ArcSwap-wrapped pool for lock-free audio thread access.
    pub arc_pool: Arc<ArcSwap<ClipPool>>,

    /// Atomic snapshot of per-track clips (lock-free audio thread access).
    pub snapshot: Arc<SharedClipSnapshot>,

    /// Atomic snapshot of per-track routing destinations for DAG rendering.
    pub routing_snapshot: Arc<SharedRoutingSnapshot>,

    /// Prebuilt DAG+plan snapshot consumed by the audio callback.
    pub prepared_graph_snapshot: Arc<SharedPreparedGraphSnapshot>,

    /// Atomic snapshot of internal effect sidechain source mapping.
    pub sidechain_snapshot: Arc<SharedSidechainSnapshot>,

    /// Atomic snapshot of external FX runtime instances per track.
    pub external_fx_snapshot: Arc<SharedExternalPluginSnapshot>,

    /// Optional reference to the shared plugin registry for querying
    /// per-track plugin latencies (PDC compensation).
    plugin_registry: Option<Arc<dream_engine::driver::SharedPluginRegistry>>,
}

impl ClipPoolState {
    pub fn new() -> Self {
        Self {
            pool: Arc::new(Mutex::new(ClipPool::new())),
            arc_pool: Arc::new(ArcSwap::from_pointee(ClipPool::new())),
            snapshot: Arc::new(SharedClipSnapshot::new()),
            routing_snapshot: Arc::new(SharedRoutingSnapshot::new()),
            prepared_graph_snapshot: Arc::new(SharedPreparedGraphSnapshot::new()),
            sidechain_snapshot: Arc::new(SharedSidechainSnapshot::new()),
            external_fx_snapshot: Arc::new(SharedExternalPluginSnapshot::new()),
            plugin_registry: None,
        }
    }

    /// Attaches the shared plugin registry for per-track PDC latency queries.
    /// Must be called during initialization, before the first graph rebuild.
    pub fn set_plugin_registry(&mut self, registry: Arc<dream_engine::driver::SharedPluginRegistry>) {
        self.plugin_registry = Some(registry);
    }

    /// Collects the total plugin latency (in samples) for each track.
    ///
    /// Iterates over the current external FX snapshot and queries each
    /// loaded, non-bypassed plugin instance for its reported latency.
    /// Returns a `Vec<u32>` indexed by track index.
    fn collect_per_track_latencies(&self, track_count: usize) -> Vec<u32> {
        let Some(registry) = &self.plugin_registry else {
            return vec![0u32; track_count];
        };
        let fx_snapshot = self.external_fx_snapshot.load();
        let registry_map = registry.load();
        let mut latencies = Vec::with_capacity(track_count);
        for track_idx in 0..track_count {
            let track_latency = if let Some(slots) = fx_snapshot.get(track_idx) {
                slots
                    .iter()
                    .filter(|slot| !slot.is_bypassed)
                    .filter_map(|slot| slot.instance_id)
                    .map(|instance_id| {
                        match registry_map.get(&instance_id) {
                            Some(arc) => {
                                // ENTERPRISE FIX: Use blocking lock() instead of
                                // try_lock() retry. This runs on the UI/background
                                // thread, never on the audio thread. Blocking is
                                // safe here and guarantees we always get the correct
                                // latency value — no more intermittent 0 reports.
                                let p = arc.lock();
                                p.latency_samples()
                            },
                            None => 0,
                        }
                    })
                    .sum::<u32>()
            } else {
                0
            };
            if track_latency > 0 {
                log::debug!("[PDC] track[{}] total latency = {} samples", track_idx, track_latency);
            }
            latencies.push(track_latency);
        }
        latencies
    }

    pub fn selected_runtime_chain(
        rack: &dream_models::project::DeviceRack,
    ) -> Option<&dream_models::project::RackChain> {
        let has_solo = rack.chains.iter().any(|c| c.is_solo);
        if has_solo {
            rack.chains.iter().find(|c| c.is_solo && !c.is_disabled)
        } else {
            rack.chains.iter().find(|c| !c.is_disabled)
        }
    }

    pub fn collect_sidechain_sources_from_node(
        node: &DeviceNode,
        project: &Project,
        parent_bypassed: bool,
        out: &mut Vec<Option<usize>>,
    ) {
        match node {
            DeviceNode::Single(slot) => {
                if parent_bypassed || slot.is_bypassed {
                    return;
                }
                if let Some(source_id) = &slot.sidechain_source_track_id {
                    let idx = project
                        .tracks
                        .iter()
                        .take(MAX_TRACKS)
                        .position(|t| t.id.to_string() == *source_id);
                    out.push(idx);
                }
            }
            DeviceNode::Rack(rack) => {
                let rack_bypassed = parent_bypassed || rack.is_bypassed;
                if let Some(chain) = Self::selected_runtime_chain(rack) {
                    for child in &chain.devices {
                        Self::collect_sidechain_sources_from_node(
                            child,
                            project,
                            rack_bypassed,
                            out,
                        );
                    }
                }
            }
        }
    }

    /// Rebuilds the clip snapshot from the current project state.
    ///
    /// Called after any project mutation (import, delete, etc.).
    /// The audio thread will pick up the new snapshot on the next buffer.
    pub fn rebuild_snapshot(&self, project: &Project) {
        self.rebuild_graph_core(project);
        // Sync decoded audio data to the lock-free ArcSwap pool
        // so the audio thread can read it without locks.
        self.sync_pool_to_arc();
    }

    /// Routing-only snapshot rebuild for device chain topology changes.
    ///
    /// Used by device_rack operations (create rack, add chain, add/remove device,
    /// load preset) where the effect chain topology changes but no new audio files
    /// are added or removed.
    ///
    /// ~5x faster than full rebuild_snapshot() because it skips:
    ///   - Pool sync (Mutex lock + decode + Arc swap)
    ///
    /// Still rebuilds: clips, routing, sidechains, and audio DAG.
    pub fn rebuild_routing_only(&self, project: &Project) {
        self.rebuild_graph_core(project);
        // NOTE: Deliberately skips sync_pool_to_arc() — device topology changes
        // don't add/remove audio files from the pool.
    }

    /// PDC-A06 FIX: Common graph rebuild logic shared by `rebuild_snapshot()`
    /// and `rebuild_routing_only()`. Previously this was duplicated across both
    /// methods (~50 lines each), making it easy for bug fixes to diverge.
    fn rebuild_graph_core(&self, project: &Project) {
        let clips_per_track: Vec<Vec<AudioClip>> = project
            .tracks
            .iter()
            .map(|track| track.clips.clone())
            .collect();
        self.snapshot.swap(clips_per_track);

        // O(1) index lookup for routing resolution (BUG-26 fix in lib.rs)
        let id_to_index: std::collections::HashMap<uuid::Uuid, usize> = project
            .tracks
            .iter()
            .enumerate()
            .map(|(i, t)| (t.id, i))
            .collect();

        let routing: Vec<Option<usize>> = project
            .tracks
            .iter()
            .map(|track| {
                track
                    .output_destination_id
                    .and_then(|dest_id| id_to_index.get(&dest_id).copied())
            })
            .collect();
        self.routing_snapshot.swap(routing);
        let routing_now = self.routing_snapshot.load();

        let sidechains: Vec<Vec<Option<usize>>> = project
            .tracks
            .iter()
            .map(|track| {
                let mut sources = Vec::new();
                if let Some(inst) = track.instrument.as_ref() {
                    Self::collect_sidechain_sources_from_node(inst, project, false, &mut sources);
                }
                for node in &track.effects {
                    Self::collect_sidechain_sources_from_node(node, project, false, &mut sources);
                }
                sources
            })
            .collect();

        // Collect per-track plugin latency for PDC.
        let per_track_latencies = self.collect_per_track_latencies(
            project.tracks.len().min(dream_engine::render_callback::MAX_TRACKS),
        );

        self.prepared_graph_snapshot.rebuild_for_routing(
            project.tracks.len(),
            routing_now.as_ref(),
            &sidechains,
            &per_track_latencies,
        );
        self.sidechain_snapshot.swap(sidechains);
    }

    /// Lightweight clip-only snapshot rebuild for position/duration changes.
    ///
    /// Used by move_clip_cmd and resize_clip_cmd where only clip positions
    /// change — routing, sidechains, DAG, and clip pool are unchanged.
    /// This is ~10x faster than full rebuild_snapshot() because it skips:
    ///   - Routing resolution (O(n) with HashMap, but still unnecessary)
    ///   - Sidechain resolution
    ///   - Audio DAG rebuild
    ///   - Pool sync (Mutex lock + log::info! allocation)
    pub fn rebuild_clips_only(&self, project: &Project) {
        let clips_per_track: Vec<Vec<AudioClip>> = project
            .tracks
            .iter()
            .map(|track| track.clips.clone())
            .collect();
        self.snapshot.swap(clips_per_track);
    }

    pub fn rebuild_external_fx_snapshot(
        &self,
        project: &Project,
        slot_instance_map: &HashMap<Uuid, Uuid>,
    ) {
        fn resolve_sidechain_track_index(slot: &PluginSlot, project: &Project) -> Option<usize> {
            slot.sidechain_source_track_id
                .as_ref()
                .and_then(|source_id| {
                    project
                        .tracks
                        .iter()
                        .take(MAX_TRACKS)
                        .position(|candidate| candidate.id.to_string() == *source_id)
                })
        }

        fn collect_effect_runtime_slots(
            node: &DeviceNode,
            project: &Project,
            slot_instance_map: &HashMap<Uuid, Uuid>,
            internal_slot_index: &mut usize,
            parent_bypassed: bool,
            is_instrument: bool,
            out: &mut Vec<dream_engine::driver::ExternalPluginRuntimeSlot>,
        ) {
            match node {
                DeviceNode::Single(slot) => {
                    let effective_bypassed = parent_bypassed || slot.is_bypassed;
                    let sidechain_track_index = resolve_sidechain_track_index(slot, project);
                    let is_internal_effect =
                        builtin_effect_type_from_plugin_id(&slot.plugin_id).is_some();
                    if is_internal_effect {
                        // Always include internal slots in the snapshot — bypass is
                        // handled at process() time by InternalDeviceSlot, not here.
                        // Excluding bypassed slots caused sidechain routing entries
                        // to vanish until the next snapshot rebuild (sidechain dropout).
                        let idx = *internal_slot_index;
                        *internal_slot_index = internal_slot_index.saturating_add(1);
                        out.push(dream_engine::driver::ExternalPluginRuntimeSlot {
                            slot_id: Some(slot.id),
                            internal_slot_index: Some(idx),
                            instance_id: None,
                            sidechain_track_index,
                            is_instrument,
                            is_bypassed: effective_bypassed,
                        });
                    } else if let Some(instance_id) = slot_instance_map.get(&slot.id).copied()
                    {
                        // SIDECHAIN-FIX: Always include external plugins even when
                        // bypassed. Previously bypassed externals were excluded,
                        // which shifted every subsequent slot index in the snapshot
                        // and caused sidechain routing to silently break.
                        // The audio callback now checks `is_bypassed` and skips
                        // processing (passthrough) while preserving slot ordering.
                        out.push(dream_engine::driver::ExternalPluginRuntimeSlot {
                            slot_id: Some(slot.id),
                            internal_slot_index: None,
                            instance_id: Some(instance_id),
                            sidechain_track_index,
                            is_instrument,
                            is_bypassed: effective_bypassed,
                        });
                    }
                }
                DeviceNode::Rack(rack) => {
                    let rack_bypassed = parent_bypassed || rack.is_bypassed;
                    if let Some(chain) = ClipPoolState::selected_runtime_chain(rack) {
                        for child in &chain.devices {
                            collect_effect_runtime_slots(
                                child,
                                project,
                                slot_instance_map,
                                internal_slot_index,
                                rack_bypassed,
                                is_instrument,
                                out,
                            );
                        }
                    }
                }
            }
        }

        let mut external_fx: Vec<Vec<dream_engine::driver::ExternalPluginRuntimeSlot>> = project
            .tracks
            .iter()
            .take(MAX_TRACKS)
            .map(|track| {
                let mut internal_slot_index: usize = 0;

                let mut slots: Vec<dream_engine::driver::ExternalPluginRuntimeSlot> = Vec::new();
                if let Some(inst) = track.instrument.as_ref() {
                    collect_effect_runtime_slots(
                        inst,
                        project,
                        slot_instance_map,
                        &mut internal_slot_index,
                        false,
                        true, // ← instrument slot
                        &mut slots,
                    );
                }
                for node in &track.effects {
                    collect_effect_runtime_slots(
                        node,
                        project,
                        slot_instance_map,
                        &mut internal_slot_index,
                        false,
                        false, // ← effect slot
                        &mut slots,
                    );
                }
                slots
            })
            .collect();

        // ── Master track external FX (CRITICAL FIX) ──────────────────────
        // The master track is stored separately from project.tracks,
        // so its external plugins (e.g., Muse, OTT, limiter VSTs) were
        // never included in the external FX map — meaning they NEVER
        // received process() calls in the audio callback.
        // Appending master FX as the LAST entry makes them available
        // at index `min(project.tracks.len(), MAX_TRACKS)` for the
        // post-graph master FX processing pass in driver.rs.
        {
            let master = &project.master_track;
            let mut master_internal_idx: usize = 0;

            let mut master_fx_chain: Vec<dream_engine::driver::ExternalPluginRuntimeSlot> = Vec::new();
            if let Some(inst) = master.instrument.as_ref() {
                collect_effect_runtime_slots(
                    inst,
                    project,
                    slot_instance_map,
                    &mut master_internal_idx,
                    false,
                    true, // ← instrument slot
                    &mut master_fx_chain,
                );
            }
            for node in &master.effects {
                collect_effect_runtime_slots(
                    node,
                    project,
                    slot_instance_map,
                    &mut master_internal_idx,
                    false,
                    false, // ← effect slot
                    &mut master_fx_chain,
                );
            }
            external_fx.push(master_fx_chain);
        }

        // ── DIAGNOSTIC: Log per-track VST slot summary ───────────────────
        // This helps identify if external plugins are actually making it into
        // the runtime snapshot that the audio thread uses.
        {
            let total_slots: usize = external_fx.iter().map(|v| v.len()).sum();
            let total_external: usize = external_fx
                .iter()
                .flat_map(|v| v.iter())
                .filter(|s| s.instance_id.is_some())
                .count();
            let total_internal: usize = external_fx
                .iter()
                .flat_map(|v| v.iter())
                .filter(|s| s.internal_slot_index.is_some())
                .count();
            log::debug!(
                "[ExternalFX] Rebuild snapshot: {} tracks, {} total slots ({} external, {} internal), slot_map has {} entries",
                external_fx.len(),
                total_slots,
                total_external,
                total_internal,
                slot_instance_map.len()
            );
            for (ti, slots) in external_fx.iter().enumerate() {
                if !slots.is_empty() {
                    let ext_count = slots.iter().filter(|s| s.instance_id.is_some()).count();
                    let int_count = slots.iter().filter(|s| s.internal_slot_index.is_some()).count();
                    let sc_count = slots.iter().filter(|s| s.sidechain_track_index.is_some()).count();
                    log::debug!(
                        "[ExternalFX]   track[{}]: {} slots (ext={}, int={}, bypassed={}, sc={})",
                        ti,
                        slots.len(),
                        ext_count,
                        int_count,
                        slots.iter().filter(|s| s.is_bypassed).count(),
                        sc_count
                    );
                    // Log individual sidechain routing for debugging
                    for (si, rs) in slots.iter().enumerate() {
                        if rs.sidechain_track_index.is_some() {
                            log::debug!(
                                "[ExternalFX]     track[{}] slot[{}]: sc_track_idx={:?}, instance={:?}, internal_idx={:?}",
                                ti, si, rs.sidechain_track_index, rs.instance_id, rs.internal_slot_index
                            );
                        }
                    }
                }
            }
        }

        self.external_fx_snapshot.swap(external_fx);
    }

    /// Propagates the Mutex-guarded pool to the lock-free ArcSwap.
    ///
    /// Called after any pool mutation (import, delete, project load).
    /// `ClipPool::clone()` only bumps `Arc` refcounts — no audio data
    /// is copied, making this O(n) on pool size with negligible cost.
    pub fn sync_pool_to_arc(&self) {
        if let Ok(pool) = self.pool.lock() {
            let cloned = pool.clone();
            // Demoted from info! → debug! to eliminate heap allocation string formatting
            // during real-time playback. This runs on every rebuild_snapshot (34+ call sites).
            log::debug!(
                "[ClipPool] synced {} entries ({:.1} MB) to audio thread",
                cloned.len(),
                cloned.total_memory_bytes() as f64 / (1024.0 * 1024.0),
            );
            self.arc_pool.store(Arc::new(cloned));
        } else {
            log::error!("[ClipPool] failed to lock pool for sync — audio thread pool stale");
        }
    }

    /// Loads (decodes) all audio files referenced by the project's tracks
    /// into the shared clip pool. Skips clips that are already loaded,
    /// have empty paths, or reference missing files.
    ///
    /// Decoding happens in **parallel** across multiple OS threads to
    /// minimize project-open latency (4–8× faster on multi-core machines).
    /// The Mutex is only held briefly for bookkeeping, never during I/O.
    pub fn load_project_clips(&self, project: &Project) {
        let start = std::time::Instant::now();

        // 1. Collect unique source paths that need loading.
        let mut unique_paths: Vec<String> = Vec::new();
        {
            let mut seen = std::collections::HashSet::new();
            let mut collect = |path: &str| {
                let trimmed = path.trim();
                if trimmed.is_empty() || trimmed.starts_with("internal://") {
                    return;
                }
                if seen.insert(trimmed.to_string()) {
                    unique_paths.push(trimmed.to_string());
                }
            };
            for track in &project.tracks {
                for clip in &track.clips {
                    collect(&clip.file_path);
                }
                if let Some(sampler) = &track.sampler {
                    collect(&sampler.sample_path);
                }
            }
        }

        // 2. Filter out paths already present in the pool (brief lock).
        let paths_to_decode: Vec<String> = {
            let pool = match self.pool.lock() {
                Ok(p) => p,
                Err(e) => {
                    log::error!("[ClipPool] lock failed in load_project_clips: {e}");
                    return;
                }
            };
            unique_paths
                .into_iter()
                .filter(|p| pool.get(p).is_none())
                .collect()
        };

        if paths_to_decode.is_empty() {
            log::info!(
                "[ClipPool] load_project_clips: all clips already loaded ({:.0}ms)",
                start.elapsed().as_millis()
            );
            return;
        }

        // 3. Decode using a bounded worker pool and stream results directly
        //    into ClipPool. This avoids holding all decoded clips in memory
        //    at once, which can crash on large projects.
        let cpu_workers = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4);
        let worker_count = paths_to_decode.len().clamp(1, cpu_workers.min(8));
        log::info!(
            "[ClipPool] decoding {} audio file(s) with {} worker(s)...",
            paths_to_decode.len(),
            worker_count
        );

        let mut buckets: Vec<Vec<String>> = vec![Vec::new(); worker_count];
        for (idx, path) in paths_to_decode.into_iter().enumerate() {
            buckets[idx % worker_count].push(path);
        }

        let total_jobs: usize = buckets.iter().map(Vec::len).sum();
        let (tx, rx) = mpsc::channel::<(String, Result<ClipAudio, String>)>();
        let mut workers = Vec::with_capacity(worker_count);
        for bucket in buckets {
            let tx_worker = tx.clone();
            workers.push(std::thread::spawn(move || {
                for sp in bucket {
                    let path = PathBuf::from(&sp);
                    let result = if !path.exists() {
                        Err("file not found".to_string())
                    } else {
                        match AudioReader::read(&path) {
                            Ok(decoded) => Ok(ClipAudio {
                                source_path: sp.clone(),
                                channels: decoded.channels,
                                sample_rate: decoded.sample_rate,
                                num_frames: decoded.num_frames,
                            }),
                            Err(e) => Err(e.to_string()),
                        }
                    };
                    if tx_worker.send((sp, result)).is_err() {
                        break;
                    }
                }
            }));
        }
        drop(tx);

        // 4. Insert decoded clips as they finish (streaming).
        let mut loaded = 0usize;
        let mut failed = 0usize;
        for _ in 0..total_jobs {
            let Ok((source_path, result)) = rx.recv() else {
                failed = failed.saturating_add(1);
                continue;
            };
            match result {
                Ok(clip_audio) => {
                    let insert_result = match self.pool.lock() {
                        Ok(mut pool) => pool.insert(clip_audio),
                        Err(e) => {
                            log::error!(
                                "[ClipPool] lock failed during insert for '{}': {e}",
                                source_path
                            );
                            Err("pool lock failed".to_string())
                        }
                    };
                    match insert_result {
                        Ok(()) => loaded = loaded.saturating_add(1),
                        Err(e) => {
                            log::warn!("[ClipPool] insert skipped for '{}': {e}", source_path);
                            failed = failed.saturating_add(1);
                        }
                    }
                }
                Err(e) => {
                    log::warn!("[ClipPool] decode failed for '{}': {e}", source_path);
                    failed = failed.saturating_add(1);
                }
            }
        }

        for worker in workers {
            if let Err(join_err) = worker.join() {
                log::warn!(
                    "[ClipPool] worker thread panicked during project clip decode: {join_err:?}"
                );
            }
        }

        log::info!(
            "[ClipPool] load_project_clips: loaded={}, failed={} ({:.0}ms)",
            loaded,
            failed,
            start.elapsed().as_millis()
        );

        // Push to the audio thread's lock-free ArcSwap
        self.sync_pool_to_arc();
    }

    /// Evicts clips from the pool that are NO LONGER referenced by the current project
    /// OR the undo/redo history stacks. This prevents memory leaks on clip deletion,
    /// while preserving audio data so Undo works instantly without glitches.
    pub fn evict_unused_clips(&self, project_state: &ProjectState) {
        let mut referenced_paths = std::collections::HashSet::new();

        // 1. Scan current project
        if let Ok(project) = project_state.project.lock() {
            for track in &project.tracks {
                for clip in &track.clips {
                    if !clip.file_path.trim().is_empty()
                        && !clip.file_path.starts_with("internal://")
                    {
                        referenced_paths.insert(clip.file_path.clone());
                    }
                }
                if let Some(sampler) = &track.sampler {
                    if !sampler.sample_path.trim().is_empty()
                        && !sampler.sample_path.starts_with("internal://")
                    {
                        referenced_paths.insert(sampler.sample_path.clone());
                    }
                }
            }
        }

        // 2. Scan undo/redo history
        if let Ok(undo) = project_state.undo.lock() {
            for snapshot in undo.undo_stack.iter().chain(undo.redo_stack.iter()) {
                let p = snapshot.to_project();
                for track in &p.tracks {
                    for clip in &track.clips {
                        if !clip.file_path.trim().is_empty()
                            && !clip.file_path.starts_with("internal://")
                        {
                            referenced_paths.insert(clip.file_path.clone());
                        }
                    }
                    if let Some(sampler) = &track.sampler {
                        if !sampler.sample_path.trim().is_empty()
                            && !sampler.sample_path.starts_with("internal://")
                        {
                            referenced_paths.insert(sampler.sample_path.clone());
                        }
                    }
                }
            }
        }

        // 3. Evict from pool
        if let Ok(mut pool) = self.pool.lock() {
            let (evicted, freed) = pool.evict_unreferenced(&referenced_paths);
            if evicted > 0 {
                log::info!(
                    "[ClipPool] Evicted {} unused clips ({:.1} MB freed)",
                    evicted,
                    freed as f64 / 1_048_576.0
                );
            }
        }
        self.sync_pool_to_arc();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dream_models::project::Track;

    #[test]
    fn runtime_fx_snapshot_keeps_internal_slot_index_alignment_with_bypassed_slots() {
        let mut project = Project::new("T", 120.0, 44100.0);
        let mut track = Track::new("Track 1");
        let mut eq_a = PluginSlot::new("EQ A", "internal://effect/eq-eight");
        eq_a.is_bypassed = false;
        let mut comp = PluginSlot::new("Comp", "internal://effect/compressor");
        comp.is_bypassed = true;
        let mut eq_b = PluginSlot::new("EQ B", "internal://effect/eq-eight");
        eq_b.is_bypassed = false;
        track.effects.push(DeviceNode::Single(eq_a));
        track.effects.push(DeviceNode::Single(comp));
        track.effects.push(DeviceNode::Single(eq_b));
        project.add_track(track);

        let state = ClipPoolState::new();
        state.rebuild_external_fx_snapshot(&project, &HashMap::new());
        let snapshot = state.external_fx_snapshot.load();
        let slots = &snapshot[0];

        // All 3 internal slots are included (even bypassed Comp) so that
        // sidechain routing survives bypass toggles. Bypass is handled
        // at process() time, not at snapshot level.
        assert_eq!(slots.len(), 3);
        assert_eq!(slots[0].internal_slot_index, Some(0));
        assert_eq!(slots[1].internal_slot_index, Some(1));
        assert_eq!(slots[2].internal_slot_index, Some(2));
    }
}
