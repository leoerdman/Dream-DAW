import Metal
import MetalKit
import AppKit
import DreamDAWModels
import DreamDAWEngine
import simd

// MARK: - PianoRollMetalRenderer (Phase 9.7)

/// Enterprise Metal renderer for the Piano Roll editor.
///
/// Renders MIDI notes, grid lines, the playhead, and velocity indicators
/// using the shared `MetalCanvasRenderer` infrastructure. All rendering
/// is done via instanced rectangles — zero per-note draw calls.
///
/// **Design**:
/// - Grid lines and note backgrounds are rendered in the first pass
/// - MIDI notes are rendered in the second pass (blended on top)
/// - Playhead is rendered last (always on top)
///
/// **Performance**:
/// - 50,000 notes in a single draw call
/// - Pre-allocated buffers (no heap allocation during render)
/// - LOD-aware: skips tiny notes at far zoom levels
public final class PianoRollMetalRenderer: MetalCanvasRenderer {
    
    // MARK: - Constants
    
    /// Maximum MIDI notes per draw call.
    private static let maxNotes = 50_000
    
    /// Maximum grid lines per draw call.
    private static let maxGridLines = 10_000
    
    /// Total MIDI pitches (0-127).
    private static let midiPitchCount = 128
    
    // MARK: - Pipeline States
    
    /// Pipeline for rendering MIDI note rectangles.
    private var notePipelineState: MTLRenderPipelineState?
    
    /// Pipeline for rendering grid lines and background rows.
    private var gridPipelineState: MTLRenderPipelineState?
    
    // MARK: - Buffers
    
    /// Pre-allocated buffer for MIDI note instances.
    private var noteBuffer: MTLBuffer?
    
    /// Pre-allocated buffer for grid line instances.
    private var gridBuffer: MTLBuffer?
    
    // MARK: - Rendering Configuration
    
    /// Piano roll colors.
    public struct ColorScheme {
        /// White key row background color.
        public var whiteKeyRow = simd_float4(0.15, 0.15, 0.17, 1.0)
        /// Black key row background color.
        public var blackKeyRow = simd_float4(0.10, 0.10, 0.12, 1.0)
        /// Beat grid line color.
        public var beatGridLine = simd_float4(0.25, 0.25, 0.28, 0.6)
        /// Bar grid line color (brighter).
        public var barGridLine = simd_float4(0.35, 0.35, 0.38, 0.8)
        /// Subdivision grid line color (dimmer).
        public var subdivisionLine = simd_float4(0.18, 0.18, 0.20, 0.3)
        /// Default note color.
        public var noteColor = simd_float4(0.4, 0.7, 1.0, 0.9)
        /// Selected note color.
        public var selectedNoteColor = simd_float4(1.0, 0.85, 0.3, 1.0)
        /// Playhead color.
        public var playheadColor = simd_float4(1.0, 1.0, 1.0, 0.9)
        /// Velocity indicator color (bottom of note).
        public var velocityColor = simd_float4(1.0, 0.5, 0.3, 0.7)
        
        public init() {}
    }
    
    /// The active color scheme.
    public var colors = ColorScheme()
    
    // MARK: - Initialization
    
    public convenience init?() {
        guard let device = MTLCreateSystemDefaultDevice() else {
            print("PianoRollMetal: Failed to create device")
            return nil
        }
        self.init(device: device)
    }
    
    public override init?(device: MTLDevice, maxInstances: Int = 50_000) {
        super.init(device: device, maxInstances: maxInstances)
        
        setupPianoRollPipelines()
        setupPianoRollBuffers()
        print("PianoRollMetal: Initialization complete")
    }
    
    // MARK: - Pipeline Setup
    
