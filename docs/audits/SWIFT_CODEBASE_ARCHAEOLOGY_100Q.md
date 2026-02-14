# Dream DAW — Swift Codebase Archaeology
# 100 Exhaustive Questions & Answers for Rust/WebGPU Porting
# Generated from 28 Swift/Metal source files

---

## SECTION 1 — TIME REPRESENTATION & CORE MATH (Q1–Q10)

---

### Q1. How is musical time represented internally, and what is the canonical unit?

Musical time lives in two parallel representations:

1. **Beat-based (`TimePosition`)** — A lightweight `Double` wrapper stored as `beats`. Used for UI display, grid drawing, and model serialization. Defined in `TimePosition.swift`.
2. **Sample-accurate (`AbsoluteTime`)** — An `Int64` sample frame index. This is the **single source of truth** for the audio engine and Metal renderer. Defined in `AbsoluteTime.swift`.

```swift
// TimePosition.swift
public struct TimePosition: Comparable, Codable, Hashable, Sendable {
    public let beats: Double
    public static let zero = TimePosition(beats: 0)
}

// AbsoluteTime.swift
public struct AbsoluteTime: Equatable, Comparable, Hashable, Codable, Sendable {
    public let sampleFrame: Int64  // 64-bit, supports >13 million hours at 96kHz
    public static let zero = AbsoluteTime(sampleFrame: 0)
}
```

**Porting note**: In Rust, use `i64` for `AbsoluteTime.sampleFrame` and `f64` for `TimePosition.beats`.

---

### Q2. How are beats converted to samples and vice versa?

The `PulseMap` struct bridges musical time and sample time. For constant tempo:

```
beats = (sampleFrame / sampleRate) * (bpm / 60.0)
sampleFrame = (beats * 60.0 / bpm) * sampleRate
```

```swift
// PulseMap.swift
public func beats(at sampleFrame: Int64) -> Double {
    let event = activeEvent(at: sampleFrame)
    let deltaSamples = Double(sampleFrame - event.sampleFrame)
    let deltaSeconds = deltaSamples / sampleRate
    let deltaBeats = deltaSeconds * (event.bpm / 60.0)
    return event.beatPosition + deltaBeats
}

public func sampleFrame(at beats: Double) -> Int64 {
    let event = activeEvent(atBeat: beats)
    let deltaBeats = beats - event.beatPosition
    let deltaSeconds = deltaBeats * (60.0 / event.bpm)
    let deltaSamples = deltaSeconds * sampleRate
    return event.sampleFrame + Int64(round(deltaSamples))
}
```

For variable tempo, `PulseMap` stores an array of `TempoEvent` and uses binary search (O(log N)) to find the active tempo region.

---

### Q3. How are beats formatted for display (bars:beats:ticks and mm:ss:ms)?

```swift
// TimePosition.swift
public func formatted(beatsPerBar: Int = 4) -> String {
    let totalBeats = max(0, beats)
    let bar = Int(totalBeats) / beatsPerBar + 1
    let beat = Int(totalBeats) % beatsPerBar + 1
    let tick = Int((totalBeats - floor(totalBeats)) * 960) // 960 PPQN
    return String(format: "%d.%d.%03d", bar, beat, tick)
}

public func formattedTime(bpm: Double) -> String {
    let totalSeconds = toSeconds(bpm: bpm)
    let minutes = Int(totalSeconds) / 60
    let seconds = Int(totalSeconds) % 60
    let ms = Int((totalSeconds - floor(totalSeconds)) * 1000)
    return String(format: "%d:%02d.%03d", minutes, seconds, ms)
}

public func toSeconds(bpm: Double) -> Double {
    return beats * (60.0 / bpm)
}
```

**Constants**: PPQN = 960 ticks per quarter note.

---

### Q4. What is the TimeSignature model and how does it affect grid math?

```swift
// Project.swift
public struct TimeSignature: Codable, Hashable, Sendable {
    public var numerator: Int     // Beats per bar (e.g. 4, 3, 6)
    public var denominator: Int   // Beat unit (4 = quarter, 8 = eighth)

    // Converts to quarter-note beats per bar
    public var beatsPerBar: Int {
        numerator * 4 / denominator  // e.g. 6/8 → 3 quarter-note beats
    }
}
```

This `beatsPerBar` value is used by `MagneticGrid`, `TimePosition.formatted()`, and the ruler renderer.

---

### Q5. What is the ViewportMatrix and what state does it hold?

`ViewportMatrix` is the central viewport controller. It stores:

```swift
// ViewportMatrix.swift
public struct ViewportMatrix {
    public var visibleStartSample: Int64     // Left edge of viewport in samples
    public var samplesPerPixel: Double        // Zoom level (higher = zoomed out)
    public var verticalScrollOffset: Float    // Y-axis scroll in points
    public var viewportWidth: Float           // Viewport width in screen pixels
    public var viewportHeight: Float          // Viewport height in screen pixels
}
```

---

### Q6. How does ViewportMatrix convert between samples and screen pixels?

```swift
// ViewportMatrix.swift
public func pixelX(forSample sample: Int64) -> Float {
    Float(Double(sample - visibleStartSample) / samplesPerPixel)
}

public func sample(forPixelX px: Float) -> Int64 {
    visibleStartSample + Int64(Double(px) * samplesPerPixel)
}

public var visibleEndSample: Int64 {
    visibleStartSample + Int64(Double(viewportWidth) * samplesPerPixel)
}

public var visibleSampleRange: Range<Int64> {
    visibleStartSample..<visibleEndSample
}
```

**Formula**: `pixelX = (sample - visibleStartSample) / samplesPerPixel`

---

### Q7. How does the "Anchor Zoom" feature work?

Anchor zoom keeps the content under the cursor stationary during scroll-wheel zoom:

```swift
// ViewportMatrix.swift
public mutating func anchorZoom(factor: Double, anchorPixelX: Float) {
    let anchorSample = sample(forPixelX: anchorPixelX)
    samplesPerPixel = max(1.0, samplesPerPixel * factor)
    visibleStartSample = anchorSample - Int64(Double(anchorPixelX) * samplesPerPixel)
}
```

**Algorithm**:
1. Record the sample under the cursor (`anchorSample`)
2. Apply zoom factor to `samplesPerPixel`
3. Recalculate `visibleStartSample` so `anchorSample` maps back to the same pixel

---

### Q8. How does the QuadTree work for spatial partitioning?

```swift
// QuadTree.swift
public struct QuadRect {
    public var x: Double, y: Double, width: Double, height: Double
}

public struct QuadElement<T: Identifiable> {
    public let value: T
    public let bounds: QuadRect
}

public class QuadTree<T: Identifiable> {
    let bounds: QuadRect
    let capacity: Int        // Default: 8
    let maxDepth: Int        // Default: 8
    var elements: [QuadElement<T>] = []
    var children: [QuadTree<T>]?

    func insert(_ element: QuadElement<T>) -> Bool
    func query(range: QuadRect) -> [QuadElement<T>]
}
```

Subdivision creates 4 children (NW, NE, SW, SE) when a node exceeds `capacity` and hasn't reached `maxDepth`. Used for rendering culling and hit-testing.

---

### Q9. How does the SpatialHashGrid differ from QuadTree, and what are its performance characteristics?

`SpatialHashGrid` is an O(1) temporal hash grid optimized for the timeline's 1D nature:

```swift
// SpatialHashGrid.swift — Key constants
let binSizeSamples: Int64 = 441_000  // 10 seconds @ 44.1kHz

// Bin index calculation
static func binIndex(for sampleFrame: Int64, binSize: Int64) -> Int {
    if sampleFrame < 0 { return Int((sampleFrame - binSize + 1) / binSize) }
    return Int(sampleFrame / binSize)
}
```

**Performance**: Marquee selection across 10,000 clips: <0.1ms (vs ~50ms with linear scan). Queries only visit the 2-3 bins that overlap the requested range.

**API**:
- `insert(clipID:, trackIndex:, start:, end:)` — Adds clip to every bin it spans
- `query(start:, end:)` → `Set<UUID>` — O(bins touched), typically 2-3
- `query(startSample:, endSample:, trackRange:)` — 2D query for marquee selection
- `hitTest(sampleFrame:, trackIndex:)` → `UUID?` — Single-point hit test
- `rebuild(from:)` — Bulk rebuild from flat clip list

---

### Q10. How does MagneticGrid implement snap-to-grid with groove preservation?

```swift
// MagneticGrid.swift — Core constants
let magneticRadiusPixels: Double = 8.0  // Pixel-based attraction zone

// Core formula
samplesPerBeat = (60.0 / bpm) * sampleRate
samplesPerGridLine = samplesPerBeat * (Double(beatsPerBar) / Double(subdivision.rawValue))

// Snap calculation
public func calculateSnapDelta(rawDelta: Int64, clipOriginalStart: Int64, samplesPerPixel: Double) -> Int64 {
    let targetPosition = clipOriginalStart + rawDelta
    let nearestGridLine = nearestLine(to: targetPosition)
    let magneticRadiusSamples = Int64(magneticRadiusPixels * samplesPerPixel)
    let distanceToGrid = abs(targetPosition - nearestGridLine)

    if distanceToGrid < magneticRadiusSamples {
        return nearestGridLine - clipOriginalStart  // SNAP
    }
    return rawDelta  // FREE movement
}
```

**GridSubdivision enum**: bar(1), halfBar(2), beat(4), halfBeat(8), sixteenth(16), triplet(12), thirtyTwo(32).

**Nearest grid line**:
```swift
private func nearestLine(to samplePosition: Int64) -> Int64 {
    let gridLinesBefore = Double(samplePosition) / samplesPerGridLine
    let lower = Int64(floor(gridLinesBefore) * samplesPerGridLine)
    let upper = Int64(ceil(gridLinesBefore) * samplesPerGridLine)
    return abs(samplePosition - lower) <= abs(samplePosition - upper) ? lower : upper
}
```

---

## SECTION 2 — RENDERING PIPELINE (Q11–Q25)

---

### Q11. How are grid lines rendered with adaptive alpha based on zoom?

```swift
// MagneticGrid.swift
let levels: [(subdivisionMultiplier: Double, baseAlpha: Float)] = [
    (Double(beatsPerBar), 1.0),    // Bar lines: always fully visible
    (1.0, 0.7),                     // Beat lines
    (0.5, 0.4),                     // Half-beat (8th note)
    (0.25, 0.25),                   // 16th note
    (0.125, 0.15),                  // 32nd note
]

for (multiplier, baseAlpha) in levels {
    let levelSamples = samplesPerBeat * multiplier
    let pixelSpacing = levelSamples / samplesPerPixel

    // Skip if lines would be < 4 pixels apart
    guard pixelSpacing >= 4.0 else { continue }

    // Logarithmic alpha: fade finer lines at lower zoom
    let zoomFade = Float(min(1.0, log2(max(1.0, pixelSpacing / 8.0)) / 3.0))
    let alpha = baseAlpha * zoomFade

    guard alpha > 0.05 else { continue }  // Below perception threshold
    // ... generate line positions
}
```

**Formula**: `alpha = baseAlpha × min(1.0, log₂(max(1.0, pixelSpacing/8)) / 3.0)`

---

### Q12. What GPU instance data structures does MetalTimelineRenderer use?

