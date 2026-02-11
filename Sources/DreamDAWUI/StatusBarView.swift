import SwiftUI
import DreamDAWModels
import DreamDAWEngine

// MARK: - StatusBarView

/// Bottom status bar mimicking Ableton Live's arrangement status bar.
/// Shows: [Time Selection info] [Start/End/Length] | [Transport position] [Main ▾] [I/O indicator]
public struct StatusBarView: View {

    @ObservedObject var transportController: TransportController
    @ObservedObject var project: Project

    public init(transportController: TransportController, project: Project) {
        self.transportController = transportController
        self.project = project
    }

    // MARK: - Computed Properties

    /// Current playhead position as bars.beats.ticks string.
    private var playheadDisplay: String {
        transportController.playheadPosition.displayString(
            beatsPerBar: project.timeSignature.beatsPerBar
        )
    }

    /// Project end position (last clip end).
    private var projectEnd: TimePosition {
        var maxEnd = TimePosition(beats: 0)
        for track in project.tracks {
            let trackEnd = track.endPosition
            if trackEnd > maxEnd { maxEnd = trackEnd }
        }
        return maxEnd
    }

    private var projectEndDisplay: String {
        projectEnd.displayString(
            beatsPerBar: project.timeSignature.beatsPerBar
        )
    }

    /// Duration in seconds, formatted as M:SS.mmm.
    private var durationSecondsDisplay: String {
        let secs = projectEnd.toSeconds(bpm: project.bpm)
        let mins = Int(secs) / 60
        let rest = secs - Double(mins * 60)
        return String(format: "%d:%06.3f", mins, rest)
    }

    public var body: some View {
        HStack(spacing: 0) {
            // Left: Playhead position + project duration
            HStack(spacing: 12) {
                statusText("Arrangement")

                HStack(spacing: 4) {
                    statusLabel("Position:")
                    statusValue(playheadDisplay)
                }

                HStack(spacing: 4) {
                    statusLabel("End:")
                    statusValue(projectEndDisplay)
                }

                HStack(spacing: 4) {
                    statusLabel("Length:")
                    statusValue(durationSecondsDisplay)
                }
            }
            .padding(.leading, 8)

            Spacer()

            // Right: Transport and output
            HStack(spacing: 12) {
                // Play indicator
                Image(systemName: transportController.state == .playing ? "play.fill" : "stop.fill")
                    .font(.system(size: 8))
                    .foregroundColor(transportController.state == .playing
                        ? Color(nsColor: DreamTheme.accent)
                        : Color(nsColor: DreamTheme.textMuted))

                // Track count
                statusText("\(project.tracks.count) tracks")

                // Sample rate
                statusText("\(Int(project.sampleRate)) Hz")

                // Main output selector
                HStack(spacing: 2) {
                    Image(systemName: "circle.fill")
                        .font(.system(size: 4))
                        .foregroundColor(Color(nsColor: DreamTheme.textMuted))
                    statusText("Main")
                }

                // Session/Arrangement toggle
                HStack(spacing: 2) {
                    Image(systemName: "square.split.2x1")
                        .font(.system(size: 8))
                        .foregroundColor(Color(nsColor: DreamTheme.textMuted))
                    Image(systemName: "square.split.1x2")
                        .font(.system(size: 8))
                        .foregroundColor(Color(nsColor: DreamTheme.textSecondary))
                }
            }
            .padding(.trailing, 8)
        }
        .frame(height: DreamTheme.statusBarHeight)
        .background(Color(nsColor: DreamTheme.bgStatusBar))
        .overlay(
            Rectangle()
                .frame(height: 1)
                .foregroundColor(Color(nsColor: DreamTheme.divider)),
            alignment: .top
        )
    }

    // MARK: - Helper Views

    private func statusLabel(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 9, weight: .regular))
            .foregroundColor(Color(nsColor: DreamTheme.textMuted))
    }

    private func statusValue(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 9, weight: .medium, design: .monospaced))
            .foregroundColor(Color(nsColor: DreamTheme.textSecondary))
    }

    private func statusText(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 9, weight: .medium))
            .foregroundColor(Color(nsColor: DreamTheme.textSecondary))
    }
}
