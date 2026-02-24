// ═══════════════════════════════════════════════════════════════════════════
// SetClipWarpCommand — Set clip warp state/mode/base BPM
// ═══════════════════════════════════════════════════════════════════════════

use uuid::Uuid;

use dream_models::time::AbsoluteTime;

use crate::context::{Command, OrchestratorContext};
use crate::error::{OrchestratorError, OrchestratorResult};

fn source_to_timeline_frames(source_frames: i64, source_sr: f64, timeline_sr: f64) -> f64 {
    let src = source_frames.max(1) as f64;
    let safe_source_sr = source_sr.max(1.0);
    let safe_timeline_sr = timeline_sr.max(1.0);
    src * (safe_timeline_sr / safe_source_sr)
}

/// Set warp state on an audio clip and recalculate timeline duration.
///
/// When warping is enabled, the clip's timeline duration is computed from:
///   `source_timeline_frames * (warp_base_bpm / project_bpm)`
///
/// When warping is disabled, duration reverts to raw source length
/// adjusted by pitch shift.
pub struct SetClipWarpCommand {
    pub clip_id: Uuid,
    pub is_warped: bool,
    pub warp_mode: Option<i32>,
    pub warp_base_bpm: f64,
}

impl SetClipWarpCommand {
    pub fn from_str_id(
        clip_id: &str,
        is_warped: bool,
        warp_mode: Option<i32>,
        warp_base_bpm: Option<f64>,
    ) -> OrchestratorResult<Self> {
        let uuid = Uuid::parse_str(clip_id).map_err(|e| OrchestratorError::InvalidId {
            field: "clip_id",
            value: clip_id.to_string(),
            source: e,
        })?;
        let base_bpm = warp_base_bpm.unwrap_or(120.0);
        if !(20.0..=300.0).contains(&base_bpm) {
            return Err(OrchestratorError::OutOfRange {
                param: "warp_base_bpm",
                value: base_bpm,
                min: 20.0,
                max: 300.0,
            });
        }
        Ok(Self {
            clip_id: uuid,
            is_warped,
            warp_mode,
            warp_base_bpm: base_bpm,
        })
    }
}

impl Command for SetClipWarpCommand {
    type Result = ();

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<()> {
        let mut project = ctx.lock_project()?;
        let project_bpm = project.pulse_map.initial_bpm().clamp(20.0, 999.0);
        let timeline_sr = project.sample_rate.max(1.0);
        let mut updated = false;

        for track in &mut project.tracks {
            if let Some(clip) = track.clips.iter_mut().find(|c| c.id == self.clip_id) {
                let source_audio = ctx.clip_pool.get_clip_audio(&clip.file_path);
                let source_sr = source_audio
                    .as_ref()
                    .map(|audio| audio.sample_rate.max(1) as f64)
                    .unwrap_or(timeline_sr);

                // Lazily initialize warp_source_duration_frames from clip pool
                if clip.warp_source_duration_frames <= 0 {
                    let source_frames = source_audio
                        .as_ref()
                        .map(|audio| audio.num_frames.max(1) as i64)
                        .unwrap_or(clip.duration.sample_frame.max(1));
                    clip.warp_source_duration_frames = source_frames;
                }

                clip.is_warped = self.is_warped;
                clip.warp_mode = self.warp_mode.or(Some(0));
                clip.warp_base_bpm = self.warp_base_bpm;

                if clip.is_warped {
                    // timeline_frames = source_timeline_frames * (warp_base_bpm / project_bpm)
                    // 120 BPM clip at 140 BPM project: 120/140 ≈ 0.857 → SHRINKS (correct!)
                    let source_len_timeline = source_to_timeline_frames(
                        clip.warp_source_duration_frames,
                        source_sr,
                        timeline_sr,
                    );
                    let next_len =
                        (source_len_timeline * (clip.warp_base_bpm / project_bpm)).round() as i64;
                    clip.duration = AbsoluteTime::new(next_len.max(1));

                    // Initialize default warp markers if empty
                    if clip.warp_markers.is_empty() {
                        // C06 FIX: Guard against source_sr == 0 (corrupt file)
                        if source_sr > 0.0 {
                            let source_dur_sec =
                                clip.warp_source_duration_frames.max(1) as f64 / source_sr;
                            let source_beats = source_dur_sec * (self.warp_base_bpm / 60.0);
                            clip.warp_markers
                                .push(dream_models::project::WarpMarkerPoint {
                                    sec_time: 0.0,
                                    beat_time: 0.0,
                                });
                            clip.warp_markers
                                .push(dream_models::project::WarpMarkerPoint {
                                    sec_time: source_dur_sec,
                                    beat_time: source_beats,
                                });
                        }
                    }
                } else {
                    let pitch_multiplier =
                        2.0_f64.powf(clip.pitch_shift_semitones.clamp(-48.0, 48.0) / 12.0);
                    let source_len_timeline = source_to_timeline_frames(
                        clip.warp_source_duration_frames,
                        source_sr,
                        timeline_sr,
                    );
                    let new_frames = (source_len_timeline / pitch_multiplier).round() as i64;
                    clip.duration = AbsoluteTime::new(new_frames.max(1));
                    // BUG-C03 FIX: Preserve warp markers when disabling warp.
                    // Previously markers were cleared, destroying user-placed markers.
                    // Markers stay dormant — re-enabling warp restores them.
                    // (Only initialized when empty via the block above.)
                }

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