```swift
// MetalTimelineRenderer.swift
struct ClipInstance {
    var x: Float            // Clip left edge in pixels
    var y: Float            // Clip top edge in pixels
    var width: Float        // Clip width in pixels
    var height: Float       // Clip height (track lane height)
    var colorR: Float       // Track/clip color (linear RGB)
    var colorG: Float
    var colorB: Float
    var colorA: Float
    var isSelected: UInt32  // 1 = selected
    var isPhantom: UInt32   // 1 = phantom overlay during drag
    var isMuted: UInt32     // 1 = muted state
    var waveformOffset: UInt32  // Index into waveform texture/buffer
    var waveformLength: UInt32  // Number of peak samples
}

struct MidiNoteInstance {
    var x: Float            // Note left edge in pixels
    var y: Float            // Note top in clip-local coordinates
    var width: Float        // Note width in pixels
    var height: Float       // Note height (pitch row height)
    var colorR: Float
    var colorG: Float
    var colorB: Float
    var colorA: Float
    var isSelected: UInt32
}
```

---

### Q13. What is the Metal rendering pipeline setup?

```swift
// MetalTimelineRenderer.swift (setup)
let library = device.makeDefaultLibrary()!
let vertexFunc = library.makeFunction(name: "timeline_vertex")!
let fragmentFunc = library.makeFunction(name: "timeline_fragment")!

let pipelineDesc = MTLRenderPipelineDescriptor()
pipelineDesc.vertexFunction = vertexFunc
pipelineDesc.fragmentFunction = fragmentFunc
pipelineDesc.colorAttachments[0].pixelFormat = .bgra8Unorm

// Alpha blending for transparency
pipelineDesc.colorAttachments[0].isBlendingEnabled = true
pipelineDesc.colorAttachments[0].sourceRGBBlendFactor = .sourceAlpha
pipelineDesc.colorAttachments[0].destinationRGBBlendFactor = .oneMinusSourceAlpha
```

Two separate pipelines: `timelinePipeline` (clips) and `notePipeline` (MIDI notes).

---

### Q14. How does the clip vertex shader position instances?

```metal
// WaveformShaders.metal
struct ClipInstance {
    float x, y, width, height;
    float colorR, colorG, colorB, colorA;
    uint isSelected, isPhantom, isMuted;
    uint waveformOffset, waveformLength;
};

vertex VertexOut timeline_vertex(
    uint vertexID [[vertex_id]],
    uint instanceID [[instance_id]],
    constant ClipInstance* instances [[buffer(0)]],
    constant float4x4& viewProjection [[buffer(1)]]
) {
    ClipInstance clip = instances[instanceID];

    // Unit quad: 6 vertices (2 triangles)
    float2 positions[6] = {
        {0,0}, {1,0}, {0,1},
        {1,0}, {1,1}, {0,1}
    };
    float2 uv = positions[vertexID];

    // Scale unit quad to clip rect
    float2 pos = float2(clip.x + uv.x * clip.width, clip.y + uv.y * clip.height);

    VertexOut out;
    out.position = viewProjection * float4(pos, 0, 1);
    out.uv = uv;
    out.clipWidth = clip.width;
    out.clipHeight = clip.height;
    // ... pass through color, state flags
    return out;
}
```

---

### Q15. How does the SDF-based rounded rectangle work in the clip fragment shader?

```metal
// WaveformShaders.metal
fragment float4 timeline_fragment(VertexOut in [[stage_in]]) {
    float2 pixelPos = float2(in.uv.x * in.clipWidth, in.uv.y * in.clipHeight);
    float cornerRadius = 4.0;

    // SDF: Signed Distance Function for rounded rect
    float2 halfSize = float2(in.clipWidth, in.clipHeight) * 0.5;
    float2 d = abs(pixelPos - halfSize) - (halfSize - cornerRadius);
    float dist = length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - cornerRadius;

    // Anti-aliased edge (1px feather)
    float edgeAlpha = 1.0 - smoothstep(-1.0, 0.0, dist);

    float4 color = float4(in.colorR, in.colorG, in.colorB, in.colorA);
    color.a *= edgeAlpha;

    // Phantom state (drag preview): reduce opacity
    if (in.isPhantom) { color.a *= 0.5; }
    // Muted state: desaturate
    if (in.isMuted) {
        float gray = dot(color.rgb, float3(0.299, 0.587, 0.114));
        color.rgb = mix(color.rgb, float3(gray), 0.7);
        color.a *= 0.6;
    }
    // Selection highlight: brighten
    if (in.isSelected) {
        color.rgb += float3(0.15);
    }

    return color;
}
```

**Corner radius constant**: 4.0 pixels. **SDF formula**: standard box SDF with corner subtraction.

---

### Q16. How is waveform data rendered inside clips?

The waveform is rendered in the fragment shader by sampling peak data from a buffer:

```metal
// WaveformShaders.metal (inside timeline_fragment)
if (in.waveformLength > 0) {
    uint peakIndex = in.waveformOffset + uint(in.uv.x * float(in.waveformLength));
    peakIndex = min(peakIndex, in.waveformOffset + in.waveformLength - 1);
    float peak = waveformPeaks[peakIndex];

    // Center the waveform vertically
    float centerY = 0.5;
    float waveTop = centerY - peak * 0.45;  // 90% of half-height
    float waveBot = centerY + peak * 0.45;

    if (in.uv.y >= waveTop && in.uv.y <= waveBot) {
        // Inside waveform: use a slightly brighter/darker shade
        color.rgb *= 1.3;
    }
}
```

---

### Q17. How is WaveformData computed from audio files?

```swift
// WaveformCache.swift
struct WaveformData: Sendable {
    let peaks: [Float]         // Per-block peak amplitude (0...1)
    let rmsValues: [Float]     // Per-block RMS
    let samplesPerPixel: Int   // Block size
    let totalSamples: Int64
}

// Computation: iterate all samples, accumulate per-block
for i in 0..<frameCount {
    let blockIndex = Int(globalSampleIndex) / samplesPerPixel
    // Mix to mono
    var sampleSum: Float = 0
    for ch in 0..<channelCount { sampleSum += channelData[ch][i] }
    let monoSample = sampleSum / Float(channelCount)

    peaks[blockIndex] = max(peaks[blockIndex], abs(monoSample))
    rmsValues[blockIndex] += monoSample * monoSample
}
// Finalize RMS
rmsValues[i] = sqrt(rmsValues[i] / samplesInBlock)
```

Chunk size for reading: `65536` frames per read.

---

### Q18. How does multi-band waveform visualization work?

Three-band frequency split using Butterworth biquad IIR filters:

```swift
// WaveformCache.swift — Band boundaries
let lowCutoff: Double = 300.0    // Bass: 20-300 Hz
let highCutoff: Double = 4000.0  // High: 4000+ Hz
// Mid = original - low - high (subtraction method)

// Butterworth low-pass filter coefficients
let omega = 2.0 * Double.pi * cutoff / sampleRate
let cosOmega = cos(omega)
let sinOmega = sin(omega)
let alpha = sinOmega / (2.0 * sqrt(2.0))  // Q = sqrt(2)/2

// Low-pass: b0 = (1 - cos(ω)) / 2, b1 = 1 - cos(ω), b2 = b0
// High-pass: b0 = (1 + cos(ω)) / 2, b1 = -(1 + cos(ω)), b2 = b0
// Common: a0 = 1 + α, a1 = -2cos(ω), a2 = 1 - α

// Direct Form II biquad
for i in 0..<count {
    let x = samples[i]
    let y = b0*x + b1*x1 + b2*x2 - a1*y1 - a2*y2
    output[i] = y
    x2 = x1; x1 = x; y2 = y1; y1 = y
}
```

---

### Q19. How does the WaveformCache manage LRU eviction and disk persistence?

```swift
// WaveformCache.swift
let maxCacheSize = 128  // Max entries per cache type

// LRU: touchKey moves key to end of array
private func touchKey(_ key: CacheKey, in order: inout [CacheKey]) {
    if let idx = order.firstIndex(of: key) { order.remove(at: idx) }
    order.append(key)
}

// Eviction: remove oldest until under limit
private func evictIfNeeded<V>(cache: inout [CacheKey: V], order: inout [CacheKey]) {
    while cache.count >= maxCacheSize, let oldest = order.first {
        cache.removeValue(forKey: oldest)
        order.removeFirst()
    }
}

// Disk: JSON serialization, files older than 7 days auto-cleaned
private func diskURL(for key: CacheKey) -> URL {
    let filename = "\(key.url.lastPathComponent)_\(key.samplesPerPixel).waveform"
    return AppSettings.shared.userCacheURL.appendingPathComponent(filename)
}
```

---

### Q20. What is the MIDI note rendering pipeline?

```metal
// WaveformShaders.metal
vertex VertexOut note_vertex(
    uint vertexID [[vertex_id]],
    uint instanceID [[instance_id]],
    constant MidiNoteInstance* notes [[buffer(0)]],
    constant float4x4& viewProjection [[buffer(1)]]
) {
    MidiNoteInstance note = notes[instanceID];
    float2 positions[6] = {{0,0},{1,0},{0,1},{1,0},{1,1},{0,1}};
    float2 uv = positions[vertexID];
    float2 pos = float2(note.x + uv.x * note.width, note.y + uv.y * note.height);
    // ... same pattern as clip rendering
}

fragment float4 note_fragment(VertexOut in [[stage_in]]) {
    float4 color = float4(in.colorR, in.colorG, in.colorB, in.colorA);
    if (in.isSelected) { color.rgb += float3(0.2); }
    return color;
}
```

---

### Q21. How does the playhead achieve zero-jitter rendering at 120 FPS?

```swift
// PlayheadInterpolator.swift — The core interpolation
public func currentVisualSample() -> Double {
    // Atomically read anchor state under lock
    os_unfair_lock_lock(&lock)
    let anchor = anchorSampleFrame
    let anchorTime = anchorMachTime
    let playing = isPlaying
    let rate = sampleRate
    let numer = timebaseNumer
    let denom = timebaseDenom
    os_unfair_lock_unlock(&lock)

    guard playing, anchorTime > 0 else { return Double(anchor) }

    let currentMach = mach_absolute_time()
    let elapsedMach = currentMach - anchorTime

    // mach ticks → nanoseconds → seconds
    let elapsedNanos = elapsedMach * numer / denom
    let elapsedSeconds = Double(elapsedNanos) / 1_000_000_000.0

    // Clamp to 50ms max to prevent runaway during stalls
    let clampedSeconds = min(elapsedSeconds, 0.050)

    // Extrapolate: anchor + elapsed × sampleRate
    return Double(anchor) + (clampedSeconds * rate)
}
```

**Problem**: Audio callbacks arrive every ~11ms but screen refreshes every ~8.3ms (120Hz). **Solution**: `mach_absolute_time()` extrapolation between anchors with 50ms clamp.

---

### Q22. What are the TrackColor palette values used for clip/track coloring?

```swift
// Track.swift — 16 Ableton-style colors
public enum TrackColor: Int, Codable, CaseIterable {
    case coral=0    // (0.94, 0.36, 0.30)
    case orange     // (1.00, 0.54, 0.10)
    case gold       // (0.96, 0.73, 0.19)
    case yellow     // (0.95, 0.90, 0.25)
    case lime       // (0.55, 0.85, 0.23)
    case green      // (0.22, 0.78, 0.35)
    case teal       // (0.16, 0.72, 0.63)
    case cyan       // (0.12, 0.75, 0.85)
    case sky        // (0.20, 0.60, 0.92)
    case blue       // (0.25, 0.42, 0.88)
    case indigo     // (0.42, 0.32, 0.85)
    case purple     // (0.62, 0.30, 0.85)
    case magenta    // (0.82, 0.25, 0.72)
    case pink       // (0.92, 0.35, 0.55)
    case rose       // (0.90, 0.40, 0.45)
    case slate      // (0.55, 0.58, 0.62)

    // Auto-assign by track index
    public static func forIndex(_ index: Int) -> TrackColor {
        allCases[index % allCases.count]
    }
}
```

---

