import Metal
import MetalKit
import AppKit
import DreamDAWModels
import DreamDAWEngine
import simd

/// A unified Metal renderer that handles batch drawing for the entire arrangement timeline.
/// Replaces the "one-layer-per-clip" bottleneck with a single GPU pipeline.
public final class MetalTimelineRenderer {
    
    // MARK: - Constants
    private let maxClips = 10000 // Enterprise scale
    
    // MARK: - Properties
    public let device: MTLDevice
    private let commandQueue: MTLCommandQueue
    private var pipelineState: MTLRenderPipelineState?
    private var notePipelineState: MTLRenderPipelineState? // Secondary pass
    
    // Buffers
    private var clipInstanceBuffer: MTLBuffer?
    private var waveformVertexBuffer: MTLBuffer?
    private var noteInstanceBuffer: MTLBuffer? // For MIDI notes
    
    private static let maxNotes = 50000 // Total visible notes
    
    public var waveformCache: WaveformCache?
    
    // MARK: - Initialization
    public init?() {
        print("Metal: Initializing renderer...")
        guard let device = MTLCreateSystemDefaultDevice() else { 
            print("Metal: Failed to create device")
            return nil 
        }
        self.device = device
        guard let commandQueue = device.makeCommandQueue() else { 
            print("Metal: Failed to create command queue")
            return nil 
        }
        self.commandQueue = commandQueue
        
        setupPipeline()
        setupBuffers()
        print("Metal: Initialization complete")
    }
    
