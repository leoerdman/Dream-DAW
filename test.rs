use dream_graph::renderer::GraphRenderer;
fn main() {
    let mut gr = GraphRenderer::new(1, 1);
    gr.render(
        &dream_graph::dag::ExecutionPlan::default(),
        &dream_graph::dag::AudioDag::new(),
        1,
        &mut [0.0],
        &mut [0.0],
        |_, _, _, _| {},
    );
}