### Q23. How does the renderer handle phantom overlays during drag operations?

The `InteractionStateMachine` produces a `PhantomOverlay` struct containing clip IDs and their delta offsets. The renderer draws these clips semi-transparently at their projected positions:

```swift
// InteractionStateMachine.swift
public var phantomOverlay: PhantomOverlay {
    if case .dragging(let ids, let delta, let deltaTrack) = currentState {
        return PhantomOverlay(clipIDs: ids, deltaSamples: delta, deltaTrackIndex: deltaTrack)
    }
    // ... similar for trimming, stretching
}

// MetalTimelineRenderer — during draw call:
for clip in phantomClips {
    var instance = ClipInstance(/* ... */)
    instance.isPhantom = 1  // Fragment shader applies 50% alpha
    instance.x += Float(Double(phantomOverlay.deltaSamples) / viewport.samplesPerPixel)
    instance.y += Float(phantomOverlay.deltaTrackIndex) * trackHeight
    clipInstances.append(instance)
}
```

---

### Q24. What visual states does the AudioClip model support?

```swift
// AudioClip.swift
public var isSelected: Bool              // Selection highlight
public var colorOverride: TrackColor?    // Per-clip color (overrides track)
public var gain: Float                   // 1.0 = unity (linear)
public var isWarped: Bool                // Stretch indicator
public var stretchFactor: Double         // 1.0 = original speed (0.25...4.0)
```

In the shader, these map to: `isSelected` → brightness boost (+0.15 RGB), `isPhantom` → 50% alpha, `isMuted` → desaturation (70% gray mix, 60% alpha).

---

### Q25. How does the MetalTimelineRenderer batch instances for GPU submission?

```swift
// MetalTimelineRenderer.swift — Render loop
func draw(in view: MTKView) {
    var clipInstances: [ClipInstance] = []
    var noteInstances: [MidiNoteInstance] = []

    // Cull: Only process tracks visible in viewport
    for (trackIndex, track) in visibleTracks.enumerated() {
        for clip in track.clips {
            // Visibility check against viewport
            let clipStartPx = viewport.pixelX(forSample: clip.absolutePosition.sampleFrame)
            let clipEndPx = viewport.pixelX(forSample: clip.absolutePosition.sampleFrame + clip.absoluteDuration.sampleFrame)
            guard clipEndPx > 0 && clipStartPx < viewport.viewportWidth else { continue }

            clipInstances.append(ClipInstance(
                x: clipStartPx, y: trackY, width: clipEndPx - clipStartPx,
                height: trackHeight, /* color, state flags, waveform data */
            ))
        }
    }

    // Upload to GPU and draw
    let buffer = device.makeBuffer(bytes: clipInstances, length: MemoryLayout<ClipInstance>.stride * clipInstances.count)
    encoder.setVertexBuffer(buffer, offset: 0, index: 0)
    encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 6, instanceCount: clipInstances.count)
}
```

---

## SECTION 3 — INTERACTION & HIT-TESTING (Q26–Q40)

---

### Q26. How does TimelineInteractionCoordinator translate mouse events to actions?

```swift
// TimelineInteractionCoordinator.swift
func mouseDown(at pixelX: Float, pixelY: Float, modifiers: NSEvent.ModifierFlags) {
    let sampleFrame = viewport.sample(forPixelX: pixelX)
    let trackIndex = trackLayout.trackIndex(atY: pixelY - viewport.verticalScrollOffset)

    // 1. Check ruler area (loop/seek)
    if pixelY < rulerHeight {
        if modifiers.contains(.command) {
            delegate?.setLoopPoint(at: sampleFrame)
        } else {
            delegate?.seekPlayhead(to: sampleFrame)
        }
        return
    }

    // 2. Hit-test clips via SpatialHashGrid
    if let clipID = spatialGrid.hitTest(sampleFrame: sampleFrame, trackIndex: trackIndex) {
        let clipEntry = spatialGrid.entry(for: clipID)!

        // Determine edge proximity for trim vs drag
        let edgeThresholdSamples = Int64(8.0 * viewport.samplesPerPixel)
        let distToLeft = abs(sampleFrame - clipEntry.startSample)
        let distToRight = abs(sampleFrame - clipEntry.endSample)

        if distToLeft < edgeThresholdSamples {
            stateMachine.beginTrim(clipIDs: [clipID], edge: .left, anchorPx: pixelX)
        } else if distToRight < edgeThresholdSamples {
            stateMachine.beginTrim(clipIDs: [clipID], edge: .right, anchorPx: pixelX)
        } else {
            stateMachine.beginPendingDrag(clipIDs: selectedClipIDs(including: clipID),
                                          anchorPx: pixelX, anchorPy: pixelY)
        }
    } else {
        // Empty space: begin marquee selection
        stateMachine.beginMarquee(anchorPx: pixelX, anchorPy: pixelY)
    }
}
```

**Edge threshold**: 8 screen pixels, converted to samples via `samplesPerPixel`.

---

### Q27. How does the InteractionStateMachine implement the "Phantom Pattern"?

The FSM tracks phantom deltas without mutating the model. Mutations only occur on `mouseUp`:

```swift
// InteractionStateMachine.swift — States
enum InteractionState {
    case idle
    case pendingDrag(clipIDs: Set<UUID>, anchorPx: Float, anchorPy: Float)
    case dragging(clipIDs: Set<UUID>, phantomDeltaSamples: Int64, deltaTrackIndex: Int)
    case trimming(clipIDs: Set<UUID>, edge: TrimEdge, phantomDeltaSamples: Int64)
    case marqueeSelecting(anchorPx: Float, anchorPy: Float, currentPx: Float, currentPy: Float)
    case splitting(at: Int64, trackIndex: Int)
    case slicing(startPx: Float, currentPx: Float, trackIndex: Int)
    case stretching(clipIDs: Set<UUID>, edge: TrimEdge, phantomDeltaBeats: Double)
}
```

**Drag threshold**: 4-point distance before committing to drag (prevents accidental drags):
```swift
static let dragThresholdPoints: Float = 4.0

case .pendingDrag(let ids, let anchorPx, let anchorPy):
    let dx = currentPixelX - anchorPx
    let dy = currentPixelY - anchorPy
    let distance = (dx*dx + dy*dy).squareRoot()

    if distance >= Self.dragThresholdPoints {
        currentState = .dragging(clipIDs: ids, phantomDeltaSamples: snappedDelta, deltaTrackIndex: deltaTrack)
    }
```

---

### Q28. How are drag deltas calculated and snapped?

```swift
// InteractionStateMachine.swift — mouseMoved
case .dragging(let ids, _, _):
    let rawDeltaSamples = viewport.sample(forPixelX: currentPx) - viewport.sample(forPixelX: anchorPx)
    let rawDeltaTracks = trackLayout.trackIndex(atY: currentPy) - trackLayout.trackIndex(atY: anchorPy)

    // Snap using MagneticGrid
    let snappedDelta = grid.calculateSnapDelta(
        rawDelta: rawDeltaSamples,
        clipOriginalStart: primaryClipStart,
        samplesPerPixel: viewport.samplesPerPixel
    )

    currentState = .dragging(clipIDs: ids, phantomDeltaSamples: snappedDelta, deltaTrackIndex: rawDeltaTracks)
```

---

### Q29. How does mouseUp commit phantom deltas to the model?

```swift
// InteractionStateMachine.swift
func mouseUp() {
    switch currentState {
    case .dragging(let ids, let deltaSamples, let deltaTrack):
        if deltaSamples != 0 || deltaTrack != 0 {
            delegate?.commitClipMove(clipIDs: ids, deltaSamples: deltaSamples, deltaTrackIndex: deltaTrack)
        }
    case .trimming(let ids, let edge, let deltaSamples):
        if deltaSamples != 0 {
            delegate?.commitClipTrim(clipIDs: ids, edge: edge, deltaSamples: deltaSamples)
        }
    case .stretching(let ids, let edge, let deltaBeats):
        if abs(deltaBeats) > 0.001 {
            delegate?.commitClipStretch(clipIDs: ids, edge: edge, deltaBeats: deltaBeats)
        }
    case .marqueeSelecting(let ax, let ay, let cx, let cy):
        let selectionRect = /* compute rect from anchor + current */
        delegate?.selectClipsInRect(selectionRect)
    default: break
    }
    currentState = .idle
}
```

This ensures a single undo entry per drag operation.

---

### Q30. How does AudioClip.applyTrim() work for left vs right edge?

```swift
// AudioClip.swift
public mutating func applyTrim(deltaBeats: Double, edge: TrimEdge) {
    switch edge {
    case .left:
        // Move start + adjust source read offset + reduce duration
        let newPosition = TimePosition(beats: max(0, position.beats + deltaBeats))
        let actualDelta = newPosition.beats - position.beats
        self.position = newPosition
        self.trimStartOffset = TimePosition(beats: max(0, trimStartOffset.beats + actualDelta))
        self.duration = TimePosition(beats: max(0.01, duration.beats - actualDelta))
    case .right:
        // Only change visible duration
        self.duration = TimePosition(beats: max(0.01, duration.beats + deltaBeats))
    }
}
```

**Minimum clip duration**: 0.01 beats.

---

### Q31. How does elastic time-stretching (warp) differ from trimming?

```swift
// AudioClip.swift
public mutating func applyWarp(deltaBeats: Double, edge: TrimEdge, sourceDurationBeats: Double) {
    // ... calculate newDurationBeats (minimum 0.125 beats = 1/8 note)

    // New rate = source duration / visual duration
    let newRate = sourceDurationBeats / newDurationBeats

    // Hard limits: protect audio engine from extreme rates
    guard newRate >= 0.25 && newRate <= 4.0 else { return }

    self.duration = TimePosition(beats: newDurationBeats)
    self.stretchFactor = newRate   // Connected to AVAudioUnitTimePitch.rate
    self.isWarped = true
}
```

**Rate limits**: 0.25× (4× slower) to 4.0× (4× faster). Pitch is preserved via `AVAudioUnitTimePitch`.

---

### Q32. How does the WarpMarker model work for sample-accurate time-stretching?

```swift
// WarpMarker.swift
public struct WarpMarker: Identifiable, Codable, Hashable, Sendable {
    public let id: UUID
    public var sourceSamplePosition: Double  // Position in source audio (samples or 0...1)
    public var targetBeat: Double             // Corresponding arrangement beat
    public var isPinned: Bool                 // Fixed anchor during warping
}
```

Warp markers create piecewise linear mappings between source time and arrangement time, enabling non-uniform time-stretching.

---

### Q33. How does clip overlap/containment hit-testing work?

```swift
// AudioClip.swift
public func contains(beat: Double) -> Bool {
    beat >= position.beats && beat < endPosition.beats
}

public func overlaps(start: TimePosition, end: TimePosition) -> Bool {
    position.beats < end.beats && endPosition.beats > start.beats
}

public var endPosition: TimePosition {
    position + duration
}
```

Standard AABB overlap test: `clip.start < query.end && clip.end > query.start`.

---

### Q34. How does the Project model track selection state?

```swift
// Project.swift — Multi-selection
@Published public var selectedTrackIDs: Set<UUID> = []
@Published public var selectedClipIDs: Set<UUID> = []
@Published public var primarySelectedClipID: UUID?
@Published public var primarySelectedTrackID: UUID?

// Backward compatibility
public var selectedTrackID: UUID? {
    get { primarySelectedTrackID }
    set {
        if let val = newValue {
            selectedTrackIDs = [val]
            primarySelectedTrackID = val
        } else {
            selectedTrackIDs = []
            primarySelectedTrackID = nil
        }
    }
}
```

---

### Q35. How does the Project model compute total duration?

