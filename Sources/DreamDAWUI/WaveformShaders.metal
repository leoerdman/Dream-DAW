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

fragment float4 waveform_fragment(VertexOut in [[stage_in]]) {
    return in.color;
}
