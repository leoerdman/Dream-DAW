use uuid::Uuid;

use dream_models::mutators;
use dream_models::project::SamplerConfig;

use crate::context::{Command, OrchestratorContext};
use crate::error::{OrchestratorError, OrchestratorResult};

#[derive(Debug, Clone)]
pub struct SetInternalPluginParamCommand {
    pub track_id: Uuid,
    pub param_id: String,
    pub value: f64,
}

#[derive(Debug, Clone)]
pub struct SetInternalPluginParamResult {
    pub track_index: usize,
    pub sampler_command_needed: bool,
    pub sampler_cfg_for_rt: Option<SamplerConfig>,
    pub sampler_waveform: Option<u8>,
    pub sampler_waveform2: Option<u8>,
    pub sampler_osc1_volume: Option<f32>,
    pub sampler_osc2_volume: Option<f32>,
    pub sampler_detune_cents: Option<f32>,
    pub sampler_sub_level: Option<f32>,
    pub sampler_filter_cutoff: Option<f32>,
    pub sampler_filter_resonance: Option<f32>,
    pub sampler_filter_type: Option<u8>,
    pub sampler_lfo_rate: Option<f32>,
    pub sampler_lfo_depth: Option<f32>,
    pub sampler_lfo_target: Option<u8>,
    pub sampler_pulse_width: Option<f32>,
    pub sampler_osc1_enabled: Option<bool>,
    pub sampler_osc2_enabled: Option<bool>,
}

impl SetInternalPluginParamCommand {
    pub fn from_str_track_id(
        track_id: &str,
        param_id: String,
        value: f64,
    ) -> OrchestratorResult<Self> {
        let track_id = Uuid::parse_str(track_id).map_err(|e| OrchestratorError::InvalidId {
            field: "track_id",
            value: track_id.to_string(),
            source: e,
        })?;
        Ok(Self {
            track_id,
            param_id,
            value,
        })
    }
}

