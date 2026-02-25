
export const GRID_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_position;
out vec2 v_uv;
void main() {
    v_uv = vec2(a_position.x * 0.5 + 0.5, 1.0 - (a_position.y * 0.5 + 0.5));
    gl_Position = vec4(a_position, 0.0, 1.0);
}`;

export const GRID_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;

uniform vec2  u_resolution;     // physical pixels
uniform vec2  u_scroll;         // CSS pixels
uniform float u_dpr;            // devicePixelRatio
uniform float u_pixelsPerBeat;  // CSS pixels
uniform float u_noteHeight;     // CSS pixels
uniform float u_beatsPerBar;
uniform float u_gridInterval;
uniform float u_totalPitches;

uniform vec3 u_whiteRowColor;
uniform vec3 u_blackRowColor;
uniform vec3 u_rootRowColor;
uniform vec3 u_scaleRowColor;   // tint for in-scale (non-root) rows
uniform vec3 u_outScaleRowColor;// dimmed color for out-of-scale rows
uniform vec3 u_barLineColor;
uniform vec3 u_beatLineColor;
uniform vec3 u_subLineColor;
uniform vec3 u_cLineColor;

uniform float u_highlightScale;
uniform float u_scaleRoot;
uniform int   u_scaleNotes[12]; // 1 = in scale, 0 = out

bool isBlackKey(int note) {
    int n = note - (note / 12) * 12;
    if (n < 0) n += 12;
    return n==1 || n==3 || n==6 || n==8 || n==10;
}

bool isC(int note) {
    int n = note - (note / 12) * 12;
    if (n < 0) n += 12;
    return n == 0;
}

float aaLine(float phase, float thickness) {
    float halfT = thickness * 0.5;
    return 1.0 - smoothstep(0.0, halfT + 1.0, abs(phase - halfT));
}

void main() {
    vec2 fragCSS = v_uv * u_resolution / u_dpr;
    vec2 worldPos = fragCSS + u_scroll;

    float rowF = worldPos.y / u_noteHeight;
    int row = int(floor(rowF));
    int pitch = int(u_totalPitches) - 1 - row;
    float rowFrac = fract(rowF);

    vec3 rowColor;
    if (pitch < 0 || pitch >= int(u_totalPitches)) {
        rowColor = u_blackRowColor * 0.4;
    } else {
        bool black = isBlackKey(pitch);
        if (u_highlightScale > 0.5) {
            int pMod = pitch - (pitch / 12) * 12;
            if (pMod < 0) pMod += 12;
            bool isRoot = pMod == int(u_scaleRoot);
            bool inScale = u_scaleNotes[pMod] == 1;
            if (isRoot) {
                rowColor = u_rootRowColor;
            } else if (inScale) {
                rowColor = black ? u_scaleRowColor * 0.82 : u_scaleRowColor;
            } else {
                rowColor = u_outScaleRowColor;
            }
        } else {
            rowColor = black ? u_blackRowColor : u_whiteRowColor;
        }
    }

    float rowGrad = 1.0 - rowFrac * 0.08;
    rowColor *= rowGrad;

    float borderPx = 1.0 / u_noteHeight;
    bool isCLine = isC(pitch);
    float borderAlpha = 0.0;
    if (rowFrac > 1.0 - borderPx * 1.5) {
        borderAlpha = isCLine ? 0.50 : 0.16;
        borderAlpha *= smoothstep(1.0 - borderPx * 1.5, 1.0 - borderPx * 0.3, rowFrac);
    }
    vec3 borderColor = isCLine ? u_cLineColor : vec3(0.35, 0.36, 0.38);

    float ppb = u_pixelsPerBeat;

    float barSpacing = u_beatsPerBar * ppb;
    float barPhase = mod(worldPos.x, barSpacing);
    float barCore = aaLine(barPhase, 1.4) * 0.62;
    float barGlow = aaLine(barPhase, 4.0) * 0.06; // subtle glow around bar lines
    float barAlpha = barCore + barGlow;

    float beatPhase = mod(worldPos.x, ppb);
    float beatAlpha = aaLine(beatPhase, 0.9) * 0.25;

    float subSpacing = u_gridInterval * ppb;
    float subPhase = mod(worldPos.x, subSpacing);
    float subAlpha = subSpacing > 3.0 ? aaLine(subPhase, 0.5) * 0.10 : 0.0;

    float lineAlpha = max(barAlpha, max(beatAlpha, subAlpha));
    vec3 lineColor = barAlpha > beatAlpha
        ? (barAlpha > subAlpha ? u_barLineColor : u_subLineColor)
        : (beatAlpha > subAlpha ? u_beatLineColor : u_subLineColor);

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

uniform vec2  u_resolution;     // physical pixels
uniform vec2  u_scroll;         // CSS pixels
uniform float u_dpr;
uniform float u_pixelsPerBeat;  // CSS pixels
uniform float u_noteHeight;     // CSS pixels
uniform float u_totalPitches;

out vec2  v_localUV;
out float v_velocity;
out float v_selected;
out float v_ghost;
out vec2  v_noteSize;   // physical pixels

void main() {
    float worldX = a_startBeat * u_pixelsPerBeat;
    float row = u_totalPitches - 1.0 - a_pitch;
    float worldY = row * u_noteHeight;

    float noteW_css = max(4.0, a_duration * u_pixelsPerBeat - 1.0);
    float noteH_css = u_noteHeight - 2.0;

    float x_css = worldX + a_quadPos.x * noteW_css - u_scroll.x;
    float y_css = worldY + 1.0 + a_quadPos.y * noteH_css - u_scroll.y;

    float x_phys = x_css * u_dpr;
    float y_phys = y_css * u_dpr;
    vec2 clipPos = vec2(
        x_phys / u_resolution.x * 2.0 - 1.0,
        1.0 - y_phys / u_resolution.y * 2.0
    );
    gl_Position = vec4(clipPos, 0.0, 1.0);

    v_localUV = a_quadPos;
    v_velocity = a_velocity;
    v_noteSize = vec2(noteW_css * u_dpr, noteH_css * u_dpr); // physical px for SDF

    int flags = int(a_flags);
    v_selected = float(flags & 1);
    v_ghost = float((flags >> 1) & 1);
}`;

