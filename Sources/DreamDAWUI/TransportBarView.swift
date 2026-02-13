import SwiftUI
import DreamDAWModels
import DreamDAWEngine

// MARK: - TransportBarView (Ableton-Style Top Control Bar)

/// Compact top control bar matching Ableton Live 11 layout.
/// Layout: [Tap | BPM | TimeSig | Quantize] | [◀ Play ▶ Stop ● Rec] | [Loop] ... [Key On/Off | Note | Mode] | [Position] | [MIDI] [CPU]
public struct TransportBarView: View {

    @ObservedObject var transportController: TransportController
    @ObservedObject var project: Project

    @State private var bpmText: String = ""

    // MARK: - Tap Tempo State

    /// Timestamps of recent taps for BPM detection.
    @State private var tapTimestamps: [Date] = []

    /// Maximum number of taps to average over.
    private let maxTapCount = 8

    /// If gap between taps exceeds this, reset the tap buffer.
    private let tapResetInterval: TimeInterval = 3.0

    // MARK: - Quantize State

    /// Available quantize values for cycling.
    private static let quantizeValues = ["1/4", "1/8", "1/16", "1/32", "1/4T", "1/8T", "1/16T", "OFF"]

    /// Current quantize index.
    @State private var quantizeIndex: Int = 0
    
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
            
            // Loop toggle
            loopSection

            thinDivider

            // Mid-left: Key selector
            keySection

            thinDivider

            // Mid-left: Position display (compact)
            positionSection

            Spacer()

            thinDivider

            // Right edge: MIDI, CPU
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
            ControlBarButton(label: "Tap", action: { handleTapTempo() })
            
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
            
            // Quantize selector — click to cycle
            Button(action: { cycleQuantize() }) {
                Text(Self.quantizeValues[quantizeIndex])
                    .font(.system(size: 10, weight: .medium, design: .monospaced))
                    .foregroundColor(quantizeIndex == Self.quantizeValues.count - 1
                        ? Color(nsColor: DreamTheme.textMuted)
                        : Color(nsColor: DreamTheme.textSecondary))
                    .padding(.horizontal, 6)
            }
            .buttonStyle(.plain)
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

    // MARK: - Tap Tempo

    /// Handle a tap tempo click: record timestamp, calculate average BPM.
    private func handleTapTempo() {
        let now = Date()

        // Reset if too long since last tap
        if let last = tapTimestamps.last, now.timeIntervalSince(last) > tapResetInterval {
            tapTimestamps.removeAll()
        }

        tapTimestamps.append(now)

        // Keep only the last N taps
        if tapTimestamps.count > maxTapCount {
            tapTimestamps.removeFirst(tapTimestamps.count - maxTapCount)
        }

        // Need at least 2 taps to calculate BPM
        guard tapTimestamps.count >= 2 else { return }

        // Calculate average interval
        var totalInterval: TimeInterval = 0
        for i in 1..<tapTimestamps.count {
            totalInterval += tapTimestamps[i].timeIntervalSince(tapTimestamps[i - 1])
        }
        let avgInterval = totalInterval / Double(tapTimestamps.count - 1)

        // Convert to BPM (60 seconds / avg interval)
        let detectedBPM = 60.0 / avgInterval

        // Clamp to valid range
        let clamped = min(max(detectedBPM, 20.0), 999.0)
        project.bpm = (clamped * 100).rounded() / 100  // Round to 2 decimal places
        transportController.bpm = project.bpm
        bpmText = String(format: "%.2f", project.bpm)
    }

    // MARK: - Quantize Cycling

    /// Cycle through quantize values.
    private func cycleQuantize() {
        quantizeIndex = (quantizeIndex + 1) % Self.quantizeValues.count
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
            
            // Record button (not yet implemented — visually disabled)
            AbletonTransportBtn(
                icon: "circle.fill",
                isActive: false,
                activeColor: Color(nsColor: DreamTheme.armButton),
                action: {}
            )
            .opacity(0.35)
            .help("Recording — coming soon")
        }
        .padding(.horizontal, 6)
    }
    
    // MARK: - Position Display
    
    private var positionSection: some View {
        Text(compactPositionString(transportController.playheadPosition))
            .font(.system(size: 12, weight: .semibold, design: .monospaced))
            .foregroundColor(Color(nsColor: DreamTheme.textPrimary))
            .frame(minWidth: 86, alignment: .trailing)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(
                RoundedRectangle(cornerRadius: 3)
                    .fill(Color(nsColor: DreamTheme.bgSurface).opacity(0.65))
            )
            .padding(.horizontal, 8)
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

    private var keySection: some View {
        HStack(spacing: 4) {
            Button(action: {
                project.keySignatureEnabled.toggle()
            }) {
                Image(systemName: project.keySignatureEnabled ? "music.note" : "music.note.slash")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(
                        project.keySignatureEnabled
                        ? Color(nsColor: DreamTheme.accentSecondary)
                        : Color(nsColor: DreamTheme.textMuted)
                    )
                    .frame(width: 20, height: 20)
                    .background(
                        RoundedRectangle(cornerRadius: 2)
                            .fill(
                                project.keySignatureEnabled
                                ? Color(nsColor: DreamTheme.accentSecondary).opacity(0.15)
                                : Color(nsColor: DreamTheme.bgSurface).opacity(0.35)
                            )
                    )
            }
            .buttonStyle(.plain)
            .help("Enable Key")
            
            Menu {
                ForEach(ProjectKeyTonic.allCases, id: \.self) { tonic in
                    Button(tonic.rawValue) {
                        project.keySignatureTonic = tonic
                    }
                }
            } label: {
                keyTokenLabel(project.keySignatureTonic.rawValue, width: 68)
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            
            Menu {
                ForEach(ProjectKeyMode.allCases, id: \.self) { mode in
                    Button(mode.rawValue) {
                        project.keySignatureMode = mode
                    }
                }
            } label: {
                keyTokenLabel(project.keySignatureMode.rawValue, width: 92)
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
        }
        .padding(.horizontal, 8)
    }
    
    private var rightSection: some View {
        HStack(spacing: 8) {
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
                Text("--")
                    .font(.system(size: 9, weight: .medium, design: .monospaced))
                    .foregroundColor(Color(nsColor: DreamTheme.textMuted))
            }
        }
        .padding(.horizontal, 8)
    }

    private func compactPositionString(_ position: TimePosition) -> String {
        let beatsPerBar = max(1, transportController.timeSignature.beatsPerBar)
        let bars = Int(position.beats) / beatsPerBar
        let beatOffset = position.beats - Double(bars * beatsPerBar)
        let wholeBeat = Int(floor(beatOffset))
        let subBeat = max(0, min(99, Int(round((beatOffset - floor(beatOffset)) * 100.0))))
        return String(format: "%d.%d.%02d", bars + 1, wholeBeat + 1, subBeat)
    }

    private func keyTokenLabel(_ title: String, width: CGFloat) -> some View {
        HStack(spacing: 4) {
            Text(title)
                .font(.system(size: 10, weight: .semibold))
                .foregroundColor(Color(nsColor: DreamTheme.textPrimary))
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 0)
            Image(systemName: "chevron.down")
                .font(.system(size: 8, weight: .medium))
                .foregroundColor(Color(nsColor: DreamTheme.textMuted))
        }
        .padding(.horizontal, 6)
        .frame(width: width, height: 20)
        .background(
            RoundedRectangle(cornerRadius: 2)
                .fill(Color(nsColor: DreamTheme.bgSurface).opacity(0.7))
        )
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
