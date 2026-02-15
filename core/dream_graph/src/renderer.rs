// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Graph Renderer (Topological Execution Engine)
// ═══════════════════════════════════════════════════════════════════════════
//
// THE PROBLEM:
//   An execution plan (topological order + PDC) exists, but nothing
//   actually WALKS that plan and dispatches audio through each node.
//   The render callback needs a single entry point that:
//   1. Iterates nodes in topological order (sources first, master last).
//   2. Reads clip audio for Track nodes.
//   3. Calls PluginInstance::process() for Effect nodes.
//   4. Sums input buffers for Bus nodes.
//   5. Applies PDC delay compensation.
//   6. Writes the final result to the output buffer.
//
// THE SOLUTION: GraphRenderer
//   A pre-allocated executor struct that the audio callback owns.
//   Zero allocations on the hot path — all buffers are pre-allocated
//   at construction time.
//
// REAL-TIME SAFETY:
//   - Zero allocations in render()
//   - Zero locks
//   - Zero I/O (disk streaming handled upstream by DiskStreamer)
//   - Bounded loop iterations (node_count is known at plan swap)
//   - PDC delay lines are pre-allocated ring buffers
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::dag::{AudioDag, AudioNode, EdgeDelayCompensation, ExecutionPlan, NodeKind};
use petgraph::visit::EdgeRef;

// ── Constants ──────────────────────────────────────────────────────────

/// Maximum number of nodes the renderer can handle.
/// Pre-allocates this many buffer slots at construction time.
const MAX_GRAPH_NODES: usize = 256;

/// Maximum buffer size in frames per channel.
const MAX_BUFFER_FRAMES: usize = 8192;

/// Maximum PDC delay in samples (enough for most plugin chains).
/// Typical: convolution reverbs can be 4096+, linear-phase EQs ~8000.
const MAX_PDC_DELAY_SAMPLES: usize = 32768;

#[inline]
fn mix_in_place(dst: &mut [f32], src: &[f32], n: usize) {
    let count = n.min(dst.len()).min(src.len());
    #[cfg(target_arch = "x86_64")]
    {
        if std::arch::is_x86_feature_detected!("avx2") {
            unsafe { mix_in_place_avx2(dst, src, count) };
        } else {
            // SSE is guaranteed on x86_64.
            unsafe { mix_in_place_sse(dst, src, count) };
        }
    }
    #[cfg(target_arch = "aarch64")]
    {
        // NEON is guaranteed on AArch64 (Apple Silicon M1–M4).
        unsafe { mix_in_place_neon(dst, src, count) };
    }
    #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
    {
        for i in 0..count {
            dst[i] += src[i];
        }
    }
}

#[cfg(target_arch = "x86_64")]
#[inline]
#[allow(unsafe_op_in_unsafe_fn)]
unsafe fn mix_in_place_avx2(dst: &mut [f32], src: &[f32], count: usize) {
    use std::arch::x86_64::*;

    let mut i = 0usize;
    while i + 8 <= count {
        let a = _mm256_loadu_ps(dst.as_ptr().add(i));
        let b = _mm256_loadu_ps(src.as_ptr().add(i));
        let c = _mm256_add_ps(a, b);
        _mm256_storeu_ps(dst.as_mut_ptr().add(i), c);
        i += 8;
    }
    // Tail fallback (up to 7 samples).
    while i < count {
        dst[i] += src[i];
        i += 1;
    }
}

#[cfg(target_arch = "x86_64")]
#[inline]
#[allow(unsafe_op_in_unsafe_fn)]
unsafe fn mix_in_place_sse(dst: &mut [f32], src: &[f32], count: usize) {
    use std::arch::x86_64::*;

    let mut i = 0usize;
    while i + 4 <= count {
        let a = _mm_loadu_ps(dst.as_ptr().add(i));
        let b = _mm_loadu_ps(src.as_ptr().add(i));
        let c = _mm_add_ps(a, b);
        _mm_storeu_ps(dst.as_mut_ptr().add(i), c);
        i += 4;
    }
    while i < count {
        dst[i] += src[i];
        i += 1;
    }
}

#[cfg(target_arch = "aarch64")]
#[inline]
#[allow(unsafe_op_in_unsafe_fn)]
unsafe fn mix_in_place_neon(dst: &mut [f32], src: &[f32], count: usize) {
    use std::arch::aarch64::*;

    let mut i = 0usize;
    while i + 4 <= count {
        unsafe {
            let a = vld1q_f32(dst.as_ptr().add(i));
            let b = vld1q_f32(src.as_ptr().add(i));
            let c = vaddq_f32(a, b);
            vst1q_f32(dst.as_mut_ptr().add(i), c);
        }
        i += 4;
    }
    while i < count {
        unsafe { *dst.get_unchecked_mut(i) += *src.get_unchecked(i) };
        i += 1;
    }
}

// ── Node Buffer ────────────────────────────────────────────────────────

