#include <metal_stdlib>
using namespace metal;

struct VertexIn {
    float2 position;
};

struct VertexOut {
    float4 position [[position]];
    float4 color;
};

struct WaveformUniforms {
    float4x4 projectionMatrix;
    float4 baseColor;
    float verticalScale;
};

vertex VertexOut waveform_vertex(const device VertexIn* vertices [[buffer(0)]],
                                 constant WaveformUniforms& uniforms [[buffer(1)]],
                                 uint vid [[vertex_id]]) {
    VertexOut out;
    float4 pos = float4(vertices[vid].position, 0.0, 1.0);
    out.position = uniforms.projectionMatrix * pos;
    out.color = uniforms.baseColor;
    return out;
}

// --- Timeline Rendering (Batch Clips) ---

// --- Timeline Rendering (Batch Clips) ---

struct ClipInstance {
    float4 rect;        // x, y, width, height (screen pixels)
    float4 color;       // RGBA
    float4 stateFlags;  // x: isSelected, y: isPhantom, z: cornerRadius, w: isMuted
    int waveformOffset;
    int waveformCount;
    float isMidi;
    float padding;
};

struct MidiNoteInstance {
    float4 rect;
    float4 color;
    float2 stateFlags; // x: type (1.0=note), y: isSelected
};

struct TimelineVertexOut {
    float4 position [[position]];
    float4 color;
    float2 localPos;
    float2 rectSize;
    float4 stateFlags;
    float isMidi;
    int waveformOffset;
    int waveformCount;
};

vertex TimelineVertexOut timeline_vertex(uint vid [[vertex_id]],
                                         uint iid [[instance_id]],
                                         constant ClipInstance* instances [[buffer(0)]],
                                         constant float2& viewport [[buffer(1)]]) {
    ClipInstance inst = instances[iid];
    float2 rectPos = inst.rect.xy;
    float2 rectSize = inst.rect.zw;
    
    // Triangle Strip positions (0: TL, 1: TR, 2: BL, 3: BR)
    float2 quadPos;
    if (vid == 0) quadPos = float2(0, 0);
    else if (vid == 1) quadPos = float2(1, 0);
    else if (vid == 2) quadPos = float2(0, 1);
    else quadPos = float2(1, 1);
    
    float2 pixelPos = rectPos + quadPos * rectSize;
    
    // Convert to NDC (-1 to 1, Y inverted for Metal)
    float2 ndc = (pixelPos / viewport) * 2.0 - 1.0;
    ndc.y = -ndc.y; 
    
    TimelineVertexOut out;
    out.position = float4(ndc, 0.0, 1.0);
    out.color = inst.color;
    out.localPos = quadPos;
    out.rectSize = rectSize;
    out.stateFlags = inst.stateFlags;
    out.isMidi = inst.isMidi;
    out.waveformOffset = inst.waveformOffset;
    out.waveformCount = inst.waveformCount;
    
    return out;
}

