use crate::dag::{AudioDag, AudioNode, EdgeDelayCompensation, ExecutionPlan, NodeKind};
use petgraph::visit::{EdgeRef, NodeIndexable};

const MAX_GRAPH_NODES: usize = 256;

const MAX_BUFFER_FRAMES: usize = 8192;

const MAX_PDC_DELAY_SAMPLES: usize = 32768;

#[inline]
fn mix_in_place(dst: &mut [f32], src: &[f32], n: usize) {
    let count = n.min(dst.len()).min(src.len());
    #[cfg(target_arch = "x86_64")]
    {
        if std::arch::is_x86_feature_detected!("avx2") {
            unsafe { mix_in_place_avx2(dst, src, count) };
        } else {
            unsafe { mix_in_place_sse(dst, src, count) };
        }
    }
    #[cfg(target_arch = "aarch64")]
    {
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
#[target_feature(enable = "avx2")]
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
    while i < count {
        dst[i] += src[i];
        i += 1;
    }
}

#[cfg(target_arch = "x86_64")]
#[inline]
#[allow(unsafe_op_in_unsafe_fn)]
#[target_feature(enable = "sse")]
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
#[target_feature(enable = "neon")]
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
        dst[i] += src[i];
        i += 1;
    }
}

#[derive(Debug)]
pub struct NodeBuffer {
    pub left: Vec<f32>,
    pub right: Vec<f32>,
    pub valid_frames: usize,
}

impl NodeBuffer {
    pub fn new(max_frames: usize) -> Self {
        Self {
            left: vec![0.0; max_frames],
            right: vec![0.0; max_frames],
            valid_frames: 0,
        }
    }

    #[inline]
    pub fn clear(&mut self, frame_count: usize) {
        let n = frame_count.min(self.left.len());
        self.left[..n].fill(0.0);
        self.right[..n].fill(0.0);
        self.valid_frames = n;
    }

    #[inline]
    pub fn mix_from(&mut self, other: &NodeBuffer) {
        let n = self.valid_frames.min(other.valid_frames);
        mix_in_place(&mut self.left[..n], &other.left[..n], n);
        mix_in_place(&mut self.right[..n], &other.right[..n], n);
    }
}

#[derive(Debug)]
pub struct PdcDelayLine {
    buffer_left: Vec<f32>,
    buffer_right: Vec<f32>,
    write_pos: usize,
    delay_samples: usize,
    frac_delay: f32,
    capacity: usize,
    mask: usize,
}

impl PdcDelayLine {
    pub fn new(max_delay: usize) -> Self {
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

    pub fn set_delay(&mut self, samples: usize) {
        self.delay_samples = samples.min(self.capacity - 1);
        self.frac_delay = 0.0;
    }

    pub fn set_delay_f32(&mut self, samples: f32) {
        let clamped = samples.max(0.0).min((self.capacity - 1) as f32);
        let int_delay = clamped.floor() as usize;
        self.delay_samples = int_delay;
        self.frac_delay = clamped - int_delay as f32;
    }

    pub fn delay(&self) -> usize {
        self.delay_samples
    }

    #[inline]
    pub fn process(&mut self, left: &mut [f32], right: &mut [f32], frame_count: usize) {
        // BUG-048 FIX: Use epsilon instead of == 0.0 for float comparison.
        // FP drift from set_delay_f32 could leave frac_delay at ~1e-15,
        // keeping the PDC permanently in the slow interpolation path.
        const FRAC_EPS: f32 = 1e-7;
        if self.delay_samples == 0 && self.frac_delay < FRAC_EPS {
            return;
        }

        let n = frame_count.min(left.len()).min(right.len());

        if self.frac_delay < FRAC_EPS {
            for i in 0..n {
                let wp = (self.write_pos + i) & self.mask;
                let rp = (self.write_pos + i + self.capacity - self.delay_samples) & self.mask;
                let delayed_l = self.buffer_left[rp];
                let delayed_r = self.buffer_right[rp];
                self.buffer_left[wp] = left[i];
                self.buffer_right[wp] = right[i];
                left[i] = delayed_l;
                right[i] = delayed_r;
            }
        } else {
            let frac = self.frac_delay;
            for i in 0..n {
                let wp = (self.write_pos + i) & self.mask;
                
                // BUG-060 FIX: When delay_samples == 0, rp0 aligns with wp representing 0 delay.
                // However buffer_left[wp] won't be written continuously until further down. 
                // We tap the exact live sample left[i] as the delay=0 source, and buffer_left[rp1] 
                // as the delay=1 source to interpolate correctly.
                let delayed_l = if self.delay_samples == 0 {
                    let rp1 = (wp + self.capacity - 1) & self.mask;
                    left[i] * (1.0 - frac) + self.buffer_left[rp1] * frac
                } else {
                    let rp0 = (self.write_pos + i + self.capacity - self.delay_samples) & self.mask;
                    let rp1 = (rp0 + self.capacity - 1) & self.mask;
                    self.buffer_left[rp0] * (1.0 - frac) + self.buffer_left[rp1] * frac
                };

                let delayed_r = if self.delay_samples == 0 {
                    let rp1 = (wp + self.capacity - 1) & self.mask;
                    right[i] * (1.0 - frac) + self.buffer_right[rp1] * frac
                } else {
                    let rp0 = (self.write_pos + i + self.capacity - self.delay_samples) & self.mask;
                    let rp1 = (rp0 + self.capacity - 1) & self.mask;
                    self.buffer_right[rp0] * (1.0 - frac) + self.buffer_right[rp1] * frac
                };

                self.buffer_left[wp] = left[i];
                self.buffer_right[wp] = right[i];
                left[i] = delayed_l;
                right[i] = delayed_r;
            }
        }

        self.write_pos = (self.write_pos + n) & self.mask;
    }

    pub fn reset(&mut self) {
        self.buffer_left.fill(0.0);
        self.buffer_right.fill(0.0);
        self.write_pos = 0;
    }
}

pub struct GraphRenderer {
    node_buffers: Vec<NodeBuffer>,

