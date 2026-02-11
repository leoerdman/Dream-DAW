import SwiftUI
import DreamDAWModels
import DreamDAWEngine

// MARK: - TransportBarView

/// SwiftUI transport bar with play/stop controls, BPM, and position display.
/// Hosted inside the main AppKit window.
public struct TransportBarView: View {

    @ObservedObject var transportController: TransportController
    @ObservedObject var project: Project

    public init(transportController: TransportController, project: Project) {
        self.transportController = transportController
        self.project = project
    }

    public var body: some View {
        HStack(spacing: 0) {
            // Left: Transport controls
            HStack(spacing: 12) {
                // Stop button
                TransportButton(
                    icon: "stop.fill",
                    isActive: transportController.state == .stopped,
                    activeColor: .white,
                    action: { transportController.stop() }
                )

                // Play/Pause button
                TransportButton(
                    icon: transportController.state == .playing ? "pause.fill" : "play.fill",
                    isActive: transportController.state == .playing,
                    activeColor: Color(nsColor: DreamTheme.accent),
                    action: { transportController.togglePlayPause() }
                )

                // Loop toggle
                TransportButton(
                    icon: "repeat",
                    isActive: transportController.isLooping,
                    activeColor: Color(nsColor: DreamTheme.accentSecondary),
                    action: { transportController.isLooping.toggle() }
                )
            }
            .padding(.horizontal, 16)

            Divider()
                .frame(height: 24)
                .background(Color(nsColor: DreamTheme.divider))

            // Center: Position display
            HStack(spacing: 20) {
                // Bars:Beats:Ticks display
                VStack(alignment: .leading, spacing: 0) {
                    Text("POSITION")
                        .font(.system(size: 9, weight: .medium))
                        .foregroundColor(Color(nsColor: DreamTheme.textMuted))
                    Text(transportController.playheadPosition.displayString(
                        beatsPerBar: transportController.timeSignature.beatsPerBar
                    ))
                    .font(.system(size: 18, weight: .semibold, design: .monospaced))
                    .foregroundColor(Color(nsColor: DreamTheme.textPrimary))
                }

                // Time display
                VStack(alignment: .leading, spacing: 0) {
                    Text("TIME")
                        .font(.system(size: 9, weight: .medium))
                        .foregroundColor(Color(nsColor: DreamTheme.textMuted))
                    Text(transportController.playheadPosition.timeDisplayString(bpm: transportController.bpm))
                        .font(.system(size: 18, weight: .semibold, design: .monospaced))
                        .foregroundColor(Color(nsColor: DreamTheme.textPrimary))
                }
            }
            .padding(.horizontal, 20)

            Divider()
                .frame(height: 24)
                .background(Color(nsColor: DreamTheme.divider))

            // Right: BPM and Time Signature
            HStack(spacing: 20) {
                // BPM
                VStack(alignment: .leading, spacing: 0) {
                    Text("BPM")
                        .font(.system(size: 9, weight: .medium))
                        .foregroundColor(Color(nsColor: DreamTheme.textMuted))
                    Text(String(format: "%.1f", project.bpm))
                        .font(.system(size: 18, weight: .semibold, design: .monospaced))
                        .foregroundColor(Color(nsColor: DreamTheme.accent))
                }

                // Time signature
                VStack(alignment: .leading, spacing: 0) {
                    Text("TIME SIG")
                        .font(.system(size: 9, weight: .medium))
                        .foregroundColor(Color(nsColor: DreamTheme.textMuted))
                    Text(project.timeSignature.displayString)
                        .font(.system(size: 18, weight: .semibold, design: .monospaced))
                        .foregroundColor(Color(nsColor: DreamTheme.textPrimary))
                }
            }
            .padding(.horizontal, 16)

            Spacer()

            // CPU/Load indicator placeholder
            HStack(spacing: 6) {
                Image(systemName: "cpu")
                    .font(.system(size: 10))
                    .foregroundColor(Color(nsColor: DreamTheme.textMuted))
                Text("0%")
                    .font(.system(size: 10, weight: .medium, design: .monospaced))
                    .foregroundColor(Color(nsColor: DreamTheme.textMuted))
            }
            .padding(.trailing, 16)
        }
        .frame(height: DreamTheme.transportBarHeight)
        .background(Color(nsColor: DreamTheme.bgTransport))
        .overlay(
            Rectangle()
                .frame(height: 1)
                .foregroundColor(Color(nsColor: DreamTheme.divider)),
            alignment: .top
        )
    }
}

// MARK: - TransportButton

struct TransportButton: View {
    let icon: String
    let isActive: Bool
    let activeColor: Color
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 14, weight: .medium))
                .foregroundColor(isActive ? activeColor : Color(nsColor: DreamTheme.textSecondary))
                .frame(width: 28, height: 28)
                .background(
                    RoundedRectangle(cornerRadius: 4)
                        .fill(isActive ? activeColor.opacity(0.15) : Color.clear)
                )
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            if hovering {
                NSCursor.pointingHand.push()
            } else {
                NSCursor.pop()
            }
        }
    }
}
