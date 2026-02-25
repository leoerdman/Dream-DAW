use rubato::{FastFixedIn, PolynomialDegree, Resampler};

fn main() {
    let from_rate = 44100;
    let to_rate = 48000;
    let ratio = to_rate as f64 / from_rate as f64;

    let mut resampler = match FastFixedIn::<f32>::new(ratio, 2.0, PolynomialDegree::Cubic, 1024, 1)
    {
        Ok(r) => r,
        Err(err) => {
            eprintln!("Failed to create resampler: {err}");
            return;
        }
    };

    // Create 1 second of input data (44100 samples)
    let input: Vec<f32> = vec![0.0; 44100];

    let mut outputs = [Vec::new()];

    let mut pos = 0;
    while pos < input.len() {
        let chunk = 1024;
        let p = &input[pos..pos.min(pos + chunk)];
        let mut padded = p.to_vec();
        padded.resize(1024, 0.0);
        let refs = [padded.as_slice()];
        match resampler.process(&refs, None) {
            Ok(res) => outputs[0].extend_from_slice(&res[0]),
            Err(err) => {
                eprintln!("Resampler process failed: {err}");
                return;
            }
        }
        pos += 1024;
    }

    println!("Ratio: {}", ratio);
    println!("Output length: {}", outputs[0].len());
}
