import Metal
import MetalKit
import simd

// MARK: - MetalCanvasRenderer (Phase 9.6)

/// Enterprise-grade shared Metal rendering infrastructure for all canvas views.
///
/// This base class provides:
/// - Metal device and command queue lifecycle
/// - Runtime shader compilation from source
/// - Instanced rectangle drawing pipeline (single draw call for N rects)
/// - Buffer pool management with pre-allocated capacity
///
/// **Subclasses**: `MetalTimelineRenderer` (arrangement), `PianoRollMetalRenderer` (piano roll)
///
/// **Design Rationale**: Instead of each canvas maintaining its own device, queue,
/// and pipeline state — which wastes GPU memory and compilation time — all canvas
/// views share this infrastructure through inheritance. The instanced-rect shader
/// is universal: clips and notes are both "colored rectangles with metadata."
open class MetalCanvasRenderer {
    
    // MARK: - Constants
    
    /// Maximum number of rect instances per draw call.
    /// At 48 bytes per instance, 10,000 instances = ~480KB — fits in L2 cache.
    public static let defaultMaxInstances = 10_000
    
    // MARK: - Core Metal Objects
    
    /// The GPU device. Shared across all renderers.
    public let device: MTLDevice
    
    /// Command queue for submitting render work.
    public let commandQueue: MTLCommandQueue
    
    // MARK: - Pipeline States
    
    /// Pipeline for instanced rectangle drawing (clips, notes, grid lines).
    /// Populated by `compilePipeline(vertexFunction:fragmentFunction:source:)`.
    public private(set) var rectPipelineState: MTLRenderPipelineState?
    
    // MARK: - Buffers
    
    /// Pre-allocated buffer for rectangle instances.
    public private(set) var instanceBuffer: MTLBuffer?
    
    /// Maximum instances this buffer can hold.
    public let maxInstances: Int
    
    // MARK: - Initialization
    
    /// Creates a new MetalCanvasRenderer.
    /// - Parameters:
    ///   - device: The Metal device (typically `MTLCreateSystemDefaultDevice()`).
    ///   - maxInstances: Maximum number of rect instances per draw call.
    /// - Returns: `nil` if the device cannot create a command queue.
    public init?(device: MTLDevice, maxInstances: Int = MetalCanvasRenderer.defaultMaxInstances) {
        guard let commandQueue = device.makeCommandQueue() else {
            print("MetalCanvasRenderer: Failed to create command queue")
            return nil
        }
        
        self.device = device
        self.commandQueue = commandQueue
        self.maxInstances = maxInstances
        
        // Pre-allocate instance buffer
        self.instanceBuffer = device.makeBuffer(
            length: MemoryLayout<RectInstance>.stride * maxInstances,
            options: .storageModeShared
        )
    }
    
    // MARK: - Shader Compilation
    
    /// Compiles a render pipeline from Metal shader source code.
    ///
    /// - Parameters:
    ///   - vertexFunction: Name of the vertex function in the shader source.
    ///   - fragmentFunction: Name of the fragment function in the shader source.
    ///   - source: Raw Metal shader source code (or `nil` to use `defaultShaderSource`).
    ///   - enableBlending: Whether to enable alpha blending (default: true).
    /// - Returns: The compiled pipeline state, or `nil` on failure.
    @discardableResult
    public func compilePipeline(
        vertexFunction: String,
        fragmentFunction: String,
        source: String? = nil,
        enableBlending: Bool = true
    ) -> MTLRenderPipelineState? {
        let shaderSource = source ?? Self.defaultRectShaderSource
        
        do {
            let library = try device.makeLibrary(source: shaderSource, options: nil)
            
            let descriptor = MTLRenderPipelineDescriptor()
            descriptor.vertexFunction = library.makeFunction(name: vertexFunction)
            descriptor.fragmentFunction = library.makeFunction(name: fragmentFunction)
            descriptor.colorAttachments[0].pixelFormat = .bgra8Unorm
            
            if enableBlending {
                descriptor.colorAttachments[0].isBlendingEnabled = true
                descriptor.colorAttachments[0].sourceRGBBlendFactor = .sourceAlpha
                descriptor.colorAttachments[0].destinationRGBBlendFactor = .oneMinusSourceAlpha
                descriptor.colorAttachments[0].sourceAlphaBlendFactor = .sourceAlpha
                descriptor.colorAttachments[0].destinationAlphaBlendFactor = .oneMinusSourceAlpha
            }
            
            let state = try device.makeRenderPipelineState(descriptor: descriptor)
            return state
        } catch {
            print("MetalCanvasRenderer: Pipeline compilation failed: \(error)")
            return nil
        }
    }
    
    // MARK: - Drawing Primitives
    