    edge_pdc_delays: Vec<EdgeDelayRuntime>,

    edge_inputs_by_dst: Vec<Vec<(usize, usize, crate::dag::AudioEdgeKind)>>,

    runtime_dependencies: Vec<std::sync::atomic::AtomicUsize>,

    max_frames: usize,

    active_node_count: usize,
}

#[derive(Debug)]
struct EdgeDelayRuntime {
    delay: PdcDelayLine,
    scratch_left: Vec<f32>,
    scratch_right: Vec<f32>,
}

struct SendPtr<T>(*mut T);

// Manual Copy/Clone impls: `*mut T` is always Copy regardless of T.
// derive(Copy) would add an unwanted `T: Copy` bound.
impl<T> Clone for SendPtr<T> {
    #[inline]
    fn clone(&self) -> Self {
        *self
    }
}
impl<T> Copy for SendPtr<T> {}

// SAFETY: Stage-based topology guarantees non-overlapping access.
// The pointed-to data lives on `render_parallel`'s stack frame.
unsafe impl<T> Send for SendPtr<T> {}
unsafe impl<T> Sync for SendPtr<T> {}

#[inline]
unsafe fn sum_node_inputs_raw(
    dag: &AudioDag,
    node_idx: petgraph::graph::NodeIndex,
    frame_count: usize,
    node_buffers_ptr: *mut NodeBuffer,
    edge_pdc_ptr: *mut EdgeDelayRuntime,
    edge_inputs_by_dst: &[Vec<(usize, usize, crate::dag::AudioEdgeKind)>],
) {
    let idx = node_idx.index();

    if idx < edge_inputs_by_dst.len() && !edge_inputs_by_dst[idx].is_empty() {
        for &(src_idx, edge_runtime_idx, edge_kind) in &edge_inputs_by_dst[idx] {
            if src_idx == idx {
                continue;
            }

            let src = unsafe { &*node_buffers_ptr.add(src_idx) };
            let copy_n = frame_count.min(src.valid_frames);

            let edge_rt = unsafe { &mut *edge_pdc_ptr.add(edge_runtime_idx) };
            edge_rt.scratch_left[..copy_n].copy_from_slice(&src.left[..copy_n]);
            edge_rt.scratch_right[..copy_n].copy_from_slice(&src.right[..copy_n]);

            edge_rt.delay.process(
                &mut edge_rt.scratch_left[..copy_n],
                &mut edge_rt.scratch_right[..copy_n],
                copy_n,
            );

            if edge_kind == crate::dag::AudioEdgeKind::Sidechain {
                continue;
            }

            let dst = unsafe { &mut *node_buffers_ptr.add(idx) };
            let edge_rt_ref = unsafe { &*edge_pdc_ptr.add(edge_runtime_idx) };

            mix_in_place(
                &mut dst.left[..copy_n],
                &edge_rt_ref.scratch_left[..copy_n],
                copy_n,
            );
            mix_in_place(
                &mut dst.right[..copy_n],
                &edge_rt_ref.scratch_right[..copy_n],
                copy_n,
            );
        }
    } else {
        // BUG-001 FIX: Zero-alloc fallback for direct routing
        for edge in dag
            .graph()
            .edges_directed(node_idx, petgraph::Direction::Incoming)
        {
            if edge.weight().kind == crate::dag::AudioEdgeKind::Sidechain {
                continue;
            }
            let src_idx = edge.source().index();
            if src_idx == idx {
                continue;
            }

            let src = unsafe { &*node_buffers_ptr.add(src_idx) };
            let copy_n = frame_count.min(src.valid_frames);
            let dst = unsafe { &mut *node_buffers_ptr.add(idx) };
            mix_in_place(&mut dst.left[..copy_n], &src.left[..copy_n], copy_n);
            mix_in_place(&mut dst.right[..copy_n], &src.right[..copy_n], copy_n);
        }
    }
}

impl GraphRenderer {
    pub fn new(max_nodes: usize, max_frames: usize) -> Self {
        let node_count = max_nodes.min(MAX_GRAPH_NODES);
        let frame_count = max_frames.min(MAX_BUFFER_FRAMES);

        let mut node_buffers = Vec::with_capacity(node_count);
        let mut runtime_dependencies = Vec::with_capacity(node_count);
        for _ in 0..node_count {
            node_buffers.push(NodeBuffer::new(frame_count));
            runtime_dependencies.push(std::sync::atomic::AtomicUsize::new(0));
        }

        Self {
            node_buffers,
            edge_pdc_delays: Vec::new(),
            edge_inputs_by_dst: vec![Vec::new(); node_count.max(1)],
            runtime_dependencies,
            max_frames: frame_count,
            active_node_count: 0,
        }
    }