```swift
// Project.swift
public var totalDuration: TimePosition {
    var maxEnd = TimePosition.zero
    for track in tracks {
        for clip in track.clips {
            if clip.endPosition > maxEnd { maxEnd = clip.endPosition }
        }
        for midiClip in track.midiClips {
            if midiClip.endPosition > maxEnd { maxEnd = midiClip.endPosition }
        }
    }
    let minimumBars = 32
    let minimumBeats = TimePosition(bars: minimumBars, beatsPerBar: timeSignature.beatsPerBar)
    return max(maxEnd + TimePosition(beats: Double(timeSignature.beatsPerBar * 4)), minimumBeats)
}
```

Always shows at least 32 bars plus 4 beats padding.

---

### Q36. How does group track nesting and visibility work?

```swift
// Project.swift
public var allVisibleTracks: [Track] {
    let trackMap = Dictionary(uniqueKeysWithValues: tracks.map { ($0.id, $0) })
    return tracks.filter { track in
        var currentParentID = track.parentTrackID
        while let parentID = currentParentID {
            if let parent = trackMap[parentID] {
                if !parent.isExpanded { return false }
                currentParentID = parent.parentTrackID
            } else { break }
        }
        return true
    } + [masterTrack]
}

public func depth(for trackID: UUID) -> Int {
    var depth = 0
    var currentParentID = trackMap[trackID]?.parentTrackID
    while let parentID = currentParentID {
        depth += 1
        currentParentID = trackMap[parentID]?.parentTrackID
    }
    return depth
}
```

---

### Q37. How does the group track routing work?

```swift
// Project.swift — groupTracks
public func groupTracks(ids: [UUID]) {
    let groupTrack = Track(name: "Group", trackType: .group, color: selectedTracks.first?.color ?? .slate)
    groupTrack.childTrackIDs = selectedTracks.map(\.id)

    for track in selectedTracks {
        track.parentTrackID = groupTrack.id
        track.outputDestinationID = groupTrack.id  // Audio routes to group bus
        track.color = groupTrack.color              // Unified color
    }

    tracks.insert(groupTrack, at: topmostIndex)
}
```

---

### Q38. What is the Track data model's complete property list?

```swift
// Track.swift
public let id: UUID
public var name: String
public var trackType: TrackType          // .audio, .midi, .group, .master
public var color: TrackColor             // 16-color palette
public var volume: Float                 // 0.0 ... 1.0 (linear)
public var pan: Float                    // -1.0 ... 1.0
public var isMuted: Bool
public var isSoloed: Bool
public var isArmed: Bool                 // Record-armed
public var height: CGFloat               // Lane height in points (default: 80)
public var clips: [AudioClip]
public var midiClips: [MidiClip]
public var effects: [AudioEffectConfig]
public var instrument: InstrumentConfig?
public var parentTrackID: UUID?          // Group parent
public var outputDestinationID: UUID?    // Audio routing target
public var childTrackIDs: [UUID]         // Group children
public var isExpanded: Bool              // Group expand state
```

---

### Q39. How does the volume fader map between linear and decibels?

```swift
// Track.swift
public static let minFaderDecibels: Float = -80.0
public static let maxFaderDecibels: Float = 6.0

public static func linearGain(fromDecibels db: Float) -> Float {
    if db <= minFaderDecibels { return 0 }
    return pow(10, db / 20.0)
}

public static func decibels(fromLinearGain gain: Float) -> Float {
    if gain <= 0.000_01 { return minFaderDecibels }
    return 20.0 * log10(gain)
}
```

**Formula**: `gain = 10^(dB/20)`, **Range**: -80 dB to +6 dB. Zero threshold at gain ≤ 0.00001.

---

### Q40. How does effectiveVolume compute the final track gain?

```swift
// Track.swift
public var effectiveVolume: Float {
    guard !isMuted else { return 0 }

    var gainLinear: Float = 1.0
    for effect in effects where effect.effectType == .utility && effect.isEnabled {
        if effect.gainDB <= -59.9 { return 0 }  // -∞ dB → silence
        gainLinear *= powf(10.0, effect.gainDB / 20.0)
    }
    return volume * gainLinear
}
```

Stacks all enabled Utility effect gains multiplicatively.

---

## SECTION 4 — AUDIO ENGINE & DSP (Q41–Q65)

---

### Q41. What is the SPSCRingBuffer architecture and why is it wait-free?

```swift
// SPSCRingBuffer.swift
public final class SPSCRingBuffer<T>: @unchecked Sendable {
    private let capacity: Int                    // Must be power of 2
    private let mask: Int                        // capacity - 1 (branchless modulo)
    private let stride: Int                      // MemoryLayout<T>.stride
    private let rawBuffer: UnsafeMutableRawPointer  // Raw memory (invisible to ARC)
    private let slotOccupied: UnsafeMutablePointer<Bool>

    private let writeIndex: ManagedAtomic<Int>   // Producer-owned
    private let readIndex: ManagedAtomic<Int>    // Consumer-owned
}
```

**Why raw pointers**: Optional wrapping (`T?`) forces `swift_retain`/`swift_release` which internally use `pthread_mutex_lock`, destroying the lock-free guarantee. Raw pointers with manual `initializeMemory`/`moveMemory` bypass ARC entirely.

```swift
@inline(__always)
public func push(_ item: T) -> Bool {
    let currentWrite = writeIndex.load(ordering: .relaxed)
    let currentRead = readIndex.load(ordering: .acquiring)
    if currentWrite - currentRead >= capacity { return false }  // Full

    let slot = currentWrite & mask
    rawBuffer.advanced(by: slot * stride).initializeMemory(as: T.self, repeating: item, count: 1)
    slotOccupied[slot] = true
    writeIndex.store(currentWrite + 1, ordering: .releasing)
    return true
}

@inline(__always)
public func pop() -> T? {
    let currentRead = readIndex.load(ordering: .relaxed)
    let currentWrite = writeIndex.load(ordering: .acquiring)
    if currentRead == currentWrite { return nil }  // Empty

    let slot = currentRead & mask
    let item = rawBuffer.advanced(by: slot * stride).assumingMemoryBound(to: T.self).move()
    slotOccupied[slot] = false
    readIndex.store(currentRead + 1, ordering: .releasing)
    return item
}
```

---

### Q42. How does TileEngine implement disk streaming with the SPSC ring buffer?

```swift
// TileEngine.swift
public let tileSize: AVAudioFrameCount = 65536  // ~1.5s @ 44.1kHz
private let ringBufferCapacity = 8               // ~12s of audio buffered

// Header: First 16384 frames loaded into RAM for instant trigger
let headerSize: AVAudioFrameCount = 16384

// Producer loop (background thread)
private func producerLoop(url: URL, file: AVAudioFile, startFrame: Int64, buffer: SPSCRingBuffer<AVAudioPCMBuffer>) async {
    while !Task.isCancelled && readPosition < total {
        let framesToRead = min(AVAudioFrameCount(remaining), tileSize)
        let pcmBuffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: framesToRead)!
        file.framePosition = readPosition
        try file.read(into: pcmBuffer, frameCount: framesToRead)

        // Push with back-pressure
        var pushed = false
        while !pushed && !Task.isCancelled {
            pushed = buffer.push(pcmBuffer)
            if !pushed { try? await Task.sleep(nanoseconds: 1_000_000) }  // 1ms wait
        }
        readPosition += Int64(framesToRead)
    }
}

// Consumer (audio thread, real-time safe)
public func readNextBuffer(url: URL) -> AVAudioPCMBuffer? {
    streams[url]?.pop()  // Lock-free
}
```

---

### Q43. How does QuantumDSP apply Hann window micro-fades?

```swift
// QuantumDSP.swift
public final class QuantumDSP {
    private let fadeLength: Int = 256           // Samples (~5.8ms @ 44.1kHz)
    private var fadeInCurve: [Float] = []       // Pre-allocated Hann fade-in
    private var fadeOutCurve: [Float] = []      // Pre-allocated Hann fade-out

    init() {
        fadeInCurve = (0..<fadeLength).map { i in
            // Hann window: 0.5 * (1 - cos(π * i / N))
            0.5 * (1.0 - cos(Float.pi * Float(i) / Float(fadeLength)))
        }
        fadeOutCurve = fadeInCurve.reversed()
    }

    // Apply fade-in to buffer start
    func applyFadeIn(buffer: UnsafeMutablePointer<Float>, frameCount: Int) {
        let fadeSamples = min(fadeLength, frameCount)
        // vDSP_vmul: element-wise multiply (vectorized, zero allocations)
        vDSP_vmul(buffer, 1, fadeInCurve, 1, buffer, 1, vDSP_Length(fadeSamples))
    }

    // Apply fade-out to buffer end
    func applyFadeOut(buffer: UnsafeMutablePointer<Float>, frameCount: Int) {
        let fadeSamples = min(fadeLength, frameCount)
        let offset = frameCount - fadeSamples
        vDSP_vmul(buffer + offset, 1, fadeOutCurve, 1, buffer + offset, 1, vDSP_Length(fadeSamples))
    }
}
```

**Hann formula**: `w(i) = 0.5 × (1 − cos(πi/N))`

---

### Q44. How does TrackMixer implement de-zippering (smooth parameter ramps)?

```swift
// TrackMixer.swift — "Hardware De-Zippering"
private let rampDuration: Float = 0.020  // 20ms ramp

func syncVolume(track: Track) {
    let targetGain = track.effectiveVolume
    let currentGain = outputMixer.outputVolume

    if abs(targetGain - currentGain) > 0.0001 {
        // Schedule smooth linear ramp over 20ms
        outputMixer.outputVolume = targetGain
        // AVAudioMixerNode applies internal ramping when set during playback
    }
}

func syncPan(track: Track) {
    let targetPan = track.pan  // -1.0 ... 1.0
    outputMixer.pan = targetPan
}
```

For manual ramping in custom nodes, the per-sample approach:
```swift
let gainStep = (targetGain - lastGain) / Float(frameCount)
for i in 0..<frameCount {
    let currentGain = lastGain + gainStep * Float(i)
    buffer[i] *= currentGain
}
lastGain = targetGain
```

---

### Q45. How does TrackMixer's insert rack work for hot-swapping plugins?

```swift
// TrackMixer.swift — Pre-allocated insert rack slots
// 4 mixer nodes per track pre-allocated as insert slots
private var insertSlots: [AVAudioNode?] = [nil, nil, nil, nil]

func hotSwapPlugin(at slotIndex: Int, newNode: AVAudioNode) {
    guard slotIndex >= 0, slotIndex < 4 else { return }

    let engine = audioEngine
    let oldNode = insertSlots[slotIndex]

    // Disconnect old node WITHOUT stopping engine
    if let old = oldNode {
        engine.disconnectNodeOutput(old)
        engine.detach(old)
    }

    // Attach and connect new node in the chain
    engine.attach(newNode)
    // Reconnect chain: previous → newNode → next
    reconnectChain(at: slotIndex, with: newNode)

    insertSlots[slotIndex] = newNode
}
```

This allows live plugin swaps without stopping playback.

---

### Q46. How does PDCEngine calculate plugin delay compensation?

```swift
// PDCEngine.swift
public func calculateLatencies(tracks: [Track]) -> [UUID: Double] {
    var localLatencies: [UUID: Double] = [:]

    // 1. Local latency = instrument + effects chain
    for track in tracks {
        var total: Double = 0
        if let _ = track.instrument {
            total += PluginHost.shared.getLatency(for: track.id)
        }
        for effect in track.effects where effect.isEnabled {
            total += PluginHost.shared.getLatency(for: effect.id)
        }
        localLatencies[track.id] = total
    }

    // 2. Path latency = walk routing tree to output
    var totalPathLatencies: [UUID: Double] = [:]
    for track in tracks {
        var currentID = track.id
        var total: Double = 0
        var visited = Set<UUID>()  // Circular routing safety

        while true {
            if visited.contains(currentID) { break }
            visited.insert(currentID)
            total += localLatencies[currentID] ?? 0.0
            guard let dest = tracks.first(where: { $0.id == currentID })?.outputDestinationID
            else { break }
            currentID = dest
        }
        totalPathLatencies[track.id] = total
    }
    return totalPathLatencies
}
```