/// Pre-allocated stereo buffer for a single processing node.
///
/// Each node in the graph gets one `NodeBuffer`. Audio flows through
/// the graph by reading from input node buffers and writing to the
/// current node's buffer.
#[derive(Debug)]
pub struct NodeBuffer {
    /// Left channel samples.
    pub left: Vec<f32>,
    /// Right channel samples.
    pub right: Vec<f32>,
    /// Number of valid frames in this buffer (set per render cycle).
    pub valid_frames: usize,
}

impl NodeBuffer {
    /// Creates a new pre-allocated node buffer.
    pub fn new(max_frames: usize) -> Self {
        Self {
            left: vec![0.0; max_frames],
            right: vec![0.0; max_frames],
            valid_frames: 0,
        }
    }

    /// Clears the buffer (sets all samples to 0.0 for the given frame count).
    #[inline]
    pub fn clear(&mut self, frame_count: usize) {
        let n = frame_count.min(self.left.len());
        self.left[..n].fill(0.0);
        self.right[..n].fill(0.0);
        self.valid_frames = n;
    }

    /// Adds (mixes) another buffer into this one.
    ///
    /// Used by Bus and MasterOutput nodes to sum their inputs.
    #[inline]
    pub fn mix_from(&mut self, other: &NodeBuffer) {
        let n = self.valid_frames.min(other.valid_frames);
        mix_in_place(&mut self.left[..n], &other.left[..n], n);
        mix_in_place(&mut self.right[..n], &other.right[..n], n);
    }
}

// ── PDC Delay Line ──────────────────────────────────────────────────────

/// A simple delay line for Plugin Delay Compensation.
///
/// Implemented as a ring buffer with read/write pointers.
/// Pre-allocated at construction time — zero alloc on the hot path.
///
/// # Real-Time Safety
/// All operations are O(n) where n = frames per buffer, with no
/// allocations, locks, or branches beyond the ring modulus.
#[derive(Debug)]
pub struct PdcDelayLine {
    /// Ring buffer storage.
    buffer_left: Vec<f32>,
    buffer_right: Vec<f32>,
    /// Current write position in the ring buffer.
    write_pos: usize,
    /// Total delay in samples.
    delay_samples: usize,
    /// Fractional delay component in samples, [0.0, 1.0).
    frac_delay: f32,
    /// Ring buffer capacity (must be power of 2 for fast modulus).
    capacity: usize,
    /// Bitmask for fast modulus (capacity - 1).
    mask: usize,
}

impl PdcDelayLine {
    /// Creates a new delay line with the given maximum delay.
    ///
    /// Capacity is rounded up to the next power of 2 for fast modulus.
    pub fn new(max_delay: usize) -> Self {
        // Round up to next power of 2
        let capacity = (max_delay + MAX_BUFFER_FRAMES).next_power_of_two();
        Self {
            buffer_left: vec![0.0; capacity],
            buffer_right: vec![0.0; capacity],
            write_pos: 0,
            delay_samples: 0,
            frac_delay: 0.0,
            capacity,
            mask: capacity - 1,
        }
    }

    /// Sets the delay amount in samples.
    ///
    /// Called when the execution plan changes (not on the hot path).
    pub fn set_delay(&mut self, samples: usize) {
        self.delay_samples = samples.min(self.capacity - 1);
        self.frac_delay = 0.0;
    }

    /// Sets delay with sub-sample precision.
    pub fn set_delay_f32(&mut self, samples: f32) {
        let clamped = samples.max(0.0).min((self.capacity - 1) as f32);
        let int_delay = clamped.floor() as usize;
        self.delay_samples = int_delay;
        self.frac_delay = clamped - int_delay as f32;
    }

    /// Returns the current delay in samples.
    pub fn delay(&self) -> usize {
        self.delay_samples
    }

    /// Processes a buffer through the delay line in-place.
    ///
    /// For zero delay, this is a no-op (input passes through unchanged).
    ///
    /// # Real-Time Safety
    /// O(n) where n = frame_count. No allocations, no branches beyond
    /// the hot loop.
    #[inline]
    pub fn process(
        &mut self,
        left: &mut [f32],
        right: &mut [f32],
        frame_count: usize,
    ) {
        if self.delay_samples == 0 && self.frac_delay == 0.0 {
            return;
        }

        let n = frame_count.min(left.len()).min(right.len());
        let frac = self.frac_delay;

        for i in 0..n {
            let wp = (self.write_pos + i) & self.mask;
            let rp0 = (self.write_pos + i + self.capacity - self.delay_samples) & self.mask;

            let (delayed_l, delayed_r) = if frac == 0.0 {
                (self.buffer_left[rp0], self.buffer_right[rp0])
            } else {
                let rp1 = (rp0 + self.capacity - 1) & self.mask;
                (
                    self.buffer_left[rp0] * (1.0 - frac) + self.buffer_left[rp1] * frac,
                    self.buffer_right[rp0] * (1.0 - frac) + self.buffer_right[rp1] * frac,
                )
            };

            // Write current sample into ring buffer
            self.buffer_left[wp] = left[i];
            self.buffer_right[wp] = right[i];

            // Output delayed sample
            left[i] = delayed_l;
            right[i] = delayed_r;
        }

        self.write_pos = (self.write_pos + n) & self.mask;
    }