    pub fn update_plan(&mut self, plan: &ExecutionPlan, dag: &AudioDag) {
        self.active_node_count = dag.graph().node_bound();

        while self.node_buffers.len() < self.active_node_count {
            self.node_buffers.push(NodeBuffer::new(self.max_frames));
            self.runtime_dependencies
                .push(std::sync::atomic::AtomicUsize::new(0));
        }

        while self.edge_inputs_by_dst.len() < self.node_buffers.len() {
            self.edge_inputs_by_dst.push(Vec::new());
        }

        self.configure_edge_pdc(&plan.edge_delay_compensation, dag);

        self.reset();

        log::info!(
            "[GraphRenderer] Plan updated: {} bounded nodes, {} stages, {} node-PDC (ignored), {} edge-PDC",
            self.active_node_count,
            plan.parallel_stages.len(),
            plan.delay_compensation.iter().filter(|&&d| d > 0).count(),
            plan.edge_delay_compensation
                .iter()
                .filter(|e| e.delay_samples > 0)
                .count(),
        );
    }

    fn configure_edge_pdc(
        &mut self,
        edge_plan: &[EdgeDelayCompensation],
        dag: &crate::dag::AudioDag,
    ) {
        self.edge_pdc_delays.clear();
        for dst in &mut self.edge_inputs_by_dst {
            dst.clear();
        }

        for edge in edge_plan {
            let src_idx = edge.from.index();
            let dst_idx = edge.to.index();
            if src_idx >= self.node_buffers.len() || dst_idx >= self.node_buffers.len() {
                log::warn!(
                    "[GraphRenderer] Edge {}->{} dropped: node index out of bounds (capacity={})",
                    src_idx,
                    dst_idx,
                    self.node_buffers.len()
                );
                continue;
            }

            let edge_kind = dag
                .graph()
                .edges_directed(edge.to, petgraph::Direction::Incoming)
                .find(|e| e.source() == edge.from)
                .map(|e| e.weight().kind)
                .unwrap_or(crate::dag::AudioEdgeKind::Routing);

            let mut delay = PdcDelayLine::new(MAX_PDC_DELAY_SAMPLES);
            delay.set_delay(edge.delay_samples as usize);

            let runtime_idx = self.edge_pdc_delays.len();
            self.edge_pdc_delays.push(EdgeDelayRuntime {
                delay,
                scratch_left: vec![0.0; self.max_frames],
                scratch_right: vec![0.0; self.max_frames],
            });
            self.edge_inputs_by_dst[dst_idx].push((src_idx, runtime_idx, edge_kind));
        }
    }