---

### Q47. How does SimpleSynthInstrument generate sine wave audio?

```swift
// SimpleSynthInstrument.swift
let sourceNode = AVAudioSourceNode { [weak self] _, timeStamp, frameCount, audioBufferList -> OSStatus in
    guard let self = self else { return noErr }

    // Hardware gating: don't produce audio before startHostTime
    if timeStamp.pointee.mHostTime < self.startHostTime { /* zero-fill */ return noErr }

    // Process lock-free commands
    while let command = self.commandQueue.pop() { /* noteOn/noteOff/paramChange */ }

    // Mix active voices
    for voice in self.activeVoices {
        for f in 0..<frameCount {
            let sample = sin(voice.phase) * voice.velocity * Float(envelope)
            buffer[f] += sample
            voice.phase += voice.phaseIncrement  // 2π × freq / sampleRate
        }
    }
    return noErr
}
```

**Phase increment**: `2π × frequency / sampleRate` where `frequency = 440 × 2^((pitch - 69) / 12)`.

---

### Q48. How does SamplerInstrument implement pitch-shifting via playback rate?

```swift
// SamplerInstrument.swift
let pitchRatio = pow(2.0, (Double(voice.pitch) - root) / 12.0)
// root = rootNote (default 60 = C3)

// Advance playback position by pitch ratio each sample
self.activeVoices[i].currentFrame += pitchRatio
// pitchRatio > 1.0 = higher pitch (faster playback)
// pitchRatio < 1.0 = lower pitch (slower playback)
```

**Formula**: `pitchRatio = 2^((midiNote - rootNote) / 12)` — standard equal temperament.

---

### Q49. How does SamplerInstrument's ADSR envelope work?

```swift
// SamplerInstrument.swift — Per-sample ADSR
let attackF = self._attack * sr    // Attack time in samples
let decayF = self._decay * sr      // Decay time in samples
let releaseF = self._release * sr  // Release time in samples
let sustain = self._sustain        // 0.0...1.0

var env: Double = 1.0
let t = voice.currentFrame - startF  // Time since note start

if !voice.isReleasing {
    if t < attackF {
        env = t / attackF                                        // Linear attack
    } else if t < attackF + decayF {
        env = 1.0 - (1.0 - sustain) * ((t - attackF) / decayF)  // Linear decay
    } else {
        env = sustain                                             // Sustain hold
    }
} else {
    env = sustain * (1.0 - (voice.releaseFrame / releaseF))       // Linear release
    if env <= 0 { removeVoice; continue }
    voice.releaseFrame += 1.0
}
```

**Default values**: attack=0.001s, decay=0.6s, sustain=1.0, release=0.05s.

---

### Q50. How does SamplerInstrument's SVF (State Variable Filter) work?

```swift
// SamplerInstrument.swift — Chamberlin SVF (sample-accurate)
// Pre-calculate coefficients per sample for automation:
let g = Float(tan(Double.pi * currentCutoff / sr))
let k = Float(2.0 * (1.0 - resonance))  // resonance 0.0...0.99
let a1 = 1.0 / (1.0 + g * (g + k))
let a2 = g * a1
let a3 = g * a2

// Per-voice filter (stereo):
let v3L = interpL - voice.ic2eq_L
let v1L = a1 * voice.ic1eq_L + a2 * v3L
let v2L = voice.ic2eq_L + a2 * voice.ic1eq_L + a3 * v3L
voice.ic1eq_L = 2.0 * v1L - voice.ic1eq_L  // State update
voice.ic2eq_L = 2.0 * v2L - voice.ic2eq_L  // State update
mixL += v2L * finalGain  // v2 = low-pass output
```

**Filter type**: Low-pass (v2 output). Per-voice state: `ic1eq` and `ic2eq` for each channel. Cutoff range: 20 Hz to sampleRate×0.49.

---

### Q51. How does SamplerInstrument handle sample-accurate MIDI scheduling?

```swift
// SamplerInstrument.swift — Inner render loop
for f in 0..<outFrames {
    // Check MIDI event queue for events at this exact sample offset
    while let event = self.midiEventQueue.peek() {
        if Int(event.sampleOffset) == f {
            _ = self.midiEventQueue.pop()
            if event.isNoteOn {
                self.activeVoices.removeAll { $0.pitch == Int(event.pitch) }
                self.activeVoices.append(Voice(pitch: Int(event.pitch),
                    velocity: Float(event.velocity) / 127.0, currentFrame: startFrame))
            } else {
                // Note off: trigger release phase
                for i in 0..<self.activeVoices.count {
                    if self.activeVoices[i].pitch == Int(event.pitch) && !self.activeVoices[i].isReleasing {
                        self.activeVoices[i].isReleasing = true
                        self.activeVoices[i].releaseFrame = 0
                    }
                }
            }
        } else if Int(event.sampleOffset) < f {
            _ = self.midiEventQueue.pop()  // Late event, process immediately
        } else {
            break  // Future event
        }
    }
    // ... render all voices at sample f
}
```

---

### Q52. How does SamplerInstrument implement linear interpolation for sample playback?

```swift
// SamplerInstrument.swift
let pos = voice.currentFrame
let idx0 = Int(pos)
let frac = Float(pos - floor(pos))

// Read adjacent samples from head buffer or streaming tile
let s0_L = head.floatChannelData?[0][idx0] ?? 0
let s1_L = head.floatChannelData?[0][idx0 + 1] ?? 0

// Linear interpolation
let interpL = s0_L * (1.0 - frac) + s1_L * frac
```

**Formula**: `output = sample[i] × (1 - frac) + sample[i+1] × frac`

---

### Q53. How does the sampler handle fade-in/fade-out at clip boundaries?

```swift
// SamplerInstrument.swift
var ramp: Float = 1.0
let fadeFrames = max(10, (self._fadePercent / 100.0) * (endF - startF))

// Fade-in at start
if t < fadeFrames { ramp *= Float(t / fadeFrames) }

// Fade-out at end
let tFromEnd = endF - voice.currentFrame
if tFromEnd < fadeFrames { ramp *= Float(max(0, tFromEnd / fadeFrames)) }

let finalGain = vGain * ramp
```

**Minimum fade**: 10 samples. Linear ramp (not Hann, unlike QuantumDSP).

---

### Q54. How does ParametricEQ's 8-band configuration work?

```swift
// ParametricEQ.swift
public static let bandCount = 8

// Default Ableton EQ Eight frequencies
let defaultFreqs: [(Float, EQFilterType)] = [
    (30,    .lowCut),      // Band 0: High-pass (lowCut) at 30 Hz
    (100,   .lowShelf),    // Band 1: Low shelf at 100 Hz
    (250,   .parametric),  // Band 2: Parametric at 250 Hz
    (500,   .parametric),  // Band 3: Parametric at 500 Hz
    (1000,  .parametric),  // Band 4: Parametric at 1000 Hz
    (2500,  .parametric),  // Band 5: Parametric at 2500 Hz
    (6000,  .highShelf),   // Band 6: High shelf at 6000 Hz
    (16000, .highCut)      // Band 7: Low-pass (highCut) at 16000 Hz
]
// Bands 2-7 enabled by default; bands 0,1 bypassed

// Filter type mapping
func mapFilterType(_ type: EQFilterType) -> AVAudioUnitEQFilterType {
    switch type {
    case .lowCut:     return .highPass
    case .lowShelf:   return .lowShelf
    case .parametric: return .parametric
    case .highShelf:  return .highShelf
    case .highCut:    return .lowPass
    }
}
```

**EQ band parameters**: frequency (20-20000 Hz), gain (-12 to +12 dB), bandwidth (0.1-4.0 octaves).

---

### Q55. How does AudioLevelMeter implement lock-free RMS/Peak metering?

```swift
// AudioLevelMeter.swift — Lock-free storage
struct LockFreeLevel {
    var rms: Float = -160.0     // dB (floor = -160)
    var peak: Float = -160.0    // dB
    var clipping: Bool = false
}

// Audio thread writes:
let rmsLinear = sqrt(sumSquares / Float(frameCount))
let rmsDB = 20.0 * log10(max(rmsLinear, 1e-10))
let peakDB = 20.0 * log10(max(peakLinear, 1e-10))

// Atomic store (simplified)
atomicLevel.store(LockFreeLevel(rms: rmsDB, peak: peakDB, clipping: peakLinear >= 1.0))

// Main thread reads:
let level = atomicLevel.load()  // Tear-free read
```

**Clipping threshold**: peak ≥ 1.0 (0 dBFS). **Floor**: -160 dB.

---

### Q56. How does AudioLevelMeter compute FFT spectrum data?

```swift
// AudioLevelMeter.swift
struct LockFreeFFT {
    var magnitudes: [Float]  // FFT bin magnitudes (dB)
    let binCount: Int        // Typically 512 (1024-point FFT / 2)
}

// FFT processing on audio thread:
// 1. Apply Hann window to input block
// 2. Perform real-to-complex FFT via Accelerate vDSP
// 3. Compute magnitude: sqrt(re² + im²) for each bin
// 4. Convert to dB: 20 * log10(magnitude)
// 5. Store in LockFreeFFT via atomic swap

// Bin frequency: f = bin_index * sampleRate / fftSize
// Resolution: sampleRate / fftSize Hz per bin
```

---

### Q57. What is the AudioCommand enum used for lock-free engine control?

```swift
// AudioCommand.swift
public enum AudioCommand {
    case noteOn(pitch: Int, velocity: Int)
    case noteOff(pitch: Int)
    case allNotesOff
    case parameterChange(id: String, value: Float)
    case automationUpdate
}
```

Pushed from UI/main thread via `SPSCRingBuffer`, popped on audio thread — zero locks.

---

### Q58. How does the sampler handle D-Stream crossfade between header and tiles?

```swift
// SamplerInstrument.swift
if pos < Double(head.frameLength - 1) {
    // Read from HEAD buffer (in RAM, instant)
    s0_L = head.floatChannelData?[0][idx0] ?? 0
    s1_L = head.floatChannelData?[0][idx0 + 1] ?? 0
} else if let tile = voice.currentTile,
          pos >= Double(voice.tileStartFrame),
          pos < Double(voice.tileStartFrame + Int64(tile.frameLength) - 1) {
    // Read from STREAMING TILE
    let relPos = pos - Double(voice.tileStartFrame)
    let idx0 = Int(relPos)
    s0_L = tile.floatChannelData?[0][idx0] ?? 0
    s1_L = tile.floatChannelData?[0][idx0 + 1] ?? 0
} else if let url = self.sampleURL {
    // Request next tile from TileEngine (real-time safe pop)
    if let newTile = TileEngine.shared.readNextBuffer(url: url) {
        voice.currentTile = newTile
        voice.tileStartFrame = Int64(pos)
    }
}
```

Header size: 16384 frames (~0.37s @ 44.1kHz). Streaming tiles: 65536 frames (~1.5s each).

---

### Q59. What are the SamplerMode playback modes?