export const NOTE_FS = `#version 300 es
precision highp float;
in vec2  v_localUV;
in float v_velocity;
in float v_selected;
in float v_ghost;
in vec2  v_noteSize;    // physical pixels
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
    float radius = min(4.0, min(halfSize.x, halfSize.y) * 0.45);

    float dist = sdfRoundedRect(pixelPos - center, halfSize, radius);
    float mask = 1.0 - smoothstep(-1.0, 0.8, dist);
    if (mask < 0.01) discard;

    if (v_ghost > 0.5) {
        vec3 ghostColor = vec3(0.55, 0.65, 0.85);
        float ghostAlpha = 0.14 * mask;
        float outlineDist = sdfRoundedRect(pixelPos - center, halfSize - vec2(1.0), max(0.0, radius - 0.5));
        float outline = (1.0 - smoothstep(-1.0, 0.5, outlineDist)) * smoothstep(-1.0, 0.5, dist + 1.5);
        ghostColor = mix(ghostColor, vec3(0.7, 0.8, 1.0), outline * 0.4);
        ghostAlpha += outline * 0.08;
        fragColor = vec4(ghostColor, ghostAlpha);
        return;
    }

    float velNorm = v_velocity / 127.0;
    float alpha = 0.25 + velNorm * 0.75;

    vec3 baseColor = u_noteColor;
    vec3 brightColor = baseColor * 1.3 + vec3(0.08);      // Push brighter for high velocity
    vec3 dimColor = baseColor * 0.6 + vec3(0.03, 0.03, 0.05); // Cooler/dimmer for low velocity
    vec3 color = mix(dimColor, brightColor, velNorm);

    float vertGrad = v_localUV.y;
    float topHighlight = smoothstep(0.0, 0.25, 1.0 - vertGrad) * 0.30;
    float bottomShadow = smoothstep(0.7, 1.0, vertGrad) * 0.25;
    color = mix(color, vec3(1.0), topHighlight * velNorm);
    color = mix(color, vec3(0.0), bottomShadow);

    float leftHL = smoothstep(3.0, 0.0, pixelPos.x) * 0.15;
    color = mix(color, vec3(1.0), leftHL * velNorm);

    // Always-visible outline: gray normally, white when selected.
    float outlineOuter = sdfRoundedRect(pixelPos - center, halfSize - vec2(0.0), radius);
    float outlineInner = sdfRoundedRect(pixelPos - center, halfSize - vec2(2.0), max(0.0, radius - 1.0));
    float outline = (1.0 - smoothstep(-1.0, 0.5, outlineOuter)) * smoothstep(-1.0, 0.5, outlineInner);
    vec3 outlineColor = mix(vec3(0.72), vec3(1.0), v_selected > 0.5 ? 1.0 : 0.0);
    float outlineStrength = mix(0.72, 0.98, v_selected > 0.5 ? 1.0 : 0.0);
    color = mix(color, outlineColor, outline * outlineStrength);
    alpha = max(alpha, outline * 0.9);

    if (v_selected > 0.5) {
        float outerDist = sdfRoundedRect(pixelPos - center, halfSize - vec2(0.0), radius);
        float innerDist = sdfRoundedRect(pixelPos - center, halfSize - vec2(3.0), max(0.0, radius - 1.5));
        float border = (1.0 - smoothstep(-1.5, 0.5, outerDist)) * smoothstep(-1.5, 0.5, innerDist);

        vec3 selColor = vec3(0.85, 0.92, 1.0);
        color = mix(color, selColor, border * 0.92);
        alpha = mix(alpha, 1.0, border * 0.85);

        float innerGlow = exp(-max(0.0, -dist) * 0.15) * 0.12;
        color += selColor * innerGlow;
    }

    fragColor = vec4(color, alpha * mask);
}`;

export const PLAYHEAD_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_position;
out vec2 v_uv;
void main() {
    v_uv = vec2(a_position.x * 0.5 + 0.5, 1.0 - (a_position.y * 0.5 + 0.5));
    gl_Position = vec4(a_position, 0.0, 1.0);
}`;

export const PLAYHEAD_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;

uniform float u_playheadX; // CSS pixels (already scroll-adjusted)
uniform vec2  u_resolution;
uniform float u_dpr;

void main() {
    float fragX_css = v_uv.x * u_resolution.x / u_dpr;
    float dist = abs(fragX_css - u_playheadX);

    float coreMask = 1.0 - smoothstep(0.0, 1.0, dist);

    float innerGlow = exp(-dist * dist * 0.15) * 0.55;

    float outerBloom = exp(-dist * 0.22) * 0.20;

    float totalAlpha = min(1.0, coreMask * 0.97 + innerGlow + outerBloom);
    if (totalAlpha < 0.004) discard;

    vec3 coreColor = vec3(1.0, 1.0, 1.0);
    vec3 glowColor = vec3(0.82, 0.88, 1.0);
    float colorMix = smoothstep(0.0, 6.0, dist);
    vec3 color = mix(coreColor, glowColor, colorMix);

    fragColor = vec4(color, totalAlpha);
}`;
