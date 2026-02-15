// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Timeline Renderer (wgpu)
// ═══════════════════════════════════════════════════════════════════════════
//
// Orchestrates the GPU rendering pipeline for the arrangement timeline.
//
// Architecture (ported from MetalTimelineRenderer.swift):
//   1. CPU builds an array of `ClipInstance` structs from the project
//   2. Uploads instances + waveform peaks to GPU storage buffers
//   3. Issues a single instanced draw call (4 verts × N instances)
//   4. GPU runs timeline.wgsl which handles all visual effects
//
// This renderer is designed to draw 10K+ clips at 120fps.
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::gpu_types::{ClipInstance, ViewportUniforms, WaveformPeakBuffer};
use crate::viewport::Viewport;

/// Maximum number of clip instances per frame.
const MAX_CLIP_INSTANCES: usize = 10_000;

/// Minimum waveform peak buffer size (in f32 values).
const MIN_PEAK_BUFFER_SIZE: usize = 1024;

/// Embedded WGSL shader source (compiled into binary).
const TIMELINE_SHADER: &str = include_str!("shaders/timeline.wgsl");

/// GPU rendering pipeline for the DAW timeline.
///
/// Manages all GPU resources needed to render clips, waveforms,
/// and MIDI notes. Designed for integration with Tauri's WebView
/// or standalone wgpu surfaces.
pub struct TimelineRenderer {
    /// wgpu device handle.
    device: wgpu::Device,

    /// wgpu command queue.
    queue: wgpu::Queue,

    /// Compiled render pipeline.
    pipeline: wgpu::RenderPipeline,

    /// Bind group layout for uniforms + storage buffers.
    bind_group_layout: wgpu::BindGroupLayout,

    /// GPU buffer for viewport uniforms.
    viewport_buffer: wgpu::Buffer,

    /// GPU buffer for clip instance data (storage).
    instance_buffer: wgpu::Buffer,

    /// GPU buffer for waveform peak data (storage).
    peak_buffer: wgpu::Buffer,

    /// Current peak buffer capacity (in bytes).
    peak_buffer_capacity: usize,
}

