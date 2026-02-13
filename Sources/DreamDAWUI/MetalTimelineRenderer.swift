import Metal
import MetalKit
import AppKit
import DreamDAWModels
import DreamDAWEngine
import simd

/// A unified Metal renderer that handles batch drawing for the entire arrangement timeline.
/// Replaces the "one-layer-per-clip" bottleneck with a single GPU pipeline.
///
/// **PHASE 9.6**: Now inherits from `MetalCanvasRenderer` for shared GPU infrastructure.
/// Adds arrangement-specific pipelines (clip waveforms, MIDI note overlays).
public final class MetalTimelineRenderer: MetalCanvasRenderer {
    
    // MARK: - Constants
    private let maxClips = 10000 // Enterprise scale
    
    // MARK: - Arrangement-Specific Properties
    private var clipPipelineState: MTLRenderPipelineState?
    private var notePipelineState: MTLRenderPipelineState? // Secondary pass
    
    // Buffers
    private var clipInstanceBuffer: MTLBuffer?
    private var waveformVertexBuffer: MTLBuffer?
    private var noteInstanceBuffer: MTLBuffer? // For MIDI notes
    
    private static let maxNotes = 50000 // Total visible notes
    
    public var waveformCache: WaveformCache?
    
    // MARK: - Initialization
    
    /// Creates the timeline renderer, inheriting device + queue from MetalCanvasRenderer.
    public convenience init?() {
        print("Metal: Initializing timeline renderer...")
        guard let device = MTLCreateSystemDefaultDevice() else { 
            print("Metal: Failed to create device")
            return nil 
        }
        self.init(device: device, maxInstances: 10000)
    }
    
    public override init?(device: MTLDevice, maxInstances: Int = 10000) {
        super.init(device: device, maxInstances: maxInstances)
        
        setupArrangementPipelines()
        setupArrangementBuffers()
        print("Metal: Timeline renderer initialization complete")
    }
    
    // MARK: - Pipeline Setup
    
    private func setupArrangementPipelines() {
        // 1. Locate the .metal source file
        let candidates = [
            Bundle.main.resourceURL?.appendingPathComponent("DreamDAW_DreamDAWUI.bundle"),
            Bundle.main.resourceURL,
            Bundle(for: MetalTimelineRenderer.self).resourceURL
        ].compactMap { $0 }
        
        var shaderSource: String?
        for url in candidates {
            guard let b = Bundle(url: url) else { continue }
            if let path = b.path(forResource: "WaveformShaders", ofType: "metal"),
               let source = try? String(contentsOfFile: path) {
                shaderSource = source
                print("Metal: Found shader source at \(path)")
                break
            }
        }
        
        guard let source = shaderSource else {
            print("Metal: Fatal - Could not find WaveformShaders.metal")
            return
        }
        
        // 2. Compile at Runtime (Synchronous for startup reliability)
        print("Metal: Compiling arrangement shaders at runtime...")
        do {
            let lib = try device.makeLibrary(source: source, options: nil)
            
            // 1. Clip Pipeline (with waveform rendering)
            let pipelineDescriptor = MTLRenderPipelineDescriptor()
            pipelineDescriptor.vertexFunction = lib.makeFunction(name: "timeline_vertex")
            pipelineDescriptor.fragmentFunction = lib.makeFunction(name: "timeline_fragment")
            pipelineDescriptor.colorAttachments[0].pixelFormat = .bgra8Unorm
            pipelineDescriptor.colorAttachments[0].isBlendingEnabled = true
            pipelineDescriptor.colorAttachments[0].sourceRGBBlendFactor = .sourceAlpha
            pipelineDescriptor.colorAttachments[0].destinationRGBBlendFactor = .oneMinusSourceAlpha
            
            self.clipPipelineState = try self.device.makeRenderPipelineState(descriptor: pipelineDescriptor)
            
            // 2. Note Pipeline (Opaque pass)
            let noteDescriptor = MTLRenderPipelineDescriptor()
            noteDescriptor.vertexFunction = lib.makeFunction(name: "note_vertex")
            noteDescriptor.fragmentFunction = lib.makeFunction(name: "note_fragment")
            noteDescriptor.colorAttachments[0].pixelFormat = .bgra8Unorm
            noteDescriptor.colorAttachments[0].isBlendingEnabled = true
            noteDescriptor.colorAttachments[0].sourceRGBBlendFactor = .sourceAlpha
            noteDescriptor.colorAttachments[0].destinationRGBBlendFactor = .oneMinusSourceAlpha
            
            self.notePipelineState = try self.device.makeRenderPipelineState(descriptor: noteDescriptor)
            
            print("Metal: Runtime compilation and dual pipelines successful")
        } catch {
            print("Metal: Runtime compilation or pipeline creation failed: \(error)")
        }
    }
    
