import AppKit
import Foundation
import DreamDAWModels

// MARK: - TrackHeaderView (Ableton Live Right-Side Style)

/// Renders a single track header in the Ableton Live style.
/// Layout: [ColoredName] [Routing▾] [S] [Volume] [Pan] [#]
/// Track name is displayed on a colored background strip matching the track color.
public final class TrackHeaderView: NSView {

    // MARK: - Properties

    private let track: Track
    private let trackIndex: Int

    // UI Components
    private let nameBackgroundView = NSView()
    private let nameLabel = NSTextField(labelWithString: "")
    private let trackTypeLabel = NSTextField(labelWithString: "")
    private let routingLabel = NSTextField(labelWithString: "")
    private let soloButton = NSButton()
    private let muteIndicator = NSView()
    private let trackNumberLabel = NSTextField(labelWithString: "")
    private let volumeBar = NSView()         // Mini volume bar
    private let volumeBarFill = NSView()     // Filled portion

    /// Callback when track settings change.
    public var onTrackChanged: ((Track) -> Void)?

    // MARK: - Initialization

    public init(track: Track, index: Int) {
        self.track = track
        self.trackIndex = index
        super.init(frame: .zero)
        setupUI()
        updateFromTrack()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    // MARK: - Setup

    private func setupUI() {
        wantsLayer = true
        layer?.backgroundColor = DreamTheme.bgTrackHeader.cgColor

        // Track name background (colored strip like Ableton)
        nameBackgroundView.wantsLayer = true
        nameBackgroundView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(nameBackgroundView)

        // Track name
        nameLabel.font = DreamTheme.fontBodyBold
        nameLabel.textColor = DreamTheme.textOnColor
        nameLabel.backgroundColor = .clear
        nameLabel.isBezeled = false
        nameLabel.isEditable = false
        nameLabel.lineBreakMode = .byTruncatingTail
        nameLabel.translatesAutoresizingMaskIntoConstraints = false
        addSubview(nameLabel)

        // Track type label (Audio/MIDI routing)
        trackTypeLabel.font = DreamTheme.fontSmall
        trackTypeLabel.textColor = DreamTheme.textSecondary
        trackTypeLabel.backgroundColor = .clear
        trackTypeLabel.isBezeled = false
        trackTypeLabel.isEditable = false
        trackTypeLabel.translatesAutoresizingMaskIntoConstraints = false
        addSubview(trackTypeLabel)

        // Routing label ("Main ▾")
        routingLabel.font = DreamTheme.fontSmall
        routingLabel.textColor = DreamTheme.textSecondary
        routingLabel.backgroundColor = .clear
        routingLabel.isBezeled = false
        routingLabel.isEditable = false
        routingLabel.translatesAutoresizingMaskIntoConstraints = false
        addSubview(routingLabel)

        // Solo button (S)
        soloButton.title = "S"
        soloButton.font = NSFont.systemFont(ofSize: 8, weight: .bold)
        soloButton.isBordered = false
        soloButton.wantsLayer = true
        soloButton.target = self
        soloButton.action = #selector(soloToggled)
        soloButton.translatesAutoresizingMaskIntoConstraints = false
        addSubview(soloButton)

        // Mini volume bar background
        volumeBar.wantsLayer = true
        volumeBar.layer?.backgroundColor = NSColor(white: 0.15, alpha: 1).cgColor
        volumeBar.layer?.cornerRadius = 1
        volumeBar.translatesAutoresizingMaskIntoConstraints = false
        addSubview(volumeBar)

        // Volume fill
        volumeBarFill.wantsLayer = true
        volumeBarFill.layer?.backgroundColor = DreamTheme.accentGreen.withAlphaComponent(0.6).cgColor
        volumeBarFill.layer?.cornerRadius = 1
        volumeBarFill.translatesAutoresizingMaskIntoConstraints = false
        volumeBar.addSubview(volumeBarFill)

        // Track number
        trackNumberLabel.font = DreamTheme.fontMonoSmall
        trackNumberLabel.textColor = DreamTheme.textMuted
        trackNumberLabel.alignment = .right
        trackNumberLabel.backgroundColor = .clear
        trackNumberLabel.isBezeled = false
        trackNumberLabel.isEditable = false
        trackNumberLabel.translatesAutoresizingMaskIntoConstraints = false
        addSubview(trackNumberLabel)

        // Bottom divider
        let divider = NSView()
        divider.wantsLayer = true
        divider.layer?.backgroundColor = DreamTheme.divider.cgColor
        divider.translatesAutoresizingMaskIntoConstraints = false
        addSubview(divider)

        // Mute click target (entire name area)
        let clickGesture = NSClickGestureRecognizer(target: self, action: #selector(nameAreaClicked))
        clickGesture.numberOfClicksRequired = 2
        nameBackgroundView.addGestureRecognizer(clickGesture)

        // Layout
        NSLayoutConstraint.activate([
            // Name background (colored strip) — left portion
            nameBackgroundView.leadingAnchor.constraint(equalTo: leadingAnchor),
            nameBackgroundView.topAnchor.constraint(equalTo: topAnchor),
            nameBackgroundView.bottomAnchor.constraint(equalTo: bottomAnchor),
            nameBackgroundView.widthAnchor.constraint(equalToConstant: 72),

            // Name label inside colored strip
            nameLabel.leadingAnchor.constraint(equalTo: nameBackgroundView.leadingAnchor, constant: 4),
            nameLabel.trailingAnchor.constraint(equalTo: nameBackgroundView.trailingAnchor, constant: -2),
            nameLabel.centerYAnchor.constraint(equalTo: centerYAnchor, constant: -6),

            // Track type under name
            trackTypeLabel.leadingAnchor.constraint(equalTo: nameBackgroundView.trailingAnchor, constant: 4),
            trackTypeLabel.centerYAnchor.constraint(equalTo: centerYAnchor, constant: -6),

            // Routing label
            routingLabel.leadingAnchor.constraint(equalTo: nameBackgroundView.trailingAnchor, constant: 4),
            routingLabel.centerYAnchor.constraint(equalTo: centerYAnchor, constant: 6),

            // Solo button
            soloButton.trailingAnchor.constraint(equalTo: volumeBar.leadingAnchor, constant: -4),
            soloButton.centerYAnchor.constraint(equalTo: centerYAnchor),
            soloButton.widthAnchor.constraint(equalToConstant: 16),
            soloButton.heightAnchor.constraint(equalToConstant: 14),

            // Volume bar
            volumeBar.trailingAnchor.constraint(equalTo: trackNumberLabel.leadingAnchor, constant: -6),
            volumeBar.centerYAnchor.constraint(equalTo: centerYAnchor),
            volumeBar.widthAnchor.constraint(equalToConstant: 40),
            volumeBar.heightAnchor.constraint(equalToConstant: 6),

            // Volume fill (left-aligned within bar, width set dynamically)
            volumeBarFill.leadingAnchor.constraint(equalTo: volumeBar.leadingAnchor),
            volumeBarFill.topAnchor.constraint(equalTo: volumeBar.topAnchor),
            volumeBarFill.bottomAnchor.constraint(equalTo: volumeBar.bottomAnchor),

            // Track number (far right)
            trackNumberLabel.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -6),
            trackNumberLabel.centerYAnchor.constraint(equalTo: centerYAnchor),
            trackNumberLabel.widthAnchor.constraint(equalToConstant: 24),

            // Bottom divider
            divider.leadingAnchor.constraint(equalTo: leadingAnchor),
            divider.trailingAnchor.constraint(equalTo: trailingAnchor),
            divider.bottomAnchor.constraint(equalTo: bottomAnchor),
            divider.heightAnchor.constraint(equalToConstant: 1),
        ])
    }

    public override func layout() {
        super.layout()
        updateVolumeFill()
    }

    private func updateFromTrack() {
        nameLabel.stringValue = track.name
        nameBackgroundView.layer?.backgroundColor = track.color.nsColor.cgColor
        trackTypeLabel.stringValue = track.trackType.displayName
        routingLabel.stringValue = "Main ▾"
        trackNumberLabel.stringValue = "\(trackIndex + 1)"
        updateButtonStates()
        updateVolumeFill()
    }

    private func updateVolumeFill() {
        let barWidth = volumeBar.bounds.width
        let fillWidth = barWidth * CGFloat(track.volume)
        volumeBarFill.frame = CGRect(
            x: 0, y: 0,
            width: fillWidth,
            height: volumeBar.bounds.height
        )

        // Gray out if muted
        let fillColor = track.isMuted
            ? NSColor(white: 0.3, alpha: 0.5)
            : DreamTheme.accentGreen.withAlphaComponent(0.6)
        volumeBarFill.layer?.backgroundColor = fillColor.cgColor
    }

    private func updateButtonStates() {
        let soloColor = track.isSoloed ? DreamTheme.soloButton : DreamTheme.textMuted
        soloButton.contentTintColor = soloColor
        soloButton.layer?.backgroundColor = track.isSoloed
            ? DreamTheme.soloButton.withAlphaComponent(0.2).cgColor
            : NSColor.clear.cgColor
        soloButton.layer?.cornerRadius = 2

        // Mute state shown via dimmed name
        if track.isMuted {
            nameBackgroundView.alphaValue = 0.4
            nameLabel.alphaValue = 0.4
        } else {
            nameBackgroundView.alphaValue = 1.0
            nameLabel.alphaValue = 1.0
        }
    }

    // MARK: - Actions

    @objc private func soloToggled() {
        track.isSoloed.toggle()
        updateButtonStates()
        onTrackChanged?(track)
    }

    @objc private func nameAreaClicked() {
        track.isMuted.toggle()
        updateButtonStates()
        updateVolumeFill()
        onTrackChanged?(track)
    }
}

// MARK: - TrackHeadersContainerView

/// Vertical stack of all track headers, positioned on the RIGHT side of the arrangement.
/// Synchronized with track lane scroll.
public final class TrackHeadersContainerView: NSView {

    // MARK: - Properties

    private var headerViews: [TrackHeaderView] = []

    public var onTrackChanged: ((Track) -> Void)?

    public override var isFlipped: Bool { true }

    // MARK: - Public API

    public func configure(tracks: [Track]) {
        // Remove existing
        headerViews.forEach { $0.removeFromSuperview() }
        headerViews.removeAll()

        var yOffset: CGFloat = 0

        for (index, track) in tracks.enumerated() {
            let header = TrackHeaderView(track: track, index: index)
            header.frame = CGRect(x: 0, y: yOffset, width: DreamTheme.trackHeaderWidth, height: track.height)
            header.onTrackChanged = { [weak self] track in
                self?.onTrackChanged?(track)
            }
            addSubview(header)
            headerViews.append(header)

            yOffset += track.height
        }

        // Update frame
        frame.size.height = yOffset
    }

    /// Scroll to match the timeline vertical scroll position.
    public func setVerticalOffset(_ offset: CGFloat) {
        setBoundsOrigin(NSPoint(x: 0, y: offset))
    }
}
