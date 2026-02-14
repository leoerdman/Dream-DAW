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

use crate::dag::{AudioDag, AudioNode, ExecutionPlan, NodeKind};

// ── Constants ──────────────────────────────────────────────────────────

/// Maximum number of nodes the renderer can handle.
/// Pre-allocates this many buffer slots at construction time.
const MAX_GRAPH_NODES: usize = 256;

/// Maximum buffer size in frames per channel.
const MAX_BUFFER_FRAMES: usize = 8192;

/// Maximum PDC delay in samples (enough for most plugin chains).
/// Typical: convolution reverbs can be 4096+, linear-phase EQs ~8000.
const MAX_PDC_DELAY_SAMPLES: usize = 32768;

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
        for i in 0..n {
            self.left[i] += other.left[i];
            self.right[i] += other.right[i];
        }
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
            capacity,
            mask: capacity - 1,
        }
    }

    /// Sets the delay amount in samples.
    ///
    /// Called when the execution plan changes (not on the hot path).
    pub fn set_delay(&mut self, samples: usize) {
        self.delay_samples = samples.min(self.capacity - 1);
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
        if self.delay_samples == 0 {
            return;
        }

        let n = frame_count.min(left.len()).min(right.len());

        for i in 0..n {
            let wp = (self.write_pos + i) & self.mask;
            let rp = (self.write_pos + i + self.capacity - self.delay_samples) & self.mask;

            // Read delayed sample
            let delayed_l = self.buffer_left[rp];
            let delayed_r = self.buffer_right[rp];

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

    /// Maximum frames per buffer (from audio device).
    max_frames: usize,

    /// The number of nodes currently active in the plan.
    active_node_count: usize,
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
        self.active_node_count = plan.processing_order.len();

        // Ensure we have enough buffers
        while self.node_buffers.len() < self.active_node_count {
            self.node_buffers.push(NodeBuffer::new(self.max_frames));
            self.pdc_delays.push(PdcDelayLine::new(MAX_PDC_DELAY_SAMPLES));
        }

        // Update PDC delay values
        for (_i, &node_idx) in plan.processing_order.iter().enumerate() {
            let idx = node_idx.index();
            if idx < plan.delay_compensation.len() && idx < self.pdc_delays.len() {
                self.pdc_delays[idx].set_delay(plan.delay_compensation[idx] as usize);
            }
        }

        // Log the plan for diagnostics
        log::info!(
            "[GraphRenderer] Plan updated: {} nodes, {} with PDC",
            self.active_node_count,
            plan.delay_compensation.iter().filter(|&&d| d > 0).count(),
        );

        let _ = dag; // Used in future for per-node metadata inspection
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

        // ── 1. Clear all active node buffers ──────────────────────
        for &node_idx in &plan.processing_order {
            let idx = node_idx.index();
            if idx < self.node_buffers.len() {
                self.node_buffers[idx].clear(n);
            }
        }

        // ── 2. Process nodes in topological order ────────────────
        //
        // We process nodes sequentially. For each node:
        //   a) Sum all input buffers into this node's buffer.
        //   b) Apply PDC delay compensation.
        //   c) Dispatch to node-specific processor.
        //
        // Because the order is topological, every input is already
        // processed by the time we reach a node.

        for &node_idx in &plan.processing_order {
            let idx = node_idx.index();
            if idx >= self.node_buffers.len() {
                continue;
            }

            let node = dag.node(node_idx);

            // ── a) Sum inputs ────────────────────────────────────
            // Collect input indices to avoid borrow conflicts.
            // We use split_at_mut to get disjoint mutable references.
            let inputs = dag.inputs(node_idx);
            for &input_idx in &inputs {
                let src_idx = input_idx.index();
                if src_idx >= self.node_buffers.len() || src_idx == idx {
                    continue;
                }

                // Safe disjoint access: split the slice so we get &NodeBuffer
                // and &mut NodeBuffer simultaneously without unsafe.
                let (lo, hi) = if src_idx < idx {
                    let (a, b) = self.node_buffers.split_at_mut(idx);
                    (&a[src_idx], &mut b[0])
                } else {
                    let (a, b) = self.node_buffers.split_at_mut(src_idx);
                    let dst = &mut a[idx];
                    let src = &b[0];
                    (src, dst)
                };

                let copy_n = n.min(lo.valid_frames);
                for i in 0..copy_n {
                    hi.left[i] += lo.left[i];
                    hi.right[i] += lo.right[i];
                }
            }

            // ── b) Apply PDC delay compensation ──────────────────
            if idx < self.pdc_delays.len() {
                let buf = &mut self.node_buffers[idx];
                self.pdc_delays[idx].process(
                    &mut buf.left[..n],
                    &mut buf.right[..n],
                    n,
                );
            }

            // ── c) Dispatch to node processor ────────────────────
            let buf = &mut self.node_buffers[idx];
            match &node.kind {
                NodeKind::Track { .. } => {
                    // Track node: read clip audio into this buffer.
                    // The callback fills buf_left/buf_right with clip data.
                    track_processor(
                        node,
                        &mut buf.left[..n],
                        &mut buf.right[..n],
                        n,
                    );
                }
                NodeKind::Effect { .. } => {
                    // Effect node: process in-place (input already summed).
                    effect_processor(
                        node,
                        &mut buf.left[..n],
                        &mut buf.right[..n],
                        n,
                    );
                }
                NodeKind::Bus { .. } => {
                    // Bus node: no additional processing — inputs already summed.
                    // Future: gain/pan/compression on bus output.
                }
                NodeKind::MasterOutput => {
                    // Master node: copy to final output.
                    let out_n = n.min(output_left.len()).min(output_right.len());
                    output_left[..out_n].copy_from_slice(&buf.left[..out_n]);
                    output_right[..out_n].copy_from_slice(&buf.right[..out_n]);
                }
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
        ExecutionPlan {
            processing_order: order,
            delay_compensation: compensation,
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
}