```swift
// AudioEffect.swift
public enum SamplerMode: String, Codable {
    case classic = "classic"   // Loop when reaching end (wraps position)
    case oneShot = "oneShot"   // Play once, ignore noteOff
    case slice   = "slice"     // Beat-sliced (future)
}

// In render loop:
if self.activeVoices[i].currentFrame >= endF {
    if mode == .classic {
        // Wrap: restart from beginning
        self.activeVoices[i].currentFrame = startF + (self.activeVoices[i].currentFrame - endF)
    } else {
        // oneShot: remove voice
        self.activeVoices.remove(at: i); continue
    }
}
```

---

### Q60. What is the InstrumentConfig's complete parameter set?

```swift
// AudioEffect.swift — InstrumentConfig
public var instrumentType: InstrumentType  // sineSynth, sampler, vst2, vst3
public var gain: Float                     // 0.0 ... 2.0 (default 1.0)
public var startPercent: Double            // 0.0 ... 100.0
public var endPercent: Double              // 0.0 ... 100.0
public var loopPercent: Double             // 0.0 ... 100.0
public var fadePercent: Double             // 0.0 ... 100.0

// ADSR
public var attack: Double    // Default: 0.001s
public var decay: Double     // Default: 0.6s
public var sustain: Double   // Default: 1.0 (0.0...1.0)
public var release: Double   // Default: 0.05s

// Filter
public var filterEnabled: Bool      // Default: false
public var filterType: Int          // 0=LowPass, 1=HighPass
public var filterCutoff: Double     // 20...22000 Hz (default: 1000)
public var filterResonance: Double  // 0.0...1.0 (default: 0.2)

// LFO
public var lfoRate: Double          // Hz (default: 1.0)
public var lfoAmount: Double        // 0.0...1.0 (default: 0.0)
public var lfoType: Int             // 0=Sine, 1=Triangle

// External
public var pluginIdentifier: String?  // VST path/identifier
```

---

### Q61. What is the AudioEffectConfig's complete parameter set?

```swift
// AudioEffect.swift — AudioEffectConfig
// EQ
public var eqBands: [EQBandConfig]          // 8 bands

// Compressor
public var threshold: Float = -20.0         // dB
public var ratio: Float = 2.0               // :1
public var attack: Float = 0.003            // Seconds
public var release: Float = 0.05            // Seconds

// Delay
public var delayTime: Double = 0.25         // Seconds
public var feedback: Float = 30.0           // %
public var wetDryMix: Float = 20.0          // %

// Reverb
public var reverbPreset: Int = 0            // Factory Preset Index
public var reverbMix: Float = 30.0          // %

// Utility
public var gainDB: Float = 0.0             // -60...+6 dB
```

---

### Q62. How does the SamplerInstrument apply master gain via SIMD/vDSP?

```swift
// SamplerInstrument.swift — After mixing all voices
// vDSP scalar multiply: output = accumulator × gain
if outChannels > 0 {
    vDSP_vsmul(accumL, 1, [targetGain],
        ablPointer[0].mData!.assumingMemoryBound(to: Float.self), 1,
        vDSP_Length(outFrames))
}
if outChannels > 1 {
    vDSP_vsmul(accumR, 1, [targetGain],
        ablPointer[1].mData!.assumingMemoryBound(to: Float.self), 1,
        vDSP_Length(outFrames))
}
```

`vDSP_vsmul` applies a scalar multiply across the entire buffer in one vectorized call.

---

### Q63. How does AudioClip synchronize beat-based and sample-based positions?

```swift
// AudioClip.swift
public mutating func synchronize(with pulseMap: PulseMap) {
    self.absolutePosition = AbsoluteTime(sampleFrame: pulseMap.sampleFrame(at: position.beats))
    self.absoluteDuration = AbsoluteTime(sampleFrame: pulseMap.durationInSamples(
        beats: duration.beats, startingAt: absolutePosition.sampleFrame))
}
```

Called whenever BPM changes or clips are edited, keeping the sample-accurate engine data in sync.

---

### Q64. What is the MidiNote data model?

```swift
// MidiClip.swift
public struct MidiNote: Identifiable, Codable, Hashable, Sendable {
    public let id: UUID
    public var pitch: Int          // 0-127 (60 = C3)
    public var velocity: Int       // 0-127
    public var position: TimePosition  // Start position in beats
    public var duration: TimePosition  // Duration in beats (default: 0.25 = 16th note)
}
```

---

### Q65. What is the MidiClip data model and how does it synchronize?

```swift
// MidiClip.swift
public struct MidiClip: Identifiable, Codable, Hashable, Sendable {
    public let id: UUID
    public var name: String
    public var position: TimePosition
    public var duration: TimePosition
    public var notes: [MidiNote]
    public var absolutePosition: AbsoluteTime   // Engine source of truth
    public var absoluteDuration: AbsoluteTime
    public var isSelected: Bool
    public var colorOverride: TrackColor?

    public mutating func synchronize(with pulseMap: PulseMap) {
        self.absolutePosition = AbsoluteTime(sampleFrame: pulseMap.sampleFrame(at: position.beats))
        self.absoluteDuration = AbsoluteTime(sampleFrame: pulseMap.durationInSamples(
            beats: duration.beats, startingAt: absolutePosition.sampleFrame))
    }
}
```

---

## SECTION 5 — PROJECT INFRASTRUCTURE & AUTOMATION (Q66–Q85)

---

### Q66. How is loop mode represented and used?

```swift
// Project.swift
@Published public var isLooping: Bool = false
@Published public var loopStart: TimePosition = TimePosition(beats: 0)
@Published public var loopEnd: TimePosition = TimePosition(beats: 16)

// Engine playback: wrap playhead when crossing loopEnd
if isLooping && currentSample >= loopEndSample {
    let loopLengthSamples = loopEndSample - loopStartSample
    currentSample = loopStartSample + ((currentSample - loopStartSample) % loopLengthSamples)
}
```

---

### Q67. What is the complete Project model schema?

```swift
// Project.swift
public final class Project: ObservableObject, Identifiable, Codable {
    public let id: UUID
    @Published public var name: String
    @Published public var bpm: Double = 120.0
    @Published public var sampleRate: Double = 44100.0
    @Published public var timeSignature: TimeSignature = TimeSignature(numerator: 4, denominator: 4)
    @Published public var tracks: [Track] = []
    @Published public var masterTrack: Track = Track(name: "Master", trackType: .master)

    // Playback
    @Published public var isPlaying: Bool = false
    @Published public var isRecording: Bool = false
    @Published public var playheadPosition: TimePosition = .zero
    @Published public var isLooping: Bool = false
    @Published public var loopStart: TimePosition = TimePosition(beats: 0)
    @Published public var loopEnd: TimePosition = TimePosition(beats: 16)

    // Selection (see Q34)
    @Published public var selectedTrackIDs: Set<UUID> = []
    @Published public var selectedClipIDs: Set<UUID> = []

    // Zoom & View
    @Published public var zoomLevel: Double = 1.0
    @Published public var gridSubdivision: GridSubdivision = .beat
}
```

---

### Q68. How does AudioClip.offsetForPlayback compute the read position in the source file?

```swift
// AudioClip.swift
public func sourceOffsetInSamples(at playheadSample: Int64) -> Int64 {
    let offsetFromClipStart = playheadSample - absolutePosition.sampleFrame
    let sourceStart = trimStartOffset.toAbsolute(bpm: /* project bpm */, sampleRate: /* sr */).sampleFrame
    return sourceStart + offsetFromClipStart
}
```

This accounts for the trim start offset — if a user trims a clip's left edge, the read position shifts into the source file.

---

### Q69. What AudioClip properties support gain and stretch?

```swift
// AudioClip.swift
public var gain: Float = 1.0           // Linear gain
public var isWarped: Bool = false       // Time-stretch engaged
public var stretchFactor: Double = 1.0  // 1.0 = original speed
public var warpMarkers: [WarpMarker] = []

// Stretch limits
let minStretch = 0.25  // 4x slower
let maxStretch = 4.0   // 4x faster
```

---

### Q70. How does the Track model handle audio effects chain ordering?

```swift
// Track.swift
public var effects: [AudioEffectConfig] = []

// Effects are processed in array order: effects[0] → effects[1] → ... → output
// Each AudioEffectConfig has:
//   - effectType: AudioEffectType (eq, compressor, reverb, delay, utility)
//   - isEnabled: Bool (bypass)
//   - Specific parameters per type

// Adding/removing/reordering: standard array operations
public mutating func addEffect(_ config: AudioEffectConfig) { effects.append(config) }
public mutating func removeEffect(at index: Int) { effects.remove(at: index) }
public mutating func moveEffect(from: Int, to: Int) { effects.move(fromOffsets: [from], toOffset: to) }
```

---

### Q71. What AudioEffectTypes are supported?

```swift
// AudioEffect.swift
public enum AudioEffectType: String, Codable {
    case eq = "eq"              // ParametricEQ (8-band)
    case compressor = "compressor"
    case reverb = "reverb"
    case delay = "delay"
    case utility = "utility"    // Gain + phase inversion
    case vst2 = "vst2"
    case vst3 = "vst3"
    case audioUnit = "audioUnit"
}
```

---

### Q72. How does EQBandConfig specify individual EQ bands?

```swift
// AudioEffect.swift
public struct EQBandConfig: Codable, Hashable, Sendable {
    public var frequency: Float  = 1000.0  // Hz
    public var gain: Float       = 0.0     // dB (-12...+12)
    public var bandwidth: Float  = 1.0     // Octaves (0.1...4.0)
    public var filterType: EQFilterType = .parametric
    public var isEnabled: Bool   = true
}

public enum EQFilterType: String, Codable {
    case lowCut     // High-pass
    case lowShelf
    case parametric // Bell curve
    case highShelf
    case highCut    // Low-pass
}
```

---

### Q73. How does TimeRange represent and manipulate beat ranges?

```swift
// TimePosition.swift
public struct TimeRange: Codable, Hashable, Sendable {
    public var start: TimePosition
    public var end: TimePosition

    public var duration: TimePosition {
        TimePosition(beats: max(0, end.beats - start.beats))
    }

    public func contains(_ position: TimePosition) -> Bool {
        position.beats >= start.beats && position.beats < end.beats
    }

    public func overlaps(_ other: TimeRange) -> Bool {
        start.beats < other.end.beats && end.beats > other.start.beats
    }

    public func intersection(_ other: TimeRange) -> TimeRange? {
        let s = TimePosition(beats: max(start.beats, other.start.beats))
        let e = TimePosition(beats: min(end.beats, other.end.beats))
        guard s.beats < e.beats else { return nil }
        return TimeRange(start: s, end: e)
    }
}
```

---

### Q74. What arithmetic operations does TimePosition support?

```swift
// TimePosition.swift
public static func + (lhs: TimePosition, rhs: TimePosition) -> TimePosition {
    TimePosition(beats: lhs.beats + rhs.beats)
}
public static func - (lhs: TimePosition, rhs: TimePosition) -> TimePosition {
    TimePosition(beats: lhs.beats - rhs.beats)
}
public static func * (lhs: TimePosition, rhs: Double) -> TimePosition {
    TimePosition(beats: lhs.beats * rhs)
}
public static func / (lhs: TimePosition, rhs: Double) -> TimePosition {
    TimePosition(beats: lhs.beats / rhs)
}
public static func += (lhs: inout TimePosition, rhs: TimePosition) {
    lhs = TimePosition(beats: lhs.beats + rhs.beats)
}
```

---

### Q75. How does TimePosition convert to samples?

```swift
// TimePosition.swift
public func toSamples(bpm: Double, sampleRate: Double) -> Int64 {
    let seconds = beats * (60.0 / bpm)
    return Int64(seconds * sampleRate)
}

public static func fromSamples(_ samples: Int64, bpm: Double, sampleRate: Double) -> TimePosition {
    let seconds = Double(samples) / sampleRate
    let beats = seconds * (bpm / 60.0)
    return TimePosition(beats: beats)
}
```