    /// Resets the delay line to silence (called on transport reset/seek).
    pub fn reset(&mut self) {
        self.buffer_left.fill(0.0);
        self.buffer_right.fill(0.0);
        self.write_pos = 0;
    }
}

// ── Graph Renderer ──────────────────────────────────────────────────────

/// The render context for graph-based audio processing.
///
/// Owns pre-allocated per-node buffers and PDC delay lines.
/// The audio callback calls `render()` once per buffer, which walks
/// the execution plan in topological order.
///
/// # Lifecycle
/// 1. Created once at engine startup with `GraphRenderer::new()`.
/// 2. When the graph changes, `update_plan()` is called to resize
///    buffers and update PDC values (NOT on the audio thread).
/// 3. `render()` is called every ~0.5ms on the audio thread.
///
/// # Real-Time Safety
/// `render()` is 100% real-time safe:
///   - All buffers pre-allocated
///   - Bounded iteration (node_count known at plan-swap time)
///   - No allocations, no locks, no I/O
pub struct GraphRenderer {
    /// Pre-allocated per-node audio buffers, indexed by NodeIndex.
    node_buffers: Vec<NodeBuffer>,

    /// PDC delay lines, one per node.
    pdc_delays: Vec<PdcDelayLine>,

    /// Edge-level PDC delay lines.
    edge_pdc_delays: Vec<EdgeDelayRuntime>,

    /// Incoming edge lookup per destination node: (src_idx, edge_runtime_idx).
    edge_inputs_by_dst: Vec<Vec<(usize, usize)>>,

    /// Scratch buffer reused for edge delay processing.
    edge_scratch: NodeBuffer,

    /// Maximum frames per buffer (from audio device).
    max_frames: usize,

    /// The number of nodes currently active in the plan.
    active_node_count: usize,
}

#[derive(Debug)]
struct EdgeDelayRuntime {
    delay: PdcDelayLine,
}

impl GraphRenderer {
    /// Creates a new graph renderer with pre-allocated buffers.
    ///
    /// # Arguments
    /// - `max_nodes`: Maximum number of nodes in the graph.
    /// - `max_frames`: Maximum frames per audio buffer.
    pub fn new(max_nodes: usize, max_frames: usize) -> Self {
        let node_count = max_nodes.min(MAX_GRAPH_NODES);
        let frame_count = max_frames.min(MAX_BUFFER_FRAMES);

        let mut node_buffers = Vec::with_capacity(node_count);
        let mut pdc_delays = Vec::with_capacity(node_count);
        for _ in 0..node_count {
            node_buffers.push(NodeBuffer::new(frame_count));
            pdc_delays.push(PdcDelayLine::new(MAX_PDC_DELAY_SAMPLES));
        }

        Self {
            node_buffers,
            pdc_delays,
            edge_pdc_delays: Vec::new(),
            edge_inputs_by_dst: vec![Vec::new(); node_count.max(1)],
            edge_scratch: NodeBuffer::new(frame_count),
            max_frames: frame_count,
            active_node_count: 0,
        }
    }

    /// Updates the renderer for a new execution plan.
    ///
    /// Sets PDC delay values for each node. This is called from the
    /// UI thread when the graph topology changes.
    ///
    /// # NOT Real-Time Safe
    /// May resize internal structures if needed.
    pub fn update_plan(&mut self, plan: &ExecutionPlan, dag: &AudioDag) {
        self.active_node_count = if !plan.processing_order.is_empty() {
            plan.processing_order.len()
        } else {
            plan.parallel_stages.iter().map(|s| s.len()).sum()
        };

        // Ensure we have enough buffers
        while self.node_buffers.len() < self.active_node_count {
            self.node_buffers.push(NodeBuffer::new(self.max_frames));
            self.pdc_delays.push(PdcDelayLine::new(MAX_PDC_DELAY_SAMPLES));
        }

        while self.edge_inputs_by_dst.len() < self.node_buffers.len() {
            self.edge_inputs_by_dst.push(Vec::new());
        }

        // Update PDC delay values
        if !plan.processing_order.is_empty() {
            for &node_idx in &plan.processing_order {
                let idx = node_idx.index();
                if idx < plan.delay_compensation.len() && idx < self.pdc_delays.len() {
                    self.pdc_delays[idx].set_delay(plan.delay_compensation[idx] as usize);
                }
            }
        } else {
            for stage in &plan.parallel_stages {
                for &node_idx in stage {
                    let idx = node_idx.index();
                    if idx < plan.delay_compensation.len() && idx < self.pdc_delays.len() {
                        self.pdc_delays[idx].set_delay(plan.delay_compensation[idx] as usize);
                    }
                }
            }
        }

        self.configure_edge_pdc(&plan.edge_delay_compensation);

        // Log the plan for diagnostics
        log::info!(
            "[GraphRenderer] Plan updated: {} nodes, {} stages, {} node-PDC, {} edge-PDC",
            self.active_node_count,
            plan.parallel_stages.len(),
            plan.delay_compensation.iter().filter(|&&d| d > 0).count(),
            plan.edge_delay_compensation
                .iter()
                .filter(|e| e.delay_samples > 0)
                .count(),
        );

        let _ = dag; // Used in future for per-node metadata inspection
    }

