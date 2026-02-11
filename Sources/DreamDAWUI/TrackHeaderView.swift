import AppKit
import Foundation
import DreamDAWModels

// MARK: - TrackHeaderView

/// Renders a single track's header panel with name, color, volume, pan, and mute/solo buttons.
public final class TrackHeaderView: NSView {

    // MARK: - Properties

    private let track: Track
    private let trackIndex: Int

    // UI Components
    private let colorStripe = NSView()
    private let nameLabel = NSTextField(labelWithString: "")
    private let volumeSlider = NSSlider()
    private let panSlider = NSSlider()
    private let muteButton = NSButton()
    private let soloButton = NSButton()

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
        layer?.backgroundColor = DreamTheme.bgSecondary.cgColor

        // Color stripe (left edge)
        colorStripe.wantsLayer = true
        colorStripe.translatesAutoresizingMaskIntoConstraints = false
        addSubview(colorStripe)

        // Track name
        nameLabel.font = DreamTheme.fontBodyBold
        nameLabel.textColor = DreamTheme.textPrimary
        nameLabel.backgroundColor = .clear
        nameLabel.isBezeled = false
        nameLabel.isEditable = false
        nameLabel.translatesAutoresizingMaskIntoConstraints = false
        addSubview(nameLabel)

        // Volume slider
        volumeSlider.minValue = 0
        volumeSlider.maxValue = 1
        volumeSlider.isContinuous = true
        volumeSlider.target = self
        volumeSlider.action = #selector(volumeChanged)
        volumeSlider.translatesAutoresizingMaskIntoConstraints = false
        volumeSlider.controlSize = .small
        addSubview(volumeSlider)

        // Pan slider
        panSlider.minValue = -1
        panSlider.maxValue = 1
        panSlider.isContinuous = true
        panSlider.target = self
        panSlider.action = #selector(panChanged)
        panSlider.translatesAutoresizingMaskIntoConstraints = false
        panSlider.controlSize = .small
        addSubview(panSlider)

        // Mute button
        muteButton.title = "M"
        muteButton.font = DreamTheme.fontSmall
        muteButton.isBordered = false
        muteButton.wantsLayer = true
        muteButton.target = self
        muteButton.action = #selector(muteToggled)
        muteButton.translatesAutoresizingMaskIntoConstraints = false
        addSubview(muteButton)

        // Solo button
        soloButton.title = "S"
        soloButton.font = DreamTheme.fontSmall
        soloButton.isBordered = false
        soloButton.wantsLayer = true
        soloButton.target = self
        soloButton.action = #selector(soloToggled)
        soloButton.translatesAutoresizingMaskIntoConstraints = false
        addSubview(soloButton)

        // Bottom divider
        let divider = NSView()
        divider.wantsLayer = true
        divider.layer?.backgroundColor = DreamTheme.divider.cgColor
        divider.translatesAutoresizingMaskIntoConstraints = false
        addSubview(divider)

        // Layout
        NSLayoutConstraint.activate([
            // Color stripe
            colorStripe.leadingAnchor.constraint(equalTo: leadingAnchor),
            colorStripe.topAnchor.constraint(equalTo: topAnchor),
            colorStripe.bottomAnchor.constraint(equalTo: bottomAnchor),
            colorStripe.widthAnchor.constraint(equalToConstant: 4),

            // Name
            nameLabel.leadingAnchor.constraint(equalTo: colorStripe.trailingAnchor, constant: 8),
            nameLabel.topAnchor.constraint(equalTo: topAnchor, constant: 6),
            nameLabel.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),

            // Mute/Solo buttons
            muteButton.leadingAnchor.constraint(equalTo: colorStripe.trailingAnchor, constant: 8),
            muteButton.topAnchor.constraint(equalTo: nameLabel.bottomAnchor, constant: 4),
            muteButton.widthAnchor.constraint(equalToConstant: 22),
            muteButton.heightAnchor.constraint(equalToConstant: 18),

            soloButton.leadingAnchor.constraint(equalTo: muteButton.trailingAnchor, constant: 4),
            soloButton.topAnchor.constraint(equalTo: muteButton.topAnchor),
            soloButton.widthAnchor.constraint(equalToConstant: 22),
            soloButton.heightAnchor.constraint(equalToConstant: 18),

            // Volume slider
            volumeSlider.leadingAnchor.constraint(equalTo: colorStripe.trailingAnchor, constant: 8),
            volumeSlider.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            volumeSlider.topAnchor.constraint(equalTo: muteButton.bottomAnchor, constant: 4),

            // Pan slider
            panSlider.leadingAnchor.constraint(equalTo: colorStripe.trailingAnchor, constant: 8),
            panSlider.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            panSlider.topAnchor.constraint(equalTo: volumeSlider.bottomAnchor, constant: 2),

            // Bottom divider
            divider.leadingAnchor.constraint(equalTo: leadingAnchor),
            divider.trailingAnchor.constraint(equalTo: trailingAnchor),
            divider.bottomAnchor.constraint(equalTo: bottomAnchor),
            divider.heightAnchor.constraint(equalToConstant: 1),
        ])
    }

    private func updateFromTrack() {
        nameLabel.stringValue = track.name
        colorStripe.layer?.backgroundColor = track.color.nsColor.cgColor
        volumeSlider.doubleValue = Double(track.volume)
        panSlider.doubleValue = Double(track.pan)
        updateButtonStates()
    }

    private func updateButtonStates() {
        let muteColor = track.isMuted ? DreamTheme.muteButton : DreamTheme.textMuted
        muteButton.contentTintColor = muteColor
        muteButton.layer?.backgroundColor = track.isMuted
            ? DreamTheme.muteButton.withAlphaComponent(0.2).cgColor
            : NSColor.clear.cgColor
        muteButton.layer?.cornerRadius = 3

        let soloColor = track.isSoloed ? DreamTheme.soloButton : DreamTheme.textMuted
        soloButton.contentTintColor = soloColor
        soloButton.layer?.backgroundColor = track.isSoloed
            ? DreamTheme.soloButton.withAlphaComponent(0.2).cgColor
            : NSColor.clear.cgColor
        soloButton.layer?.cornerRadius = 3
    }

    // MARK: - Actions

    @objc private func volumeChanged() {
        track.volume = Float(volumeSlider.doubleValue)
        onTrackChanged?(track)
    }

    @objc private func panChanged() {
        track.pan = Float(panSlider.doubleValue)
        onTrackChanged?(track)
    }

    @objc private func muteToggled() {
        track.isMuted.toggle()
        updateButtonStates()
        onTrackChanged?(track)
    }

    @objc private func soloToggled() {
        track.isSoloed.toggle()
        updateButtonStates()
        onTrackChanged?(track)
    }
}

// MARK: - TrackHeadersContainerView

/// Vertical stack of all track headers, synchronized with track lane scroll.
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
        // We adjust our bounds origin to simulate scrolling
        setBoundsOrigin(NSPoint(x: 0, y: offset))
    }
}