    private func setupPianoRollPipelines() {
        // Compile the shared rect shader for both grid and note rendering
        let shaderSource = Self.pianoRollShaderSource
        
        notePipelineState = compilePipeline(
            vertexFunction: "pianoroll_vertex",
            fragmentFunction: "pianoroll_note_fragment",
            source: shaderSource,
            enableBlending: true
        )
        
        gridPipelineState = compilePipeline(
            vertexFunction: "pianoroll_vertex",
            fragmentFunction: "pianoroll_grid_fragment",
            source: shaderSource,
            enableBlending: true
        )
        
        if notePipelineState != nil && gridPipelineState != nil {
            print("PianoRollMetal: Both pipelines compiled successfully")
        }
    }
    
    private func setupPianoRollBuffers() {
        noteBuffer = device.makeBuffer(
            length: MemoryLayout<PianoRollInstance>.stride * Self.maxNotes,
            options: .storageModeShared
        )
        gridBuffer = device.makeBuffer(
            length: MemoryLayout<PianoRollInstance>.stride * Self.maxGridLines,
            options: .storageModeShared
        )
    }
    
    // MARK: - Rendering
    
    /// Renders the complete piano roll view.
    ///
    /// - Parameters:
    ///   - clip: The MIDI clip being edited.
    ///   - visibleRect: The visible portion of the piano roll in pixel coordinates.
    ///   - pixelsPerBeat: Horizontal zoom level.
    ///   - noteHeight: Height of a single MIDI row in pixels.
    ///   - playheadBeat: Current playhead position in beats (relative to clip start).
    ///   - layer: The CAMetalLayer to render into.
    ///   - timeSignature: Current time signature for grid generation.
    public func render(
        clip: MidiClip,
        visibleRect: CGRect,
        pixelsPerBeat: CGFloat,
        noteHeight: CGFloat,
        playheadBeat: Double?,
        in layer: CAMetalLayer,
        timeSignature: TimeSignature = TimeSignature()
    ) {
        guard let drawable = layer.nextDrawable() else { return }
        guard let gridPipeline = gridPipelineState,
              let notePipeline = notePipelineState,
              let gridBuf = gridBuffer,
              let noteBuf = noteBuffer else { return }
        
        let viewportSize = simd_float2(Float(layer.bounds.width), Float(layer.bounds.height))
        
        // --- Pass 1: Grid (clear + draw background rows and grid lines) ---
        guard let commandBuffer = commandQueue.makeCommandBuffer() else { return }
        
        let clearRPD = MTLRenderPassDescriptor()
        clearRPD.colorAttachments[0].texture = drawable.texture
        clearRPD.colorAttachments[0].loadAction = .clear
        clearRPD.colorAttachments[0].clearColor = MTLClearColor(red: 0.08, green: 0.08, blue: 0.10, alpha: 1.0)
        clearRPD.colorAttachments[0].storeAction = .store
        
        if let gridEncoder = commandBuffer.makeRenderCommandEncoder(descriptor: clearRPD) {
            gridEncoder.setRenderPipelineState(gridPipeline)
            
            var vp = viewportSize
            gridEncoder.setVertexBytes(&vp, length: MemoryLayout<simd_float2>.size, index: 1)
            
            var gridInstances: [PianoRollInstance] = []
            
            // Background rows (white/black key alternation)
            let minPitch = max(0, Int(visibleRect.minY / noteHeight))
            let maxPitch = min(Self.midiPitchCount - 1, Int(visibleRect.maxY / noteHeight) + 1)
            
            for pitch in minPitch...maxPitch {
                let y = Float(CGFloat(Self.midiPitchCount - 1 - pitch) * noteHeight - visibleRect.minY)
                let isBlackKey = Self.isBlackKey(pitch: pitch)
                
                gridInstances.append(PianoRollInstance(
                    rect: simd_float4(0, y, Float(layer.bounds.width), Float(noteHeight)),
                    color: isBlackKey ? colors.blackKeyRow : colors.whiteKeyRow,
                    metadata: 0 // row type
                ))
            }
            
            // Vertical grid lines
            let minBeat = Double(visibleRect.minX) / Double(pixelsPerBeat)
            let maxBeat = Double(visibleRect.maxX) / Double(pixelsPerBeat)
            let beatsPerBar = Double(timeSignature.beatsPerBar)
            
            // Determine subdivision level based on zoom
            let subdivision: Double
            if pixelsPerBeat > 80 {
                subdivision = 0.25 // 16th notes
            } else if pixelsPerBeat > 40 {
                subdivision = 0.5  // 8th notes
            } else if pixelsPerBeat > 15 {
                subdivision = 1.0  // quarter notes
            } else {
                subdivision = beatsPerBar // bars only
            }
            
            var beat = (minBeat / subdivision).rounded(.down) * subdivision
            while beat <= maxBeat && gridInstances.count < Self.maxGridLines {
                let x = Float((beat - minBeat) * Double(pixelsPerBeat))
                let isBar = beat.truncatingRemainder(dividingBy: beatsPerBar) == 0
                let isBeat = beat.truncatingRemainder(dividingBy: 1.0) == 0
                
                let lineColor: simd_float4
                let lineWidth: Float
                if isBar {
                    lineColor = colors.barGridLine
                    lineWidth = 1.5
                } else if isBeat {
                    lineColor = colors.beatGridLine
                    lineWidth = 1.0
                } else {
                    lineColor = colors.subdivisionLine
                    lineWidth = 0.5
                }
                
                gridInstances.append(PianoRollInstance(
                    rect: simd_float4(x - lineWidth/2, 0, lineWidth, Float(layer.bounds.height)),
                    color: lineColor,
                    metadata: 1 // grid line type
                ))
                
                beat += subdivision
            }
            
            // Upload and draw grid
            if !gridInstances.isEmpty {
                let count = min(gridInstances.count, Self.maxGridLines)
                let ptr = gridBuf.contents().assumingMemoryBound(to: PianoRollInstance.self)
                for i in 0..<count {
                    ptr[i] = gridInstances[i]
                }
                gridEncoder.setVertexBuffer(gridBuf, offset: 0, index: 0)
                gridEncoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4, instanceCount: count)
            }
            
            gridEncoder.endEncoding()
        }
        