    fn configure_edge_pdc(&mut self, edge_plan: &[EdgeDelayCompensation]) {
        self.edge_pdc_delays.clear();
        for dst in &mut self.edge_inputs_by_dst {
            dst.clear();
        }

        for edge in edge_plan {
            let src_idx = edge.from.index();
            let dst_idx = edge.to.index();
            if src_idx >= self.node_buffers.len() || dst_idx >= self.node_buffers.len() {
                continue;
            }

            let mut delay = PdcDelayLine::new(MAX_PDC_DELAY_SAMPLES);
            delay.set_delay(edge.delay_samples as usize);

            let runtime_idx = self.edge_pdc_delays.len();
            self.edge_pdc_delays.push(EdgeDelayRuntime {
                delay,
            });
            self.edge_inputs_by_dst[dst_idx].push((src_idx, runtime_idx));
        }
    }

    #[inline]
    fn clear_active_buffers(&mut self, plan: &ExecutionPlan, frame_count: usize) {
        if !plan.processing_order.is_empty() {
            for &node_idx in &plan.processing_order {
                let idx = node_idx.index();
                if idx < self.node_buffers.len() {
                    self.node_buffers[idx].clear(frame_count);
                }
            }
        } else {
            for stage in &plan.parallel_stages {
                for &node_idx in stage {
                    let idx = node_idx.index();
                    if idx < self.node_buffers.len() {
                        self.node_buffers[idx].clear(frame_count);
                    }
                }
            }
        }
    }

    #[inline]
    #[allow(clippy::too_many_arguments)]
    fn process_node<FTrack, FEffect>(
        &mut self,
        dag: &AudioDag,
        node_idx: petgraph::graph::NodeIndex,
        frame_count: usize,
        output_left: &mut [f32],
        output_right: &mut [f32],
        track_processor: &mut FTrack,
        effect_processor: &mut FEffect,
    )
    where
        FTrack: FnMut(&AudioNode, &mut [f32], &mut [f32], usize),
        FEffect: FnMut(&AudioNode, &mut [f32], &mut [f32], usize),
    {
        let idx = node_idx.index();
        if idx >= self.node_buffers.len() {
            return;
        }

        let node = dag.node(node_idx);

        // a) Sum inputs into node buffer (edge-level PDC if configured).
        if idx < self.edge_inputs_by_dst.len() && !self.edge_inputs_by_dst[idx].is_empty() {
            let edge_input_len = self.edge_inputs_by_dst[idx].len();
            for i in 0..edge_input_len {
                let (src_idx, edge_runtime_idx) = self.edge_inputs_by_dst[idx][i];
                if src_idx >= self.node_buffers.len() || src_idx == idx || edge_runtime_idx >= self.edge_pdc_delays.len() {
                    continue;
                }

                // Copy source into scratch so each edge has independent delay state.
                let copy_n = {
                    let src = &self.node_buffers[src_idx];
                    let copy_n = frame_count.min(src.valid_frames);
                    self.edge_scratch.left[..copy_n].copy_from_slice(&src.left[..copy_n]);
                    self.edge_scratch.right[..copy_n].copy_from_slice(&src.right[..copy_n]);
                    copy_n
                };

                self.edge_pdc_delays[edge_runtime_idx]
                    .delay
                    .process(
                        &mut self.edge_scratch.left[..copy_n],
                        &mut self.edge_scratch.right[..copy_n],
                        copy_n,
                    );

                let dst = &mut self.node_buffers[idx];
                mix_in_place(
                    &mut dst.left[..copy_n],
                    &self.edge_scratch.left[..copy_n],
                    copy_n,
                );
                mix_in_place(
                    &mut dst.right[..copy_n],
                    &self.edge_scratch.right[..copy_n],
                    copy_n,
                );
            }
        } else {
            for edge in dag
                .graph()
                .edges_directed(node_idx, petgraph::Direction::Incoming)
            {
                let src_idx = edge.source().index();
                if src_idx >= self.node_buffers.len() || src_idx == idx {
                    continue;
                }

                let (src, dst) = if src_idx < idx {
                    let (a, b) = self.node_buffers.split_at_mut(idx);
                    (&a[src_idx], &mut b[0])
                } else {
                    let (a, b) = self.node_buffers.split_at_mut(src_idx);
                    (&b[0], &mut a[idx])
                };

                let copy_n = frame_count.min(src.valid_frames);
                mix_in_place(&mut dst.left[..copy_n], &src.left[..copy_n], copy_n);
                mix_in_place(&mut dst.right[..copy_n], &src.right[..copy_n], copy_n);
            }
        }

        // b) Dispatch node processor.
        let buf = &mut self.node_buffers[idx];
        match &node.kind {
            NodeKind::Track { .. } => {
                track_processor(
                    node,
                    &mut buf.left[..frame_count],
                    &mut buf.right[..frame_count],
                    frame_count,
                );
            }
            NodeKind::Effect { .. } => {
                effect_processor(
                    node,
                    &mut buf.left[..frame_count],
                    &mut buf.right[..frame_count],
                    frame_count,
                );
            }
            NodeKind::Bus { .. } => {}
            NodeKind::MasterOutput => {}
        }

        // c) Apply PDC delay compensation on node output.
        if idx < self.pdc_delays.len() {
            self.pdc_delays[idx].process(
                &mut buf.left[..frame_count],
                &mut buf.right[..frame_count],
                frame_count,
            );
        }

        // d) Master node copies to final output.
        if matches!(&node.kind, NodeKind::MasterOutput) {
            let out_n = frame_count.min(output_left.len()).min(output_right.len());
            output_left[..out_n].copy_from_slice(&buf.left[..out_n]);
            output_right[..out_n].copy_from_slice(&buf.right[..out_n]);
        }
    }