    private func setupArrangementBuffers() {
        // Pre-allocate buffer for clip instances
        clipInstanceBuffer = device.makeBuffer(length: MemoryLayout<ClipInstance>.stride * maxClips, options: .storageModeShared)
        noteInstanceBuffer = device.makeBuffer(length: MemoryLayout<MidiNoteInstance>.stride * Self.maxNotes, options: .storageModeShared)
        
        // WAVEFORM STORAGE: Global buffer for all visible peaks
        // 1000 clips * 1024 peaks per clip * 4 bytes = ~4MB
        waveformVertexBuffer = device.makeBuffer(length: 1000 * 1024 * MemoryLayout<Float>.stride, options: .storageModeShared)
    }
    
    // MARK: - Drawing
    
    // MARK: - Drawing (PHASE 9.6)
    
    /// Renders the entire visible arrangement into the provided Metal layer.
    /// Uses ViewportMatrix and TrackLayoutEngine for O(1)/O(log N) performance.
    @MainActor
    public func render(
        project: Project,
        viewport: ViewportMatrix,
        layoutEngine: TrackLayoutEngine,
        interactionSM: InteractionStateMachine,
        pulseMap: PulseMap,
        in layer: CAMetalLayer
    ) {
        guard let drawable = layer.nextDrawable() else { return }
        guard let pipelineState = clipPipelineState,
              let instanceBuffer = clipInstanceBuffer,
              let waveformCache = waveformCache else { return }
        
        let renderPassDescriptor = MTLRenderPassDescriptor()
        renderPassDescriptor.colorAttachments[0].texture = drawable.texture
        renderPassDescriptor.colorAttachments[0].loadAction = .clear
        renderPassDescriptor.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0.0)
        renderPassDescriptor.colorAttachments[0].storeAction = .store
        
        guard let commandBuffer = commandQueue.makeCommandBuffer(),
              let renderEncoder = commandBuffer.makeRenderCommandEncoder(descriptor: renderPassDescriptor) else { return }
        
        renderEncoder.setRenderPipelineState(pipelineState)
        
        // 1. Prepare Projection (Normalized Device Coordinates / Viewport Size)
        var vpSize = simd_float2(Float(layer.bounds.width), Float(layer.bounds.height))
        renderEncoder.setVertexBytes(&vpSize, length: MemoryLayout<simd_float2>.size, index: 1)
        
        // 2. Prepare Instances
        let visibleTracks = project.allVisibleTracks.filter { $0.trackType != .master }
        var instances: [ClipInstance] = []
        
        let phantom = interactionSM.phantomOverlay
        let visibleSampleRange = viewport.visibleSampleRange
        
        var audioClipCount = 0
        var midiClipCount = 0

