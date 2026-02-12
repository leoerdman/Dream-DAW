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

struct ClipInstance {
    float4 rect; // x, y, width, height
    float4 color;
    float isSelected;
};

struct MidiNoteInstance {
    float4 rect;
    float4 color;
    float type; // 1.0 = Note
};

struct TimelineVertexOut {
    float4 position [[position]];
    float4 color;
    float2 localPos;
    float2 rectSize;
    float isSelected;
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
    out.isSelected = inst.isSelected;
    
    return out;
}

fragment float4 timeline_fragment(TimelineVertexOut in [[stage_in]]) {
    float2 pixelCoord = in.localPos * in.rectSize;
    float2 size = in.rectSize;
    float r = 4.0; // Corner radius
    float headerHeight = 22.0; // Professional DAW header height
    
    // Rounded corner SDF
    float2 d = abs(pixelCoord - size/2.0) - (size/2.0 - r);
    float dist = length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
    
    // Anti-aliasing for the outer edge
    float alpha = 1.0 - smoothstep(-0.5, 0.5, dist);
    if (alpha <= 0.01) discard_fragment();
    
    float4 color = in.color;
    bool isHeader = (pixelCoord.y < headerHeight);
    
    if (isHeader) {
        // --- HEADER AESTHETICS (Opaque) ---
        // Header is slightly darker or saturated for better readability
        color.rgb *= 1.15;
        color.a = 1.0;
        
        // Header separator line
        if (abs(pixelCoord.y - headerHeight) < 1.0) {
            color.rgb *= 0.7;
        }
    } else {
        // --- BODY AESTHETICS (Semi-Transparent 'Liquid Glass') ---
        color.a = 0.55; // High transparency for grid visibility
        
        // Subtle vertical gradient for body depth
        color.rgb *= (1.05 - in.localPos.y * 0.1);
    }
    
    // Highlight at the top of the header
    float highlight = smoothstep(1.5, 0.0, pixelCoord.y) * 0.2;
    color.rgb += highlight;
    
    // Border (Professional DAW outline)
    float borderSize = 1.0;
    if (dist > -borderSize) {
        float borderAlpha = smoothstep(-borderSize, -borderSize + 0.5, dist);
        float3 borderColor = mix(color.rgb * 1.6, float3(1.0), 0.25);
        color.rgb = mix(color.rgb, borderColor, borderAlpha);
        color.a = mix(color.a, 1.0, borderAlpha); // Opaque border
    }
    
    // Selection state (High Visibility)
    if (in.isSelected > 0.5) {
        if (dist > -2.0) {
            color.rgb = float3(1.0); 
            color.a = 1.0;
        } else {
            color.rgb = mix(color.rgb, float3(1.0), 0.3);
            color.a = mix(color.a, 1.0, 0.4);
        }
    }
    
    return float4(color.rgb, color.a * alpha);
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
    out.isSelected = 0.0;
    
    return out;
}

fragment float4 note_fragment(TimelineVertexOut in [[stage_in]]) {
    // Simple opaque notes for now, with a tiny border
    float3 color = in.color.rgb;
    
    // Horizontal highlight
    color *= (1.1 - in.localPos.y * 0.2);
    
    return float4(color, 1.0);
}
