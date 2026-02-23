// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — PianoRoll GLSL Shaders (WebGL2)
// ═══════════════════════════════════════════════════════════════════════════
//
// All shaders receive CSS-pixel uniforms (scroll, ppb, noteHeight) and
// a u_dpr uniform. Physical-pixel conversion is done inside the shader
// so the host can pass values directly from React without pre-scaling.
//
// Grid: procedural fragment shader — infinite precision at any zoom.
// Notes: hardware-instanced SDF rounded rectangles.
// Playhead: fullscreen quad with glow falloff.
// ═══════════════════════════════════════════════════════════════════════════

// ── Grid ────────────────────────────────────────────────────────────────

export const GRID_VS = `#version 300 es
precision highp float;
out vec2 v_uv;
void main() {
    // Fullscreen triangle trick: 3 verts cover [-1,1]² without a VBO
    float x = float((gl_VertexID & 1) << 2) - 1.0;
    float y = float((gl_VertexID & 2) << 1) - 1.0;
    v_uv = vec2(x * 0.5 + 0.5, 1.0 - (y * 0.5 + 0.5));
    gl_Position = vec4(x, y, 0.0, 1.0);
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

// Anti-aliased line: returns [0,1] coverage for a line at phase=0 with given thickness
float aaLine(float phase, float thickness) {
    float halfT = thickness * 0.5;
    return 1.0 - smoothstep(0.0, halfT + 1.0, abs(phase - halfT));
}

void main() {
    // Convert fragment position to CSS-pixel world coordinates
    vec2 fragCSS = v_uv * u_resolution / u_dpr;
    vec2 worldPos = fragCSS + u_scroll;

    // ── Row coloring ──
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
            bool inScale = u_scaleNotes[pMod] == 1;
            if (isRoot) {
                rowColor = u_rootRowColor;
            } else if (inScale) {
                rowColor = black ? u_scaleRowColor * 0.85 : u_scaleRowColor;
            } else {
                rowColor = u_outScaleRowColor;
            }
        } else {
            rowColor = black ? u_blackRowColor : u_whiteRowColor;
        }
    }

    // ── Horizontal row borders (anti-aliased) ──
    float rowFrac = fract(rowF);
    float borderPx = 1.0 / u_noteHeight;
    bool isCLine = isC(pitch);
    float borderAlpha = 0.0;
    if (rowFrac > 1.0 - borderPx * 1.5) {
        borderAlpha = isCLine ? 0.40 : 0.14;
        borderAlpha *= smoothstep(1.0 - borderPx * 1.5, 1.0 - borderPx * 0.3, rowFrac);
    }
    vec3 borderColor = isCLine ? u_cLineColor : vec3(0.4);

    // ── Vertical grid lines (anti-aliased via smoothstep) ──
    float ppb = u_pixelsPerBeat;

    // Bar lines
    float barSpacing = u_beatsPerBar * ppb;
    float barPhase = mod(worldPos.x, barSpacing);
    float barAlpha = aaLine(barPhase, 1.2) * 0.55;

    // Beat lines
    float beatPhase = mod(worldPos.x, ppb);
    float beatAlpha = aaLine(beatPhase, 0.8) * 0.22;

    // Subdivision lines
    float subSpacing = u_gridInterval * ppb;
    float subPhase = mod(worldPos.x, subSpacing);
    float subAlpha = subSpacing > 3.0 ? aaLine(subPhase, 0.5) * 0.10 : 0.0;

    // Composite: bar wins over beat wins over sub
    float lineAlpha = max(barAlpha, max(beatAlpha, subAlpha));
    vec3 lineColor = barAlpha > beatAlpha
        ? (barAlpha > subAlpha ? u_barLineColor : u_subLineColor)
        : (beatAlpha > subAlpha ? u_beatLineColor : u_subLineColor);

    // ── Compose ──
    vec3 color = mix(rowColor, borderColor, borderAlpha);
    color = mix(color, lineColor, lineAlpha);
    fragColor = vec4(color, 1.0);
}`;

// ── Notes ───────────────────────────────────────────────────────────────

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
    // All math in CSS pixels, then convert to physical at the end
    float worldX = a_startBeat * u_pixelsPerBeat;
    float row = u_totalPitches - 1.0 - a_pitch;
    float worldY = row * u_noteHeight;

    float noteW_css = max(4.0, a_duration * u_pixelsPerBeat - 1.0);
    float noteH_css = u_noteHeight - 2.0;

    float x_css = worldX + a_quadPos.x * noteW_css - u_scroll.x;
    float y_css = worldY + 1.0 + a_quadPos.y * noteH_css - u_scroll.y;

    // Convert to NDC using physical resolution
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
    float radius = min(3.0, min(halfSize.x, halfSize.y) * 0.5);

    float dist = sdfRoundedRect(pixelPos - center, halfSize, radius);
    float mask = 1.0 - smoothstep(-1.0, 1.0, dist);
    if (mask < 0.01) discard;

    // ── Ghost notes ──
    if (v_ghost > 0.5) {
        fragColor = vec4(0.616, 0.698, 0.839, 0.17 * mask);
        return;
    }

    // ── Velocity → alpha gradient ──
    float velNorm = v_velocity / 127.0;
    float alpha = 0.15 + velNorm * 0.85;
    vec3 color = u_noteColor;

    // Top highlight (specular-like edge reflection)
    if (pixelPos.y < 2.0 && pixelPos.x > 1.5 && pixelPos.x < v_noteSize.x - 1.5) {
        float highlightStrength = 0.35 * smoothstep(2.0, 0.0, pixelPos.y);
        color = mix(color, vec3(1.0), highlightStrength);
    }

    // Bottom shadow
    if (pixelPos.y > v_noteSize.y - 1.5) {
        float shadowStrength = 0.15 * smoothstep(v_noteSize.y - 1.5, v_noteSize.y, pixelPos.y);
        color = mix(color, vec3(0.0), shadowStrength);
    }

    // ── Selection border ──
    if (v_selected > 0.5) {
        float outerDist = sdfRoundedRect(pixelPos - center, halfSize - vec2(0.5), radius);
        float innerDist = sdfRoundedRect(pixelPos - center, halfSize - vec2(2.5), max(0.0, radius - 1.0));
        float border = (1.0 - smoothstep(-1.0, 0.0, outerDist)) * smoothstep(-1.0, 0.0, innerDist);
        color = mix(color, vec3(1.0), border * 0.9);
        alpha = mix(alpha, 1.0, border * 0.9);
    }

    fragColor = vec4(color, alpha * mask);
}`;

// ── Playhead ────────────────────────────────────────────────────────────

export const PLAYHEAD_VS = `#version 300 es
precision highp float;
out vec2 v_uv;
void main() {
    // Same fullscreen triangle as grid
    float x = float((gl_VertexID & 1) << 2) - 1.0;
    float y = float((gl_VertexID & 2) << 1) - 1.0;
    v_uv = vec2(x * 0.5 + 0.5, 1.0 - (y * 0.5 + 0.5));
    gl_Position = vec4(x, y, 0.0, 1.0);
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

    // Core line: 2 CSS pixels wide
    float coreMask = 1.0 - smoothstep(0.0, 1.2, dist);

    // Soft glow bloom: 6px falloff
    float glow = exp(-dist * 0.35) * 0.45;

    float totalAlpha = min(1.0, coreMask * 0.95 + glow);
    if (totalAlpha < 0.005) discard;

    fragColor = vec4(1.0, 1.0, 1.0, totalAlpha);
}`;