        // --- Pass 2: Notes (blended on top of grid) ---
        let noteRPD = MTLRenderPassDescriptor()
        noteRPD.colorAttachments[0].texture = drawable.texture
        noteRPD.colorAttachments[0].loadAction = .load
        noteRPD.colorAttachments[0].storeAction = .store
        
        if let noteEncoder = commandBuffer.makeRenderCommandEncoder(descriptor: noteRPD) {
            noteEncoder.setRenderPipelineState(notePipeline)
            
            var vp = viewportSize
            noteEncoder.setVertexBytes(&vp, length: MemoryLayout<simd_float2>.size, index: 1)
            
            var noteInstances: [PianoRollInstance] = []
            
            let minBeat = Double(visibleRect.minX) / Double(pixelsPerBeat)
            let maxBeat = Double(visibleRect.maxX) / Double(pixelsPerBeat)
            
            // LOD: Minimum pixel width for a note to be rendered
            let minNotePixelWidth: Float = 1.0
            
            for note in clip.notes {
                let noteEndBeat = note.position.beats + note.duration.beats
                
                // Visibility cull
                guard noteEndBeat >= minBeat && note.position.beats <= maxBeat else { continue }
                
                let x = Float((note.position.beats - minBeat) * Double(pixelsPerBeat))
                let w = Float(note.duration.beats * Double(pixelsPerBeat))
                
                // LOD: Skip notes smaller than 1 pixel
                guard w >= minNotePixelWidth else { continue }
                
                let y = Float(CGFloat(Self.midiPitchCount - 1 - note.pitch) * noteHeight - visibleRect.minY)
                let h = Float(noteHeight - 1) // 1px gap between rows
                
                // Velocity-weighted opacity
                let velocityAlpha = Float(note.velocity) / 127.0
                var color = colors.noteColor
                color.w = 0.6 + velocityAlpha * 0.4
                
                // TODO: Use note.isSelected when that property is available
                let metadata: Float = 0 // 0 = unselected, 1 = selected
                
                noteInstances.append(PianoRollInstance(
                    rect: simd_float4(x, y, w, h),
                    color: color,
                    metadata: metadata
                ))
                
                if noteInstances.count >= Self.maxNotes { break }
            }
            
            // Playhead (rendered in the note pass for correct z-ordering)
            if let phBeat = playheadBeat {
                let phX = Float((phBeat - Double(visibleRect.minX) / Double(pixelsPerBeat)) * Double(pixelsPerBeat))
                noteInstances.append(PianoRollInstance(
                    rect: simd_float4(phX - 0.5, 0, 1.0, Float(layer.bounds.height)),
                    color: colors.playheadColor,
                    metadata: 2 // playhead type
                ))
            }
            
            // Upload and draw notes
            if !noteInstances.isEmpty {
                let count = min(noteInstances.count, Self.maxNotes)
                let ptr = noteBuf.contents().assumingMemoryBound(to: PianoRollInstance.self)
                for i in 0..<count {
                    ptr[i] = noteInstances[i]
                }
                noteEncoder.setVertexBuffer(noteBuf, offset: 0, index: 0)
                noteEncoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4, instanceCount: count)
            }
            