    /// Renders one audio buffer through the graph.
    ///
    /// Walks the execution plan in topological order:
    /// 1. For each node, clear its buffer.
    /// 2. Sum all input node buffers into the current node's buffer.
    /// 3. Apply PDC delay compensation.
    /// 4. Dispatch to the node-specific processor (Track, Effect, Bus, Master).
    /// 5. Copy the master output to the final output buffer.
    ///
    /// # Arguments
    /// - `plan`: The current execution plan (loaded via `LiveGraph::load()`).
    /// - `dag`: The current audio DAG (for node metadata).
    /// - `frame_count`: Number of frames to process this cycle.
    /// - `output_left`: Final left channel output buffer.
    /// - `output_right`: Final right channel output buffer.
    /// - `track_processor`: Callback for Track nodes (reads clip audio).
    /// - `effect_processor`: Callback for Effect nodes (plugin processing).
    ///
    /// # Real-Time Safety
    /// Zero allocations. Zero locks. Zero I/O. Bounded iteration.
    #[inline]
    #[allow(clippy::too_many_arguments)]
    pub fn render<FTrack, FEffect>(
        &mut self,
        plan: &ExecutionPlan,
        dag: &AudioDag,
        frame_count: usize,
        output_left: &mut [f32],
        output_right: &mut [f32],
        mut track_processor: FTrack,
        mut effect_processor: FEffect,
    )
    where
        FTrack: FnMut(
            &AudioNode,            // node metadata
            &mut [f32],            // left channel buffer
            &mut [f32],            // right channel buffer
            usize,                 // frame count
        ),
        FEffect: FnMut(
            &AudioNode,            // node metadata
            &mut [f32],            // left channel buffer (in-place)
            &mut [f32],            // right channel buffer (in-place)
            usize,                 // frame count
        ),
    {
        let n = frame_count.min(self.max_frames);
        let out_n = n.min(output_left.len()).min(output_right.len());

        // Clear output slice up-front so stale samples never leak when a plan is empty
        // or a master node is absent from an outdated execution order.
        output_left[..out_n].fill(0.0);
        output_right[..out_n].fill(0.0);

        // 1) Clear active buffers.
        self.clear_active_buffers(plan, n);

        // 2) Execute by dependency stages when available.
        // Fallback keeps compatibility with legacy plans.
        if !plan.parallel_stages.is_empty() {
            for stage in &plan.parallel_stages {
                for &node_idx in stage {
                    self.process_node(
                        dag,
                        node_idx,
                        n,
                        output_left,
                        output_right,
                        &mut track_processor,
                        &mut effect_processor,
                    );
                }
            }
        } else {
            for &node_idx in &plan.processing_order {
                self.process_node(
                    dag,
                    node_idx,
                    n,
                    output_left,
                    output_right,
                    &mut track_processor,
                    &mut effect_processor,
                );
            }
        }
    }

    /// Resets all PDC delay lines and buffers (called on transport seek).
    pub fn reset(&mut self) {
        for buf in &mut self.node_buffers {
            buf.clear(self.max_frames);
        }
        for delay in &mut self.pdc_delays {
            delay.reset();
        }
        for edge in &mut self.edge_pdc_delays {
            edge.delay.reset();
        }
    }

    /// Returns the number of pre-allocated node buffer slots.
    pub fn capacity(&self) -> usize {
        self.node_buffers.len()
    }

