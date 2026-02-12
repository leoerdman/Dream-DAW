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

struct TimelineVertexOut {
    float4 position [[position]];
    float4 color;
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
    
    float4 color = inst.color;
    if (inst.isSelected > 0.5) {
        color.rgb = mix(color.rgb, float3(1.0), 0.3); // Brighten selected
    }
    out.color = color;
    
    return out;
}

fragment float4 timeline_fragment(TimelineVertexOut in [[stage_in]]) {
    return in.color;
}
