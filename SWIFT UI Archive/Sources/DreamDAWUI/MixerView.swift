import SwiftUI
import DreamDAWModels
import DreamDAWEngine

// MARK: - MixerView

/// Vertical channel strip mixer view (toggled with Tab key).
/// Each track gets a vertical strip with volume fader, pan knob, mute/solo buttons.
/// Master track strip is on the far right.
public struct MixerView: View {

    @ObservedObject var project: Project

    /// Callback when a track's volume/pan/mute changes.
    public var onTrackChanged: ((Track) -> Void)?

    public init(project: Project, onTrackChanged: ((Track) -> Void)? = nil) {
        self.project = project
        self.onTrackChanged = onTrackChanged
    }

    public var body: some View {
        HStack(spacing: 0) {
            // Regular tracks
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 1) {
                    ForEach(project.tracks, id: \.id) { track in
                        ChannelStripView(track: track, onChanged: {
                            onTrackChanged?(track)
                        })
                    }
                }
                .padding(.horizontal, 2)
            }

            // Separator
            Rectangle()
                .fill(Color(nsColor: DreamTheme.divider))
                .frame(width: 2)

            // Master strip
            ChannelStripView(track: project.masterTrack, isMaster: true, onChanged: {
                onTrackChanged?(project.masterTrack)
            })
            .frame(width: 90)
        }
        .background(Color(nsColor: DreamTheme.bgPrimary))
    }
}

// MARK: - ChannelStripView

/// Single vertical channel strip — volume fader, pan, mute/solo, track name.
struct ChannelStripView: View {

    @ObservedObject var track: Track
    var isMaster: Bool = false
    var onChanged: (() -> Void)?

    var body: some View {
        VStack(spacing: 4) {
            // Track name
            Text(track.name)
                .font(.system(size: DreamTheme.fontSizeSmall, weight: .semibold))
                .foregroundColor(.white)
                .lineLimit(1)
                .frame(maxWidth: .infinity)
                .padding(.top, 6)

            // Track type badge
            if !isMaster {
                Text(track.trackType.displayName)
                    .font(.system(size: DreamTheme.fontSizeMicro, weight: .medium))
                    .foregroundColor(.white.opacity(0.5))
                    .padding(.horizontal, 4)
                    .padding(.vertical, 1)
                    .background(track.color.color.opacity(0.3))
                    .cornerRadius(DreamTheme.radiusSmall)
            }

            Spacer()

            // VU meter placeholder (colored bar)
            RoundedRectangle(cornerRadius: DreamTheme.radiusSmall)
                .fill(
                    LinearGradient(
                        colors: [.green, .yellow, .red],
                        startPoint: .bottom,
                        endPoint: .top
                    )
                )
                .frame(width: 8, height: 120)
                .opacity(0.3)

            Spacer()

            // Pan knob (as a slider for now)
            if !isMaster || true {
                HStack(spacing: 2) {
                    Text("L")
                        .font(.system(size: DreamTheme.fontSizeMicro))
                        .foregroundColor(.white.opacity(0.4))
                    Slider(value: Binding(
                        get: { Double(track.pan) },
                        set: { track.pan = Float($0); onChanged?() }
                    ), in: -1...1)
                    .frame(width: 50)
                    Text("R")
                        .font(.system(size: DreamTheme.fontSizeMicro))
                        .foregroundColor(.white.opacity(0.4))
                }
            }

            // Volume fader
            VStack(spacing: 2) {
                Slider(value: Binding(
                    get: { Double(track.volume) },
                    set: { track.volume = Float($0); onChanged?() }
                ), in: 0...1)
                .rotationEffect(.degrees(-90))
                .frame(width: 30, height: 100)

                // dB label
                let db = track.volume > 0 ? 20 * log10(track.volume) : -Float.infinity
                Text(db > -60 ? String(format: "%.1f", db) : "-∞")
                    .font(.system(size: DreamTheme.fontSizeMicro + 1, design: .monospaced))
                    .foregroundColor(.white.opacity(0.6))
            }

            // Mute / Solo buttons
            HStack(spacing: 4) {
                Button(action: {
                    track.isMuted.toggle()
                    onChanged?()
                }) {
                    Text("M")
                        .font(.system(size: DreamTheme.fontSizeSmall, weight: .bold))
                        .foregroundColor(track.isMuted ? .black : .white.opacity(0.6))
                        .frame(width: 22, height: 18)
                        .background(track.isMuted ? Color.orange : Color.white.opacity(0.1))
                        .cornerRadius(DreamTheme.radiusSmall)
                }
                .buttonStyle(.plain)

                if !isMaster {
                    Button(action: {
                        track.isSoloed.toggle()
                        onChanged?()
                    }) {
                        Text("S")
                            .font(.system(size: DreamTheme.fontSizeSmall, weight: .bold))
                            .foregroundColor(track.isSoloed ? .black : .white.opacity(0.6))
                            .frame(width: 22, height: 18)
                            .background(track.isSoloed ? Color.yellow : Color.white.opacity(0.1))
                            .cornerRadius(DreamTheme.radiusSmall)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.bottom, 6)
        }
        .frame(minWidth: isMaster ? 90 : 72, maxWidth: isMaster ? 90 : 72, maxHeight: .infinity)
        .background(
            isMaster
                ? Color(nsColor: DreamTheme.bgHeader)
                : Color(nsColor: DreamTheme.bgSecondary)
        )
        .overlay(
            Rectangle()
                .fill(track.color.color)
                .frame(height: 3),
            alignment: .top
        )
    }
}
