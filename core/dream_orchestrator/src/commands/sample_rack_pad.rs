use crate::context::{Command, OrchestratorContext};
use crate::error::{OrchestratorError, OrchestratorResult};
use dream_models::midi::SampleRackConfig;
use uuid::Uuid;

fn resolve_track_index(
    project: &dream_models::project::Project,
    track_id: Uuid,
) -> OrchestratorResult<usize> {
    project
        .tracks
        .iter()
        .position(|t| t.id == track_id)
        .ok_or_else(|| OrchestratorError::NotFound {
            entity: "Track",
            id: track_id.to_string(),
        })
}

fn validate_pad_index(pad_index: u8) -> OrchestratorResult<usize> {
    if pad_index < 16 {
        Ok(pad_index as usize)
    } else {
        Err(OrchestratorError::OutOfRange {
            param: "pad_index",
            value: pad_index as f64,
            min: 0.0,
            max: 15.0,
        })
    }
}

#[derive(Debug, Clone, Copy)]
pub struct SetSampleRackPadVolumeResult {
    pub track_index: u16,
    pub pad_index: u8,
    pub volume: f32,
}

pub struct SetSampleRackPadVolumeCommand {
    pub track_id: Uuid,
    pub pad_index: u8,
    pub volume: f32,
}

impl SetSampleRackPadVolumeCommand {
    pub fn from_str_track_id(
        track_id: &str,
        pad_index: u8,
        volume: f32,
    ) -> OrchestratorResult<Self> {
        let track_id = Uuid::parse_str(track_id).map_err(|e| OrchestratorError::InvalidId {
            field: "track_id",
            value: track_id.to_string(),
            source: e,
        })?;
        Ok(Self {
            track_id,
            pad_index,
            volume,
        })
    }
}

impl Command for SetSampleRackPadVolumeCommand {
    type Result = SetSampleRackPadVolumeResult;

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<Self::Result> {
        let mut project = ctx.lock_project()?;
        let track_index = resolve_track_index(&project, self.track_id)?;
        let pad_idx = validate_pad_index(self.pad_index)?;
        let clamped = self.volume.clamp(0.0, 2.0);

        let rack = project.tracks[track_index]
            .sample_rack
            .get_or_insert_with(SampleRackConfig::default);
        rack.pads[pad_idx].volume = clamped as f64;

        Ok(SetSampleRackPadVolumeResult {
            track_index: track_index as u16,
            pad_index: self.pad_index,
            volume: clamped,
        })
    }
}

#[derive(Debug, Clone, Copy)]
pub struct SetSampleRackPadMuteResult {
    pub track_index: u16,
    pub track_id: Uuid,
    pub pad_index: u8,
    pub muted: bool,
    pub effective_volume: f32,
}

pub struct SetSampleRackPadMuteCommand {
    pub track_id: Uuid,
    pub pad_index: u8,
    pub muted: bool,
}

impl SetSampleRackPadMuteCommand {
    pub fn from_str_track_id(
        track_id: &str,
        pad_index: u8,
        muted: bool,
    ) -> OrchestratorResult<Self> {
        let track_id = Uuid::parse_str(track_id).map_err(|e| OrchestratorError::InvalidId {
            field: "track_id",
            value: track_id.to_string(),
            source: e,
        })?;
        Ok(Self {
            track_id,
            pad_index,
            muted,
        })
    }
}

impl Command for SetSampleRackPadMuteCommand {
    type Result = SetSampleRackPadMuteResult;

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<Self::Result> {
        let mut project = ctx.lock_project()?;
        let track_index = resolve_track_index(&project, self.track_id)?;
        let pad_idx = validate_pad_index(self.pad_index)?;

        let rack = project.tracks[track_index]
            .sample_rack
            .get_or_insert_with(SampleRackConfig::default);
        rack.pads[pad_idx].is_disabled = self.muted;
        let effective_volume = if self.muted {
            0.0
        } else {
            rack.pads[pad_idx].volume as f32
        };

        Ok(SetSampleRackPadMuteResult {
            track_index: track_index as u16,
            track_id: self.track_id,
            pad_index: self.pad_index,
            muted: self.muted,
            effective_volume,
        })
    }
}