        for (trackIndex, track) in visibleTracks.enumerated() {
            let trackY = Float(layoutEngine.yPosition(forTrackIndex: trackIndex))
            // Skip offscreen tracks (culling is mostly handled by layoutEngine.visibleTrackRange)
            // but we process all visibleTracks here for simplicity in this pass.
            
            // Render Audio Clips
            let audioClipsInRange = track.clips.filter {
                $0.absolutePosition.sampleFrame + $0.absoluteDuration.sampleFrame >= visibleSampleRange.lowerBound &&
                $0.absolutePosition.sampleFrame <= visibleSampleRange.upperBound
            }
            
            for clip in audioClipsInRange {
                if clip.absoluteDuration.sampleFrame == 0 {
                    NSLog("[MetalTimelineRenderer] WARNING: Audio clip '\(clip.name)' has zero absoluteDuration. Beats: \(clip.duration.beats)")
                }
                
                let x = viewport.pixelX(for: clip.absolutePosition.sampleFrame)
                let w = viewport.pixelWidth(forSamples: clip.absoluteDuration.sampleFrame)
                let h = Float(track.height - 4) // 2px padding top/bottom
                let y = viewport.pixelY(forDocumentY: trackY + 2)
                
                let isSelected = clip.isSelected
                let isPhantom = phantom.isActive && phantom.clipIDs.contains(clip.id)
                
                // WAVEFORM LOGIC: Fetch peaks from cache
                var wfOffset: Int32 = -1
                var wfCount: Int32 = 0
                
                // Use ViewportMatrix SPP directly for stabilization
                let stabilizedSPP = Int(viewport.samplesPerPixel)
                
                if let data = waveformCache.getCachedWaveform(for: clip.fileURL, samplesPerPixel: stabilizedSPP) {
                    let targetPeaks = 1024 
                    let globalPeakOffset = audioClipCount * targetPeaks
                    if let waveformBuffer = waveformVertexBuffer {
                        let wfPtr = waveformBuffer.contents().assumingMemoryBound(to: Float.self).advanced(by: globalPeakOffset)
                        for i in 0..<min(data.peaks.count, targetPeaks) {
                            wfPtr[i] = data.peaks[i]
                        }
                        wfOffset = Int32(globalPeakOffset)
                        wfCount = Int32(min(data.peaks.count, targetPeaks))
                    }
                } else {
                    // Trigger async load
                    waveformCache.getWaveform(for: clip.fileURL, samplesPerPixel: stabilizedSPP) { _ in }
                }

                instances.append(ClipInstance(
                    rect: simd_float4(x, y, w, h),
                    color: track.color.simdColor,
                    stateFlags: simd_float4(isSelected ? 1.0 : 0.0, isPhantom ? 1.0 : 0.0, 5.0, 0.0), // z=5.0 radius
                    waveformOffset: wfOffset,
                    waveformCount: wfCount,
                    isMidi: 0.0
                ))
                audioClipCount += 1
                if instances.count >= maxClips { break }
            }
            
            // Render MIDI Clips
            let midiClipsInRange = track.midiClips.filter { 
                $0.absolutePosition.sampleFrame + $0.absoluteDuration.sampleFrame >= visibleSampleRange.lowerBound &&
                $0.absolutePosition.sampleFrame <= visibleSampleRange.upperBound
            }
            
            for clip in midiClipsInRange {
                let x = viewport.pixelX(for: clip.absolutePosition.sampleFrame)
                let w = viewport.pixelWidth(forSamples: clip.absoluteDuration.sampleFrame)
                let h = Float(track.height - 4)
                let y = viewport.pixelY(forDocumentY: trackY + 2)
                
                let isSelected = clip.isSelected
                let isPhantom = phantom.isActive && phantom.clipIDs.contains(clip.id)
                
                instances.append(ClipInstance(
                    rect: simd_float4(x, y, w, h),
                    color: track.color.simdColor,
                    stateFlags: simd_float4(isSelected ? 1.0 : 0.0, isPhantom ? 1.0 : 0.0, 5.0, 0.0),
                    waveformOffset: -1,
                    waveformCount: 0,
                    isMidi: 1.0
                ))
                midiClipCount += 1
                if instances.count >= maxClips { break }
            }
            
            if instances.count >= maxClips { break }
        }
        