impl Command for SetInternalPluginParamCommand {
    type Result = SetInternalPluginParamResult;

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<Self::Result> {
        fn waveform_token_and_code(value: f64) -> (&'static str, u8) {
            let idx = value.round().clamp(0.0, 3.0) as u8;
            match idx {
                1 => ("internal://waveform/triangle", 1),
                2 => ("internal://waveform/saw", 2),
                3 => ("internal://waveform/square", 3),
                _ => ("internal://waveform/sine", 0),
            }
        }

        let mut project = ctx.lock_project()?;
        let raw_key = self.param_id.to_lowercase();
        let key = if raw_key.starts_with("slot:") {
            raw_key
                .splitn(3, ':')
                .nth(2)
                .unwrap_or(raw_key.as_str())
                .to_string()
        } else {
            raw_key.clone()
        };
        let lane_param_id = |fallback: &str| -> String {
            if raw_key.starts_with("slot:") {
                self.param_id.clone()
            } else {
                fallback.to_string()
            }
        };

        let mut sampler_command_needed = false;
        let mut sampler_waveform = None;
        let mut sampler_waveform2 = None;
        let mut sampler_osc1_volume: Option<f32> = None;
        let mut sampler_osc2_volume: Option<f32> = None;
        let mut sampler_detune_cents = None;
        let mut sampler_sub_level = None;
        let mut sampler_filter_cutoff = None;
        let mut sampler_filter_resonance = None;
        let mut sampler_filter_type = None;
        let mut sampler_lfo_rate = None;
        let mut sampler_lfo_depth = None;
        let mut sampler_lfo_target = None;
        let mut sampler_pulse_width = None;
        let mut sampler_osc1_enabled: Option<bool> = None;
        let mut sampler_osc2_enabled: Option<bool> = None;

        let (track_index, sampler_cfg_for_rt) = {
            let (idx, track) = project
                .tracks
                .iter_mut()
                .enumerate()
                .find(|(_, t)| t.id == self.track_id)
                .ok_or_else(|| OrchestratorError::NotFound {
                    entity: "Track",
                    id: self.track_id.to_string(),
                })?;

            match key.as_str() {
                "gain" | "utility.gain" | "plugin.gain" => {
                    let linear = 10.0_f64
                        .powf(self.value.clamp(-60.0, 24.0) / 20.0)
                        .clamp(0.0, 16.0);
                    mutators::upsert_static_automation_lane(
                        track,
                        &lane_param_id("plugin.gain"),
                        linear,
                    );
                }
                "pan" | "utility.pan" | "plugin.pan" => {
                    let pan = if self.value.abs() > 1.0 {
                        (self.value / 100.0).clamp(-1.0, 1.0)
                    } else {
                        self.value.clamp(-1.0, 1.0)
                    };
                    mutators::upsert_static_automation_lane(
                        track,
                        &lane_param_id("plugin.pan"),
                        pan,
                    );
                }
                "width" | "utility.width" | "plugin.width" => {
                    mutators::upsert_static_automation_lane(
                        track,
                        &lane_param_id("plugin.width"),
                        self.value.clamp(0.0, 200.0),
                    );
                }
                "mono" | "utility.mono" | "plugin.mono" => {
                    mutators::upsert_static_automation_lane(
                        track,
                        &lane_param_id("plugin.mono"),
                        if self.value >= 0.5 { 1.0 } else { 0.0 },
                    );
                }
                "sampler.volume" | "sampler.gain" | "volume" => {
                    let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                    cfg.volume = self.value.clamp(0.0, 2.0);
                    sampler_command_needed = true;
                }
                "sampler.attack" | "sampler.atk" | "attack" | "atk" => {
                    let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                    cfg.attack = self.value.clamp(0.001, 10.0);
                    sampler_command_needed = true;
                }
                "sampler.decay" | "sampler.dec" | "decay" | "dec" => {
                    let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                    cfg.decay = self.value.clamp(0.001, 10.0);
                    sampler_command_needed = true;
                }
                "sampler.sustain" | "sampler.sus" | "sustain" | "sus" => {
                    let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                    cfg.sustain = self.value.clamp(0.0, 1.0);
                    sampler_command_needed = true;
                }
                "sampler.release" | "sampler.rel" | "release" | "rel" => {
                    let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                    cfg.release = self.value.clamp(0.001, 20.0);
                    sampler_command_needed = true;
                }
                "sampler.rootnote" | "rootnote" | "sampler.root_note" => {
                    let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                    cfg.root_note = self.value.round().clamp(0.0, 127.0) as u8;
                    sampler_command_needed = true;
                }
                "synth.waveform"
                | "waveform"
                | "sampler.waveform"
                | "sampler.osc1wave"
                | "sampler.osc1_wave"
                | "synth.osc1.waveform"
                | "synth.osc1.wave" => {
                    let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                    let (token, code) = waveform_token_and_code(self.value);
                    cfg.sample_path = token.to_string();
                    sampler_waveform = Some(code);
                }
                "synth.osc2.waveform"
                | "synth.osc2.wave"
                | "sampler.osc2wave"
                | "sampler.osc2_wave" => {
                    let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                    let (_, code) = waveform_token_and_code(self.value);
                    cfg.osc2_waveform = code;
                    sampler_waveform2 = Some(code);
                }
                "synth.osc.mix" | "synth.oscmix" | "sampler.mix" => {
                    let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                    // Legacy mix compat: treat as split volumes (osc1=1-mix, osc2=mix)
                    let mix = self.value.clamp(0.0, 1.0) as f32;
                    cfg.osc_mix = mix as f64;
                    sampler_osc1_volume = Some(1.0 - mix);
                    sampler_osc2_volume = Some(mix);
                }
                "synth.osc1.volume" | "sampler.osc1volume" | "osc1volume" | "sampler.osc1vol" => {
                    let vol = self.value.clamp(0.0, 1.0) as f32;
                    sampler_osc1_volume = Some(vol);
                }
                "synth.osc2.volume" | "sampler.osc2volume" | "osc2volume" | "sampler.osc2vol" => {
                    let vol = self.value.clamp(0.0, 1.0) as f32;
                    sampler_osc2_volume = Some(vol);
                }
                "synth.detune" | "synth.detunecents" | "synth.osc2.detune" | "sampler.detune" => {
                    let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                    let cents = self.value.clamp(-50.0, 50.0) as f32;
                    cfg.detune_cents = cents as f64;
                    sampler_detune_cents = Some(cents);
                }
                "synth.sub" | "synth.sublevel" | "sampler.sub" => {
                    let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                    let level = self.value.clamp(0.0, 1.0) as f32;
                    cfg.sub_level = level as f64;
                    sampler_sub_level = Some(level);
                }
                "synth.filter.cutoff" | "synth.filtercutoff" | "sampler.cutoff" => {
                    let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                    let cutoff = self.value.clamp(20.0, 20000.0) as f32;
                    cfg.filter_cutoff = cutoff as f64;
                    sampler_filter_cutoff = Some(cutoff);
                }
                "synth.filter.resonance"
                | "synth.filterresonance"
                | "synth.filter.res"
                | "sampler.res"
                | "sampler.resonance" => {
                    let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                    let res = self.value.clamp(0.0, 0.99) as f32;
                    cfg.filter_resonance = res as f64;
                    sampler_filter_resonance = Some(res);
                }
                "synth.filter.type" | "synth.filtertype" | "sampler.filttype"
                | "sampler.filtertype" => {
                    let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                    let ft = self.value.round().clamp(0.0, 3.0) as u8;
                    cfg.filter_type = ft;
                    sampler_filter_type = Some(ft);
                }
                "synth.lfo.rate" | "synth.lforate" | "sampler.lforate" => {
                    let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                    let rate = self.value.clamp(0.01, 20.0) as f32;
                    cfg.lfo_rate = rate as f64;
                    sampler_lfo_rate = Some(rate);
                }
                "synth.lfo.depth" | "synth.lfodepth" | "sampler.lfodepth" => {
                    let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                    let depth = self.value.clamp(0.0, 1.0) as f32;
                    cfg.lfo_depth = depth as f64;
                    sampler_lfo_depth = Some(depth);
                }
                "synth.lfo.target" | "synth.lfotarget" | "sampler.lfotarget" => {
                    let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                    let target = self.value.round().clamp(0.0, 2.0) as u8;
                    cfg.lfo_target = target;
                    sampler_lfo_target = Some(target);
                }
                "synth.pulse_width" | "synth.pulsewidth" | "synth.pw" | "sampler.pulsewidth" => {
                    let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                    let pw = self.value.clamp(0.05, 0.95) as f32;
                    cfg.pulse_width = pw as f64;
                    sampler_pulse_width = Some(pw);
                }
                "synth.osc1.enabled" | "sampler.osc1enabled" | "osc1enabled" => {
                    sampler_osc1_enabled = Some(self.value >= 0.5);
                }
                "synth.osc2.enabled" | "sampler.osc2enabled" | "osc2enabled" => {
                    sampler_osc2_enabled = Some(self.value >= 0.5);
                }
                _ => {
                    mutators::upsert_static_automation_lane(track, &self.param_id, self.value);
                }
            }

            if sampler_command_needed {
                (idx, track.sampler.clone())
            } else {
                (idx, None)
            }
        };

        Ok(SetInternalPluginParamResult {
            track_index,
            sampler_command_needed,
            sampler_cfg_for_rt,
            sampler_waveform,
            sampler_waveform2,
            sampler_osc1_volume,
            sampler_osc2_volume,
            sampler_detune_cents,
            sampler_sub_level,
            sampler_filter_cutoff,
            sampler_filter_resonance,
            sampler_filter_type,
            sampler_lfo_rate,
            sampler_lfo_depth,
            sampler_lfo_target,
            sampler_pulse_width,
            sampler_osc1_enabled,
            sampler_osc2_enabled,
        })
    }
}