#[derive(Debug, Clone)]
pub struct SetSampleRackPadSoloResult {
    pub track_index: u16,
    pub track_id: Uuid,
    pub pad_index: u8,
    pub soloed: bool,
    pub effective_pad_volumes: [f32; 16],
}

pub struct SetSampleRackPadSoloCommand {
    pub track_id: Uuid,
    pub pad_index: u8,
    pub soloed: bool,
}

impl SetSampleRackPadSoloCommand {
    pub fn from_str_track_id(
        track_id: &str,
        pad_index: u8,
        soloed: bool,
    ) -> OrchestratorResult<Self> {
        let track_id = Uuid::parse_str(track_id).map_err(|e| OrchestratorError::InvalidId {
            field: "track_id",
            value: track_id.to_string(),
            source: e,
        })?;
        Ok(Self {
            track_id,
            pad_index,
            soloed,
        })
    }
}

impl Command for SetSampleRackPadSoloCommand {
    type Result = SetSampleRackPadSoloResult;

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<Self::Result> {
        let mut project = ctx.lock_project()?;
        let track_index = resolve_track_index(&project, self.track_id)?;
        let pad_idx = validate_pad_index(self.pad_index)?;

        let rack = project.tracks[track_index]
            .sample_rack
            .get_or_insert_with(SampleRackConfig::default);
        rack.pads[pad_idx].is_soloed = self.soloed;

        let any_soloed = rack.pads.iter().any(|p| p.is_soloed);
        let mut effective_pad_volumes = [0.0f32; 16];
        for (i, pad) in rack.pads.iter().enumerate().take(16) {
            effective_pad_volumes[i] = if (any_soloed && !pad.is_soloed) || pad.is_disabled {
                0.0
            } else {
                pad.volume as f32
            };
        }

        Ok(SetSampleRackPadSoloResult {
            track_index: track_index as u16,
            track_id: self.track_id,
            pad_index: self.pad_index,
            soloed: self.soloed,
            effective_pad_volumes,
        })
    }
}

#[derive(Debug, Clone, Copy)]
pub struct SetSampleRackPadAdsrResult {
    pub track_index: u16,
    pub track_id: Uuid,
    pub pad_index: u8,
    pub attack: f32,
    pub decay: f32,
    pub sustain: f32,
    pub release: f32,
}

pub struct SetSampleRackPadAdsrCommand {
    pub track_id: Uuid,
    pub pad_index: u8,
    pub attack: f32,
    pub decay: f32,
    pub sustain: f32,
    pub release: f32,
}

impl SetSampleRackPadAdsrCommand {
    pub fn from_str_track_id(
        track_id: &str,
        pad_index: u8,
        attack: f32,
        decay: f32,
        sustain: f32,
        release: f32,
    ) -> OrchestratorResult<Self> {
        let track_id = Uuid::parse_str(track_id).map_err(|e| OrchestratorError::InvalidId {
            field: "track_id",
            value: track_id.to_string(),
            source: e,
        })?;
        Ok(Self {
            track_id,
            pad_index,
            attack,
            decay,
            sustain,
            release,
        })
    }
}