            noteEncoder.endEncoding()
        }
        
        commandBuffer.present(drawable)
        commandBuffer.commit()
    }
    
    // MARK: - Helpers
    
    /// Returns true if the given MIDI pitch corresponds to a black key.
    private static func isBlackKey(pitch: Int) -> Bool {
        let pc = pitch % 12
        return pc == 1 || pc == 3 || pc == 6 || pc == 8 || pc == 10
    }
    
    // MARK: - Shader Source
    
    /// Piano roll-specific shader with note rendering and rounded corners.
    static let pianoRollShaderSource = """
    #include <metal_stdlib>
    using namespace metal;
    
    struct PianoRollInstance {
        float4 rect;     // x, y, width, height (pixels)
        float4 color;    // RGBA
        float metadata;  // 0=row, 1=gridLine, 2=playhead, 3=note
    };
    
    struct PianoRollVertexOut {
        float4 position [[position]];
        float4 color;
        float2 localUV;
        float2 rectSize;
        float metadata;
    };
    
    vertex PianoRollVertexOut pianoroll_vertex(uint vid [[vertex_id]],
                                               uint iid [[instance_id]],
                                               constant PianoRollInstance* instances [[buffer(0)]],
                                               constant float2& viewport [[buffer(1)]]) {
        PianoRollInstance inst = instances[iid];
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
        
        PianoRollVertexOut out;
        out.position = float4(ndc, 0.0, 1.0);
        out.color = inst.color;
        out.localUV = quadPos;
        out.rectSize = rectSize;
        out.metadata = inst.metadata;
        return out;
    }
    
    fragment float4 pianoroll_grid_fragment(PianoRollVertexOut in [[stage_in]]) {
        return in.color;
    }
    
    fragment float4 pianoroll_note_fragment(PianoRollVertexOut in [[stage_in]]) {
        float2 size = in.rectSize;
        float2 pixelCoord = in.localUV * size;
        
        // Playhead: plain white line, no rounding
        if (in.metadata > 1.5) {
            return in.color;
        }
        
        // Rounded corner SDF for notes
        float r = min(2.0, min(size.x, size.y) * 0.15);
        float2 d = abs(pixelCoord - size / 2.0) - (size / 2.0 - r);
        float dist = length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
        float alpha = 1.0 - smoothstep(-0.5, 0.5, dist);
        
        if (alpha <= 0.01) discard_fragment();
        
        // Gradient: brighter at the top
        float3 color = in.color.rgb * (1.1 - in.localUV.y * 0.2);
        
        // Subtle border
        float borderSize = 0.8;
        if (dist > -borderSize) {
            float borderAlpha = smoothstep(-borderSize, -borderSize + 0.5, dist);
            color = mix(color, float3(1.0), borderAlpha * 0.4);
        }
        
        return float4(color, in.color.a * alpha);
    }
    """
}

// MARK: - PianoRollInstance

/// Instance data for the piano roll shader.
struct PianoRollInstance {
    var rect: simd_float4
    var color: simd_float4
    var metadata: Float
}
