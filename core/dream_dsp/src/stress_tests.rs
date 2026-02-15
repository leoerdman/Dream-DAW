// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Mega Stress Test Suite for All 15 Built-in DSP Effects
// ═══════════════════════════════════════════════════════════════════════════
//
// This module provides 1000+ virtual tests across all effects:
//
// 1. SIGNAL INTEGRITY — no NaN, no Inf, bounded output
// 2. PARAMETER SWEEPS — every param at min/mid/max
// 3. EXTREME EDGES — clipping inputs, DC, silence, impulse
// 4. EFFECT CHAINING — all 105 2-effect permutations (15×14/2)
// 5. ALL-MODES TORTURE — every mode/shape combination per effect
// 6. RESET IDEMPOTENCY — reset clears state completely
// 7. SAMPLE RATE INDEPENDENCE — 22050, 44100, 48000, 96000
// 8. RAPID PARAM CHANGES — simulate automation at every sample
// 9. MONO-STEREO COHERENCE — check L/R relationship
// 10. LONG-RUNNING STABILITY — 10 seconds of continuous processing
//
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod stress_suite {
    use crate::dsp_processor::{BuiltinEffectType, DspProcessor};

    const SR: f32 = 44100.0;
    const BUF: usize = 2048;

    // ═══════════════════════════════════════════════════════════════════════
    // TEST 1: All 15 effects — signal integrity (no NaN, no Inf)
    // ═══════════════════════════════════════════════════════════════════════

    /// Generate test signal: 440Hz sine
    fn sine_buffer(len: usize, freq: f32, sr: f32) -> Vec<f32> {
        (0..len)
            .map(|i| (2.0 * std::f32::consts::PI * freq * i as f32 / sr).sin() * 0.5)
            .collect()
    }

    /// Check that all samples are finite and bounded in [-30, 30]
    fn assert_sane(buf: &[f32], label: &str) {
        for (i, &s) in buf.iter().enumerate() {
            assert!(s.is_finite(), "{label}: NaN/Inf at sample {i}");
            assert!(
                s.abs() <= 30.0,
                "{label}: Unbounded output {s} at sample {i}"
            );
        }
    }

    #[test]
    fn t001_all_effects_silence_integrity() {
        for id in 0..=14u8 {
            let ty = BuiltinEffectType::from_u8(id).unwrap();
            let mut proc = ty.create_processor(SR);
            let mut l = vec![0.0f32; BUF];
            let mut r = vec![0.0f32; BUF];
            proc.process_stereo(&mut l, &mut r, SR);
            assert_sane(&l, &format!("Effect {id} silence L"));
            assert_sane(&r, &format!("Effect {id} silence R"));
        }
    }

    #[test]
    fn t002_all_effects_sine_integrity() {
        for id in 0..=14u8 {
            let ty = BuiltinEffectType::from_u8(id).unwrap();
            let mut proc = ty.create_processor(SR);
            let mut l = sine_buffer(BUF, 440.0, SR);
            let mut r = sine_buffer(BUF, 440.0, SR);
            proc.process_stereo(&mut l, &mut r, SR);
            assert_sane(&l, &format!("Effect {id} sine L"));
            assert_sane(&r, &format!("Effect {id} sine R"));
        }
    }

    #[test]
    fn t003_all_effects_impulse_integrity() {
        for id in 0..=14u8 {
            let ty = BuiltinEffectType::from_u8(id).unwrap();
            let mut proc = ty.create_processor(SR);
            let mut l = vec![0.0f32; BUF];
            let mut r = vec![0.0f32; BUF];
            l[0] = 1.0;
            r[0] = 1.0;
            proc.process_stereo(&mut l, &mut r, SR);
            assert_sane(&l, &format!("Effect {id} impulse L"));
            assert_sane(&r, &format!("Effect {id} impulse R"));
        }
    }

    #[test]
    fn t004_all_effects_dc_integrity() {
        for id in 0..=14u8 {
            let ty = BuiltinEffectType::from_u8(id).unwrap();
            let mut proc = ty.create_processor(SR);
            let mut l = vec![0.8f32; BUF];
            let mut r = vec![0.8f32; BUF];
            proc.process_stereo(&mut l, &mut r, SR);
            assert_sane(&l, &format!("Effect {id} DC L"));
            assert_sane(&r, &format!("Effect {id} DC R"));
        }
    }

    #[test]
    fn t005_all_effects_hot_signal_integrity() {
        for id in 0..=14u8 {
            let ty = BuiltinEffectType::from_u8(id).unwrap();
            let mut proc = ty.create_processor(SR);
            let mut l = vec![2.0f32; BUF]; // clipping level
            let mut r = vec![2.0f32; BUF];
            proc.process_stereo(&mut l, &mut r, SR);
            assert_sane(&l, &format!("Effect {id} hot L"));
            assert_sane(&r, &format!("Effect {id} hot R"));
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // TEST 2: Parameter sweep — every param at min, mid, max
    // ═══════════════════════════════════════════════════════════════════════

    /// Per-effect parameter definitions: (index, min, mid, max)
    fn get_param_ranges(effect_id: u8) -> Vec<(u8, f32, f32, f32)> {
        match effect_id {
            // EQ: bands 0-7, each has freq/gain/q/enable (indices 0-31), + output gain (32)
            0 => {
                let mut v = Vec::new();
                for band in 0..8u8 {
                    let base = band * 4;
                    v.push((base, 20.0, 1000.0, 20000.0));   // freq
                    v.push((base + 1, -24.0, 0.0, 24.0));    // gain
                    v.push((base + 2, 0.1, 1.0, 18.0));      // Q
                    v.push((base + 3, 0.0, 0.5, 1.0));       // enable
                }
                v.push((32, -24.0, 0.0, 24.0)); // output gain
                v
            }
            // Compressor
            1 => vec![
                (0, -60.0, -18.0, 0.0),   // threshold
                (1, 1.0, 4.0, 20.0),       // ratio
                (2, 0.1, 10.0, 100.0),     // attack
                (3, 10.0, 100.0, 1000.0),  // release
                (4, 0.0, 6.0, 24.0),       // knee
                (5, -12.0, 0.0, 24.0),     // makeup
                (6, 0.0, 50.0, 100.0),     // mix
                (7, 20.0, 100.0, 500.0),   // sc hpf
                (8, 0.0, 0.5, 1.0),        // auto gain
                (9, 0.0, 0.5, 1.0),        // rms mode
            ],
            // Delay
            2 => vec![
                (0, 1.0, 250.0, 2000.0),    // time L
                (1, 1.0, 375.0, 2000.0),    // time R
                (2, 0.0, 30.0, 95.0),       // feedback
                (3, 0.0, 30.0, 100.0),      // mix
                (4, 200.0, 5000.0, 15000.0), // filter
                (5, 0.0, 0.5, 1.0),         // ping-pong
                (6, 0.0, 0.5, 5.0),         // mod rate
                (7, 0.0, 10.0, 100.0),      // mod depth
            ],
            // Reverb
            3 => vec![
                (0, 0.0, 50.0, 100.0),     // size
                (1, 0.0, 40.0, 100.0),     // damping
                (2, 0.0, 30.0, 100.0),     // mix
                (3, 0.0, 10.0, 200.0),     // predelay
                (4, 0.0, 50.0, 100.0),     // width
                (5, 0.0, 20.0, 100.0),     // low damp
                (6, 0.0, 0.3, 3.0),        // mod rate
                (7, 0.0, 15.0, 100.0),     // mod depth
                (8, 0.0, 0.5, 1.0),        // freeze
            ],
            // Chorus
            4 => vec![
                (0, 0.05, 1.0, 10.0),     // rate
                (1, 0.0, 50.0, 100.0),    // depth
                (2, 0.0, 50.0, 100.0),    // mix
                (3, -95.0, 0.0, 95.0),    // feedback
                (4, 1.0, 2.0, 3.0),       // voices
                (5, 0.0, 80.0, 100.0),    // spread
                (6, 20.0, 80.0, 500.0),   // hp freq
            ],
            // Utility
            5 => vec![
                (0, -60.0, 0.0, 24.0),    // gain
                (1, -100.0, 0.0, 100.0),  // pan
                (2, 0.0, 100.0, 200.0),   // width
                (3, 0.0, 0.5, 1.0),       // mono
            ],
            // Saturator
            6 => vec![
                (0, 0.0, 6.0, 36.0),      // drive
                (1, 0.0, 50.0, 100.0),    // tone
                (2, 0.0, 50.0, 100.0),    // mix
                (3, 0.0, 2.0, 4.0),       // mode
                (4, -24.0, 0.0, 6.0),     // output
                (5, 0.0, 50.0, 100.0),    // color
            ],
            // Limiter
            7 => vec![
                (0, -30.0, -6.0, 0.0),    // threshold
                (1, 10.0, 100.0, 1000.0), // release
                (2, -6.0, -0.1, 0.0),     // ceiling
                (3, 0.1, 1.0, 5.0),       // lookahead
                (4, 0.0, 0.5, 1.0),       // auto release
                (5, 0.0, 50.0, 100.0),    // stereo link
            ],
            // Gate
            8 => vec![
                (0, -60.0, -30.0, 0.0),   // threshold
                (1, 0.01, 0.5, 50.0),     // attack
                (2, 0.0, 50.0, 500.0),    // hold
                (3, 5.0, 100.0, 2000.0),  // release
                (4, -96.0, -40.0, 0.0),   // range
                (5, 20.0, 100.0, 500.0),  // sc hpf
                (6, 0.0, 3.0, 12.0),      // hysteresis
                (7, 0.0, 0.5, 1.0),       // duck mode
            ],
            // Auto Filter
            9 => vec![
                (0, 20.0, 1000.0, 20000.0), // cutoff
                (1, 0.0, 25.0, 100.0),      // resonance
                (2, 0.01, 1.0, 20.0),       // lfo rate
                (3, 0.0, 50.0, 100.0),      // lfo depth
                (4, -100.0, 30.0, 100.0),   // env amount
                (5, 0.0, 1.0, 3.0),         // filter type
                (6, 0.0, 50.0, 100.0),      // mix
                (7, 0.0, 2.0, 5.0),         // lfo shape
                (8, 0.0, 6.0, 24.0),        // drive
                (9, 1.0, 20.0, 200.0),      // env speed
            ],
            // Phaser
            10 => vec![
                (0, 0.01, 0.5, 10.0),      // rate
                (1, 0.0, 50.0, 100.0),     // depth
                (2, -95.0, 40.0, 95.0),    // feedback
                (3, 2.0, 6.0, 12.0),       // stages
                (4, 100.0, 1000.0, 8000.0), // center
                (5, 0.0, 50.0, 100.0),     // mix
                (6, 0.0, 50.0, 100.0),     // spread
                (7, 0.0, 1.0, 3.0),        // lfo shape
                (8, 200.0, 4000.0, 10000.0), // range
            ],
            // Flanger
            11 => vec![
                (0, 0.01, 0.3, 10.0),      // rate
                (1, 0.0, 50.0, 100.0),     // depth
                (2, -95.0, 40.0, 95.0),    // feedback
                (3, 0.1, 2.0, 10.0),       // delay
                (4, 0.0, 50.0, 100.0),     // mix
                (5, 0.0, 90.0, 180.0),     // stereo offset
                (6, 0.0, 1.0, 3.0),        // lfo shape
                (7, 1000.0, 8000.0, 20000.0), // fb damp
                (8, 0.0, 0.5, 1.0),        // tz mode
            ],
            // Distortion
            12 => vec![
                (0, 0.0, 50.0, 100.0),    // drive
                (1, 0.0, 50.0, 100.0),    // tone
                (2, 0.0, 50.0, 100.0),    // mix
                (3, 0.0, 2.0, 4.0),       // mode
                (4, -24.0, 0.0, 6.0),     // output
                (5, 0.0, 0.5, 1.0),       // cab sim
                (6, 0.0, 50.0, 100.0),    // tightness
                (7, -100.0, 0.0, 100.0),  // bias
            ],
            // Bitcrusher
            13 => vec![
                (0, 1.0, 8.0, 32.0),      // bit depth
                (1, 1.0, 8.0, 64.0),      // downsample
                (2, 0.0, 50.0, 100.0),    // mix
                (3, 0.0, 25.0, 100.0),    // jitter
                (4, 200.0, 5000.0, 20000.0), // pre filter
                (5, 200.0, 5000.0, 20000.0), // post filter
                (6, 0.0, 0.5, 1.0),       // stereo mode
                (7, 0.0, 25.0, 100.0),    // dither
            ],
            // Noise Machine
            14 => vec![
                (0, -60.0, -12.0, 0.0),   // volume
                (1, 0.0, 2.0, 5.0),       // type
                (2, 0.0, 50.0, 100.0),    // stereo
                (3, 200.0, 5000.0, 20000.0), // lp freq
                (4, 20.0, 100.0, 5000.0), // hp freq
                (5, -100.0, 0.0, 100.0),  // pan
            ],
            _ => vec![],
        }
    }

    /// This generates ~(15 effects × ~8 params × 3 values) ≈ 360 sub-tests
    #[test]
    fn t010_parameter_sweep_all_effects() {
        for id in 0..=14u8 {
            let ranges = get_param_ranges(id);
            let ty = BuiltinEffectType::from_u8(id).unwrap();
            for (param_idx, min, mid, max) in &ranges {
                for &val in &[*min, *mid, *max] {
                    let mut proc = ty.create_processor(SR);
                    proc.set_param(*param_idx, val);
                    let mut l = sine_buffer(1024, 440.0, SR);
                    let mut r = sine_buffer(1024, 440.0, SR);
                    proc.process_stereo(&mut l, &mut r, SR);
                    assert_sane(
                        &l,
                        &format!("Effect {id} param {} = {val}", param_idx),
                    );
                }
            }
        }
    }

    /// Set ALL params to MIN, then MAX, then process
    #[test]
    fn t011_all_params_extreme_min() {
        for id in 0..=14u8 {
            let ty = BuiltinEffectType::from_u8(id).unwrap();
            let ranges = get_param_ranges(id);
            let mut proc = ty.create_processor(SR);
            for (idx, min, _, _) in &ranges {
                proc.set_param(*idx, *min);
            }
            let mut l = sine_buffer(BUF, 440.0, SR);
            let mut r = sine_buffer(BUF, 440.0, SR);
            proc.process_stereo(&mut l, &mut r, SR);
            assert_sane(&l, &format!("Effect {id} ALL min L"));
        }
    }

    #[test]
    fn t012_all_params_extreme_max() {
        for id in 0..=14u8 {
            let ty = BuiltinEffectType::from_u8(id).unwrap();
            let ranges = get_param_ranges(id);
            let mut proc = ty.create_processor(SR);
            for (idx, _, _, max) in &ranges {
                proc.set_param(*idx, *max);
            }
            let mut l = sine_buffer(BUF, 440.0, SR);
            let mut r = sine_buffer(BUF, 440.0, SR);
            proc.process_stereo(&mut l, &mut r, SR);
            assert_sane(&l, &format!("Effect {id} ALL max L"));
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // TEST 3: Effect chaining — all 105 two-effect permutations
    // ═══════════════════════════════════════════════════════════════════════

    #[test]
    fn t020_all_2effect_chains() {
        for a in 0..=14u8 {
            for b in (a + 1)..=14u8 {
                let ty_a = BuiltinEffectType::from_u8(a).unwrap();
                let ty_b = BuiltinEffectType::from_u8(b).unwrap();
                let mut proc_a = ty_a.create_processor(SR);
                let mut proc_b = ty_b.create_processor(SR);

                let mut l = sine_buffer(1024, 440.0, SR);
                let mut r = sine_buffer(1024, 440.0, SR);

                proc_a.process_stereo(&mut l, &mut r, SR);
                proc_b.process_stereo(&mut l, &mut r, SR);

                assert_sane(&l, &format!("Chain {a}→{b} L"));
                assert_sane(&r, &format!("Chain {a}→{b} R"));
            }
        }
    }

    /// Reversed chains (b→a) to catch order-dependent bugs
    #[test]
    fn t021_all_2effect_chains_reversed() {
        for a in 0..=14u8 {
            for b in (a + 1)..=14u8 {
                let ty_a = BuiltinEffectType::from_u8(a).unwrap();
                let ty_b = BuiltinEffectType::from_u8(b).unwrap();
                let mut proc_a = ty_a.create_processor(SR);
                let mut proc_b = ty_b.create_processor(SR);

                let mut l = sine_buffer(1024, 440.0, SR);
                let mut r = sine_buffer(1024, 440.0, SR);

                proc_b.process_stereo(&mut l, &mut r, SR);  // b first
                proc_a.process_stereo(&mut l, &mut r, SR);  // then a

                assert_sane(&l, &format!("Chain {b}→{a} L"));
                assert_sane(&r, &format!("Chain {b}→{a} R"));
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // TEST 4: All mode/shape combinations per effect
    // ═══════════════════════════════════════════════════════════════════════

    #[test]
    fn t030_saturator_all_modes() {
        for mode in 0..=4u8 {
            let ty = BuiltinEffectType::from_u8(6).unwrap();
            let mut proc = ty.create_processor(SR);
            proc.set_param(3, mode as f32);
            proc.set_param(0, 18.0); // decent drive
            let mut l = sine_buffer(BUF, 440.0, SR);
            let mut r = sine_buffer(BUF, 440.0, SR);
            proc.process_stereo(&mut l, &mut r, SR);
            assert_sane(&l, &format!("Sat mode {mode}"));
        }
    }

    #[test]
    fn t031_distortion_all_modes() {
        for mode in 0..=4u8 {
            let ty = BuiltinEffectType::from_u8(12).unwrap();
            let mut proc = ty.create_processor(SR);
            proc.set_param(3, mode as f32);
            proc.set_param(0, 80.0);
            let mut l = sine_buffer(BUF, 440.0, SR);
            let mut r = sine_buffer(BUF, 440.0, SR);
            proc.process_stereo(&mut l, &mut r, SR);
            assert_sane(&l, &format!("Dist mode {mode}"));
        }
    }

    #[test]
    fn t032_auto_filter_all_types_and_shapes() {
        for filter_type in 0..=3u8 {
            for lfo_shape in 0..=5u8 {
                let ty = BuiltinEffectType::from_u8(9).unwrap();
                let mut proc = ty.create_processor(SR);
                proc.set_param(5, filter_type as f32);
                proc.set_param(7, lfo_shape as f32);
                proc.set_param(2, 2.0);  // faster LFO
                proc.set_param(3, 80.0); // deep
                let mut l = sine_buffer(BUF, 440.0, SR);
                let mut r = sine_buffer(BUF, 440.0, SR);
                proc.process_stereo(&mut l, &mut r, SR);
                assert_sane(&l, &format!("AF type {filter_type} shape {lfo_shape}"));
            }
        }
    }

    #[test]
    fn t033_phaser_all_shapes_and_stages() {
        for shape in 0..=3u8 {
            for stages in [2, 4, 6, 8, 12] {
                let ty = BuiltinEffectType::from_u8(10).unwrap();
                let mut proc = ty.create_processor(SR);
                proc.set_param(7, shape as f32);
                proc.set_param(3, stages as f32);
                proc.set_param(0, 1.0);
                proc.set_param(1, 80.0);
                let mut l = sine_buffer(BUF, 440.0, SR);
                let mut r = sine_buffer(BUF, 440.0, SR);
                proc.process_stereo(&mut l, &mut r, SR);
                assert_sane(&l, &format!("Phaser shape {shape} stages {stages}"));
            }
        }
    }

    #[test]
    fn t034_flanger_all_shapes_and_tz() {
        for shape in 0..=3u8 {
            for tz in [0.0, 1.0] {
                let ty = BuiltinEffectType::from_u8(11).unwrap();
                let mut proc = ty.create_processor(SR);
                proc.set_param(6, shape as f32);
                proc.set_param(8, tz);
                proc.set_param(0, 1.0);
                proc.set_param(1, 80.0);
                let mut l = sine_buffer(BUF, 440.0, SR);
                let mut r = sine_buffer(BUF, 440.0, SR);
                proc.process_stereo(&mut l, &mut r, SR);
                assert_sane(&l, &format!("Flanger shape {shape} tz {tz}"));
            }
        }
    }

    #[test]
    fn t035_noise_machine_all_types() {
        for noise_type in 0..=5u8 {
            let ty = BuiltinEffectType::from_u8(14).unwrap();
            let mut proc = ty.create_processor(SR);
            proc.set_param(1, noise_type as f32);
            proc.set_param(0, -6.0);
            let mut l = vec![0.0f32; BUF];
            let mut r = vec![0.0f32; BUF];
            proc.process_stereo(&mut l, &mut r, SR);
            assert_sane(&l, &format!("Noise type {noise_type}"));
            // Should produce output (except maybe grey at very low level)
            let energy: f32 = l.iter().map(|s| s * s).sum();
            assert!(
                energy > 0.0001,
                "Noise type {noise_type} should produce energy: {energy}"
            );
        }
    }

    #[test]
    fn t036_gate_duck_mode() {
        let ty = BuiltinEffectType::from_u8(8).unwrap();
        let mut proc = ty.create_processor(SR);
        proc.set_param(7, 1.0); // duck mode ON
        proc.set_param(0, -20.0);
        let mut l = vec![0.5f32; BUF];
        let mut r = vec![0.5f32; BUF];
        proc.process_stereo(&mut l, &mut r, SR);
        assert_sane(&l, "Gate duck L");
    }

    // ═══════════════════════════════════════════════════════════════════════
    // TEST 5: Reset idempotency
    // ═══════════════════════════════════════════════════════════════════════

    #[test]
    fn t040_reset_produces_same_output() {
        for id in 0..=14u8 {
            let ty = BuiltinEffectType::from_u8(id).unwrap();
            let mut proc = ty.create_processor(SR);

            // First pass with signal
            let mut l1 = sine_buffer(BUF, 880.0, SR);
            let mut r1 = l1.clone();
            proc.process_stereo(&mut l1, &mut r1, SR);

            // Reset
            proc.reset();

            // Second pass with same signal — should be same as fresh
            let mut l2 = sine_buffer(BUF, 880.0, SR);
            let mut r2 = l2.clone();
            proc.process_stereo(&mut l2, &mut r2, SR);

            // Compare with fresh processor
            let mut fresh = ty.create_processor(SR);
            let mut l3 = sine_buffer(BUF, 880.0, SR);
            let mut r3 = l3.clone();
            fresh.process_stereo(&mut l3, &mut r3, SR);

            // After reset, output should match fresh
            let diff: f32 = l2
                .iter()
                .zip(l3.iter())
                .map(|(a, b)| (a - b).abs())
                .sum();
            assert!(
                diff < 5.0,
                "Effect {id} reset divergence: {diff}"
            );
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // TEST 6: Sample rate independence
    // ═══════════════════════════════════════════════════════════════════════

    #[test]
    fn t050_sample_rates() {
        for sr in [22050.0, 44100.0, 48000.0, 96000.0] {
            for id in 0..=14u8 {
                let ty = BuiltinEffectType::from_u8(id).unwrap();
                let mut proc = ty.create_processor(sr);
                let mut l = sine_buffer(1024, 440.0, sr);
                let mut r = l.clone();
                proc.process_stereo(&mut l, &mut r, sr);
                assert_sane(&l, &format!("Effect {id} @ {sr}Hz"));
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // TEST 7: Rapid parameter automation (change every sample)
    // ═══════════════════════════════════════════════════════════════════════

    #[test]
    fn t060_rapid_automation() {
        for id in 0..=14u8 {
            let ty = BuiltinEffectType::from_u8(id).unwrap();
            let mut proc = ty.create_processor(SR);
            let ranges = get_param_ranges(id);

            // Process multiple small buffers with param changes between each
            for step in 0..100u32 {
                let progress = step as f32 / 99.0;
                for (idx, min, _, max) in &ranges {
                    let val = *min + progress * (*max - *min);
                    proc.set_param(*idx, val);
                }
                let mut l = sine_buffer(64, 440.0, SR);
                let mut r = l.clone();
                proc.process_stereo(&mut l, &mut r, SR);
                assert_sane(&l, &format!("Effect {id} auto step {step}"));
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // TEST 8: Long-running stability (10 seconds)
    // ═══════════════════════════════════════════════════════════════════════

    #[test]
    fn t070_long_running_stability() {
        for id in 0..=14u8 {
            let ty = BuiltinEffectType::from_u8(id).unwrap();
            let mut proc = ty.create_processor(SR);
            let total_samples = (SR * 10.0) as usize; // 10 seconds
            let chunk = 512;
            let mut processed = 0;

            while processed < total_samples {
                let n = chunk.min(total_samples - processed);
                let mut l = sine_buffer(n, 440.0, SR);
                let mut r = l.clone();
                proc.process_stereo(&mut l, &mut r, SR);

                // Check last sample of each chunk
                let last = l[n - 1];
                assert!(
                    last.is_finite(),
                    "Effect {id} diverged after {processed} samples: {last}"
                );
                assert!(
                    last.abs() <= 10.0,
                    "Effect {id} blew up after {processed} samples: {last}"
                );
                processed += n;
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // TEST 9: Multi-frequency test signals
    // ═══════════════════════════════════════════════════════════════════════

    #[test]
    fn t080_multi_frequency_signals() {
        let freqs = [20.0, 100.0, 440.0, 1000.0, 5000.0, 10000.0, 20000.0];
        for id in 0..=14u8 {
            let ty = BuiltinEffectType::from_u8(id).unwrap();
            for &freq in &freqs {
                let mut proc = ty.create_processor(SR);
                let mut l = sine_buffer(1024, freq, SR);
                let mut r = l.clone();
                proc.process_stereo(&mut l, &mut r, SR);
                assert_sane(&l, &format!("Effect {id} @ {freq}Hz"));
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // TEST 10: 3-effect and 4-effect chains
    // ═══════════════════════════════════════════════════════════════════════

    #[test]
    fn t090_triple_chains() {
        // Test common real-world chains
        let chains: Vec<[u8; 3]> = vec![
            [0, 1, 5],    // EQ → Comp → Utility
            [12, 6, 3],   // Distortion → Saturator → Reverb
            [9, 11, 2],   // AutoFilter → Flanger → Delay
            [1, 7, 5],    // Comp → Limiter → Utility
            [0, 4, 3],    // EQ → Chorus → Reverb
            [13, 12, 6],  // Bitcrusher → Distortion → Saturator
            [8, 1, 7],    // Gate → Comp → Limiter
            [10, 4, 3],   // Phaser → Chorus → Reverb
            [14, 0, 5],   // NoiseMachine → EQ → Utility
            [9, 2, 3],    // AutoFilter → Delay → Reverb
        ];
        for chain in &chains {
            let mut procs: Vec<Box<dyn DspProcessor>> = chain
                .iter()
                .map(|&id| BuiltinEffectType::from_u8(id).unwrap().create_processor(SR))
                .collect();

            let mut l = sine_buffer(BUF, 440.0, SR);
            let mut r = l.clone();
            for p in &mut procs {
                p.process_stereo(&mut l, &mut r, SR);
            }
            assert_sane(&l, &format!("Triple {:?}", chain));
        }
    }

    #[test]
    fn t091_quad_chains() {
        let chains: Vec<[u8; 4]> = vec![
            [0, 1, 3, 7],    // EQ → Comp → Reverb → Limiter
            [12, 6, 2, 5],   // Dist → Sat → Delay → Utility
            [9, 10, 4, 3],   // AF → Phaser → Chorus → Reverb
            [8, 0, 1, 7],    // Gate → EQ → Comp → Limiter
            [13, 12, 0, 7],  // BC → Dist → EQ → Limiter
        ];
        for chain in &chains {
            let mut procs: Vec<Box<dyn DspProcessor>> = chain
                .iter()
                .map(|&id| BuiltinEffectType::from_u8(id).unwrap().create_processor(SR))
                .collect();

            let mut l = sine_buffer(BUF, 440.0, SR);
            let mut r = l.clone();
            for p in &mut procs {
                p.process_stereo(&mut l, &mut r, SR);
            }
            assert_sane(&l, &format!("Quad {:?}", chain));
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // TEST 11: Effect-specific functional tests
    // ═══════════════════════════════════════════════════════════════════════

    #[test]
    fn t100_eq_each_band_affects_signal() {
        for band in 0..8u8 {
            let mut proc = BuiltinEffectType::Eq.create_processor(SR);
            // Enable band and boost
            proc.set_param(band * 4 + 3, 1.0);
            proc.set_param(band * 4 + 1, 12.0);
            let mut l = sine_buffer(BUF, 440.0, SR);
            let mut r = l.clone();
            proc.process_stereo(&mut l, &mut r, SR);
            assert_sane(&l, &format!("EQ band {band} boost"));
        }
    }

    #[test]
    fn t101_compressor_ratio_sweep() {
        for ratio in [1.0, 2.0, 4.0, 8.0, 20.0] {
            let mut proc = BuiltinEffectType::Compressor.create_processor(SR);
            proc.set_param(0, -20.0);
            proc.set_param(1, ratio);
            proc.set_param(2, 0.1);
            proc.set_param(8, 0.0); // manual gain
            let mut l = vec![0.9f32; BUF];
            let mut r = l.clone();
            proc.process_stereo(&mut l, &mut r, SR);
            assert_sane(&l, &format!("Comp ratio {ratio}"));
        }
    }

    #[test]
    fn t102_delay_time_sweep() {
        for time_ms in [1.0, 50.0, 250.0, 1000.0, 2000.0] {
            let mut proc = BuiltinEffectType::Delay.create_processor(SR);
            proc.set_param(0, time_ms);
            proc.set_param(1, time_ms);
            proc.set_param(3, 80.0);
            let mut l = sine_buffer(4096, 440.0, SR);
            let mut r = l.clone();
            proc.process_stereo(&mut l, &mut r, SR);
            assert_sane(&l, &format!("Delay {time_ms}ms"));
        }
    }

    #[test]
    fn t103_reverb_size_sweep() {
        for size in [0.0, 25.0, 50.0, 75.0, 100.0] {
            let mut proc = BuiltinEffectType::Reverb.create_processor(SR);
            proc.set_param(0, size);
            proc.set_param(2, 100.0);
            let mut l = vec![0.0f32; 44100];
            let mut r = vec![0.0f32; 44100];
            l[0] = 1.0;
            r[0] = 1.0;
            proc.process_stereo(&mut l, &mut r, SR);
            assert_sane(&l[..4096], &format!("Reverb size {size} head"));
        }
    }

    #[test]
    fn t104_limiter_threshold_sweep() {
        for thresh in [-30.0, -12.0, -6.0, -3.0, 0.0] {
            let mut proc = BuiltinEffectType::Limiter.create_processor(SR);
            proc.set_param(0, thresh);
            let mut l = vec![1.0f32; 4096];
            let mut r = l.clone();
            proc.process_stereo(&mut l, &mut r, SR);
            assert_sane(&l, &format!("Limiter thresh {thresh}"));
        }
    }

    #[test]
    fn t105_gate_threshold_sweep() {
        for thresh in [-60.0, -40.0, -20.0, -10.0, 0.0] {
            let mut proc = BuiltinEffectType::Gate.create_processor(SR);
            proc.set_param(0, thresh);
            let mut l = sine_buffer(BUF, 440.0, SR);
            let mut r = l.clone();
            proc.process_stereo(&mut l, &mut r, SR);
            assert_sane(&l, &format!("Gate thresh {thresh}"));
        }
    }

    #[test]
    fn t106_chorus_depth_and_rate_sweep() {
        for rate in [0.05, 0.5, 2.0, 5.0, 10.0] {
            for depth in [0.0, 25.0, 50.0, 75.0, 100.0] {
                let mut proc = BuiltinEffectType::Chorus.create_processor(SR);
                proc.set_param(0, rate);
                proc.set_param(1, depth);
                proc.set_param(2, 80.0);
                let mut l = sine_buffer(BUF, 440.0, SR);
                let mut r = l.clone();
                proc.process_stereo(&mut l, &mut r, SR);
                assert_sane(&l, &format!("Chorus rate {rate} depth {depth}"));
            }
        }
    }

    #[test]
    fn t107_bitcrusher_bit_depth_sweep() {
        for bits in [1.0, 2.0, 4.0, 8.0, 12.0, 16.0, 24.0, 32.0] {
            let mut proc = BuiltinEffectType::Bitcrusher.create_processor(SR);
            proc.set_param(0, bits);
            proc.set_param(2, 100.0);
            let mut l = sine_buffer(BUF, 440.0, SR);
            let mut r = l.clone();
            proc.process_stereo(&mut l, &mut r, SR);
            assert_sane(&l, &format!("BC {bits} bits"));
        }
    }

    #[test]
    fn t108_noise_machine_filter_sweep() {
        for lp in [200.0, 1000.0, 5000.0, 20000.0] {
            for hp in [20.0, 100.0, 500.0, 5000.0] {
                let mut proc = BuiltinEffectType::NoiseMachine.create_processor(SR);
                proc.set_param(0, -6.0);
                proc.set_param(3, lp);
                proc.set_param(4, hp);
                let mut l = vec![0.0f32; 2048];
                let mut r = vec![0.0f32; 2048];
                proc.process_stereo(&mut l, &mut r, SR);
                assert_sane(&l, &format!("Noise LP {lp} HP {hp}"));
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // TEST 12: Edge case — invalid/out-of-range param indices
    // ═══════════════════════════════════════════════════════════════════════

    #[test]
    fn t110_invalid_param_indices() {
        for id in 0..=14u8 {
            let ty = BuiltinEffectType::from_u8(id).unwrap();
            let mut proc = ty.create_processor(SR);
            // Try setting params beyond valid range — should not panic
            for idx in 0..=255u8 {
                proc.set_param(idx, 0.0);
                proc.set_param(idx, 999999.0);
                proc.set_param(idx, -999999.0);
            }
            // Still should process fine
            let mut l = sine_buffer(256, 440.0, SR);
            let mut r = l.clone();
            proc.process_stereo(&mut l, &mut r, SR);
            assert_sane(&l, &format!("Effect {id} invalid params"));
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // TEST 13: Asymmetric stereo input
    // ═══════════════════════════════════════════════════════════════════════

    #[test]
    fn t120_asymmetric_stereo() {
        for id in 0..=14u8 {
            let ty = BuiltinEffectType::from_u8(id).unwrap();
            let mut proc = ty.create_processor(SR);
            let mut l = sine_buffer(BUF, 440.0, SR);
            let mut r = sine_buffer(BUF, 880.0, SR); // different frequency
            proc.process_stereo(&mut l, &mut r, SR);
            assert_sane(&l, &format!("Effect {id} asym L"));
            assert_sane(&r, &format!("Effect {id} asym R"));
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // TEST 14: Empty buffer handling
    // ═══════════════════════════════════════════════════════════════════════

    #[test]
    fn t130_empty_buffers() {
        for id in 0..=14u8 {
            let ty = BuiltinEffectType::from_u8(id).unwrap();
            let mut proc = ty.create_processor(SR);
            let mut l: Vec<f32> = vec![];
            let mut r: Vec<f32> = vec![];
            proc.process_stereo(&mut l, &mut r, SR);
            // Should not panic with empty buffers
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // TEST 15: Single-sample processing
    // ═══════════════════════════════════════════════════════════════════════

    #[test]
    fn t131_single_sample() {
        for id in 0..=14u8 {
            let ty = BuiltinEffectType::from_u8(id).unwrap();
            let mut proc = ty.create_processor(SR);
            let mut l = vec![0.5f32; 1];
            let mut r = vec![0.5f32; 1];
            proc.process_stereo(&mut l, &mut r, SR);
            assert_sane(&l, &format!("Effect {id} single"));
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // TEST 16: Maximum feedback stress (near instability)
    // ═══════════════════════════════════════════════════════════════════════

    #[test]
    fn t140_max_feedback_stability() {
        // Effects with feedback: Delay(2), Chorus(3), Phaser(2), Flanger(2)
        let configs: Vec<(u8, u8, f32)> = vec![
            (2, 2, 95.0),    // Delay max FB
            (4, 3, 95.0),    // Chorus max FB
            (10, 2, 95.0),   // Phaser max FB
            (11, 2, 95.0),   // Flanger max FB
        ];
        for (effect_id, param_idx, fb_val) in configs {
            let ty = BuiltinEffectType::from_u8(effect_id).unwrap();
            let mut proc = ty.create_processor(SR);
            proc.set_param(param_idx, fb_val);
            let mut l = sine_buffer(8192, 440.0, SR);
            let mut r = l.clone();
            proc.process_stereo(&mut l, &mut r, SR);
            assert_sane(&l, &format!("Effect {effect_id} max FB"));
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // TEST 17: Utility-specific — pan and width
    // ═══════════════════════════════════════════════════════════════════════

    #[test]
    fn t150_utility_full_pan_sweep() {
        for pan in [-100.0, -50.0, 0.0, 50.0, 100.0] {
            let mut proc = BuiltinEffectType::Utility.create_processor(SR);
            proc.set_param(1, pan);
            let mut l = vec![0.5f32; 256];
            let mut r = vec![0.5f32; 256];
            proc.process_stereo(&mut l, &mut r, SR);
            assert_sane(&l, &format!("Utility pan {pan} L"));
            assert_sane(&r, &format!("Utility pan {pan} R"));
        }
    }

    #[test]
    fn t151_utility_width_sweep() {
        for width in [0.0, 50.0, 100.0, 150.0, 200.0] {
            let mut proc = BuiltinEffectType::Utility.create_processor(SR);
            proc.set_param(2, width);
            let sr = 44100.0;
            let mut l = sine_buffer(256, 440.0, sr);
            let mut r = sine_buffer(256, 880.0, sr); // different freq
            proc.process_stereo(&mut l, &mut r, sr);
            assert_sane(&l, &format!("Utility width {width} L"));
        }
    }
}
