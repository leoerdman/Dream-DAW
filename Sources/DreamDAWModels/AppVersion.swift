import Foundation

/// Central source of truth for the application version.
public struct AppVersion {
    public static let current = "1.2.116"
    public static let buildNumber = "2026.02.13.37"
    
    public static var fullVersionString: String {
        return "\(current) (\(buildNumber))"
    }
    
    /// Professional version history for the settings screen.
    public static let history: [(version: String, date: String, changes: [String])] = [
        ("v1.2.0", "Feb 2026", [
            "Full Sampler UI Overhaul with Gain/Volume control",
            "Real-time parameter synchronization for Instruments",
            "Global Search (Command+F) with focus/clear logic",
            "High-precision audio engine synchronization (Mach timing)",
            "Optimized UI rendering for large arrangements"
        ]),
        ("v1.1.0", "Jan 2026", [
            "Added VU meters to track headers",
            "Implemented Piano Roll editing and MIDI playback",
            "Added Sampler instrument with basic ADSR",
            "Multi-track playback support"
        ]),
        ("v1.0.0", "Dec 2025", [
            "Initial release of Dream DAW",
            "Basic arrangement timeline with clip dragging",
            "Simple Synth instrument implementation",
            "Project save/load functionality"
        ])
    ]
}
