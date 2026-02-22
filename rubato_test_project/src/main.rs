use rubato::{FastFixedIn, PolynomialDegree, Resampler};

fn main() {
    let from_rate = 44100;
    let to_rate = 48000;
    let ratio = to_rate as f64 / from_rate as f64;

    let mut resampler =
        FastFixedIn::<f32>::new(ratio, 2.0, PolynomialDegree::Cubic, 1024, 1).unwrap();

    // Create 1 second of input data (44100 samples)
    let input: Vec<f32> = vec![0.0; 44100];

    let mut outputs = vec![Vec::new()];

    let mut pos = 0;
    while pos < input.len() {
        let chunk = 1024;
        let p = &input[pos..pos.min(pos + chunk)];
        let mut padded = p.to_vec();
        padded.resize(1024, 0.0);
        let refs = vec![padded.as_slice()];
        let res = resampler.process(&refs, None).unwrap();
        outputs[0].extend_from_slice(&res[0]);
        pos += 1024;
    }

    println!("Ratio: {}", ratio);
    println!("Output length: {}", outputs[0].len());
}