---

### Q76. How does AbsoluteTime bridge to legacy TimePosition?

```swift
// AbsoluteTime.swift
public func toTimePosition(bpm: Double, sampleRate: Double) -> TimePosition {
    let beats = PulseMap(bpm: bpm, sampleRate: sampleRate).beats(at: sampleFrame)
    return TimePosition(beats: beats)
}

// TimePosition extension
public func toAbsolute(bpm: Double, sampleRate: Double = 44100) -> AbsoluteTime {
    let pulseMap = PulseMap(bpm: bpm, sampleRate: sampleRate)
    return AbsoluteTime(sampleFrame: pulseMap.sampleFrame(at: beats))
}
```

---

### Q77. How does PulseMap handle variable tempo (tempo automation)?

```swift
// PulseMap.swift — Designed for multiple tempo events
tempoEvents: [TempoEvent(sampleFrame: 0, beatPosition: 0, bpm: 120),
              TempoEvent(sampleFrame: 441_000, beatPosition: 8.0, bpm: 140)]

// Binary search finds active event: O(log N)
func activeEvent(at sampleFrame: Int64) -> TempoEvent {
    if tempoEvents.count == 1 { return tempoEvents[0] }  // Fast path
    var lo = 0, hi = tempoEvents.count - 1
    while lo < hi {
        let mid = lo + (hi - lo + 1) / 2
        if tempoEvents[mid].sampleFrame <= sampleFrame { lo = mid }
        else { hi = mid - 1 }
    }
    return tempoEvents[lo]
}
```

Each `TempoEvent` caches its `beatPosition` for O(1) within that segment.

---

### Q78. How does the SpatialHashGrid handle negative sample positions?

```swift
// SpatialHashGrid.swift
static func binIndex(for sampleFrame: Int64, binSize: Int64) -> Int {
    if sampleFrame < 0 {
        // Floor division for negative numbers
        return Int((sampleFrame - binSize + 1) / binSize)
    }
    return Int(sampleFrame / binSize)
}
```

This ensures bins extend properly into negative territory (before the timeline origin).

---

### Q79. How does SpatialHashGrid support 2D marquee selection?

```swift
// SpatialHashGrid.swift — 2D query
func query(startSample: Int64, endSample: Int64, trackRange: ClosedRange<Int>) -> Set<UUID> {
    // 1. Iterate temporal bins (same as 1D query)
    let startBin = Self.binIndex(for: startSample, binSize: binSizeSamples)
    let endBin = Self.binIndex(for: max(startSample, endSample - 1), binSize: binSizeSamples)

    for b in startBin...endBin {
        for id in bins[b] ?? [] {
            if let entry = entries[id],
               entry.startSample < endSample && entry.endSample > startSample &&
               trackRange.contains(entry.trackIndex) {  // ← Track range filter
                result.insert(id)
            }
        }
    }
}
```

---

### Q80. What thread safety mechanism does SpatialHashGrid use?

```swift
// SpatialHashGrid.swift
private var lock = os_unfair_lock()

// Every public method wraps with:
os_unfair_lock_lock(&lock)
defer { os_unfair_lock_unlock(&lock) }
```

`os_unfair_lock` is Apple's most lightweight spinlock — no priority inheritance overhead, suitable for very short critical sections (<μs). The Metal render thread can query concurrently with main-thread mutations.

---

### Q81. How does the QuadTree subdivide and what are its capacity limits?

```swift
// QuadTree.swift
let capacity: Int = 8    // Max elements before subdivision
let maxDepth: Int = 8    // Maximum tree depth

func subdivide() {
    let midX = bounds.x + bounds.width / 2
    let midY = bounds.y + bounds.height / 2

    children = [
        QuadTree(bounds: QuadRect(x: bounds.x, y: bounds.y,
            width: bounds.width/2, height: bounds.height/2), capacity: capacity, depth: depth+1, maxDepth: maxDepth),
        QuadTree(bounds: QuadRect(x: midX, y: bounds.y,
            width: bounds.width/2, height: bounds.height/2), capacity: capacity, depth: depth+1, maxDepth: maxDepth),
        QuadTree(bounds: QuadRect(x: bounds.x, y: midY,
            width: bounds.width/2, height: bounds.height/2), capacity: capacity, depth: depth+1, maxDepth: maxDepth),
        QuadTree(bounds: QuadRect(x: midX, y: midY,
            width: bounds.width/2, height: bounds.height/2), capacity: capacity, depth: depth+1, maxDepth: maxDepth),
    ]

    // Re-insert existing elements into children
    for element in elements { ... }
    elements.removeAll()
}
```

---

### Q82. How does the QuadTree query algorithm work?

```swift
// QuadTree.swift
func query(range: QuadRect) -> [QuadElement<T>] {
    guard QuadRect.intersects(bounds, range) else { return [] }

    var found: [QuadElement<T>] = []

    // Check own elements
    for element in elements {
        if QuadRect.intersects(element.bounds, range) {
            found.append(element)
        }
    }

    // Recurse into children
    if let children = children {
        for child in children {
            found.append(contentsOf: child.query(range: range))
        }
    }
    return found
}

static func intersects(_ a: QuadRect, _ b: QuadRect) -> Bool {
    a.x < b.x + b.width && a.x + a.width > b.x &&
    a.y < b.y + b.height && a.y + a.height > b.y
}
```

Standard AABB intersection.

---

### Q83. What is the ViewportMatrix's visible beat range calculation?

```swift
// ViewportMatrix.swift (computed)
public var visibleBeatRange: Range<Double> {
    let startBeats = pulseMap.beats(at: visibleStartSample)
    let endBeats = pulseMap.beats(at: visibleEndSample)
    return startBeats..<endBeats
}

// Legacy compat: for constant tempo only
public var pixelsPerBeat: Double {
    (60.0 / pulseMap.initialBPM) * pulseMap.sampleRate / samplesPerPixel
}
```

---

### Q84. How does the PlayheadInterpolator anchor to the audio thread?

```swift
// PlayheadInterpolator.swift
// Audio thread callback (typically every 512 samples / ~11ms @ 44.1kHz)
public func updateAnchor(sampleFrame: Int64) {
    os_unfair_lock_lock(&lock)
    anchorSampleFrame = sampleFrame
    anchorMachTime = mach_absolute_time()
    os_unfair_lock_unlock(&lock)
}

// UI thread reads via currentVisualSample() — see Q21
// mach_absolute_time → nanoseconds conversion
init() {
    var timebase = mach_timebase_info_data_t()
    mach_timebase_info(&timebase)
    timebaseNumer = UInt64(timebase.numer)
    timebaseDenom = UInt64(timebase.denom)
}
```

---

### Q85. How does TrackMixer handle solo logic?

```swift
// TrackMixer.swift — Solo exclusion
func recalculateSoloState(tracks: [Track]) {
    let anySoloed = tracks.contains { $0.isSoloed }

    for (index, track) in tracks.enumerated() {
        if anySoloed {
            // Only soloed tracks (and their group parents) produce audio
            let shouldPlay = track.isSoloed || isChildOfSoloedGroup(track, tracks: tracks)
            trackMixers[index].outputMixer.outputVolume = shouldPlay ? track.effectiveVolume : 0
        } else {
            // Normal: use mute state
            trackMixers[index].outputMixer.outputVolume = track.effectiveVolume
        }
    }
}
```

---

## SECTION 6 — ARCHITECTURE PATTERNS & PORTING GUIDE (Q86–Q100)

---

### Q86. What is the memory layout of ClipInstance for Metal buffer upload?

```swift
// MetalTimelineRenderer.swift — ClipInstance memory layout
// Total size: 52 bytes (13 × 4 bytes)
// OFFSET  TYPE       FIELD
// 0       Float      x
// 4       Float      y
// 8       Float      width
// 12      Float      height
// 16      Float      colorR
// 20      Float      colorG
// 24      Float      colorB
// 28      Float      colorA
// 32      UInt32     isSelected
// 36      UInt32     isPhantom
// 40      UInt32     isMuted
// 44      UInt32     waveformOffset
// 48      UInt32     waveformLength
```

For WebGPU porting: use `repr(C)` in Rust and ensure 4-byte alignment. The equivalent WGSL struct would use `f32` and `u32` fields.

---

### Q87. What is the Metal view-projection matrix format?

```swift
// MetalTimelineRenderer.swift
// Orthographic projection matrix for 2D timeline:
let left: Float = 0
let right: Float = viewportWidth
let top: Float = 0
let bottom: Float = viewportHeight
let near: Float = -1
let far: Float = 1

let viewProjection = float4x4(
    float4(2.0/(right-left), 0, 0, 0),
    float4(0, 2.0/(top-bottom), 0, 0),
    float4(0, 0, -2.0/(far-near), 0),
    float4(-(right+left)/(right-left), -(top+bottom)/(top-bottom), -(far+near)/(far-near), 1)
)
```

Standard orthographic projection. Top-left origin (y increases downward). Z range [-1, 1].

For WebGPU: Adjust to clip space [0, 1] for Z and ensure column-major layout with `mat4x4<f32>`.

---

### Q88. How should the unit quad pattern be ported to WebGPU?

```metal
// Original Metal: 6 vertices per instance (2 triangles)
float2 positions[6] = {
    {0,0}, {1,0}, {0,1},  // Triangle 1
    {1,0}, {1,1}, {0,1}   // Triangle 2
};
```

WebGPU equivalent using an index buffer (more efficient):
```wgsl
// 4 vertices + 6 indices
var<private> QUAD_POS: array<vec2f, 4> = array(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0),
    vec2f(0.0, 1.0), vec2f(1.0, 1.0)
);
var<private> QUAD_IDX: array<u32, 6> = array(0u, 1u, 2u, 1u, 3u, 2u);
```

---

### Q89. What is the complete list of constants needed for Rust porting?

```
// Time & Tempo
PPQN = 960                        // Ticks per quarter note
DEFAULT_BPM = 120.0
DEFAULT_SAMPLE_RATE = 44100.0

// Spatial Indexing
SPATIAL_HASH_BIN_SIZE = 441_000   // 10 seconds @ 44.1kHz
QUADTREE_CAPACITY = 8
QUADTREE_MAX_DEPTH = 8

// Rendering
CORNER_RADIUS = 4.0               // Clip rounded rect (pixels)
SELECTION_BRIGHTNESS_BOOST = 0.15  // RGB addition
PHANTOM_ALPHA = 0.5
MUTE_DESATURATION = 0.7           // Gray mix factor
MUTE_ALPHA = 0.6
WAVEFORM_AMPLITUDE_SCALE = 0.45   // Half-height multiplier

// Interaction
DRAG_THRESHOLD_POINTS = 4.0       // Min distance before drag commits
EDGE_THRESHOLD_PIXELS = 8.0       // Trim handle width
MAGNETIC_RADIUS_PIXELS = 8.0      // Snap zone

// DSP
HANN_FADE_LENGTH = 256            // Micro-fade samples
TILE_SIZE = 65536                 // Disk streaming tile
HEADER_SIZE = 16384               // D-Stream header
RING_BUFFER_CAPACITY = 8          // Tiles buffered

// Metering
METER_FLOOR_DB = -160.0
CLIP_THRESHOLD = 1.0              // 0 dBFS
FFT_BIN_COUNT = 512               // 1024-point FFT

// Audio
MIN_FADER_DB = -80.0
MAX_FADER_DB = 6.0
ZERO_GAIN_THRESHOLD = 0.00001
RAMP_DURATION_SECONDS = 0.020     // De-zippering
MIN_CLIP_DURATION_BEATS = 0.01
MIN_STRETCH_RATE = 0.25
MAX_STRETCH_RATE = 4.0

// EQ
EQ_BAND_COUNT = 8
DEFAULT_EQ_FREQS = [30, 100, 250, 500, 1000, 2500, 6000, 16000]

// Sampler ADSR
DEFAULT_ATTACK = 0.001            // Seconds
DEFAULT_DECAY = 0.6
DEFAULT_SUSTAIN = 1.0
DEFAULT_RELEASE = 0.05

// Waveform Cache
MAX_CACHE_ENTRIES = 128
CACHE_EXPIRY_DAYS = 7
READ_CHUNK_SIZE = 65536
BAND_LOW_CUTOFF = 300.0           // Hz
BAND_HIGH_CUTOFF = 4000.0         // Hz
```

