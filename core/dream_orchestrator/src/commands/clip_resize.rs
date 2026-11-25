// ═══════════════════════════════════════════════════════════════════════════
// ResizeClipCommand — Resize a clip to a new position and duration
// ═══════════════════════════════════════════════════════════════════════════

use uuid::Uuid;

use dream_models::mutators;
use dream_models::time::AbsoluteTime;

use crate::context::{Command, OrchestratorContext};
use crate::error::{OrchestratorError, OrchestratorResult};

/// Resize a clip (audio or MIDI) to a new position and duration.
pub struct ResizeClipCommand {
    pub clip_id: Uuid,
    pub new_position_frames: i64,
    pub new_duration_frames: i64,
    pub allow_stretch: bool,
}

impl ResizeClipCommand {
    pub fn from_str_id(
        clip_id: &str,
        new_position_frames: i64,
        new_duration_frames: i64,
        allow_stretch: bool,
    ) -> OrchestratorResult<Self> {
        let uuid = Uuid::parse_str(clip_id).map_err(|e| OrchestratorError::InvalidId {
            field: "clip_id",
            value: clip_id.to_string(),
            source: e,
        })?;
        Ok(Self {
            clip_id: uuid,
            new_position_frames,
            new_duration_frames,
            allow_stretch,
        })
    }
}

