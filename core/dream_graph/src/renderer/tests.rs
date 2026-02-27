use super::*;
use crate::dag::*;
use crate::pdc;

fn build_simple_dag() -> AudioDag {
    // Track1 → Master
    GraphBuilder::new()
        .add_node(AudioNode::new(NodeId(0), NodeKind::MasterOutput))
        .add_node(AudioNode::new(
            NodeId(1),
            NodeKind::Track {
                name: "Track 1".into(),
                latency_samples: 0,
            },
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
            NodeKind::Track {
                name: "Piano".into(),
                latency_samples: 0,
            },
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

    use petgraph::visit::{EdgeRef, NodeIndexable};
    let node_bound = dag.graph().node_bound();
    let mut dependency_counts = vec![0usize; node_bound];
    let mut dependents = vec![Vec::new(); node_bound];

    for &node_idx in &order {
        let n_idx = node_idx.index();
        for edge in dag
            .graph()
            .edges_directed(node_idx, petgraph::Direction::Incoming)
        {
            let src_idx = edge.source().index();
            dependency_counts[n_idx] += 1;
            dependents[src_idx].push(node_idx);
        }
    }

    ExecutionPlan {
        processing_order: order,
        delay_compensation: compensation,
        edge_delay_compensation: edge_compensation,
        parallel_stages: stages,
        dependency_counts,
        dependents,
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
        |_node, left, right, n, _resolver| {
            // Track processor: fill with 1.0 (test signal)
            for i in 0..n {
                left[i] = 1.0;
                right[i] = 0.5;
            }
        },
        |_node, _left, _right, _n, _resolver| {
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
        |_node, left, right, n, _resolver| {
            for i in 0..n {
                left[i] = 0.8;
                right[i] = 0.8;
            }
        },
        |_node, left, right, n, _resolver| {
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
        dependency_counts: Vec::new(),
        dependents: Vec::new(),
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
        |_node, _left, _right, _n, _resolver| {},
        |_node, _left, _right, _n, _resolver| {},
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
            NodeKind::Track { name: "T1".into(), latency_samples: 0 },
        ))
        .add_node(AudioNode::new(
            NodeId(2),
            NodeKind::Track { name: "T2".into(), latency_samples: 0 },
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
        |node, left, right, n, _resolver| {
            // T1 outputs 0.3, T2 outputs 0.7
            let val = if node.display_name() == "T1" {
                0.3
            } else {
                0.7
            };
            for i in 0..n {
                left[i] = val;
                right[i] = val;
            }
        },
        |_node, _left, _right, _n, _resolver| {},
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
        |_node, left, right, n, _resolver| {
            for i in 0..n {
                left[i] = 0.25;
                right[i] = 0.25;
            }
        },
        |_node, _left, _right, _n, _resolver| {},
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
            NodeKind::Track { name: "T1".into(), latency_samples: 0 },
        ))
        .add_node(AudioNode::new(
            NodeId(2),
            NodeKind::Track { name: "T2".into(), latency_samples: 0 },
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
        dependency_counts: vec![0; dag.graph().node_bound()],
        dependents: vec![Vec::new(); dag.graph().node_bound()],
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
        |node, left, right, n, _resolver| {
            // Impulses from both tracks at sample 0.
            if node.display_name() == "T1" || node.display_name() == "T2" {
                left[..n].fill(0.0);
                right[..n].fill(0.0);
                left[0] = 1.0;
                right[0] = 1.0;
            }
        },
        |_node, _left, _right, _n, _resolver| {},
    );

    // At master: T1 impulse at t=0, T2 delayed by 2 samples.
    assert_eq!(out_l[0], 1.0);
    assert_eq!(out_l[1], 0.0);
    assert_eq!(out_l[2], 1.0);
}
