import Foundation
import Accelerate
import os.log

/// Enterprise benchmarking utility to quantify DSP performance.
/// Compares standard Swift scalar loops against vectorized Accelerate (vDSP) implementations.
public final class PerformanceBenchmark {
    
    private let logger = Logger(subsystem: "com.dreamdaw", category: "PerformanceBenchmark")
    
    public init() {}
    
    /// Runs a suite of benchmarks and logs the results.
    public func runBenchmarks() {
        logger.info("Starting DSP Performance Benchmarks...")
        
        let sampleCount = 1_000_000
        let source = [Float](repeating: 0.5, count: sampleCount)
        var destination = [Float](repeating: 0.0, count: sampleCount)
        let gain: Float = 0.5
        
        // --- 1. Vector Addition / Summing ---
        
        // Scalar Implementation
        let scalarTime = measure {
            for i in 0..<sampleCount {
                destination[i] += source[i] * gain
            }
        }
        
        // vDSP Implementation
        var gainVar = gain
        let vDSPTime = measure {
            vDSP_vsma(source, 1, &gainVar, destination, 1, &destination, 1, vDSP_Length(sampleCount))
        }
        
        logResult(name: "Vector Summing (vsma)", scalar: scalarTime, vDSP: vDSPTime)
        
        // --- 2. Level Metering (RMS) ---
        
        // Scalar RMS
        let scalarRMSTime = measure {
            var sumOfSquares: Float = 0
            for i in 0..<sampleCount {
                sumOfSquares += source[i] * source[i]
            }
            _ = sqrt(sumOfSquares / Float(sampleCount))
        }
        
        // vDSP RMS
        let vDSPRMSTime = measure {
            var sumOfSquares: Float = 0
            vDSP_svesq(source, 1, &sumOfSquares, vDSP_Length(sampleCount))
            _ = sqrt(sumOfSquares / Float(sampleCount))
        }
        
        logResult(name: "Level Metering (RMS)", scalar: scalarRMSTime, vDSP: vDSPRMSTime)
        
        // --- 3. Peak Detection ---
        
        // Scalar Peak
        let scalarPeakTime = measure {
            var peak: Float = 0
            for i in 0..<sampleCount {
                let absVal = abs(source[i])
                if absVal > peak { peak = absVal }
            }
        }
        
        // vDSP Peak
        let vDSPPeakTime = measure {
            var peak: Float = 0
            vDSP_maxmgv(source, 1, &peak, vDSP_Length(sampleCount))
        }
        
        logResult(name: "Peak Detection (maxmgv)", scalar: scalarPeakTime, vDSP: vDSPPeakTime)
    }
    
    private func measure(_ block: () -> Void) -> Double {
        let start = DispatchTime.now()
        block()
        let end = DispatchTime.now()
        let nanoTime = end.uptimeNanoseconds - start.uptimeNanoseconds
        return Double(nanoTime) / 1_000_000.0 // Result in milliseconds
    }
    
    private func logResult(name: String, scalar: Double, vDSP: Double) {
        let speedup = scalar / vDSP
        let msg = String(format: "Benchmark [%@]: Scalar=%.4f ms, vDSP=%.4f ms (Speedup: %.2fx)", name, scalar, vDSP, speedup)
        logger.info("\(msg)")
        print(msg)
    }
}
