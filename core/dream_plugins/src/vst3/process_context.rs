use crate::instance::TransportContext;
use crate::vst3::com_abi::{
    K_BAR_POSITION_VALID, K_CONT_TIME_VALID, K_CYCLE_ACTIVE, K_PLAYING, K_PROJECT_TIME_VALID,
    K_RECORDING, K_TEMPO_VALID, K_TIME_SIG_VALID, Vst3Chord, Vst3FrameRate, Vst3ProcessContext,
};

pub(crate) fn process_context_from_transport(ctx: &TransportContext) -> Vst3ProcessContext {
    let mut state: u32 = K_TEMPO_VALID
        | K_TIME_SIG_VALID
        | K_PROJECT_TIME_VALID
        | K_BAR_POSITION_VALID
        | K_CONT_TIME_VALID;
    if ctx.is_playing {
        state |= K_PLAYING;
    }
    if ctx.is_recording {
        state |= K_RECORDING;
    }
    if ctx.cycle_active {
        state |= K_CYCLE_ACTIVE;
    }

    let beats_per_second = if ctx.tempo > 0.0 {
        ctx.tempo / 60.0
    } else {
        2.0
    };
    let position_seconds = if ctx.sample_rate > 0.0 {
        ctx.position_samples as f64 / ctx.sample_rate
    } else {
        0.0
    };
    let position_beats = position_seconds * beats_per_second;
    let time_sig_num = ctx.time_sig_numerator.max(1) as f64;
    let bar_position_music = (position_beats / time_sig_num).floor() * time_sig_num;

    // LOOP-WRAP-FIX: Compute cycle boundaries in beats (musical position).
    let (cycle_start_music, cycle_end_music) = if ctx.cycle_active && ctx.sample_rate > 0.0 {
        let start_sec = ctx.loop_start_samples as f64 / ctx.sample_rate;
        let end_sec = ctx.loop_end_samples as f64 / ctx.sample_rate;
        (start_sec * beats_per_second, end_sec * beats_per_second)
    } else {
        (0.0, 0.0)
    };

    Vst3ProcessContext {
        state,
        sample_rate: ctx.sample_rate,
        project_time_samples: ctx.position_samples,
        system_time: 0,
        continuous_time_samples: ctx.position_samples,
        project_time_music: position_beats,
        bar_position_music,
        cycle_start_music,
        cycle_end_music,
        tempo: ctx.tempo,
        time_sig_numerator: ctx.time_sig_numerator,
        time_sig_denominator: ctx.time_sig_denominator,
        chord: Vst3Chord {
            key_note: 0,
            root_note: 0,
            chord_mask: 0,
        },
        smpte_offset_subframes: 0,
        frame_rate: Vst3FrameRate {
            frames_per_second: 0,
            flags: 0,
        },
        samples_to_next_clock: 0,
    }
}