impl Command for ResizeClipCommand {
    type Result = ();

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<()> {
        // BUG-038 FIX: Validate inputs before mutating.
        if self.new_duration_frames <= 0 {
            return Err(OrchestratorError::Other(format!(
                "Clip duration must be positive, got {}",
                self.new_duration_frames
            )));
        }
        if self.new_position_frames < 0 {
            return Err(OrchestratorError::Other(format!(
                "Clip position must be non-negative, got {}",
                self.new_position_frames
            )));
        }

        let mut project = ctx.lock_project()?;

        // Lazily hydrate immutable source bounds from the clip pool for legacy clips.
        // Without this, trims can ratchet the boundary down to the current visible
        // duration, so re-expanding the clip collapses to the minimum width.
        for track in &mut project.tracks {
            if let Some(clip) = track.clips.iter_mut().find(|c| c.id == self.clip_id) {
                let source_audio = ctx.clip_pool.get_clip_audio(&clip.file_path);
                if let Some(audio) = source_audio.as_ref() {
                    // SSOT: the clip pool owns authoritative decoded source length and
                    // source sample rate. Hydrate them together so resize math never
                    // sees updated bounds without the matching source-domain ratio.
                    clip.set_source_media_with_visible_window(
                        (audio.num_frames as i64).max(1),
                        clip.warp_source_duration_frames.max(1),
                        Some(audio.sample_rate.max(1)),
                    );
                }

                if clip.warp_source_duration_frames <= 0 {
                    let source_frames = source_audio
                        .as_ref()
                        .map(|audio| audio.num_frames as i64)
                        .unwrap_or_else(|| clip.duration.sample_frame.max(1));
                    clip.set_source_media_with_visible_window(
                        clip.source_file_total_frames.max(source_frames.max(1)),
                        source_frames.max(1),
                        source_audio.as_ref().map(|audio| audio.sample_rate.max(1)),
                    );
                }
                break;
            }
        }

        let new_position = AbsoluteTime::new(self.new_position_frames);
        let new_duration = AbsoluteTime::new(self.new_duration_frames);

        if let Err(_audio_err) = mutators::resize_clip(
            &mut project,
            self.clip_id,
            new_position,
            new_duration,
            self.allow_stretch,
        ) {
            // BUG-017 FIX: Return the MIDI error (not audio error) when both fail.
            if let Err(midi_err) =
                mutators::resize_midi_clip(&mut project, self.clip_id, new_position, new_duration)
            {
                return Err(OrchestratorError::MutatorFailed(midi_err));
            }
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use parking_lot::{Mutex, MutexGuard};

    use dream_clip_engine::pool::{ClipAudio, ClipPool};
    use dream_models::project::{AudioClip, Project, Track};

    use crate::context::{
        ClipPoolAccess, DirtyMarker, HistoryRecorder, OrchestratorContext, SnapshotRebuilder,
        UndoManager,
    };

    use super::*;

    struct TestUndoManager;
    impl UndoManager for TestUndoManager {
        fn push_undo(&self, _project: &Project) -> OrchestratorResult<()> { Ok(()) }
        fn push_undo_coalesced(&self, _project: &Project) -> OrchestratorResult<()> { Ok(()) }
    }

    struct TestSnapshotRebuilder;
    impl SnapshotRebuilder for TestSnapshotRebuilder {
        fn rebuild_clips_only(&self, _project: &Project) {}
        fn rebuild_full(&self, _project: &Project) {}
        fn rebuild_midi(&self, _project: &Project) {}
        fn rebuild_automation(&self, _project: &Project) {}
        fn rebuild_samplers(&self, _project: &Project) {}
        fn evict_unused_clips(&self, _project: &Project) {}
    }

    struct TestDirtyMarker;
    impl DirtyMarker for TestDirtyMarker {
        fn mark_dirty(&self, _project_name: &str) -> OrchestratorResult<()> { Ok(()) }
    }

    struct TestHistoryRecorder;
    impl HistoryRecorder for TestHistoryRecorder {
        fn record(&self, _kind: &str, _detail: &str) -> OrchestratorResult<()> { Ok(()) }
    }

    struct TestClipPoolAccess {
        pool: Arc<Mutex<ClipPool>>,
    }

    impl ClipPoolAccess for TestClipPoolAccess {
        fn get_clip_audio(&self, file_path: &str) -> Option<Arc<ClipAudio>> {
            self.pool.lock().get(file_path)
        }

        fn insert_clip_audio(&self, audio: ClipAudio) -> OrchestratorResult<()> {
            self.pool
                .lock()
                .insert(audio)
                .map_err(OrchestratorError::Other)
        }

        fn lock_pool(&self) -> OrchestratorResult<MutexGuard<'_, ClipPool>> {
            Ok(self.pool.lock())
        }
    }

    fn test_context_with_clip_pool(project: Project, audio: ClipAudio) -> OrchestratorContext {
        let pool = Arc::new(Mutex::new(ClipPool::new()));
        pool.lock().insert(audio).expect("insert test clip");
        OrchestratorContext {
            project: Arc::new(Mutex::new(project)),
            undo: Arc::new(TestUndoManager),
            snapshots: Arc::new(TestSnapshotRebuilder),
            clip_pool: Arc::new(TestClipPoolAccess { pool }),
            dirty: Arc::new(TestDirtyMarker),
            history: Arc::new(TestHistoryRecorder),
        }
    }

    #[test]
    fn resize_clip_hydrates_legacy_source_bounds_from_clip_pool() {
        let mut project = Project::new("test", 120.0, 44_100.0);
        let mut track = Track::new("Audio");
        let mut clip = AudioClip::new(
            "clip",
            "/tmp/test.wav",
            AbsoluteTime::new(0),
            AbsoluteTime::new(2_000),
        );
        clip.source_file_total_frames = clip.duration.sample_frame;
        clip.warp_source_duration_frames = 0;
        let clip_id = clip.id;
        track.clips.push(clip);
        project.tracks.push(track);

        let ctx = test_context_with_clip_pool(
            project,
            ClipAudio::new("/tmp/test.wav", vec![vec![0.0; 8_000]], 44_100),
        );

        let cmd = ResizeClipCommand {
            clip_id,
            new_position_frames: 0,
            new_duration_frames: 3_500,
            allow_stretch: false,
        };

        cmd.execute(&ctx).expect("resize should succeed");

        let project = ctx.lock_project().expect("lock project");
        let clip = project
            .tracks
            .iter()
            .flat_map(|t| t.clips.iter())
            .find(|c| c.id == clip_id)
            .expect("clip exists");

        assert_eq!(clip.duration.sample_frame, 3_500);
        assert_eq!(clip.source_file_total_frames, 8_000);
        assert_eq!(clip.warp_source_duration_frames, 8_000);
    }

    #[test]
    fn resize_clip_replaces_nonzero_but_stale_source_bounds_from_clip_pool() {
        let mut project = Project::new("test", 120.0, 48_000.0);
        project.tracks.push(Track::new("Track 1"));
        let mut clip = AudioClip::new(
            "Test",
            "/tmp/test.wav",
            AbsoluteTime::new(0),
            AbsoluteTime::new(4_000),
        );
        clip.source_file_total_frames = 6_000;
        clip.warp_source_duration_frames = 4_000;
        let clip_id = clip.id;
        project.tracks[0].clips.push(clip);

        let ctx = test_context_with_clip_pool(
            project,
            ClipAudio::new("/tmp/test.wav", vec![vec![0.0; 8_000]], 48_000),
        );

        let cmd = ResizeClipCommand {
            clip_id,
            new_position_frames: 0,
            new_duration_frames: 7_500,
            allow_stretch: false,
        };
        cmd.execute(&ctx).expect("resize succeeds");

        let project = ctx.project.lock();
        let clip = &project.tracks[0].clips[0];
        assert_eq!(clip.source_file_total_frames, 8_000);
        assert_eq!(clip.duration.sample_frame, 7_500);
    }
}