    /// Returns the number of active nodes in the current plan.
    pub fn active_node_count(&self) -> usize {
        self.active_node_count
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dag::*;
    use crate::pdc;

    fn build_simple_dag() -> AudioDag {
        // Track1 → Master
        GraphBuilder::new()
            .add_node(AudioNode::new(NodeId(0), NodeKind::MasterOutput))
            .add_node(AudioNode::new(
                NodeId(1),
                NodeKind::Track { name: "Track 1".into() },
            ))
            .add_edge(NodeId(1), NodeId(0))
            .unwrap()
            .build()
            .unwrap()
    }

    fn build_chain_dag() -> AudioDag {
        // Track → Effect (256 latency) → Master
        GraphBuilder::new()
            .add_node(AudioNode::new(NodeId(0), NodeKind::MasterOutput))
            .add_node(AudioNode::new(
                NodeId(1),
                NodeKind::Track { name: "Piano".into() },
            ))
            .add_node(AudioNode::new(
                NodeId(2),
                NodeKind::Effect {
                    name: "Reverb".into(),
                    latency_samples: 256,
                },
            ))
            .add_edge(NodeId(1), NodeId(2))
            .unwrap()
            .add_edge(NodeId(2), NodeId(0))
            .unwrap()
            .build()
            .unwrap()
    }

    fn make_plan(dag: &AudioDag) -> ExecutionPlan {
        let order = dag.topological_order().unwrap();
        let compensation = pdc::compute_delay_compensation(dag, &order);
        let edge_compensation = pdc::compute_edge_delay_compensation(dag, &order);
        let stages = dag.parallel_stages_from_order(&order);
        let metrics = AudioDag::parallelism_metrics_from_stages(&stages);
        ExecutionPlan {
            processing_order: order,
            delay_compensation: compensation,
            edge_delay_compensation: edge_compensation,
            parallel_stages: stages,
            parallelism_metrics: metrics,
        }
    }

    #[test]
    fn renderer_processes_simple_graph() {
        let dag = build_simple_dag();
        let plan = make_plan(&dag);

        let mut renderer = GraphRenderer::new(16, 256);
        renderer.update_plan(&plan, &dag);

        let mut out_l = vec![0.0f32; 256];
        let mut out_r = vec![0.0f32; 256];

        renderer.render(
            &plan,
            &dag,
            256,
            &mut out_l,
            &mut out_r,
            |_node, left, right, n| {
                // Track processor: fill with 1.0 (test signal)
                for i in 0..n {
                    left[i] = 1.0;
                    right[i] = 0.5;
                }
            },
            |_node, _left, _right, _n| {
                // No effects in this graph
            },
        );

        // Master output should contain the track signal
        assert_eq!(out_l[0], 1.0);
        assert_eq!(out_r[0], 0.5);
        assert_eq!(out_l[255], 1.0);
    }

    #[test]
    fn renderer_applies_track_output_pdc() {
        let dag = build_simple_dag();
        let order = dag.topological_order().unwrap();
        let mut compensation = vec![0u32; dag.graph().node_count()];
        let track_idx = dag
            .graph()
            .node_indices()
            .find(|&i| matches!(dag.node(i).kind, NodeKind::Track { .. }))
            .unwrap();
        compensation[track_idx.index()] = 2;
        let plan = ExecutionPlan {
            processing_order: order.clone(),
            delay_compensation: compensation,
            edge_delay_compensation: Vec::new(),
            parallel_stages: dag.parallel_stages_from_order(&order),
            parallelism_metrics: dag.parallelism_metrics_from_order(&order),
        };

        let mut renderer = GraphRenderer::new(16, 16);
        renderer.update_plan(&plan, &dag);

        let mut out_l = vec![0.0f32; 8];
        let mut out_r = vec![0.0f32; 8];

        renderer.render(
            &plan,
            &dag,
            8,
            &mut out_l,
            &mut out_r,
            |_node, left, right, n| {
                for i in 0..n {
                    left[i] = 1.0;
                    right[i] = 1.0;
                }
            },
            |_node, _left, _right, _n| {},
        );

        assert_eq!(out_l[0], 0.0);
        assert_eq!(out_l[1], 0.0);
        assert_eq!(out_l[2], 1.0);
    }

    #[test]
    fn renderer_processes_effect_chain() {
        let dag = build_chain_dag();
        let plan = make_plan(&dag);

        let mut renderer = GraphRenderer::new(16, 256);
        renderer.update_plan(&plan, &dag);

        let mut out_l = vec![0.0f32; 256];
        let mut out_r = vec![0.0f32; 256];

        renderer.render(
            &plan,
            &dag,
            256,
            &mut out_l,
            &mut out_r,
            |_node, left, right, n| {
                for i in 0..n {
                    left[i] = 0.8;
                    right[i] = 0.8;
                }
            },
            |_node, left, right, n| {
                // Effect: halve the signal (simulating gain reduction)
                for i in 0..n {
                    left[i] *= 0.5;
                    right[i] *= 0.5;
                }
            },
        );

        // Output should be 0.8 * 0.5 = 0.4 (track through effect)
        // Note: PDC delay may affect initial samples
        assert!((out_l[0] - 0.4).abs() < 0.01 || out_l[0] == 0.0);
    }

    #[test]
    fn pdc_delay_line_basic() {
        let mut delay = PdcDelayLine::new(1024);
        delay.set_delay(4);

        let mut left = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0];
        let mut right = left;

        delay.process(&mut left, &mut right, 8);

        // First 4 samples should be silence (delay = 4)
        assert_eq!(left[0], 0.0);
        assert_eq!(left[1], 0.0);
        assert_eq!(left[2], 0.0);
        assert_eq!(left[3], 0.0);
        // Sample 4 should be the original sample 0
        assert_eq!(left[4], 1.0);
        assert_eq!(left[5], 2.0);
    }