    /// Begins a render pass with the given drawable and optional clear color.
    ///
    /// - Parameters:
    ///   - drawable: The CAMetalDrawable to render into.
    ///   - clearColor: Background color (default: transparent).
    /// - Returns: A tuple of (commandBuffer, renderEncoder), or `nil` if creation fails.
    public func beginRenderPass(
        drawable: CAMetalDrawable,
        clearColor: MTLClearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
    ) -> (MTLCommandBuffer, MTLRenderCommandEncoder)? {
        guard let commandBuffer = commandQueue.makeCommandBuffer() else { return nil }
        
        let renderPassDescriptor = MTLRenderPassDescriptor()
        renderPassDescriptor.colorAttachments[0].texture = drawable.texture
        renderPassDescriptor.colorAttachments[0].loadAction = .clear
        renderPassDescriptor.colorAttachments[0].storeAction = .store
        renderPassDescriptor.colorAttachments[0].clearColor = clearColor
        
        guard let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: renderPassDescriptor) else {
            return nil
        }
        
        return (commandBuffer, encoder)
    }
    
    /// Draws an array of rect instances using instanced triangle strips.
    ///
    /// - Parameters:
    ///   - instances: The array of `RectInstance` data.
    ///   - encoder: The active render command encoder.
    ///   - viewport: The viewport size in points (width, height).
    ///   - pipelineState: The pipeline to use (if nil, uses `rectPipelineState`).
    public func drawRects(
        _ instances: [RectInstance],
        encoder: MTLRenderCommandEncoder,
        viewport: simd_float2,
        pipelineState: MTLRenderPipelineState? = nil
    ) {
        guard !instances.isEmpty,
              let buffer = instanceBuffer,
              let pipeline = pipelineState ?? rectPipelineState else { return }
        
        let count = min(instances.count, maxInstances)
        
        // Upload instances to GPU buffer
        let bufferPointer = buffer.contents().assumingMemoryBound(to: RectInstance.self)
        for i in 0..<count {
            bufferPointer[i] = instances[i]
        }
        
        encoder.setRenderPipelineState(pipeline)
        encoder.setVertexBuffer(buffer, offset: 0, index: 0)
        
        var vp = viewport
        encoder.setVertexBytes(&vp, length: MemoryLayout<simd_float2>.size, index: 1)
        
        // 4 vertices per triangle strip = 1 quad, instanced N times
        encoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4, instanceCount: count)
    }
    
    /// Submits the command buffer and presents the drawable.
    public func endRenderPass(
        commandBuffer: MTLCommandBuffer,
        encoder: MTLRenderCommandEncoder,
        drawable: CAMetalDrawable
    ) {
        encoder.endEncoding()
        commandBuffer.present(drawable)
        commandBuffer.commit()
    }
    
    // MARK: - Default Shader
    
    /// Minimal instanced-rect shader for general-purpose colored rectangles.
    /// Subclasses can provide their own shaders for specialized rendering.
    public static let defaultRectShaderSource = """
    #include <metal_stdlib>
    using namespace metal;
    
    struct RectInstance {
        float4 rect;   // x, y, width, height (in pixels)
        float4 color;  // RGBA
        float metadata; // Subclass-defined (e.g., isSelected, type)
    };
    
    struct RectVertexOut {
        float4 position [[position]];
        float4 color;
        float2 localUV;
        float metadata;
    };
    
    vertex RectVertexOut rect_vertex(uint vid [[vertex_id]],
                                     uint iid [[instance_id]],
                                     constant RectInstance* instances [[buffer(0)]],
                                     constant float2& viewport [[buffer(1)]]) {
        RectInstance inst = instances[iid];
        float2 rectPos = inst.rect.xy;
        float2 rectSize = inst.rect.zw;
        
        // Triangle strip: TL(0), TR(1), BL(2), BR(3)
        float2 quadPos;
        if (vid == 0) quadPos = float2(0, 0);
        else if (vid == 1) quadPos = float2(1, 0);
        else if (vid == 2) quadPos = float2(0, 1);
        else quadPos = float2(1, 1);
        
        float2 pixelPos = rectPos + quadPos * rectSize;
        float2 ndc = (pixelPos / viewport) * 2.0 - 1.0;
        ndc.y = -ndc.y;
        
        RectVertexOut out;
        out.position = float4(ndc, 0.0, 1.0);
        out.color = inst.color;
        out.localUV = quadPos;
        out.metadata = inst.metadata;
        return out;
    }
    
    fragment float4 rect_fragment(RectVertexOut in [[stage_in]]) {
        // Rounded corners: 2px radius
        float2 uv = in.localUV;
        float radius = 0.02; // Relative to rect size
        float2 d = abs(uv - 0.5) - (0.5 - radius);
        float sdf = length(max(d, 0.0)) - radius;
        float alpha = 1.0 - smoothstep(-0.005, 0.005, sdf);
        return float4(in.color.rgb, in.color.a * alpha);
    }
    """
}

// MARK: - RectInstance (Shared Data Type)

/// Universal instanced rectangle data for Metal rendering.
/// Used by both arrangement clips and piano roll notes.
///
/// Memory layout: 36 bytes, fits 10,000 instances in 352KB.
public struct RectInstance {
    /// Rectangle bounds in pixel coordinates (x, y, width, height).
    public var rect: simd_float4
    /// RGBA color.
    public var color: simd_float4
    /// Subclass-defined metadata (e.g., 1.0 = selected, 0.0 = not selected).
    public var metadata: Float
    
    public init(rect: simd_float4, color: simd_float4, metadata: Float = 0) {
        self.rect = rect
        self.color = color
        self.metadata = metadata
    }
}
