use cpal::traits::{DeviceTrait, HostTrait};
use log::{info, warn};

use super::AudioDriverError;

pub(crate) struct OutputSetup {
    pub(crate) device: cpal::Device,
    pub(crate) device_name: String,
    pub(crate) sample_format: cpal::SampleFormat,
    pub(crate) sample_rate: cpal::SampleRate,
    pub(crate) channels: usize,
    pub(crate) config: cpal::StreamConfig,
}

pub(crate) fn resolve_output_setup(
    preferred_output_device: Option<&str>,
) -> Result<OutputSetup, AudioDriverError> {
    let host = cpal::default_host();
    info!("Audio host: {:?}", host.id());

    let requested_device_name = preferred_output_device
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let device = if let Some(wanted_name) = requested_device_name {
        if wanted_name.eq_ignore_ascii_case("Default Output") {
            host.default_output_device()
                .ok_or(AudioDriverError::NoOutputDevice)?
        } else {
            let mut found = None;
            if let Ok(mut outputs) = host.output_devices() {
                found = outputs.find(|dev| {
                    dev.description()
                        .map(|d| d.name().to_string())
                        .ok()
                        .as_deref()
                        == Some(wanted_name)
                });
            }
            found
                .or_else(|| {
                    warn!(
                        "Requested output device '{}' not found; falling back to system default",
                        wanted_name
                    );
                    host.default_output_device()
                })
                .ok_or(AudioDriverError::NoOutputDevice)?
        }
    } else {
        host.default_output_device()
            .ok_or(AudioDriverError::NoOutputDevice)?
    };

    let device_name = device
        .description()
        .map(|d| d.name().to_string())
        .unwrap_or_else(|_| String::from("Unknown Device"));

    if let Some(wanted) = requested_device_name
        && !wanted.eq_ignore_ascii_case("Default Output")
        && wanted != device_name
    {
        warn!("Output device '{}' resolved to '{}'", wanted, device_name);
    }

    info!("Output device: {}", device_name);

    let default_config = device
        .default_output_config()
        .map_err(|e| AudioDriverError::DefaultConfigError(e.to_string()))?;

    let supported_config = if default_config.sample_format() == cpal::SampleFormat::F32 {
        default_config
    } else {
        let fallback = device
            .supported_output_configs()
            .ok()
            .and_then(|mut ranges| {
                ranges.find_map(|range| {
                    if range.sample_format() != cpal::SampleFormat::F32 {
                        return None;
                    }
                    let desired_rate = default_config.sample_rate();
                    let clamped_rate =
                        desired_rate.clamp(range.min_sample_rate(), range.max_sample_rate());
                    Some(range.with_sample_rate(clamped_rate))
                })
            });

        if let Some(cfg) = fallback {
            warn!(
                "Default output sample format {:?} unsupported by engine, using f32 fallback",
                default_config.sample_format()
            );
            cfg
        } else {
            return Err(AudioDriverError::DefaultConfigError(format!(
                "No f32 output stream config available for device '{}'. Current engine supports f32 output only.",
                device_name
            )));
        }
    };

    let sample_format = supported_config.sample_format();
    let sample_rate = supported_config.sample_rate();
    let channels = supported_config.channels() as usize;
    let config: cpal::StreamConfig = supported_config.into();

    info!(
        "Stream config: {:?}, {}ch, {:?}",
        sample_rate, channels, sample_format
    );

    Ok(OutputSetup {
        device,
        device_name,
        sample_format,
        sample_rate,
        channels,
        config,
    })
}

/// Enumerates all available audio input and output devices on the system.
///
/// Returns `(output_device_names, input_device_names)`.
/// Uses `cpal::default_host()` which maps to CoreAudio on macOS,
/// WASAPI on Windows, and ALSA/PulseAudio on Linux.
pub(crate) fn list_audio_devices_backend() -> (Vec<String>, Vec<String>) {
    let host = cpal::default_host();

    let mut outputs: Vec<String> = host
        .output_devices()
        .map(|devices| {
            devices
                .filter_map(|d| d.description().ok().map(|desc| desc.name().to_string()))
                .collect()
        })
        .unwrap_or_default();

    let mut inputs: Vec<String> = host
        .input_devices()
        .map(|devices| {
            devices
                .filter_map(|d| d.description().ok().map(|desc| desc.name().to_string()))
                .collect()
        })
        .unwrap_or_default();

    outputs.sort();
    outputs.dedup();
    inputs.sort();
    inputs.dedup();

    outputs.insert(0, String::from("Default Output"));
    inputs.insert(0, String::from("Default Input"));

    info!(
        "Audio devices: {} outputs, {} inputs",
        outputs.len(),
        inputs.len()
    );
    (outputs, inputs)
}
