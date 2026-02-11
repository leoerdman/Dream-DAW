import SwiftUI
import DreamDAWModels
import DreamDAWEngine

// MARK: - TransportBarView (Ableton-Style Top Control Bar)

/// Compact top control bar matching Ableton Live 11 layout.
/// Layout: [Tap | BPM | TimeSig | Quantize] | [◀ Play ▶ Stop ● Rec] | [Position Counter] | [Loop] | [Key] [MIDI] [CPU]
public struct TransportBarView: View {

    @ObservedObject var transportController: TransportController
    @ObservedObject var project: Project

    @State private var bpmText: String = ""
    
    public init(transportController: TransportController, project: Project) {
        self.transportController = transportController
        self.project = project
        self._bpmText = State(initialValue: String(format: "%.2f", project.bpm))
    }

    public var body: some View {
        HStack(spacing: 0) {
            // Left section: Tempo & Time
            leftSection
            
            thinDivider
            
            // Center: Transport controls
            centerSection
            
            thinDivider
            
            // Position display
            positionSection
            
            thinDivider
            
            // Loop toggle
            loopSection
            
            Spacer()
            
            thinDivider
            
            // Right: Key, MIDI, CPU
            rightSection
        }
        .frame(height: DreamTheme.controlBarHeight)
        .background(Color(nsColor: DreamTheme.bgTransport))
        .overlay(
            Rectangle()
                .frame(height: 1)
                .foregroundColor(Color(nsColor: DreamTheme.divider)),
            alignment: .bottom
        )
        .onChange(of: project.bpm) { newBpm in
            bpmText = String(format: "%.2f", newBpm)
        }
    }
    
    // MARK: - Left Section (Tempo)
    
    private var leftSection: some View {
        HStack(spacing: 2) {
            // Tap tempo
            ControlBarButton(label: "Tap", action: {})
            
            // BPM — editable field
            TextField("BPM", text: $bpmText, onCommit: {
                commitBpm()
            })
            .font(.system(size: 11, weight: .medium, design: .monospaced))
            .foregroundColor(Color(nsColor: DreamTheme.textPrimary))
            .textFieldStyle(.plain)
            .frame(width: 52)
            .padding(.horizontal, 4)
            .padding(.vertical, 2)
            .background(
                RoundedRectangle(cornerRadius: 3)
                    .fill(Color(nsColor: DreamTheme.bgSurface).opacity(0.5))
            )
            .multilineTextAlignment(.center)
            
            // Time signature
            HStack(spacing: 1) {
                Text("\(project.timeSignature.numerator)")
                    .font(.system(size: 10, weight: .medium, design: .monospaced))
                    .foregroundColor(Color(nsColor: DreamTheme.textPrimary))
                Text("/")
                    .font(.system(size: 9, weight: .regular))
                    .foregroundColor(Color(nsColor: DreamTheme.textMuted))
                Text("\(project.timeSignature.denominator)")
                    .font(.system(size: 10, weight: .medium, design: .monospaced))
                    .foregroundColor(Color(nsColor: DreamTheme.textPrimary))
            }
            .padding(.horizontal, 4)
            
            thinDivider
            
            // Quantize selector
            Text("1/4")
                .font(.system(size: 10, weight: .medium, design: .monospaced))
                .foregroundColor(Color(nsColor: DreamTheme.textSecondary))
                .padding(.horizontal, 6)
        }
        .padding(.leading, 8)
    }
    
    /// Validate and apply the edited BPM value.
    private func commitBpm() {
        guard let value = Double(bpmText), value >= 20, value <= 999 else {
            // Revert to current value if invalid
            bpmText = String(format: "%.2f", project.bpm)
            return
        }
        project.bpm = value
        transportController.bpm = value
    }
    
    // MARK: - Center Section (Transport Controls)
    
