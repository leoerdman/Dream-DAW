// ═══════════════════════════════════════════════════════════════════════════
// SetClipSourceOffsetCommand — Slip edit (source offset) on an audio clip
// ═══════════════════════════════════════════════════════════════════════════

use uuid::Uuid;

use dream_models::time::AbsoluteTime;

use crate::context::{Command, OrchestratorContext};
use crate::error::{OrchestratorError, OrchestratorResult};

/// Update a clip's source offset for slip editing.
///
/// The offset is clamped to `[0, source_file_length - 1]` so at least
/// one frame remains visible.
pub struct SetClipSourceOffsetCommand {
    pub clip_id: Uuid,
    pub source_offset_frames: i64,
}

impl SetClipSourceOffsetCommand {
    pub fn from_str_id(clip_id: &str, source_offset_frames: i64) -> OrchestratorResult<Self> {
        let uuid = Uuid::parse_str(clip_id).map_err(|e| OrchestratorError::InvalidId {
            field: "clip_id",
            value: clip_id.to_string(),
            source: e,
        })?;
        Ok(Self {
            clip_id: uuid,
            source_offset_frames,
        })
    }
}

impl Command for SetClipSourceOffsetCommand {
    type Result = ();

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<()> {
        let mut project = ctx.lock_project()?;
        let project_sample_rate = project.sample_rate.max(1.0);
        let mut updated = false;

        for track in &mut project.tracks {
            if let Some(clip) = track.clips.iter_mut().find(|c| c.id == self.clip_id) {
                let source_audio = ctx.clip_pool.get_clip_audio(&clip.file_path);
                if let Some(audio) = source_audio.as_ref() {
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

                let source_total = clip.source_file_total_frames.max(1);
                let visible_source_window = if clip.is_warped && clip.warp_source_duration_frames > 0 {
                    clip.warp_source_duration_frames.max(1)
                } else {
                    let pitch_multiplier = {
                        let pitch_mul = if clip.pitch_shift_semitones != 0.0 {
                            2.0_f64.powf(clip.pitch_shift_semitones.clamp(-36.0, 36.0) / 12.0)
                        } else {
                            1.0
                        };
                        let source_rate_ratio = clip
                            .sample_rate
                            .map(|sr| sr.max(1) as f64 / project_sample_rate)
                            .unwrap_or(1.0);
                        pitch_mul * source_rate_ratio.max(1e-9)
                    };
                    ((clip.duration.sample_frame.max(1) as f64) * pitch_multiplier).round() as i64
                };
                // SSOT: slip-edit offset is bounded by the remaining source AFTER the
                // currently visible source window, not by source_total - 1. Otherwise
                // the clip can be offset into a state where its source window extends
                // past the end of file and the next resize must repair the inconsistency.
                let max_offset = source_total.saturating_sub(visible_source_window.max(1)).max(0);
                clip.source_offset =
                    AbsoluteTime::new(self.source_offset_frames.max(0).min(max_offset));
                updated = true;
                break;
            }
        }

        if !updated {
            return Err(OrchestratorError::NotFound {
                entity: "clip",
                id: self.clip_id.to_string(),
            });
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
            self.pool.lock().insert(audio).map_err(OrchestratorError::Other)
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
    fn source_offset_clamps_to_remaining_non_warped_visible_window() {
        let mut project = Project::new("test", 120.0, 48_000.0);
        let mut track = Track::new("Audio");
        let mut clip = AudioClip::new(
            "clip",
            "/tmp/test.wav",
            AbsoluteTime::new(0),
            AbsoluteTime::new(2_000),
        );
        clip.pitch_shift_semitones = 12.0;
        let clip_id = clip.id;
        track.clips.push(clip);
        project.tracks.push(track);

        let ctx = test_context_with_clip_pool(
            project,
            ClipAudio::new("/tmp/test.wav", vec![vec![0.0; 8_000]], 48_000),
        );

        SetClipSourceOffsetCommand {
            clip_id,
            source_offset_frames: 7_500,
        }
        .execute(&ctx)
        .expect("slip edit succeeds");

        let project = ctx.lock_project().expect("lock project");
        let clip = &project.tracks[0].clips[0];
        assert_eq!(clip.source_file_total_frames, 8_000);
        assert_eq!(clip.source_offset.sample_frame, 4_000);
    }

    #[test]
    fn source_offset_clamps_to_remaining_warped_visible_window() {
        let mut project = Project::new("test", 120.0, 48_000.0);
        let mut track = Track::new("Audio");
        let mut clip = AudioClip::new(
            "clip",
            "/tmp/test.wav",
            AbsoluteTime::new(0),
            AbsoluteTime::new(2_000),
        );
        clip.is_warped = true;
        clip.warp_source_duration_frames = 3_000;
        let clip_id = clip.id;
        track.clips.push(clip);
        project.tracks.push(track);

        let ctx = test_context_with_clip_pool(
            project,
            ClipAudio::new("/tmp/test.wav", vec![vec![0.0; 8_000]], 48_000),
        );

        SetClipSourceOffsetCommand {
            clip_id,
            source_offset_frames: 7_500,
        }
        .execute(&ctx)
        .expect("slip edit succeeds");

        let project = ctx.lock_project().expect("lock project");
        let clip = &project.tracks[0].clips[0];
        assert_eq!(clip.source_file_total_frames, 8_000);
        assert_eq!(clip.source_offset.sample_frame, 5_000);
    }

    #[test]
    fn source_offset_clamps_using_source_sample_rate_ratio() {
        let mut project = Project::new("test", 120.0, 48_000.0);
        let mut track = Track::new("Audio");
        let mut clip = AudioClip::new(
            "clip",
            "/tmp/test.wav",
            AbsoluteTime::new(0),
            AbsoluteTime::new(2_000),
        );
        clip.sample_rate = Some(44_100);
        let clip_id = clip.id;
        track.clips.push(clip);
        project.tracks.push(track);

        let ctx = test_context_with_clip_pool(
            project,
            ClipAudio::new("/tmp/test.wav", vec![vec![0.0; 44_100]], 44_100),
        );

        SetClipSourceOffsetCommand {
            clip_id,
            source_offset_frames: 50_000,
        }
        .execute(&ctx)
        .expect("slip edit succeeds");

        let project = ctx.lock_project().expect("lock project");
        let clip = &project.tracks[0].clips[0];
        assert_eq!(clip.source_file_total_frames, 44_100);
        assert_eq!(clip.source_offset.sample_frame, 42_262);
    }
}