    #[inline]
    pub fn clear_active_buffers(&mut self, plan: &ExecutionPlan, frame_count: usize) {
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

    pub fn node_buffers_ptr(&mut self) -> *mut NodeBuffer {
        self.node_buffers.as_mut_ptr()
    }

    #[inline]
    pub fn sum_node_inputs(
        &mut self,
        dag: &AudioDag,
        node_idx: petgraph::graph::NodeIndex,
        frame_count: usize,
    ) {
        let idx = node_idx.index();
        if idx >= self.node_buffers.len() {
            return;
        }

        if idx < self.edge_inputs_by_dst.len() && !self.edge_inputs_by_dst[idx].is_empty() {
            for &(src_idx, edge_runtime_idx, edge_kind) in &self.edge_inputs_by_dst[idx] {
                if src_idx >= self.node_buffers.len()
                    || src_idx == idx
                    || edge_runtime_idx >= self.edge_pdc_delays.len()
                {
                    continue;
                }

                let copy_n = {
                    let src = unsafe { &*self.node_buffers.as_ptr().add(src_idx) };
                    let copy_n = frame_count.min(src.valid_frames);

                    let edge_rt =
                        unsafe { &mut *self.edge_pdc_delays.as_mut_ptr().add(edge_runtime_idx) };
                    edge_rt.scratch_left[..copy_n].copy_from_slice(&src.left[..copy_n]);
                    edge_rt.scratch_right[..copy_n].copy_from_slice(&src.right[..copy_n]);

                    edge_rt.delay.process(
                        &mut edge_rt.scratch_left[..copy_n],
                        &mut edge_rt.scratch_right[..copy_n],
                        copy_n,
                    );
                    copy_n
                };

                if edge_kind == crate::dag::AudioEdgeKind::Sidechain {
                    continue;
                }

                let dst = unsafe { &mut *self.node_buffers.as_mut_ptr().add(idx) };
                let edge_rt = unsafe { &*self.edge_pdc_delays.as_ptr().add(edge_runtime_idx) };

                mix_in_place(
                    &mut dst.left[..copy_n],
                    &edge_rt.scratch_left[..copy_n],
                    copy_n,
                );
                mix_in_place(
                    &mut dst.right[..copy_n],
                    &edge_rt.scratch_right[..copy_n],
                    copy_n,
                );
            }
        } else {
            // BUG-020 FIX: Zero-alloc fallback — iterate edges directly instead of
            // collecting into a Vec. Heap allocation on the RT thread causes dropouts.
            for edge in dag
                .graph()
                .edges_directed(node_idx, petgraph::Direction::Incoming)
            {
                if edge.weight().kind == crate::dag::AudioEdgeKind::Sidechain {
                    continue;
                }
                let src_idx = edge.source().index();
                if src_idx >= self.node_buffers.len() || src_idx == idx {
                    continue;
                }

                let src = unsafe { &*self.node_buffers.as_ptr().add(src_idx) };
                let copy_n = frame_count.min(src.valid_frames);
                let dst = unsafe { &mut *self.node_buffers.as_mut_ptr().add(idx) };
                mix_in_place(&mut dst.left[..copy_n], &src.left[..copy_n], copy_n);
                mix_in_place(&mut dst.right[..copy_n], &src.right[..copy_n], copy_n);
            }
        }
    }

    #[inline]
    pub fn copy_master_output(
        &self,
        node_idx: petgraph::graph::NodeIndex,
        output_left: &mut [f32],
        output_right: &mut [f32],
        frame_count: usize,
    ) {
        let idx = node_idx.index();
        if idx >= self.node_buffers.len() {
            return;
        }
        let buf = &self.node_buffers[idx];
        let out_n = frame_count.min(output_left.len()).min(output_right.len());
        output_left[..out_n].copy_from_slice(&buf.left[..out_n]);
        output_right[..out_n].copy_from_slice(&buf.right[..out_n]);
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
    ) where
        FTrack: FnMut(&AudioNode, &mut [f32], &mut [f32], usize, &dyn Fn(usize) -> Option<(*const f32, *const f32)>),
        FEffect: FnMut(&AudioNode, &mut [f32], &mut [f32], usize, &dyn Fn(usize) -> Option<(*const f32, *const f32)>),
    {
        let idx = node_idx.index();
        if idx >= self.node_buffers.len() {
            return;
        }

        self.sum_node_inputs(dag, node_idx, frame_count);

        let node = dag.node(node_idx);
        let buf = &mut self.node_buffers[idx];

        let sidechain_resolver = |src_idx: usize| -> Option<(*const f32, *const f32)> {
            if idx >= self.edge_inputs_by_dst.len() {
                return None;
            }
            let edge = self.edge_inputs_by_dst[idx].iter().find(|e| e.0 == src_idx && e.2 == crate::dag::AudioEdgeKind::Sidechain)?;
            let rt = self.edge_pdc_delays.get(edge.1)?;
            Some((rt.scratch_left.as_ptr(), rt.scratch_right.as_ptr()))
        };

        match &node.kind {
            NodeKind::Track { .. } => {
                track_processor(
                    node,
                    &mut buf.left[..frame_count],
                    &mut buf.right[..frame_count],
                    frame_count,
                    &sidechain_resolver,
                );
            }
            NodeKind::Effect { .. } => {
                effect_processor(
                    node,
                    &mut buf.left[..frame_count],
                    &mut buf.right[..frame_count],
                    frame_count,
                    &sidechain_resolver,
                );
            }
            NodeKind::Bus { .. } => {}
            NodeKind::MasterOutput => {}
        }

        // BUF-G06 FIX: Sanitize NaN/Inf after each node processes.
        // A single bad plugin or DSP returning NaN/Inf would otherwise
        // poison ALL downstream nodes via mix_from summation.
        for i in 0..frame_count {
            if !buf.left[i].is_finite() {
                buf.left[i] = 0.0;
            }
            if !buf.right[i].is_finite() {
                buf.right[i] = 0.0;
            }
        }

        if matches!(&node.kind, NodeKind::MasterOutput) {
            self.copy_master_output(node_idx, output_left, output_right, frame_count);
        }
    }

    #[inline]
    #[allow(clippy::too_many_arguments)]
    pub fn render_parallel<FProcessor>(
        &mut self,
        plan: &ExecutionPlan,
        dag: &AudioDag,
        frame_count: usize,
        output_left: &mut [f32],
        output_right: &mut [f32],
        processor: FProcessor,
    ) where
        FProcessor: Fn(&AudioNode, &mut [f32], &mut [f32], usize, &dyn Fn(usize) -> Option<(*const f32, *const f32)>) + Sync + Send,
    {
        let n = frame_count.min(self.max_frames);
        let out_n = n.min(output_left.len()).min(output_right.len());

        output_left[..out_n].fill(0.0);
        output_right[..out_n].fill(0.0);

        self.clear_active_buffers(plan, n);

        if !plan.parallel_stages.is_empty() {
            let node_buffers_ptr = SendPtr(self.node_buffers.as_mut_ptr());
            let edge_pdc_ptr = SendPtr(self.edge_pdc_delays.as_mut_ptr());
            let capacity = self.capacity();
            let edge_inputs_by_dst = &self.edge_inputs_by_dst;

            for stage in &plan.parallel_stages {
                if stage.len() <= 1 {
                    for &node_idx in stage {
                        let idx = node_idx.index();
                        if idx >= capacity {
                            continue;
                        }
                        unsafe {
                            sum_node_inputs_raw(
                                dag,
                                node_idx,
                                n,
                                node_buffers_ptr.0,
                                edge_pdc_ptr.0,
                                edge_inputs_by_dst,
                            );
                        }
                        let sidechain_resolver = |src_idx: usize| -> Option<(*const f32, *const f32)> {
                            if idx >= edge_inputs_by_dst.len() || src_idx >= capacity {
                                return None;
                            }
                            let edge = edge_inputs_by_dst[idx].iter().find(|e| e.0 == src_idx && e.2 == crate::dag::AudioEdgeKind::Sidechain)?;
                            let rt = unsafe { &*edge_pdc_ptr.0.add(edge.1) };
                            Some((rt.scratch_left.as_ptr(), rt.scratch_right.as_ptr()))
                        };
                        
                        let node = dag.node(node_idx);
                        let buf = unsafe { &mut *node_buffers_ptr.0.add(idx) };
                        processor(node, &mut buf.left[..n], &mut buf.right[..n], n, &sidechain_resolver);

                        // BUG-G06b FIX: Sanitize NaN/Inf in parallel path (mirrors process_node).
                        for i in 0..n {
                            if !buf.left[i].is_finite() { buf.left[i] = 0.0; }
                            if !buf.right[i].is_finite() { buf.right[i] = 0.0; }
                        }

                        if matches!(&node.kind, NodeKind::MasterOutput) {
                            let master_n = n.min(output_left.len()).min(output_right.len());
                            output_left[..master_n].copy_from_slice(&buf.left[..master_n]);
                            output_right[..master_n].copy_from_slice(&buf.right[..master_n]);
                        }
                    }
                } else {
                    for &node_idx in stage {
                        let idx = node_idx.index();
                        if idx >= capacity {
                            continue;
                        }
                        unsafe {
                            sum_node_inputs_raw(
                                dag,
                                node_idx,
                                n,
                                node_buffers_ptr.0,
                                edge_pdc_ptr.0,
                                edge_inputs_by_dst,
                            );
                        }
                        let sidechain_resolver = |src_idx: usize| -> Option<(*const f32, *const f32)> {
                            if idx >= edge_inputs_by_dst.len() || src_idx >= capacity {
                                return None;
                            }
                            let edge = edge_inputs_by_dst[idx].iter().find(|e| e.0 == src_idx && e.2 == crate::dag::AudioEdgeKind::Sidechain)?;
                            let rt = unsafe { &*edge_pdc_ptr.0.add(edge.1) };
                            Some((rt.scratch_left.as_ptr(), rt.scratch_right.as_ptr()))
                        };
                        
                        let node = dag.node(node_idx);
                        let buf = unsafe { &mut *node_buffers_ptr.0.add(idx) };
                        processor(node, &mut buf.left[..n], &mut buf.right[..n], n, &sidechain_resolver);

                        // BUG-G06b FIX: Sanitize NaN/Inf (multi-node parallel path).
                        for i in 0..n {
                            if !buf.left[i].is_finite() { buf.left[i] = 0.0; }
                            if !buf.right[i].is_finite() { buf.right[i] = 0.0; }
                        }
                    }
                }
            }
        } else {
            let node_buffers_ptr = SendPtr(self.node_buffers.as_mut_ptr());
            let capacity = self.node_buffers.len();
            for &node_idx in &plan.processing_order {
                let idx = node_idx.index();
                if idx >= capacity {
                    continue;
                }
                self.sum_node_inputs(dag, node_idx, n);
                
                let edge_pdc_ptr = SendPtr(self.edge_pdc_delays.as_mut_ptr());
                let sidechain_resolver = |src_idx: usize| -> Option<(*const f32, *const f32)> {
                    if idx >= self.edge_inputs_by_dst.len() || src_idx >= capacity {
                        return None;
                    }
                    let edge = self.edge_inputs_by_dst[idx].iter().find(|e| e.0 == src_idx && e.2 == crate::dag::AudioEdgeKind::Sidechain)?;
                    let rt = unsafe { &*edge_pdc_ptr.0.add(edge.1) };
                    Some((rt.scratch_left.as_ptr(), rt.scratch_right.as_ptr()))
                };
                
                let node = dag.node(node_idx);
                let buf = unsafe { &mut *node_buffers_ptr.0.add(idx) };
                processor(node, &mut buf.left[..n], &mut buf.right[..n], n, &sidechain_resolver);

                // BUG-G06b FIX: Sanitize NaN/Inf (sequential fallback path).
                for i in 0..n {
                    if !buf.left[i].is_finite() { buf.left[i] = 0.0; }
                    if !buf.right[i].is_finite() { buf.right[i] = 0.0; }
                }

                if matches!(&node.kind, NodeKind::MasterOutput) {
                    self.copy_master_output(node_idx, output_left, output_right, n);
                }
            }
        }
    }

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
    ) where
        FTrack: FnMut(
            &AudioNode, // node metadata
            &mut [f32], // left channel buffer
            &mut [f32], // right channel buffer
            usize,      // frame count
            &dyn Fn(usize) -> Option<(*const f32, *const f32)>, // sidechain resolver
        ),
        FEffect: FnMut(
            &AudioNode, // node metadata
            &mut [f32], // left channel buffer (in-place)
            &mut [f32], // right channel buffer (in-place)
            usize,      // frame count
            &dyn Fn(usize) -> Option<(*const f32, *const f32)>, // sidechain resolver
        ),
    {
        let n = frame_count.min(self.max_frames);
        let out_n = n.min(output_left.len()).min(output_right.len());

        output_left[..out_n].fill(0.0);
        output_right[..out_n].fill(0.0);

        self.clear_active_buffers(plan, n);

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

    pub fn reset(&mut self) {
        for buf in &mut self.node_buffers {
            buf.clear(self.max_frames);
        }
        for edge in &mut self.edge_pdc_delays {
            edge.delay.reset();
        }
    }

    pub fn capacity(&self) -> usize {
        self.node_buffers.len()
    }

    pub fn active_node_count(&self) -> usize {
        self.active_node_count
    }
}

#[cfg(test)]
mod tests;
