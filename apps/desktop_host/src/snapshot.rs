// ═══════════════════════════════════════════════════════════════════════
// Structural-sharing undo/redo snapshots for the project model.
//
// Extracted from lib.rs — zero Tauri dependency. Only depends on
// dream_models and std.
// ═══════════════════════════════════════════════════════════════════════

use std::collections::VecDeque;
use std::sync::Arc;

use serde::Serialize;
use dream_models::project::{AudioClip, Project, Track, MidiClip, DeviceNode, AutomationLane};

// ── Track Snapshot ──────────────────────────────────────────────────────

#[derive(Clone)]
pub(crate) struct SharedTrackSnapshot {
    pub(crate) base: Track,
    clips: Vec<Arc<AudioClip>>,
    midi_clips: Vec<Arc<MidiClip>>,
    effects: Vec<Arc<DeviceNode>>,
    automation_lanes: Vec<Arc<AutomationLane>>,
}

impl SharedTrackSnapshot {
    pub(crate) fn from_track(track: &Track, prev: Option<&SharedTrackSnapshot>) -> Self {
        let mut clips = Vec::with_capacity(track.clips.len());
        for clip in &track.clips {
            let reused = prev.and_then(|previous| {
                previous
                    .clips
                    .iter()
                    .find(|p| p.id == clip.id && ***p == *clip)
                    .cloned()
            });
            clips.push(reused.unwrap_or_else(|| Arc::new(clip.clone())));
        }

        let mut midi_clips = Vec::with_capacity(track.midi_clips.len());
        for clip in &track.midi_clips {
            let reused = prev.and_then(|previous| {
                previous
                    .midi_clips
                    .iter()
                    .find(|p| p.id == clip.id && ***p == *clip)
                    .cloned()
            });
            midi_clips.push(reused.unwrap_or_else(|| Arc::new(clip.clone())));
        }

        let mut effects = Vec::with_capacity(track.effects.len());
        for fx in &track.effects {
            let reused = prev.and_then(|previous| {
                previous
                    .effects
                    .iter()
                    .find(|p| p.id() == fx.id() && ***p == *fx)
                    .cloned()
            });
            effects.push(reused.unwrap_or_else(|| Arc::new(fx.clone())));
        }

        let mut automation_lanes = Vec::with_capacity(track.automation_lanes.len());
        for lane in &track.automation_lanes {
            let reused = prev.and_then(|previous| {
                previous
                    .automation_lanes
                    .iter()
                    .find(|p| ***p == *lane)
                    .cloned()
            });
            automation_lanes.push(reused.unwrap_or_else(|| Arc::new(lane.clone())));
        }

        // BUG-A002 FIX: SSOT inheritance. Store the base track and clear the unshared nested items.
        let mut base = track.clone();
        base.clips.clear();
        base.midi_clips.clear();
        base.effects.clear();
        base.automation_lanes.clear();

        Self {
            base,
            clips,
            midi_clips,
            effects,
            automation_lanes,
        }
    }

    pub(crate) fn equals_track(&self, track: &Track) -> bool {
        if self.clips.len() != track.clips.len() || self.midi_clips.len() != track.midi_clips.len() || self.effects.len() != track.effects.len() || self.automation_lanes.len() != track.automation_lanes.len() {
            return false;
        }
        if !self.clips.iter().zip(track.clips.iter()).all(|(a, b)| **a == *b) {
            return false;
        }
        if !self.midi_clips.iter().zip(track.midi_clips.iter()).all(|(a, b)| **a == *b) {
            return false;
        }
        if !self.effects.iter().zip(track.effects.iter()).all(|(a, b)| **a == *b) {
            return false;
        }
        if !self.automation_lanes.iter().zip(track.automation_lanes.iter()).all(|(a, b)| **a == *b) {
            return false;
        }

        let mut track_base = track.clone();
        track_base.clips.clear();
        track_base.midi_clips.clear();
        track_base.effects.clear();
        track_base.automation_lanes.clear();
        self.base == track_base
    }

    pub(crate) fn to_track(&self) -> Track {
        let mut track = self.base.clone();
        track.clips = self.clips.iter().map(|c| (**c).clone()).collect();
        track.midi_clips = self.midi_clips.iter().map(|c| (**c).clone()).collect();
        track.effects = self.effects.iter().map(|c| (**c).clone()).collect();
        track.automation_lanes = self.automation_lanes.iter().map(|c| (**c).clone()).collect();
        track
    }
}

// ── Project Snapshot ────────────────────────────────────────────────────

#[derive(Clone)]
pub(crate) struct SharedProjectSnapshot {
    base: Arc<Project>,
    tracks: Vec<Arc<SharedTrackSnapshot>>,
    master_track: Arc<Track>,
}

