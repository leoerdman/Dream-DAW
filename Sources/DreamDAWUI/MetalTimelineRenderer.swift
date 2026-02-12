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
    private let device: MTLDevice
    private let commandQueue: MTLCommandQueue
    private var pipelineState: MTLRenderPipelineState?
    
    // Buffers
    private var clipInstanceBuffer: MTLBuffer?
    private var waveformVertexBuffer: MTLBuffer?
    
    // MARK: - Initialization
    public init?() {
        guard let device = MTLCreateSystemDefaultDevice() else { return nil }
        self.device = device
        guard let commandQueue = device.makeCommandQueue() else { return nil }
        self.commandQueue = commandQueue
        
        setupPipeline()
        setupBuffers()
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
            
            let pipelineDescriptor = MTLRenderPipelineDescriptor()
            pipelineDescriptor.vertexFunction = lib.makeFunction(name: "timeline_vertex")
            pipelineDescriptor.fragmentFunction = lib.makeFunction(name: "timeline_fragment")
            pipelineDescriptor.colorAttachments[0].pixelFormat = .bgra8Unorm
            pipelineDescriptor.colorAttachments[0].isBlendingEnabled = true
            pipelineDescriptor.colorAttachments[0].sourceRGBBlendFactor = .sourceAlpha
            pipelineDescriptor.colorAttachments[0].destinationRGBBlendFactor = .oneMinusSourceAlpha
            
            self.pipelineState = try self.device.makeRenderPipelineState(descriptor: pipelineDescriptor)
            print("Metal: Runtime compilation successful")
        } catch {
            print("Metal: Runtime compilation or pipeline creation failed: \(error)")
        }
    }
    
    private func setupBuffers() {
        // Pre-allocate buffer for clip instances
        clipInstanceBuffer = device.makeBuffer(length: MemoryLayout<ClipInstance>.stride * maxClips, options: .storageModeShared)
    }
    
    // MARK: - Drawing
    
    /// Renders the entire visible arrangement into the provided Metal layer.
    public func render(
        project: Project,
        visibleRect: CGRect,
        pixelsPerBeat: CGFloat,
        in layer: CAMetalLayer
    ) {
        guard let drawable = layer.nextDrawable(),
              let pipelineState = pipelineState,
              let instanceBuffer = clipInstanceBuffer else { return }
        
        let renderPassDescriptor = MTLRenderPassDescriptor()
        renderPassDescriptor.colorAttachments[0].texture = drawable.texture
        renderPassDescriptor.colorAttachments[0].loadAction = .clear
        renderPassDescriptor.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0.0)
        renderPassDescriptor.colorAttachments[0].storeAction = .store
        
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
                let h = Float(track.height)
                let y = Float(trackY - visibleRect.minY)
                
                instances.append(ClipInstance(
                    rect: simd_float4(x, y, w, h),
                    color: track.color.simdColor,
                    isSelected: clip.isSelected ? 1.0 : 0.0
                ))
                audioClipCount += 1
                if instances.count >= maxClips { break }
            }
            
            // Render MIDI Clips
            let midiClipsInRange = track.midiClips.filter { $0.endPosition.beats >= minBeat && $0.position.beats <= maxBeat }
            for clip in midiClipsInRange {
                let x = Float(CGFloat(clip.position.beats) * pixelsPerBeat - visibleRect.minX)
                let w = Float(CGFloat(clip.duration.beats) * pixelsPerBeat)
                let h = Float(track.height)
                let y = Float(trackY - visibleRect.minY)
                
                instances.append(ClipInstance(
                    rect: simd_float4(x, y, w, h),
                    color: track.color.simdColor,
                    isSelected: clip.isSelected ? 1.0 : 0.0
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
            renderEncoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4, instanceCount: instances.count)
        }
        
        renderEncoder.endEncoding()
        commandBuffer.present(drawable)
        commandBuffer.commit()
    }
}

// MARK: - Shared Types

struct ClipInstance {
    var rect: simd_float4 // x, y, width, height
    var color: simd_float4
    var isSelected: Float
}

extension TrackColor {
    var simdColor: simd_float4 {
        let count = 4
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 1
        self.nsColor.getRed(&r, green: &g, blue: &b, alpha: &a)
        return simd_float4(Float(r), Float(g), Float(b), Float(a))
    }
}