        // 3. Upload and Draw
        if !instances.isEmpty {
            let bufferPointer = instanceBuffer.contents().assumingMemoryBound(to: ClipInstance.self)
            for (i, instance) in instances.enumerated() {
                bufferPointer[i] = instance
            }
            
            renderEncoder.setVertexBuffer(instanceBuffer, offset: 0, index: 0)
            
            // WAVEFORM BUFFER (Fragment index 2)
            if let waveformBuffer = waveformVertexBuffer {
                renderEncoder.setFragmentBuffer(waveformBuffer, offset: 0, index: 2)
            }
            
            renderEncoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4, instanceCount: instances.count)
        }
        
        renderEncoder.endEncoding()
        
        // 4. Draw MIDI Notes
        // 4. Draw MIDI Notes
        renderMidiNotes(project: project, viewport: viewport, layoutEngine: layoutEngine, pulseMap: pulseMap, in: layer, commandBuffer: commandBuffer, drawable: drawable)
        
        commandBuffer.present(drawable)
        commandBuffer.commit()
    }

    @MainActor
    private func renderMidiNotes(
        project: Project,
        viewport: ViewportMatrix,
        layoutEngine: TrackLayoutEngine,
        pulseMap: PulseMap,
        in layer: CAMetalLayer,
        commandBuffer: MTLCommandBuffer,
        drawable: CAMetalDrawable
    ) {
        guard let pipelineState = notePipelineState,
              let noteBuffer = noteInstanceBuffer else { return }
        
        let renderPassDescriptor = MTLRenderPassDescriptor()
        renderPassDescriptor.colorAttachments[0].texture = drawable.texture
        renderPassDescriptor.colorAttachments[0].loadAction = .load // Load previous (clips)
        renderPassDescriptor.colorAttachments[0].storeAction = .store
        
        guard let renderEncoder = commandBuffer.makeRenderCommandEncoder(descriptor: renderPassDescriptor) else { return }
        renderEncoder.setRenderPipelineState(pipelineState)
        
        var vpSize = simd_float2(Float(layer.bounds.width), Float(layer.bounds.height))
        renderEncoder.setVertexBytes(&vpSize, length: MemoryLayout<simd_float2>.size, index: 1)
        
        var noteInstances: [MidiNoteInstance] = []
        let visibleTracks = project.allVisibleTracks.filter { $0.trackType != .master }
        let visibleSampleRange = viewport.visibleSampleRange
        
        for (trackIndex, track) in visibleTracks.enumerated() {
            let trackY = Float(layoutEngine.yPosition(forTrackIndex: trackIndex))
            
            let clipsInRange = track.midiClips.filter { 
                $0.absolutePosition.sampleFrame + $0.absoluteDuration.sampleFrame >= visibleSampleRange.lowerBound &&
                $0.absolutePosition.sampleFrame <= visibleSampleRange.upperBound
            }
            
            for clip in clipsInRange {
                for note in clip.notes {
                    // Coordinates relative to viewport left edge
                    let noteStartSample = pulseMap.sampleFrame(at: note.position.beats)
                    let noteDurationSamples = Int64(note.duration.beats * (60.0 / Double(project.bpm)) * 44100.0) // Fallback for duration
                    
                    let x = viewport.pixelX(for: clip.absolutePosition.sampleFrame + noteStartSample)
                    let w = viewport.pixelWidth(forSamples: noteDurationSamples)
                    
                    // Vertical: 128 MIDI notes mapped to track height (with 22px header excluded)
                    let headerH: CGFloat = 22 // Sync with shader headerHeight
                    let usableH = track.height - headerH - 4
                    let pitchRatio = CGFloat(127 - note.pitch) / 128.0
                    let pitchOffset = pitchRatio * usableH
                    let noteY = viewport.pixelY(forDocumentY: trackY + Float(headerH) + 2 + Float(pitchOffset))
                    let noteH = Float(max(1.0, usableH / 128.0))
                    
                    noteInstances.append(MidiNoteInstance(
                        rect: simd_float4(x, noteY, w, noteH),
                        color: simd_float4(1, 1, 1, 0.7), // White notes with 0.7 alpha
                        stateFlags: simd_float2(1.0, clip.isSelected ? 1.0 : 0.0) // type=1.0, isSelected
                    ))
                    if noteInstances.count >= Self.maxNotes { break }
                }
                if noteInstances.count >= Self.maxNotes { break }
            }
            if noteInstances.count >= Self.maxNotes { break }
        }
        
        if !noteInstances.isEmpty {
            let bufferPointer = noteBuffer.contents().assumingMemoryBound(to: MidiNoteInstance.self)
            for (i, instance) in noteInstances.enumerated() {
                bufferPointer[i] = instance
            }
            renderEncoder.setVertexBuffer(noteBuffer, offset: 0, index: 0)
            renderEncoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4, instanceCount: noteInstances.count)
        }
        
        renderEncoder.endEncoding()
    }
}

// MARK: - Shared Types (Phase 9.6)

/// Enterprise-grade clip instance data for Metal rendering.
/// Memory layout: 64 bytes (perfectly aligned for GPU).
public struct ClipInstance {
    /// x, y, width, height in screen pixels.
    public var rect: simd_float4
    /// R, G, B, A normalized (0.0 - 1.0).
    public var color: simd_float4
    
    /// Bito-wise state flags for the fragment shader:
    /// x: isSelected (0.0 or 1.0) -> Neon border
    /// y: isPhantom (0.0 or 1.0) -> alpha * 0.4
    /// z: cornerRadius (pixels) -> SDF rounding
    /// w: isMuted (0.0 or 1.0) -> Desaturation
    public var stateFlags: simd_float4
    
    /// Waveform metadata.
    public var waveformOffset: Int32 // Offset into waveformVertexBuffer
    public var waveformCount: Int32  // Number of peaks
    public var isMidi: Float         // 1.0 if MIDI, 0.0 if Audio
    
    /// Padding to maintain 16-byte alignment
    public var padding: Float = 0
}

/// MIDI note instance data.
public struct MidiNoteInstance {
    public var rect: simd_float4
    public var color: simd_float4
    /// x: type (1.0 = note), y: isSelected (1.0 = highlight)
    public var stateFlags: simd_float2
}

extension TrackColor {
    var simdColor: simd_float4 {
        let count = 4
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 1
        self.nsColor.getRed(&r, green: &g, blue: &b, alpha: &a)
        return simd_float4(Float(r), Float(g), Float(b), Float(a))
    }
}