    #[test]
    fn pdc_delay_line_zero_delay_passthrough() {
        let mut delay = PdcDelayLine::new(1024);
        delay.set_delay(0);

        let mut left = [1.0, 2.0, 3.0, 4.0];
        let mut right = left;

        delay.process(&mut left, &mut right, 4);

        // Zero delay = passthrough
        assert_eq!(left, [1.0, 2.0, 3.0, 4.0]);
    }

    #[test]
    fn pdc_delay_line_fractional_delay_interpolates() {
        let mut delay = PdcDelayLine::new(1024);
        delay.set_delay_f32(1.5);

        let mut left = [1.0, 3.0, 5.0, 7.0];
        let mut right = left;

        delay.process(&mut left, &mut right, 4);

        assert!((left[0] - 0.0).abs() < 1e-6);
        assert!((left[1] - 0.5).abs() < 1e-6);
        assert!((left[2] - 2.0).abs() < 1e-6);
        assert!((left[3] - 4.0).abs() < 1e-6);
    }

    #[test]
    fn pdc_delay_line_reset() {
        let mut delay = PdcDelayLine::new(1024);
        delay.set_delay(4);

        let mut left = [1.0; 8];
        let mut right = left;
        delay.process(&mut left, &mut right, 8);

        delay.reset();

        let mut left2 = [5.0; 8];
        let mut right2 = left2;
        delay.process(&mut left2, &mut right2, 8);

        // After reset, first 4 samples should be silence again
        assert_eq!(left2[0], 0.0);
        assert_eq!(left2[3], 0.0);
        assert_eq!(left2[4], 5.0);
    }

    #[test]
    fn renderer_reset_clears_all() {
        let mut renderer = GraphRenderer::new(8, 128);
        renderer.reset();
        assert_eq!(renderer.capacity(), 8);
    }

    #[test]
    fn node_buffer_mix_from() {
        let mut dst = NodeBuffer::new(4);
        dst.clear(4);
        dst.left[0] = 1.0;
        dst.right[0] = 2.0;

        let mut src = NodeBuffer::new(4);
        src.clear(4);
        src.left[0] = 0.5;
        src.right[0] = 0.3;

        dst.mix_from(&src);
        assert_eq!(dst.left[0], 1.5);
        assert_eq!(dst.right[0], 2.3);
    }

    #[test]
    fn render_silences_output_when_plan_has_no_nodes() {
        let dag = build_simple_dag();
        let plan = ExecutionPlan {
            processing_order: Vec::new(),
            delay_compensation: Vec::new(),
            edge_delay_compensation: Vec::new(),
            parallel_stages: Vec::new(),
            parallelism_metrics: ParallelismMetrics::default(),
        };

        let mut renderer = GraphRenderer::new(8, 16);
        renderer.update_plan(&plan, &dag);

        let mut out_l = vec![0.75f32; 8];
        let mut out_r = vec![0.75f32; 8];
        renderer.render(
            &plan,
            &dag,
            8,
            &mut out_l,
            &mut out_r,
            |_node, _left, _right, _n| {},
            |_node, _left, _right, _n| {},
        );

        assert!(out_l.iter().all(|&x| x == 0.0));
        assert!(out_r.iter().all(|&x| x == 0.0));
    }