impl TimelineRenderer {
    /// Creates a new timeline renderer from existing wgpu device and queue.
    ///
    /// The `surface_format` must match the target render surface.
    pub fn new(
        device: wgpu::Device,
        queue: wgpu::Queue,
        surface_format: wgpu::TextureFormat,
    ) -> Self {
        let shader_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Dream DAW Timeline Shader"),
            source: wgpu::ShaderSource::Wgsl(TIMELINE_SHADER.into()),
        });

        // ── Bind Group Layout ──────────────────────────────────────
        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Timeline Bind Group Layout"),
            entries: &[
                // @group(0) @binding(0): viewport uniforms
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                // @group(0) @binding(1): clip instances (storage)
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: true },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                // @group(0) @binding(2): waveform peaks (storage)
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: true },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });

        // ── Pipeline Layout ────────────────────────────────────────
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Timeline Pipeline Layout"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });

        // ── Render Pipeline ────────────────────────────────────────
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Timeline Render Pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader_module,
                entry_point: Some("vs_main"),
                buffers: &[], // No vertex buffers — all data comes from storage
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader_module,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: surface_format,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleStrip,
                strip_index_format: None,
                front_face: wgpu::FrontFace::Ccw,
                cull_mode: None, // No culling for 2D quads
                polygon_mode: wgpu::PolygonMode::Fill,
                unclipped_depth: false,
                conservative: false,
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });

        // ── GPU Buffers ────────────────────────────────────────────
        let viewport_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Viewport Uniforms"),
            size: std::mem::size_of::<ViewportUniforms>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let instance_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Clip Instances"),
            size: (std::mem::size_of::<ClipInstance>() * MAX_CLIP_INSTANCES) as u64,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let peak_buffer_capacity = MIN_PEAK_BUFFER_SIZE * std::mem::size_of::<f32>();
        let peak_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Waveform Peaks"),
            size: peak_buffer_capacity as u64,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        Self {
            device,
            queue,
            pipeline,
            bind_group_layout,
            viewport_buffer,
            instance_buffer,
            peak_buffer,
            peak_buffer_capacity,
        }
    }

    /// Renders clip instances into the provided render pass.
    ///
    /// This is the main render entry point, called once per frame.
    ///
    /// # Arguments
    /// - `encoder`: Active command encoder
    /// - `target`: Texture view to render into
    /// - `viewport`: Current viewport state
    /// - `clips`: Array of clip instances to render
    /// - `peaks`: Waveform peak buffer
    /// - `clear_color`: Background color
    pub fn render(
        &mut self,
        encoder: &mut wgpu::CommandEncoder,
        target: &wgpu::TextureView,
        viewport: &Viewport,
        clips: &[ClipInstance],
        peaks: &WaveformPeakBuffer,
        clear_color: wgpu::Color,
    ) {
        if clips.is_empty() {
            return;
        }

        let clip_count = clips.len().min(MAX_CLIP_INSTANCES);

        // ── Upload viewport uniforms ───────────────────────────────
        let uniforms = ViewportUniforms {
            viewport_size: [viewport.width, viewport.height, 0.0, 0.0],
        };
        self.queue
            .write_buffer(&self.viewport_buffer, 0, bytemuck::bytes_of(&uniforms));

        // ── Upload clip instances ──────────────────────────────────
        self.queue.write_buffer(
            &self.instance_buffer,
            0,
            bytemuck::cast_slice(&clips[..clip_count]),
        );

        // ── Upload waveform peaks (reallocate if needed) ───────────
        let peak_bytes = if peaks.is_empty() {
            // Must upload at least a dummy value for the storage buffer
            &[0u8; 4][..]
        } else {
            peaks.as_bytes()
        };

        if peak_bytes.len() > self.peak_buffer_capacity {
            // Grow the peak buffer (double + round up)
            let new_capacity = (peak_bytes.len() * 2).max(MIN_PEAK_BUFFER_SIZE * 4);
            self.peak_buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("Waveform Peaks (regrown)"),
                size: new_capacity as u64,
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            self.peak_buffer_capacity = new_capacity;
        }

        self.queue.write_buffer(&self.peak_buffer, 0, peak_bytes);

        // ── Create bind group ──────────────────────────────────────
        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Timeline Bind Group"),
            layout: &self.bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: self.viewport_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: self.instance_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: self.peak_buffer.as_entire_binding(),
                },
            ],
        });

        // ── Render Pass ────────────────────────────────────────────
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Timeline Render Pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: target,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(clear_color),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });

            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &bind_group, &[]);

            // Draw: 4 vertices (quad) × N instances
            pass.draw(0..4, 0..clip_count as u32);
        }
    }

    /// Returns a reference to the wgpu device.
    pub fn device(&self) -> &wgpu::Device {
        &self.device
    }

    /// Returns a reference to the wgpu queue.
    pub fn queue(&self) -> &wgpu::Queue {
        &self.queue
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shader_source_is_valid() {
        // Verify the WGSL shader source is properly embedded
        assert!(!TIMELINE_SHADER.is_empty());
        assert!(TIMELINE_SHADER.contains("vs_main"));
        assert!(TIMELINE_SHADER.contains("fs_main"));
        assert!(TIMELINE_SHADER.contains("ClipInstance"));
    }

    #[test]
    #[allow(clippy::assertions_on_constants)]
    fn max_instances_is_reasonable() {
        assert!(MAX_CLIP_INSTANCES >= 1000);
        // Verify buffer size doesn't exceed 256MB
        let buffer_size = std::mem::size_of::<ClipInstance>() * MAX_CLIP_INSTANCES;
        assert!(buffer_size < 256 * 1024 * 1024);
    }
}
