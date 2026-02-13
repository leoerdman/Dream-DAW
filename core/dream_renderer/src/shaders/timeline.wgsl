// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Timeline Clip Shader (WGSL)
// ═══════════════════════════════════════════════════════════════════════════
//
// Ported from WaveformShaders.metal to WGSL for cross-platform WebGPU.
//
// Features:
//   - Instanced clip rendering via storage buffer
//   - SDF rounded rectangles with hardware anti-aliasing
//   - Waveform peak visualization (GPU-side interpolation)
//   - Selection glow, phantom/muted states
//   - Liquid Glass aesthetics (gradient, top highlight)
//
// Bind Groups:
//   @group(0) @binding(0): viewport uniforms
//   @group(0) @binding(1): clip instances (storage)
//   @group(0) @binding(2): waveform peaks (storage)
//
// ═══════════════════════════════════════════════════════════════════════════

// ── Structs ────────────────────────────────────────────────────────────

struct ViewportUniforms {
    viewport_size: vec4<f32>, // xy = width, height
};

struct ClipInstance {
    rect: vec4<f32>,         // x, y, width, height (screen px)
    color: vec4<f32>,        // rgba
    state_flags: vec4<f32>,  // x: selected, y: phantom, z: corner_r, w: muted
    waveform_offset: i32,
    waveform_count: i32,
    is_midi: f32,
    _padding: f32,
};

struct VertexOut {
    @builtin(position) position: vec4<f32>,
    @location(0) color: vec4<f32>,
    @location(1) local_pos: vec2<f32>,
    @location(2) rect_size: vec2<f32>,
    @location(3) state_flags: vec4<f32>,
    @location(4) is_midi: f32,
    @location(5) @interpolate(flat) waveform_offset: i32,
    @location(6) @interpolate(flat) waveform_count: i32,
};

// ── Bindings ───────────────────────────────────────────────────────────

@group(0) @binding(0) var<uniform> viewport: ViewportUniforms;
@group(0) @binding(1) var<storage, read> clips: array<ClipInstance>;
@group(0) @binding(2) var<storage, read> waveform_peaks: array<f32>;

// ── Vertex Shader ──────────────────────────────────────────────────────

@vertex
fn vs_main(
    @builtin(vertex_index) vid: u32,
    @builtin(instance_index) iid: u32,
) -> VertexOut {
    let inst = clips[iid];
    let rect_pos = inst.rect.xy;
    let rect_size = inst.rect.zw;

    // Triangle strip quad: 0=TL, 1=TR, 2=BL, 3=BR
    var quad_pos: vec2<f32>;
    switch vid {
        case 0u: { quad_pos = vec2<f32>(0.0, 0.0); }
        case 1u: { quad_pos = vec2<f32>(1.0, 0.0); }
        case 2u: { quad_pos = vec2<f32>(0.0, 1.0); }
        default: { quad_pos = vec2<f32>(1.0, 1.0); }
    }

    let pixel_pos = rect_pos + quad_pos * rect_size;

    // Convert pixel coords → NDC (-1..1, Y flipped for WebGPU)
    var ndc = (pixel_pos / viewport.viewport_size.xy) * 2.0 - 1.0;
    ndc.y = -ndc.y;

    var out: VertexOut;
    out.position = vec4<f32>(ndc, 0.0, 1.0);
    out.color = inst.color;
    out.local_pos = quad_pos;
    out.rect_size = rect_size;
    out.state_flags = inst.state_flags;
    out.is_midi = inst.is_midi;
    out.waveform_offset = inst.waveform_offset;
    out.waveform_count = inst.waveform_count;

    return out;
}

// ── Fragment Shader ────────────────────────────────────────────────────

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
    let pixel_coord = in.local_pos * in.rect_size;
    let size = in.rect_size;
    let r = select(5.0, in.state_flags.z, in.state_flags.z > 0.0);
    let header_height = 22.0;

    // ── 1. SDF Rounded Rectangle (Inigo Quilez) ────────────────────
    let d = abs(pixel_coord - size / 2.0) - (size / 2.0 - r);
    let dist = length(max(d, vec2<f32>(0.0))) + min(max(d.x, d.y), 0.0) - r;

    // Hardware anti-aliasing
    let alpha_mask = 1.0 - smoothstep(-0.5, 0.5, dist);
    if alpha_mask <= 0.01 {
        discard;
    }

    var color = in.color;

    // ── 2. Phantom State ───────────────────────────────────────────
    if in.state_flags.y > 0.5 {
        color.a *= 0.45;
    }

    // ── 3. Muted State ────────────────────────────────────────────
    if in.state_flags.w > 0.5 {
        let gray = dot(color.rgb, vec3<f32>(0.299, 0.587, 0.114));
        color = vec4<f32>(mix(color.rgb, vec3<f32>(gray), 0.8) * 0.5, color.a);
    }

    let is_header = pixel_coord.y < header_height;

    if is_header {
        // ── Header Aesthetics ──────────────────────────────────────
        color = vec4<f32>(color.rgb * 1.15, color.a);
        if in.state_flags.y < 0.5 {
            color.a = 1.0;
        }
        if abs(pixel_coord.y - header_height) < 1.0 {
            color = vec4<f32>(color.rgb * 0.7, color.a);
        }
    } else {
        // ── Body Aesthetics (Liquid Glass) ─────────────────────────
        if in.state_flags.y < 0.5 {
            color.a *= 0.65;
        }
        color = vec4<f32>(color.rgb * (1.05 - in.local_pos.y * 0.1), color.a);

        // ── Waveform Rendering ─────────────────────────────────────
        if in.is_midi < 0.5 && in.waveform_offset >= 0 {
            let norm_x = in.local_pos.x;
            let sample_idx = norm_x * f32(in.waveform_count - 1);
            let idx_l = i32(floor(sample_idx));
            let idx_r = i32(ceil(sample_idx));
            let frac = sample_idx - f32(idx_l);

            let peak_l = waveform_peaks[in.waveform_offset + idx_l];
            let peak_r = waveform_peaks[in.waveform_offset + idx_r];
            let peak = mix(peak_l, peak_r, frac);

            let body_y = (pixel_coord.y - header_height) / (size.y - header_height);
            let dist_to_center = abs(body_y - 0.5) * 2.0;

            if dist_to_center < peak {
                let intensity = 1.0 - smoothstep(peak - 0.15, peak, dist_to_center);
                let wave_color = mix(color.rgb, vec3<f32>(1.0), 0.4);
                color = vec4<f32>(mix(color.rgb, wave_color, intensity), mix(color.a, 0.9, intensity));
            }
        }
    }

    // ── Top Highlight ──────────────────────────────────────────────
    let top_highlight = smoothstep(1.5, 0.0, pixel_coord.y) * 0.25;
    color = vec4<f32>(color.rgb + top_highlight, color.a);

    // ── 4. Selection Glow ──────────────────────────────────────────
    if in.state_flags.x > 0.5 {
        let border_dist = abs(dist);
        let border_glow = 1.0 - smoothstep(0.0, 2.0, border_dist);
        color = vec4<f32>(
            mix(color.rgb, vec3<f32>(1.0), border_glow * 0.9),
            mix(color.a, 1.0, border_glow),
        );
    } else {
        let border_dist = abs(dist);
        if border_dist < 1.0 {
            color = vec4<f32>(color.rgb * 1.4, 1.0);
        }
    }

    return vec4<f32>(color.rgb, color.a * alpha_mask);
}
