export const GRID_VS = `#version 300 es
precision highp float;
out vec2 v_uv;
void main() {
    float x = float((gl_VertexID & 1) << 2) - 1.0;
    float y = float((gl_VertexID & 2) << 1) - 1.0;
    v_uv = vec2(x * 0.5 + 0.5, 1.0 - (y * 0.5 + 0.5));
    gl_Position = vec4(x, y, 0.0, 1.0);
}`;

export const GRID_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform vec2 u_resolution;
uniform vec2 u_scroll;
uniform float u_pixelsPerBeat;
uniform float u_noteHeight;
uniform float u_beatsPerBar;
uniform float u_gridInterval;
uniform float u_totalPitches;
uniform vec3 u_whiteRowColor;
uniform vec3 u_blackRowColor;
uniform vec3 u_rootRowColor;
uniform vec3 u_barLineColor;
uniform vec3 u_beatLineColor;
uniform vec3 u_subLineColor;
uniform vec3 u_cLineColor;
uniform float u_highlightScale;
uniform float u_scaleRoot;
bool isBlackKey(int note) {
    int n = note - (note / 12) * 12;
    if (n < 0) n += 12;
    return n == 1 || n == 3 || n == 6 || n == 8 || n == 10;
}
bool isC(int note) {
    int n = note - (note / 12) * 12;
    if (n < 0) n += 12;
    return n == 0;
}
void main() {
    vec2 worldPos = v_uv * u_resolution + u_scroll;
    float rowF = worldPos.y / u_noteHeight;
    int row = int(floor(rowF));
    int pitch = int(u_totalPitches) - 1 - row;
    vec3 rowColor;
    if (pitch < 0 || pitch >= int(u_totalPitches)) {
        rowColor = u_blackRowColor * 0.5;
    } else {
        bool black = isBlackKey(pitch);
        if (u_highlightScale > 0.5) {
            int pMod = pitch - (pitch / 12) * 12;
            if (pMod < 0) pMod += 12;
            bool isRoot = pMod == int(u_scaleRoot);
            rowColor = isRoot ? u_rootRowColor : (black ? u_blackRowColor : u_whiteRowColor);
        } else {
            rowColor = black ? u_blackRowColor : u_whiteRowColor;
        }
    }
    float rowFrac = fract(rowF);
    float borderThickness = 1.0 / u_noteHeight;
    bool isCLine = isC(pitch);
    float borderAlpha = 0.0;
    if (rowFrac > 1.0 - borderThickness) borderAlpha = isCLine ? 0.35 : 0.12;
    vec3 borderColor = isCLine ? u_cLineColor : vec3(0.4);
    float barPhase = mod(worldPos.x, u_beatsPerBar * u_pixelsPerBeat);
    float barAlpha = barPhase < 1.0 ? 0.5 : 0.0;
    float beatPhase = mod(worldPos.x, u_pixelsPerBeat);
    float beatAlpha = beatPhase < 0.65 ? 0.18 : 0.0;
    float subPhase = mod(worldPos.x, u_gridInterval * u_pixelsPerBeat);
    float subAlpha = subPhase < 0.45 ? 0.08 : 0.0;
    float lineAlpha = max(barAlpha, max(beatAlpha, subAlpha));
    vec3 lineColor = barAlpha > 0.0 ? u_barLineColor : (beatAlpha > 0.0 ? u_beatLineColor : u_subLineColor);
    vec3 color = mix(rowColor, borderColor, borderAlpha);
    color = mix(color, lineColor, lineAlpha);
    fragColor = vec4(color, 1.0);
}`;

export const NOTE_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_quadPos;
layout(location = 1) in float a_startBeat;
layout(location = 2) in float a_pitch;
layout(location = 3) in float a_duration;
layout(location = 4) in float a_velocity;
layout(location = 5) in float a_flags;
uniform vec2 u_resolution;
uniform vec2 u_scroll;
uniform float u_pixelsPerBeat;
uniform float u_noteHeight;
uniform float u_totalPitches;
out vec2 v_localUV;
out float v_velocity;
out float v_selected;
out float v_ghost;
out vec2 v_noteSize;
void main() {
    float worldX = a_startBeat * u_pixelsPerBeat;
    float row = u_totalPitches - 1.0 - a_pitch;
    float worldY = row * u_noteHeight;
    float noteW = max(4.0, a_duration * u_pixelsPerBeat - 1.0);
    float noteH = u_noteHeight - 2.0;
    float x = worldX + a_quadPos.x * noteW - u_scroll.x;
    float y = worldY + 1.0 + a_quadPos.y * noteH - u_scroll.y;
    vec2 clipPos = vec2(x / u_resolution.x * 2.0 - 1.0, 1.0 - y / u_resolution.y * 2.0);
    gl_Position = vec4(clipPos, 0.0, 1.0);
    v_localUV = a_quadPos;
    v_velocity = a_velocity;
    v_noteSize = vec2(noteW, noteH);
    int flags = int(a_flags);
    v_selected = float(flags & 1);
    v_ghost = float((flags >> 1) & 1);
}`;

export const NOTE_FS = `#version 300 es
precision highp float;
in vec2 v_localUV;
in float v_velocity;
in float v_selected;
in float v_ghost;
in vec2 v_noteSize;
uniform vec3 u_noteColor;
out vec4 fragColor;
float sdfRoundedRect(vec2 p, vec2 halfSize, float r) {
    vec2 d = abs(p) - halfSize + vec2(r);
    return length(max(d, vec2(0.0))) + min(max(d.x, d.y), 0.0) - r;
}
void main() {
    vec2 pixelPos = v_localUV * v_noteSize;
    vec2 center = v_noteSize * 0.5;
    vec2 halfSize = center;
    float radius = min(2.0, min(halfSize.x, halfSize.y) * 0.5);
    float dist = sdfRoundedRect(pixelPos - center, halfSize, radius);
    float mask = 1.0 - smoothstep(-1.0, 1.0, dist);
    if (mask < 0.01) discard;
    if (v_ghost > 0.5) {
        fragColor = vec4(0.616, 0.698, 0.839, 0.17 * mask);
        return;
    }
    float alpha = 0.15 + (v_velocity / 127.0) * 0.85;
    vec3 color = u_noteColor;
    float topHighlight = 0.0;
    if (pixelPos.y < 1.5 && pixelPos.x > 1.0 && pixelPos.x < v_noteSize.x - 1.0) topHighlight = 0.35;
    color = mix(color, vec3(1.0), topHighlight);
    if (v_selected > 0.5) {
        float outerDist = sdfRoundedRect(pixelPos - center, halfSize - vec2(0.5), radius);
        float innerDist = sdfRoundedRect(pixelPos - center, halfSize - vec2(2.0), radius - 0.5);
        float border = (1.0 - smoothstep(-1.0, 0.0, outerDist)) * smoothstep(-1.0, 0.0, innerDist);
        color = mix(color, vec3(1.0), border * 0.9);
        alpha = mix(alpha, 1.0, border * 0.9);
    }
    fragColor = vec4(color, alpha * mask);
}`;

export const PLAYHEAD_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_pos;
uniform float u_playheadX;
uniform vec2 u_resolution;
void main() {
    float x = (u_playheadX + a_pos.x * 2.0) / u_resolution.x * 2.0 - 1.0;
    float y = 1.0 - a_pos.y / u_resolution.y * 2.0;
    gl_Position = vec4(x, y, 0.0, 1.0);
}`;

export const PLAYHEAD_FS = `#version 300 es
precision highp float;
out vec4 fragColor;
void main() {
    fragColor = vec4(1.0, 1.0, 1.0, 0.95);
}`;