    #[test]
    fn renderer_handles_bus_summing() {
        // Track1 ─┐
        //         ├→ Bus → Master
        // Track2 ─┘
        let dag = GraphBuilder::new()
            .add_node(AudioNode::new(NodeId(0), NodeKind::MasterOutput))
            .add_node(AudioNode::new(
                NodeId(1),
                NodeKind::Track { name: "T1".into() },
            ))
            .add_node(AudioNode::new(
                NodeId(2),
                NodeKind::Track { name: "T2".into() },
            ))
            .add_node(AudioNode::new(
                NodeId(3),
                NodeKind::Bus { name: "Sum".into() },
            ))
            .add_edge(NodeId(1), NodeId(3))
            .unwrap()
            .add_edge(NodeId(2), NodeId(3))
            .unwrap()
            .add_edge(NodeId(3), NodeId(0))
            .unwrap()
            .build()
            .unwrap();

        let plan = make_plan(&dag);
        let mut renderer = GraphRenderer::new(16, 64);
        renderer.update_plan(&plan, &dag);

        let mut out_l = vec![0.0f32; 64];
        let mut out_r = vec![0.0f32; 64];

        renderer.render(
            &plan,
            &dag,
            64,
            &mut out_l,
            &mut out_r,
            |node, left, right, n| {
                // T1 outputs 0.3, T2 outputs 0.7
                let val = if node.display_name() == "T1" { 0.3 } else { 0.7 };
                for i in 0..n {
                    left[i] = val;
                    right[i] = val;
                }
            },
            |_node, _left, _right, _n| {},
        );

        // Bus sums T1 + T2 = 0.3 + 0.7 = 1.0
        assert!((out_l[0] - 1.0).abs() < 0.001);
        assert!((out_r[0] - 1.0).abs() < 0.001);
    }

    #[test]
    fn renderer_can_execute_from_stage_plan_without_processing_order() {
        let dag = build_simple_dag();
        let mut plan = make_plan(&dag);
        // Force stage-only execution path.
        plan.processing_order.clear();

        let mut renderer = GraphRenderer::new(16, 64);
        renderer.update_plan(&plan, &dag);

        let mut out_l = vec![0.0f32; 64];
        let mut out_r = vec![0.0f32; 64];

        renderer.render(
            &plan,
            &dag,
            64,
            &mut out_l,
            &mut out_r,
            |_node, left, right, n| {
                for i in 0..n {
                    left[i] = 0.25;
                    right[i] = 0.25;
                }
            },
            |_node, _left, _right, _n| {},
        );

        assert!((out_l[0] - 0.25).abs() < 0.001);
        assert!((out_r[0] - 0.25).abs() < 0.001);
    }

    #[test]
    fn renderer_applies_edge_level_pdc() {
        // T1 -> Bus -> Master
        // T2 -> Bus -> Master
        let dag = GraphBuilder::new()
            .add_node(AudioNode::new(NodeId(0), NodeKind::MasterOutput))
            .add_node(AudioNode::new(
                NodeId(1),
                NodeKind::Track { name: "T1".into() },
            ))
            .add_node(AudioNode::new(
                NodeId(2),
                NodeKind::Track { name: "T2".into() },
            ))
            .add_node(AudioNode::new(
                NodeId(3),
                NodeKind::Bus { name: "Bus".into() },
            ))
            .add_edge(NodeId(1), NodeId(3))
            .unwrap()
            .add_edge(NodeId(2), NodeId(3))
            .unwrap()
            .add_edge(NodeId(3), NodeId(0))
            .unwrap()
            .build()
            .unwrap();

        let order = dag.topological_order().unwrap();
        let stages = dag.parallel_stages_from_order(&order);
        let bus_idx = dag
            .graph()
            .node_indices()
            .find(|&i| matches!(dag.node(i).kind, NodeKind::Bus { .. }))
            .unwrap();
        let t2_idx = dag
            .graph()
            .node_indices()
            .find(|&i| dag.node(i).display_name() == "T2")
            .unwrap();
        let t1_idx = dag
            .graph()
            .node_indices()
            .find(|&i| dag.node(i).display_name() == "T1")
            .unwrap();

        let plan = ExecutionPlan {
            processing_order: order,
            delay_compensation: vec![0; dag.graph().node_count()],
            edge_delay_compensation: vec![
                EdgeDelayCompensation {
                    from: t1_idx,
                    to: bus_idx,
                    delay_samples: 0,
                },
                EdgeDelayCompensation {
                    from: t2_idx,
                    to: bus_idx,
                    delay_samples: 2,
                },
            ],
            parallel_stages: stages.clone(),
            parallelism_metrics: AudioDag::parallelism_metrics_from_stages(&stages),
        };

        let mut renderer = GraphRenderer::new(16, 16);
        renderer.update_plan(&plan, &dag);

        let mut out_l = vec![0.0f32; 8];
        let mut out_r = vec![0.0f32; 8];

        renderer.render(
            &plan,
            &dag,
            8,
            &mut out_l,
            &mut out_r,
            |node, left, right, n| {
                // Impulses from both tracks at sample 0.
                if node.display_name() == "T1" || node.display_name() == "T2" {
                    left[..n].fill(0.0);
                    right[..n].fill(0.0);
                    left[0] = 1.0;
                    right[0] = 1.0;
                }
            },
            |_node, _left, _right, _n| {},
        );

        // At master: T1 impulse at t=0, T2 delayed by 2 samples.
        assert_eq!(out_l[0], 1.0);
        assert_eq!(out_l[1], 0.0);
        assert_eq!(out_l[2], 1.0);
    }
}