    private var centerSection: some View {
        HStack(spacing: 1) {
            // Play button
            AbletonTransportBtn(
                icon: "play.fill",
                isActive: transportController.state == .playing,
                activeColor: Color(nsColor: DreamTheme.accentGreen),
                action: { transportController.togglePlayPause() }
            )
            
            // Stop button
            AbletonTransportBtn(
                icon: "stop.fill",
                isActive: transportController.state == .stopped,
                activeColor: Color(nsColor: DreamTheme.textPrimary),
                action: { transportController.stop() }
            )
            
            // Record button
            AbletonTransportBtn(
                icon: "circle.fill",
                isActive: false,
                activeColor: Color(nsColor: DreamTheme.armButton),
                action: {}
            )
        }
        .padding(.horizontal, 6)
    }
    
    // MARK: - Position Display
    
    private var positionSection: some View {
        HStack(spacing: 8) {
            // Bars.Beats.Ticks
            Text(transportController.playheadPosition.displayString(
                beatsPerBar: transportController.timeSignature.beatsPerBar
            ))
            .font(.system(size: 14, weight: .semibold, design: .monospaced))
            .foregroundColor(Color(nsColor: DreamTheme.accent))
            .frame(minWidth: 90, alignment: .trailing)
        }
        .padding(.horizontal, 10)
    }
    
    // MARK: - Loop Section
    
    private var loopSection: some View {
        HStack(spacing: 4) {
            Button(action: { transportController.isLooping.toggle() }) {
                Image(systemName: "repeat")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(
                        transportController.isLooping
                            ? Color(nsColor: DreamTheme.accentSecondary)
                            : Color(nsColor: DreamTheme.textMuted)
                    )
                    .frame(width: 22, height: 22)
                    .background(
                        RoundedRectangle(cornerRadius: 2)
                            .fill(transportController.isLooping
                                  ? Color(nsColor: DreamTheme.accentSecondary).opacity(0.15)
                                  : Color.clear)
                    )
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 6)
    }
    
    // MARK: - Right Section (Indicators)
    
    private var rightSection: some View {
        HStack(spacing: 8) {
            // Key indicator
            Text("Key")
                .font(.system(size: 10, weight: .medium))
                .foregroundColor(Color(nsColor: DreamTheme.textMuted))
            
            // MIDI indicator
            HStack(spacing: 2) {
                Text("MIDI")
                    .font(.system(size: 9, weight: .medium))
                    .foregroundColor(Color(nsColor: DreamTheme.midiIndicator))
            }
            
            thinDivider
            
            // CPU meter
            HStack(spacing: 3) {
                Image(systemName: "cpu")
                    .font(.system(size: 9))
                    .foregroundColor(Color(nsColor: DreamTheme.textMuted))
                Text("0%")
                    .font(.system(size: 9, weight: .medium, design: .monospaced))
                    .foregroundColor(Color(nsColor: DreamTheme.textMuted))
            }
        }
        .padding(.horizontal, 8)
    }
    
    // MARK: - Helpers
    
    private var thinDivider: some View {
        Rectangle()
            .fill(Color(nsColor: DreamTheme.divider))
            .frame(width: 1, height: 20)
    }
}

// MARK: - AbletonTransportBtn

/// Minimal flat transport button matching Ableton style.
struct AbletonTransportBtn: View {
    let icon: String
    let isActive: Bool
    let activeColor: Color
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 11, weight: .medium))
                .foregroundColor(isActive ? activeColor : Color(nsColor: DreamTheme.textMuted))
                .frame(width: 24, height: 24)
                .background(
                    RoundedRectangle(cornerRadius: 2)
                        .fill(isActive ? activeColor.opacity(0.12) : Color.clear)
                )
        }
        .buttonStyle(.plain)
    }
}

// MARK: - ControlBarButton

struct ControlBarButton: View {
    let label: String
    let action: () -> Void
    
    var body: some View {
        Button(action: action) {
            Text(label)
                .font(.system(size: 10, weight: .medium))
                .foregroundColor(Color(nsColor: DreamTheme.textSecondary))
                .padding(.horizontal, 6)
                .padding(.vertical, 3)
                .background(
                    RoundedRectangle(cornerRadius: 2)
                        .fill(Color(nsColor: DreamTheme.bgSurface).opacity(0.5))
                )
        }
        .buttonStyle(.plain)
    }
}
