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

    public var body: some View {
        HStack(spacing: 0) {
            // Left: Selection info
            HStack(spacing: 12) {
                statusText("Time Selection")

                HStack(spacing: 4) {
                    statusLabel("Start:")
                    statusValue("1.1.1")
                }

                HStack(spacing: 4) {
                    statusLabel("End:")
                    statusValue("1.1.1")
                }

                HStack(spacing: 4) {
                    statusLabel("Length:")
                    statusValue("0.0.0")
                }
            }
            .padding(.leading, 8)

            Spacer()

            // Right: Transport and output
            HStack(spacing: 12) {
                // Play indicator
                Image(systemName: transportController.state == .playing ? "play.fill" : "stop.fill")
                    .font(.system(size: 8))
                    .foregroundColor(Color(nsColor: DreamTheme.textMuted))

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
