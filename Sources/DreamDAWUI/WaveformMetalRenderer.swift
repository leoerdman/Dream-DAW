import Metal
import MetalKit
import AppKit
import DreamDAWModels
import DreamDAWEngine

/// High-performance Metal renderer for audio waveforms.
/// Moves drawing from CPU (Core Graphics) to GPU (Metal) for 120fps fluid interaction.
public final class WaveformMetalRenderer {

    // MARK: - Properties

    private let device: MTLDevice
    private let commandQueue: MTLCommandQueue
    private var pipelineState: MTLRenderPipelineState?
    
    // Shared vertex buffer pool for performance
    private var vertexBuffers: [UUID: MTLBuffer] = [:]

    // MARK: - Initialization

    public init?() {
        guard let device = MTLCreateSystemDefaultDevice() else { return nil }
        self.device = device
        guard let commandQueue = device.makeCommandQueue() else { return nil }
        self.commandQueue = commandQueue
        
        setupPipeline()
    }

    private func setupPipeline() {
        // Shaders are in the DreamDAWUI bundle.
        // Bundle(for: WaveformMetalRenderer.self) reliably finds the bundle containing this class.
        let bundle = Bundle(for: WaveformMetalRenderer.self)
        let library = (try? device.makeDefaultLibrary(bundle: bundle)) ?? device.makeDefaultLibrary()
        
        guard let lib = library else {
            print("Metal: Failed to find shader library in \(bundle.bundlePath)")
            return
        }

        let vertexFunction = lib.makeFunction(name: "waveform_vertex")
        let fragmentFunction = lib.makeFunction(name: "waveform_fragment")
        
        guard let vFunc = vertexFunction, let fFunc = fragmentFunction else {
            print("Metal: Failed to find shader functions in \(bundle.bundlePath)")
            return
        }
        
        let pipelineDescriptor = MTLRenderPipelineDescriptor()
        pipelineDescriptor.vertexFunction = vFunc
        pipelineDescriptor.fragmentFunction = fFunc
        pipelineDescriptor.colorAttachments[0].pixelFormat = .bgra8Unorm
        pipelineDescriptor.colorAttachments[0].isBlendingEnabled = true
        pipelineDescriptor.colorAttachments[0].sourceRGBBlendFactor = .sourceAlpha
        pipelineDescriptor.colorAttachments[0].destinationRGBBlendFactor = .oneMinusSourceAlpha
        
        do {
            pipelineState = try device.makeRenderPipelineState(descriptor: pipelineDescriptor)
        } catch {
            print("Metal: Failed to create pipeline state: \(error)")
        }
    }

    // MARK: - Rendering

    /// Renders a waveform into the provided metal layer.
    public func render(
        clip: AudioClip,
        data: MultiBandWaveformData,
        in layer: CAMetalLayer,
        color: NSColor,
        verticalScale: Float
    ) {
        guard let drawable = layer.nextDrawable(),
              let pipelineState = pipelineState else { return }
        
        let renderPassDescriptor = MTLRenderPassDescriptor()
        renderPassDescriptor.colorAttachments[0].texture = drawable.texture
        renderPassDescriptor.colorAttachments[0].loadAction = .clear
        renderPassDescriptor.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
        renderPassDescriptor.colorAttachments[0].storeAction = .store
        
        guard let commandBuffer = commandQueue.makeCommandBuffer(),
              let renderEncoder = commandBuffer.makeRenderCommandEncoder(descriptor: renderPassDescriptor) else { return }
        
        renderEncoder.setRenderPipelineState(pipelineState)
        
        // Setup Vertex Buffer (from peak data)
        let vertices = generateVertices(data: data, verticalScale: verticalScale)
        let vertexBuffer = device.makeBuffer(bytes: vertices, length: vertices.count * MemoryLayout<Float>.size, options: [])
        renderEncoder.setVertexBuffer(vertexBuffer, offset: 0, index: 0)
        
        // Setup Uniforms
        var uniforms = WaveformUniforms(
            projectionMatrix: matrix_float4x4_ortho(0, 1, -1, 1, -1, 1),
            baseColor: simd_float4(Float(color.redComponent), Float(color.greenComponent), Float(color.blueComponent), Float(color.alphaComponent)),
            verticalScale: verticalScale
        )
        renderEncoder.setVertexBytes(&uniforms, length: MemoryLayout<WaveformUniforms>.size, index: 1)
        
        renderEncoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: vertices.count / 2)
        
        renderEncoder.endEncoding()
        commandBuffer.present(drawable)
        commandBuffer.commit()
    }

    // MARK: - Helpers

    private func generateVertices(data: MultiBandWaveformData, verticalScale: Float) -> [Float] {
        var vertices: [Float] = []
        let count = data.lowPeaks.count
        for i in 0..<count {
            let x = Float(i) / Float(count - 1)
            let peak = data.lowPeaks[i]
            
            // Triangle Strip: Upper then Lower
            vertices.append(x)
            vertices.append(peak)
            
            vertices.append(x)
            vertices.append(-peak)
        }
        return vertices
    }
}

// MARK: - Metal Types

struct WaveformUniforms {
    var projectionMatrix: matrix_float4x4
    var baseColor: simd_float4
    var verticalScale: Float
}

func matrix_float4x4_ortho(_ left: Float, _ right: Float, _ bottom: Float, _ top: Float, _ near: Float, _ far: Float) -> matrix_float4x4 {
    let ral = right + left
    let rsl = right - left
    let tab = top + bottom
    let tsb = top - bottom
    let fsn = far - near
    
    return matrix_float4x4(
        simd_float4(2.0 / rsl, 0.0, 0.0, 0.0),
        simd_float4(0.0, 2.0 / tsb, 0.0, 0.0),
        simd_float4(0.0, 0.0, 1.0 / fsn, 0.0),
        simd_float4(-ral / rsl, -tab / tsb, -near / fsn, 1.0)
    )
}
