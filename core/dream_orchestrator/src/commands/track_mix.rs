use crate::context::{Command, OrchestratorContext};
use crate::error::{OrchestratorError, OrchestratorResult};
use dream_models::project::{AutomationLane, AutomationPoint};
use uuid::Uuid;

#[derive(Debug, Clone, Copy)]
pub struct SetTrackVolumeResult {
    pub track_id: Uuid,
    pub volume: f32,
}

pub struct SetTrackVolumeByIndexCommand {
    pub track_index: u16,
    pub volume: f32,
}

impl Command for SetTrackVolumeByIndexCommand {
    type Result = SetTrackVolumeResult;

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<Self::Result> {
        let mut project = ctx.lock_project()?;
        let idx = self.track_index as usize;
        let total = project.tracks.len();
        let track = project
            .tracks
            .get_mut(idx)
            .ok_or(OrchestratorError::TrackOutOfRange {
                requested: idx,
                total,
            })?;
        // BUG-043 FIX: Clamp to 12.0 to match ChannelStrip's actual ceiling.
        // ChannelStrip::set_volume (BUG-M5 FIX) clamps to [0.0, 12.0].
        // Previously clamped to 2.0 here → SSOT violation with the mixer.
        let clamped = self.volume.clamp(0.0, 12.0);
        track.volume = clamped as f64;
        Ok(SetTrackVolumeResult {
            track_id: track.id,
            volume: clamped,
        })
    }
}

#[derive(Debug, Clone, Copy)]
pub struct SetTrackPanResult {
    pub track_id: Uuid,
    pub pan: f32,
}

pub struct SetTrackPanByIndexCommand {
    pub track_index: u16,
    pub pan: f32,
}

impl Command for SetTrackPanByIndexCommand {
    type Result = SetTrackPanResult;

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<Self::Result> {
        let mut project = ctx.lock_project()?;
        let idx = self.track_index as usize;
        let total = project.tracks.len();
        let track = project
            .tracks
            .get_mut(idx)
            .ok_or(OrchestratorError::TrackOutOfRange {
                requested: idx,
                total,
            })?;
        let clamped = self.pan.clamp(-1.0, 1.0);
        track.pan = clamped as f64;
        Ok(SetTrackPanResult {
            track_id: track.id,
            pan: clamped,
        })
    }
}

pub struct SetMasterVolumeCommand {
    pub volume: f32,
}

impl Command for SetMasterVolumeCommand {
    type Result = f32;

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<Self::Result> {
        let mut project = ctx.lock_project()?;
        let clamped = self.volume.clamp(0.0, 2.0);
        project.master_track.volume = clamped as f64;
        Ok(clamped)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct SetTrackDisabledResult {
    pub track_id: Uuid,
    pub disabled: bool,
}

pub struct SetTrackDisabledByIndexCommand {
    pub track_index: u16,
    pub disabled: bool,
}

impl Command for SetTrackDisabledByIndexCommand {
    type Result = SetTrackDisabledResult;

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<Self::Result> {
        let mut project = ctx.lock_project()?;
        let idx = self.track_index as usize;
        let total = project.tracks.len();
        let track = project
            .tracks
            .get_mut(idx)
            .ok_or(OrchestratorError::TrackOutOfRange {
                requested: idx,
                total,
            })?;
        track.is_disabled = self.disabled;
        Ok(SetTrackDisabledResult {
            track_id: track.id,
            disabled: self.disabled,
        })
    }
}

#[derive(Debug, Clone, Copy)]
pub struct SetTrackSoloResult {
    pub track_id: Uuid,
    pub soloed: bool,
}

pub struct SetTrackSoloByIndexCommand {
    pub track_index: u16,
    pub soloed: bool,
}

impl Command for SetTrackSoloByIndexCommand {
    type Result = SetTrackSoloResult;

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<Self::Result> {
        let mut project = ctx.lock_project()?;
        let idx = self.track_index as usize;
        let total = project.tracks.len();
        let track = project
            .tracks
            .get_mut(idx)
            .ok_or(OrchestratorError::TrackOutOfRange {
                requested: idx,
                total,
            })?;
        track.is_solo = self.soloed;
        Ok(SetTrackSoloResult {
            track_id: track.id,
            soloed: self.soloed,
        })
    }
}

#[derive(Debug, Clone)]
pub struct SetTrackSendLevelResult {
    pub track_id: Uuid,
    pub param_id: String,
    pub value: f32,
}

pub struct SetTrackSendLevelByIndexCommand {
    pub track_index: u16,
    pub send: String,
    pub value: f32,
}

impl Command for SetTrackSendLevelByIndexCommand {
    type Result = SetTrackSendLevelResult;

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<Self::Result> {
        let mut project = ctx.lock_project()?;
        let idx = self.track_index as usize;
        let total = project.tracks.len();
        let track = project
            .tracks
            .get_mut(idx)
            .ok_or(OrchestratorError::TrackOutOfRange {
                requested: idx,
                total,
            })?;

        let send_label = self.send.trim().to_ascii_uppercase();
        if send_label != "A" && send_label != "B" {
            return Err(OrchestratorError::Other(format!(
                "Unsupported send '{}'. Expected 'A' or 'B'.",
                self.send
            )));
        }
        let param_id = format!("send.{send_label}");
        let clamped = self.value.clamp(0.0, 1.0);

        // BUG-026 FIX: Only update/insert the initial (beat=0) anchor point.
        // Previously replaced ALL automation points with a single point,
        // destroying the user's send automation envelope.
        if let Some(lane) = track
            .automation_lanes
            .iter_mut()
            .find(|lane| lane.param_id == param_id)
        {
            if let Some(anchor) = lane.points.iter_mut().find(|p| p.beat == 0.0) {
                anchor.value = clamped as f64;
            } else {
                lane.points.insert(
                    0,
                    AutomationPoint {
                        beat: 0.0,
                        value: clamped as f64,
                        curve_type: "linear".to_string(),
                        tension: None,
                        bezier_cp1x: None,
                        bezier_cp1y: None,
                        bezier_cp2x: None,
                        bezier_cp2y: None,
                    },
                );
            }
        } else {
            track.automation_lanes.push(AutomationLane {
                param_id: param_id.clone(),
                points: vec![AutomationPoint {
                    beat: 0.0,
                    value: clamped as f64,
                    curve_type: "linear".to_string(),
                    tension: None,
                    bezier_cp1x: None,
                    bezier_cp1y: None,
                    bezier_cp2x: None,
                    bezier_cp2y: None,
                }],
            });
        }

        Ok(SetTrackSendLevelResult {
            track_id: track.id,
            param_id,
            value: clamped,
        })
    }
}