fragment float4 timeline_fragment(TimelineVertexOut in [[stage_in]],
                                 const device float* waveformPeaks [[buffer(2)]]) {
    float2 pixelCoord = in.localPos * in.rectSize;
    float2 size = in.rectSize;
    float r = in.stateFlags.z > 0.0 ? in.stateFlags.z : 5.0; // Dynamic corner radius
    float headerHeight = 22.0; 
    
    // 1. SDF Rounded Rectangle (Inigo Quilez)
    float2 d = abs(pixelCoord - size/2.0) - (size/2.0 - r);
    float dist = length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
    
    // 2. Hardware Anti-Aliasing
    float alphaMask = 1.0 - smoothstep(-0.5, 0.5, dist);
    if (alphaMask <= 0.01) discard_fragment();
    
    float4 color = in.color;
    
    // 3. Phantom State (isPhantom == 1.0)
    if (in.stateFlags.y > 0.5) {
        color.a *= 0.45;
    }
    
    // 4. Muted State (isMuted == 1.0)
    if (in.stateFlags.w > 0.5) {
        float gray = dot(color.rgb, float3(0.299, 0.587, 0.114));
        color.rgb = mix(color.rgb, float3(gray), 0.8) * 0.5;
    }
    
    bool isHeader = (pixelCoord.y < headerHeight);
    
    if (isHeader) {
        // --- HEADER AESTHETICS ---
        color.rgb *= 1.15;
        // Keep header more opaque unless it's a phantom
        if (in.stateFlags.y < 0.5) color.a = 1.0; 
        if (abs(pixelCoord.y - headerHeight) < 1.0) color.rgb *= 0.7;
    } else {
        // --- BODY AESTHETICS (Liquid Glass) ---
        if (in.stateFlags.y < 0.5) color.a *= 0.65;
        color.rgb *= (1.05 - in.localPos.y * 0.1);
        
        // --- WAVEFORM RENDERING ---
        if (in.isMidi < 0.5 && in.waveformOffset >= 0) {
            float normX = in.localPos.x;
            float sampleIdx = normX * (float(in.waveformCount) - 1.0);
            int idxL = int(floor(sampleIdx));
            int idxR = int(ceil(sampleIdx));
            float frac = sampleIdx - float(idxL);
            
            float peakL = waveformPeaks[in.waveformOffset + idxL];
            float peakR = waveformPeaks[in.waveformOffset + idxR];
            float peak = mix(peakL, peakR, frac);
            
            float bodyY = (pixelCoord.y - headerHeight) / (size.y - headerHeight);
            float distToCenter = abs(bodyY - 0.5) * 2.0; 
            
            if (distToCenter < peak) {
                float intensity = 1.0 - smoothstep(peak - 0.15, peak, distToCenter);
                float3 waveColor = mix(color.rgb, float3(1.0), 0.4);
                color.rgb = mix(color.rgb, waveColor, intensity);
                color.a = mix(color.a, 0.9, intensity);
            }
        }
    }
    
    // Highlight at the top
    float topHighlight = smoothstep(1.5, 0.0, pixelCoord.y) * 0.25;
    color.rgb += topHighlight;
    
    // 5. Selection Neon Inner Glow (isSelected == 1.0)
    if (in.stateFlags.x > 0.5) {
        // Draw white border inside
        float borderDist = abs(dist);
        float borderGlow = 1.0 - smoothstep(0.0, 2.0, borderDist);
        color.rgb = mix(color.rgb, float3(1.0), borderGlow * 0.9);
        color.a = mix(color.a, 1.0, borderGlow);
    } else {
        // Subtle regular border
        float borderDist = abs(dist);
        if (borderDist < 1.0) {
            color.rgb *= 1.4;
            color.a = 1.0;
        }
    }
    
    return float4(color.rgb, color.a * alphaMask);
}


// --- Note Rendering (MIDI) ---

vertex TimelineVertexOut note_vertex(uint vid [[vertex_id]],
                                    uint iid [[instance_id]],
                                    constant MidiNoteInstance* instances [[buffer(0)]],
                                    constant float2& viewport [[buffer(1)]]) {
    MidiNoteInstance inst = instances[iid];
    float2 rectPos = inst.rect.xy;
    float2 rectSize = inst.rect.zw;
    
    float2 quadPos;
    if (vid == 0) quadPos = float2(0, 0);
    else if (vid == 1) quadPos = float2(1, 0);
    else if (vid == 2) quadPos = float2(0, 1);
    else quadPos = float2(1, 1);
    
    float2 pixelPos = rectPos + quadPos * rectSize;
    float2 ndc = (pixelPos / viewport) * 2.0 - 1.0;
    ndc.y = -ndc.y; 
    
    TimelineVertexOut out;
    out.position = float4(ndc, 0.0, 1.0);
    out.color = inst.color;
    out.localPos = quadPos;
    out.rectSize = rectSize;
    out.stateFlags = float4(inst.stateFlags.y, 0.0, 5.0, 0.0); // x: isSelected, z: cornerRadius
    
    return out;
}

fragment float4 note_fragment(TimelineVertexOut in [[stage_in]]) {
    float3 color = in.color.rgb;
    
    // Selection highlight
    if (in.stateFlags.x > 0.5) {
        color = mix(color, float3(1.0), 0.4);
    }
    
    // Horizontal highlight
    color *= (1.1 - in.localPos.y * 0.2);
    
    return float4(color, 1.0);
}