    private func setupPipeline() {
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
        print("Metal: Compiling shaders at runtime...")
        do {
            let lib = try device.makeLibrary(source: source, options: nil)
            
            // 1. Clip Pipeline
            let pipelineDescriptor = MTLRenderPipelineDescriptor()
            pipelineDescriptor.vertexFunction = lib.makeFunction(name: "timeline_vertex")
            pipelineDescriptor.fragmentFunction = lib.makeFunction(name: "timeline_fragment")
            pipelineDescriptor.colorAttachments[0].pixelFormat = .bgra8Unorm
            pipelineDescriptor.colorAttachments[0].isBlendingEnabled = true
            pipelineDescriptor.colorAttachments[0].sourceRGBBlendFactor = .sourceAlpha
            pipelineDescriptor.colorAttachments[0].destinationRGBBlendFactor = .oneMinusSourceAlpha
            
            self.pipelineState = try self.device.makeRenderPipelineState(descriptor: pipelineDescriptor)
            
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
    
    private func setupBuffers() {
        // Pre-allocate buffer for clip instances
        clipInstanceBuffer = device.makeBuffer(length: MemoryLayout<ClipInstance>.stride * maxClips, options: .storageModeShared)
        noteInstanceBuffer = device.makeBuffer(length: MemoryLayout<MidiNoteInstance>.stride * Self.maxNotes, options: .storageModeShared)
        
        // WAVEFORM STORAGE: Global buffer for all visible peaks
        // 1000 clips * 1024 peaks per clip * 4 bytes = ~4MB
        waveformVertexBuffer = device.makeBuffer(length: 1000 * 1024 * MemoryLayout<Float>.stride, options: .storageModeShared)
    }
    
    // MARK: - Drawing
    
    /// Renders the entire visible arrangement into the provided Metal layer.
    public func render(
        project: Project,
        visibleRect: CGRect,
        pixelsPerBeat: CGFloat,
        in layer: CAMetalLayer
    ) {
        guard let drawable = layer.nextDrawable() else {
            // This is completely normal during resize/initialization when the layer isn't fully ready.
            // Silently return instead of spamming logs.
            return 
        }
        guard let pipelineState = pipelineState else {
            print("Metal: Error - pipelineState is NIL")
            return
        }
        guard let instanceBuffer = clipInstanceBuffer else {
            print("Metal: Error - clipInstanceBuffer is NIL")
            return
        }
        
        let renderPassDescriptor = MTLRenderPassDescriptor()
        renderPassDescriptor.colorAttachments[0].texture = drawable.texture
        renderPassDescriptor.colorAttachments[0].loadAction = .clear
        renderPassDescriptor.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0.0)
        renderPassDescriptor.colorAttachments[0].storeAction = .store
        
        guard let waveformCache = waveformCache else {
            print("Metal: Error - waveformCache is NIL")
            return
        }

        guard let commandBuffer = commandQueue.makeCommandBuffer(),
              let renderEncoder = commandBuffer.makeRenderCommandEncoder(descriptor: renderPassDescriptor) else { return }
        
        renderEncoder.setRenderPipelineState(pipelineState)
        
        // 1. Prepare Projection
        var viewport = simd_float2(Float(layer.bounds.width), Float(layer.bounds.height))
        renderEncoder.setVertexBytes(&viewport, length: MemoryLayout<simd_float2>.size, index: 1)
        
        // 2. Filter & Prepare Instances
        let visibleTracks = project.allVisibleTracks.filter { $0.trackType != .master }
        var instances: [ClipInstance] = []
        
        let minBeat = Double(visibleRect.minX) / Double(pixelsPerBeat)
        let maxBeat = Double(visibleRect.maxX) / Double(pixelsPerBeat)
        
        print("Metal: Rendering visibleRect=\(visibleRect) ppB=\(pixelsPerBeat) tracks=\(visibleTracks.count) beats=\(minBeat)...\(maxBeat)")
        
        var trackY: CGFloat = 0
        var audioClipCount = 0
        var midiClipCount = 0
        
        for track in visibleTracks {
            // Render Audio Clips
            let audioClipsInRange = track.clips.filter { $0.endPosition.beats >= minBeat && $0.position.beats <= maxBeat }
            for clip in audioClipsInRange {
                let x = Float(CGFloat(clip.position.beats) * pixelsPerBeat - visibleRect.minX)
                let w = Float(CGFloat(clip.duration.beats) * pixelsPerBeat)
                let h = Float(track.height - 4) // 2px padding top/bottom
                let y = Float(trackY - visibleRect.minY + 2)

                // WAVEFORM LOGIC: Fetch peaks from cache
                var wfOffset: Int32 = -1
                var wfCount: Int32 = 0
                
                // Professional DAW SPP stabilization (avoid cache thrashing)
                let sampleRate = 44100.0 // TODO: Get from clip or engine
                let secondsPerPixel = 1.0 / (pixelsPerBeat * (Double(60.0) / 60.0)) // FIXME: Use project BPM
                let rawSPP = max(1, Int(secondsPerPixel * sampleRate))
                
                let stabilizedSPP: Int
                if rawSPP < 100 {
                    stabilizedSPP = rawSPP
                } else {
                    let logStep = pow(1.1, round(log(Double(rawSPP)) / log(1.1)))
                    stabilizedSPP = Int(logStep)
                }

                if let data = waveformCache.getCachedWaveform(for: clip.fileURL, samplesPerPixel: stabilizedSPP) {
                    let targetPeaks = 512 
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
                    // Trigger async load for next frame with the stabilized resolution
                    waveformCache.getWaveform(for: clip.fileURL, samplesPerPixel: stabilizedSPP) { _ in }
                }

                instances.append(ClipInstance(
                    rect: simd_float4(x, y, w, h),
                    color: track.color.simdColor,
                    isSelected: clip.isSelected ? 1.0 : 0.0,
                    waveformOffset: wfOffset,
                    waveformCount: wfCount,
                    isMidi: 0.0
                ))
                audioClipCount += 1
                if instances.count >= maxClips { break }
            }
            
            // Render MIDI Clips
            let midiClipsInRange = track.midiClips.filter { $0.endPosition.beats >= minBeat && $0.position.beats <= maxBeat }
            for clip in midiClipsInRange {
                let x = Float(CGFloat(clip.position.beats) * pixelsPerBeat - visibleRect.minX)
                let w = Float(CGFloat(clip.duration.beats) * pixelsPerBeat)
                let h = Float(track.height - 4) // 2px padding top/bottom
                let y = Float(trackY - visibleRect.minY + 2)
                
                instances.append(ClipInstance(
                    rect: simd_float4(x, y, w, h),
                    color: track.color.simdColor,
                    isSelected: clip.isSelected ? 1.0 : 0.0,
                    waveformOffset: -1,
                    waveformCount: 0,
                    isMidi: 1.0
                ))
                midiClipCount += 1
                if instances.count >= maxClips { break }
            }
            
            trackY += track.height
            if instances.count >= maxClips { break }
        }
        
        print("Metal: Prepared \(audioClipCount) audio and \(midiClipCount) midi clips")
        
        // 3. Upload and Draw
        if !instances.isEmpty {
            print("Metal: Rendering \(instances.count) clips")
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
        renderMidiNotes(project: project, visibleRect: visibleRect, pixelsPerBeat: pixelsPerBeat, in: layer, commandBuffer: commandBuffer, drawable: drawable)
        
        commandBuffer.present(drawable)
        commandBuffer.commit()
    }
    
    private func renderMidiNotes(
        project: Project,
        visibleRect: CGRect,
        pixelsPerBeat: CGFloat,
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
        
        var viewport = simd_float2(Float(layer.bounds.width), Float(layer.bounds.height))
        renderEncoder.setVertexBytes(&viewport, length: MemoryLayout<simd_float2>.size, index: 1)
        
        var noteInstances: [MidiNoteInstance] = []
        let visibleTracks = project.allVisibleTracks.filter { $0.trackType != .master }
        let minBeat = Double(visibleRect.minX) / Double(pixelsPerBeat)
        let maxBeat = Double(visibleRect.maxX) / Double(pixelsPerBeat)
        
        var trackY: CGFloat = 0
        for track in visibleTracks {
            let clipsInRange = track.midiClips.filter { $0.endPosition.beats >= minBeat && $0.position.beats <= maxBeat }
            for clip in clipsInRange {
                for note in clip.notes {
                    // Coordinates relative to view
                    let x = Float(CGFloat(clip.position.beats + note.position.beats) * pixelsPerBeat - visibleRect.minX)
                    let w = Float(CGFloat(note.duration.beats) * pixelsPerBeat)
                    
                    // Vertical: 128 MIDI notes mapped to track height (with 20px header excluded)
                    let headerH: CGFloat = 20
                    let usableH = track.height - headerH - 4
                    let noteH = Float(max(1.0, usableH / 128.0))
                    let noteY = Float(trackY - visibleRect.minY + headerH + 2 + (CGFloat(127 - note.pitch) * (usableH / 128.0)))
                    
                    noteInstances.append(MidiNoteInstance(
                        rect: simd_float4(x, noteY, w, noteH),
                        color: simd_float4(1, 1, 1, 0.8), // White notes
                        type: 1.0 // MIDI Note
                    ))
                    if noteInstances.count >= Self.maxNotes { break }
                }
            }
            trackY += track.height
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

// MARK: - Shared Types

struct ClipInstance {
    var rect: simd_float4 // x, y, width, height
    var color: simd_float4
    var isSelected: Float
    var waveformOffset: Int32 // Offset into waveformVertexBuffer
    var waveformCount: Int32  // Number of peaks
    var isMidi: Float         // 1.0 if MIDI, 0.0 if Audio
}

struct MidiNoteInstance {
    var rect: simd_float4
    var color: simd_float4
    var type: Float // 1.0 for note
}

extension TrackColor {
    var simdColor: simd_float4 {
        let count = 4
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 1
        self.nsColor.getRed(&r, green: &g, blue: &b, alpha: &a)
        return simd_float4(Float(r), Float(g), Float(b), Float(a))
    }
}
