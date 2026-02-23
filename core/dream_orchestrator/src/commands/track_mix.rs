use crate::context::{Command, OrchestratorContext};
use crate::error::{OrchestratorError, OrchestratorResult};
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
        let clamped = self.volume.clamp(0.0, 2.0);
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
pub struct SetTrackMuteResult {
    pub track_id: Uuid,
    pub muted: bool,
}

pub struct SetTrackMuteByIndexCommand {
    pub track_index: u16,
    pub muted: bool,
}

impl Command for SetTrackMuteByIndexCommand {
    type Result = SetTrackMuteResult;

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
        track.is_mute = self.muted;
        Ok(SetTrackMuteResult {
            track_id: track.id,
            muted: self.muted,
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