impl Command for SetSampleRackPadAdsrCommand {
    type Result = SetSampleRackPadAdsrResult;

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<Self::Result> {
        let mut project = ctx.lock_project()?;
        let track_index = resolve_track_index(&project, self.track_id)?;
        let pad_idx = validate_pad_index(self.pad_index)?;

        let attack = self.attack.clamp(0.001, 10.0);
        let decay = self.decay.clamp(0.001, 10.0);
        let sustain = self.sustain.clamp(0.0, 1.0);
        let release = self.release.clamp(0.001, 20.0);

        let rack = project.tracks[track_index]
            .sample_rack
            .get_or_insert_with(SampleRackConfig::default);
        let pad = &mut rack.pads[pad_idx];
        pad.attack = attack as f64;
        pad.decay = decay as f64;
        pad.sustain = sustain as f64;
        pad.release = release as f64;

        Ok(SetSampleRackPadAdsrResult {
            track_index: track_index as u16,
            track_id: self.track_id,
            pad_index: self.pad_index,
            attack,
            decay,
            sustain,
            release,
        })
    }
}

#[derive(Debug, Clone, Copy)]
pub struct SetSampleRackPadFilterCutoffResult {
    pub track_index: u16,
    pub track_id: Uuid,
    pub pad_index: u8,
    pub cutoff: f32,
}

pub struct SetSampleRackPadFilterCutoffCommand {
    pub track_id: Uuid,
    pub pad_index: u8,
    pub cutoff: f32,
}

impl SetSampleRackPadFilterCutoffCommand {
    pub fn from_str_track_id(
        track_id: &str,
        pad_index: u8,
        cutoff: f32,
    ) -> OrchestratorResult<Self> {
        let track_id = Uuid::parse_str(track_id).map_err(|e| OrchestratorError::InvalidId {
            field: "track_id",
            value: track_id.to_string(),
            source: e,
        })?;
        Ok(Self {
            track_id,
            pad_index,
            cutoff,
        })
    }
}

impl Command for SetSampleRackPadFilterCutoffCommand {
    type Result = SetSampleRackPadFilterCutoffResult;

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<Self::Result> {
        let mut project = ctx.lock_project()?;
        let track_index = resolve_track_index(&project, self.track_id)?;
        let pad_idx = validate_pad_index(self.pad_index)?;
        let clamped_cutoff = self.cutoff.clamp(20.0, 20_000.0);

        let rack = project.tracks[track_index]
            .sample_rack
            .get_or_insert_with(SampleRackConfig::default);
        rack.pads[pad_idx].filter_cutoff = clamped_cutoff as f64;

        Ok(SetSampleRackPadFilterCutoffResult {
            track_index: track_index as u16,
            track_id: self.track_id,
            pad_index: self.pad_index,
            cutoff: clamped_cutoff,
        })
    }
}

#[derive(Debug, Clone)]
pub struct SetSampleRackPadSampleResult {
    pub track_index: u16,
    pub track_id: Uuid,
    pub pad_index: u8,
    pub sample_path: String,
}

pub struct SetSampleRackPadSamplePathCommand {
    pub track_id: Uuid,
    pub pad_index: u8,
    pub sample_path: String,
}

impl SetSampleRackPadSamplePathCommand {
    pub fn from_str_track_id(
        track_id: &str,
        pad_index: u8,
        sample_path: String,
    ) -> OrchestratorResult<Self> {
        let track_id = Uuid::parse_str(track_id).map_err(|e| OrchestratorError::InvalidId {
            field: "track_id",
            value: track_id.to_string(),
            source: e,
        })?;
        Ok(Self {
            track_id,
            pad_index,
            sample_path,
        })
    }
}

impl Command for SetSampleRackPadSamplePathCommand {
    type Result = SetSampleRackPadSampleResult;

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<Self::Result> {
        let mut project = ctx.lock_project()?;
        let track_index = resolve_track_index(&project, self.track_id)?;
        let pad_idx = validate_pad_index(self.pad_index)?;
        let rack = project.tracks[track_index]
            .sample_rack
            .get_or_insert_with(SampleRackConfig::default);
        rack.pads[pad_idx].sample_path = self.sample_path.clone();

        Ok(SetSampleRackPadSampleResult {
            track_index: track_index as u16,
            track_id: self.track_id,
            pad_index: self.pad_index,
            sample_path: self.sample_path.clone(),
        })
    }
}