impl SharedProjectSnapshot {
    pub(crate) fn from_project(
        project: &Project,
        prev: Option<&SharedProjectSnapshot>,
    ) -> Self {
        let mut tracks = Vec::with_capacity(project.tracks.len());
        for track in &project.tracks {
            let reused = prev.and_then(|previous| {
                previous
                    .tracks
                    .iter()
                    .find(|p| p.equals_track(track))
                    .cloned()
            });

            tracks.push(reused.unwrap_or_else(|| {
                let prev_track = prev.and_then(|previous| {
                    previous
                        .tracks
                        .iter()
                        .find(|p| p.base.id == track.id)
                        .map(|p| &**p)
                });
                Arc::new(SharedTrackSnapshot::from_track(track, prev_track))
            }));
        }

        let master_track = if let Some(previous) = prev {
            if *previous.master_track == project.master_track {
                previous.master_track.clone()
            } else {
                Arc::new(project.master_track.clone())
            }
        } else {
            Arc::new(project.master_track.clone())
        };

        // BUG-A001 FIX: Capture all project SSOT metadata safely
        let mut base_proj = project.clone();
        base_proj.tracks.clear();

        Self {
            base: Arc::new(base_proj),
            tracks,
            master_track,
        }
    }

    pub(crate) fn to_project(&self) -> Project {
        let mut project = (*self.base).clone();
        project.tracks = self.tracks.iter().map(|t| t.to_track()).collect();
        project.master_track = (*self.master_track).clone();
        project
    }
}

// ── Undo/Redo ───────────────────────────────────────────────────────────

/// Maximum redo stack depth — prevents unbounded memory growth. (BUG-024 FIX)
pub(crate) const MAX_REDO_DEPTH: usize = 50;

/// Undo/Redo history backed by structural-sharing snapshots.
///
/// Uses `VecDeque` for O(1) front eviction when the undo depth
/// exceeds `MAX_UNDO_DEPTH`. `Vec::remove(0)` was previously used
/// here, which is O(n) due to element shifting — unacceptable for
/// a hot path that fires on every user mutation.
pub(crate) struct UndoState {
    pub(crate) undo_stack: VecDeque<SharedProjectSnapshot>,
    pub(crate) redo_stack: VecDeque<SharedProjectSnapshot>,
}

impl UndoState {
    pub(crate) fn new() -> Self {
        Self {
            undo_stack: VecDeque::new(),
            redo_stack: VecDeque::new(),
        }
    }
}

/// Maximum number of undo snapshots to retain.
pub(crate) const MAX_UNDO_DEPTH: usize = 100;
pub(crate) const MAX_PROJECT_HISTORY: usize = 2048;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectHistoryEvent {
    pub(crate) seq: u64,
    pub(crate) kind: String,
    pub(crate) detail: String,
    pub(crate) timestamp_ms: u128,
}

pub(crate) struct ProjectHistory {
    pub(crate) next_seq: u64,
    pub(crate) events: VecDeque<ProjectHistoryEvent>,
}

impl ProjectHistory {
    pub(crate) fn new() -> Self {
        Self {
            next_seq: 1,
            events: VecDeque::new(),
        }
    }

    pub(crate) fn push(&mut self, kind: impl Into<String>, detail: impl Into<String>) {
        let timestamp_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let event = ProjectHistoryEvent {
            seq: self.next_seq,
            kind: kind.into(),
            detail: detail.into(),
            timestamp_ms,
        };
        self.next_seq = self.next_seq.saturating_add(1);
        self.events.push_back(event);
        if self.events.len() > MAX_PROJECT_HISTORY {
            self.events.pop_front();
        }
    }

    pub(crate) fn snapshot(
        &self,
        limit: Option<usize>,
        since_seq: Option<u64>,
    ) -> Vec<ProjectHistoryEvent> {
        // BUG-FIX: Previous implementation did double-collect (first into a Vec,
        // then skip+collect into another Vec). Refactored to single allocation.
        // BUG-A018 FIX: Removed Box<dyn Iterator> heap allocation overhead.
        let mut selected: Vec<ProjectHistoryEvent> = if let Some(since) = since_seq {
            let tail_seq = self.events.back().map(|e| e.seq).unwrap_or(0);
            if since > tail_seq {
                self.events.iter().cloned().collect()
            } else {
                self.events.iter().filter(|e| e.seq > since).cloned().collect()
            }
        } else {
            self.events.iter().cloned().collect()
        };
        if let Some(max) = limit {
            let len = selected.len();
            if len > max {
                selected.drain(..len - max);
            }
        }
        selected
    }
}