---

### Q90. What are the thread-safety patterns to replicate in Rust?

| Swift Pattern | Rust Equivalent |
|---|---|
| `os_unfair_lock` (SpatialHashGrid, PlayheadInterpolator) | `parking_lot::Mutex` or `spin::Mutex` |
| `SPSCRingBuffer<T>` (audio commands) | `ringbuf::HeapRb` or custom `crossbeam` SPSC |
| `AtomicBool / AtomicInt` (LockFreeLevel) | `std::sync::atomic::{AtomicBool, AtomicI64}` |
| `DispatchQueue(serial)` (TileEngine management) | `tokio::sync::mpsc` channel |
| `Task.detached` (producer loop) | `tokio::spawn` or `std::thread::spawn` |
| `@unchecked Sendable` | Wrap in `unsafe impl Send + Sync` |

---

### Q91. How should the SDF rounded rect be ported to WGSL?

```wgsl
fn sdf_rounded_rect(uv: vec2f, size: vec2f, radius: f32) -> f32 {
    let half_size = size * 0.5;
    let d = abs(uv - half_size) - (half_size - radius);
    return length(max(d, vec2f(0.0))) + min(max(d.x, d.y), 0.0) - radius;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
    let pixel_pos = vec2f(in.uv.x * in.clip_width, in.uv.y * in.clip_height);
    let dist = sdf_rounded_rect(pixel_pos, vec2f(in.clip_width, in.clip_height), 4.0);
    let edge_alpha = 1.0 - smoothstep(-1.0, 0.0, dist);
    var color = vec4f(in.color_r, in.color_g, in.color_b, in.color_a * edge_alpha);
    return color;
}
```

---

### Q92. How should the Butterworth biquad filter be ported to Rust?

```rust
// Rust equivalent of WaveformCache band-splitting
struct BiquadFilter {
    b0: f64, b1: f64, b2: f64,
    a1: f64, a2: f64,
    x1: f64, x2: f64,
    y1: f64, y2: f64,
}

impl BiquadFilter {
    fn lowpass(cutoff: f64, sample_rate: f64) -> Self {
        let omega = 2.0 * std::f64::consts::PI * cutoff / sample_rate;
        let cos_w = omega.cos();
        let sin_w = omega.sin();
        let alpha = sin_w / (2.0 * std::f64::consts::SQRT_2);
        let a0 = 1.0 + alpha;

        Self {
            b0: ((1.0 - cos_w) / 2.0) / a0,
            b1: (1.0 - cos_w) / a0,
            b2: ((1.0 - cos_w) / 2.0) / a0,
            a1: (-2.0 * cos_w) / a0,
            a2: (1.0 - alpha) / a0,
            x1: 0.0, x2: 0.0, y1: 0.0, y2: 0.0,
        }
    }

    fn process(&mut self, x: f64) -> f64 {
        let y = self.b0 * x + self.b1 * self.x1 + self.b2 * self.x2
              - self.a1 * self.y1 - self.a2 * self.y2;
        self.x2 = self.x1; self.x1 = x;
        self.y2 = self.y1; self.y1 = y;
        y
    }
}
```

---

### Q93. How should the Chamberlin SVF filter be ported to Rust?

```rust
// Direct port of SamplerInstrument.swift SVF
struct SvfState { ic1eq: f32, ic2eq: f32 }

fn svf_lowpass(input: f32, cutoff: f64, resonance: f64, sr: f64, state: &mut SvfState) -> f32 {
    let g = (std::f64::consts::PI * cutoff / sr).tan() as f32;
    let k = (2.0 * (1.0 - resonance)) as f32;
    let a1 = 1.0 / (1.0 + g * (g + k));
    let a2 = g * a1;
    let a3 = g * a2;

    let v3 = input - state.ic2eq;
    let v1 = a1 * state.ic1eq + a2 * v3;
    let v2 = state.ic2eq + a2 * state.ic1eq + a3 * v3;
    state.ic1eq = 2.0 * v1 - state.ic1eq;
    state.ic2eq = 2.0 * v2 - state.ic2eq;
    v2  // low-pass output
}
```

---

### Q94. How should the Hann micro-fade be ported to Rust?

```rust
// Direct port of QuantumDSP.swift
fn generate_hann_fade_in(length: usize) -> Vec<f32> {
    (0..length).map(|i| {
        0.5 * (1.0 - (std::f32::consts::PI * i as f32 / length as f32).cos())
    }).collect()
}

fn apply_fade_in(buffer: &mut [f32], fade: &[f32]) {
    let n = buffer.len().min(fade.len());
    for i in 0..n {
        buffer[i] *= fade[i];
    }
}
```

For SIMD: use `packed_simd2` or `std::simd` (nightly) for vectorized multiply.

---

### Q95. How should the PulseMap be ported to Rust?

```rust
#[derive(Clone)]
pub struct PulseMap {
    events: Vec<TempoEvent>,
    sample_rate: f64,
}

#[derive(Clone, Copy)]
pub struct TempoEvent {
    pub sample_frame: i64,
    pub beat_position: f64,
    pub bpm: f64,
}

impl PulseMap {
    pub fn beats_at(&self, sample_frame: i64) -> f64 {
        let event = self.active_event_at_sample(sample_frame);
        let delta_samples = (sample_frame - event.sample_frame) as f64;
        let delta_seconds = delta_samples / self.sample_rate;
        event.beat_position + delta_seconds * (event.bpm / 60.0)
    }

    pub fn sample_at(&self, beats: f64) -> i64 {
        let event = self.active_event_at_beat(beats);
        let delta_beats = beats - event.beat_position;
        let delta_seconds = delta_beats * (60.0 / event.bpm);
        event.sample_frame + (delta_seconds * self.sample_rate).round() as i64
    }

    fn active_event_at_sample(&self, sf: i64) -> TempoEvent {
        if self.events.len() == 1 { return self.events[0]; }
        // Binary search...
        let idx = self.events.partition_point(|e| e.sample_frame <= sf);
        self.events[idx.saturating_sub(1).max(0)]
    }
}
```

---

### Q96. How should the SpatialHashGrid be ported to Rust?

```rust
use std::collections::{HashMap, HashSet};
use uuid::Uuid;
use parking_lot::Mutex;

pub struct SpatialHashGrid {
    bin_size: i64,  // 441_000
    bins: Mutex<HashMap<i64, HashSet<Uuid>>>,
    entries: Mutex<HashMap<Uuid, ClipEntry>>,
}

pub struct ClipEntry {
    pub clip_id: Uuid,
    pub track_index: usize,
    pub start_sample: i64,
    pub end_sample: i64,
}

impl SpatialHashGrid {
    fn bin_index(sample: i64, bin_size: i64) -> i64 {
        if sample < 0 { (sample - bin_size + 1) / bin_size }
        else { sample / bin_size }
    }
}
```

---

### Q97. What is the complete data flow from user click to model mutation?

```
1. NSEvent.mouseDown → TimelineInteractionCoordinator.mouseDown()
2. Coordinator computes sampleFrame and trackIndex from viewport
3. SpatialHashGrid.hitTest() → finds clip UUID (or nil for empty space)
4. Edge proximity check (8px threshold) → determines trim vs drag vs marquee
5. InteractionStateMachine enters pendingDrag/trimming/marqueeSelecting state
6. NSEvent.mouseDragged → StateMachine accumulates phantom deltas
7. MagneticGrid.calculateSnapDelta() → snaps delta to nearest grid line
8. Renderer reads phantomOverlay → draws semi-transparent clip at projected position
9. NSEvent.mouseUp → StateMachine calls delegate.commitClipMove/Trim/Stretch
10. Delegate mutates Project model (single undo checkpoint)
11. SpatialHashGrid.rebuild() → re-indexes after model change
12. MetalTimelineRenderer.draw() → renders final positions
```

---

### Q98. What is the complete audio signal chain per track?

```
Source → [Instrument/Player] → [PDC Delay] → [TimePitch] → [Insert 0] → [Insert 1] →
  [Insert 2] → [Insert 3] → [Output Mixer (vol/pan)] → [Group Bus or Master]
```

```swift
// TrackMixer.swift — Node chain
playerNode → pdcDelayNode → timePitchNode →
  insertSlot[0] → insertSlot[1] → insertSlot[2] → insertSlot[3] →
  outputMixer → (group bus || master mixer)
```

---

### Q99. What is the complete render frame lifecycle?

```
1. PlayheadInterpolator.currentVisualSample() → extrapolated playhead position
2. ViewportMatrix.anchorZoom() / scroll → updated viewport state
3. SpatialHashGrid.query(visibleRange) → visible clip UUIDs
4. For each visible clip:
   a. Compute ClipInstance (position, color, state flags)
   b. WaveformCache.getWaveform() → peak data at current zoom level
   c. Append to instance buffer
5. For each MIDI clip: compute MidiNoteInstance for visible notes
6. PhantomOverlay: append phantom instances if dragging
7. Upload instance buffers to Metal/WebGPU
8. Draw call: timeline pipeline (clips) + note pipeline (MIDI)
9. Draw playhead line, rulers, grid lines (separate passes)
```

---

### Q100. What is the recommended Rust crate mapping for the complete port?

| Swift Component | Recommended Rust Crate |
|---|---|
| AVAudioEngine | `cpal` + `dasp` |
| AVAudioPCMBuffer | `dasp::Frame` or raw `Vec<f32>` |
| AVAudioUnitEQ | Custom biquad filter bank |
| AVAudioUnitTimePitch | `rubato` (high-quality resampling) |
| Metal / MSL | `wgpu` + WGSL shaders |
| vDSP | `realfft` + `rustfft` for FFT; manual SIMD for multiply |
| os_unfair_lock | `parking_lot::Mutex` |
| SPSCRingBuffer | `ringbuf::HeapRb` or `crossbeam-channel` |
| mach_absolute_time | `std::time::Instant` (platform-agnostic) |
| Codable (JSON) | `serde` + `serde_json` |
| UUID | `uuid` crate |
| ObservableObject | Custom event system or `tokio::watch` channels |
| Task.detached | `tokio::spawn` |
| DispatchQueue | `tokio::sync::mpsc` |

---

## END OF DOCUMENT

Total: 100 questions answered with original Swift/Metal code, formulas, constants, and Rust porting guides.

Source files analyzed (28 total):
- DreamDAWModels: TimePosition, QuadTree, ViewportMatrix, AudioClip, MidiClip, Track, Project, AudioEffect, WarpMarker, MagneticGrid, PulseMap, AbsoluteTime, SpatialHashGrid
- DreamDAWUI: MetalTimelineRenderer, WaveformShaders.metal, TimelineInteractionCoordinator, InteractionStateMachine
- DreamDAWEngine: TrackMixer, QuantumDSP, SimpleSynthInstrument, AudioLevelMeter, PlayheadInterpolator, WaveformCache, SamplerInstrument, SPSCRingBuffer, PDCEngine, TileEngine, ParametricEQ
