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

    /// Expose track ID for drag-and-drop hit testing
    public var trackID: UUID { track.id }

    // UI Components
    private let nameBackgroundView = NSView()
    private let nameLabel = NSTextField(labelWithString: "")
    private let trackTypeLabel = NSTextField(labelWithString: "")
    private let routingLabel = NSTextField(labelWithString: "")
    private let soloButton = NSButton()
    private let muteIndicator = NSView()
    private let trackNumberLabel = NSTextField(labelWithString: "")
    private let vuMeterBarL = NSView()       // Left channel VU meter background
    private let vuMeterFillL = NSView()      // Left channel filled portion
    private let vuMeterBarR = NSView()       // Right channel VU meter background
    private let vuMeterFillR = NSView()      // Right channel filled portion
    private let peakIndicator = NSView()     // Peak clip indicator

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

        // Vertical VU meter — left channel
        vuMeterBarL.wantsLayer = true
        vuMeterBarL.layer?.backgroundColor = NSColor(white: 0.12, alpha: 1).cgColor
        vuMeterBarL.layer?.cornerRadius = 1
        vuMeterBarL.translatesAutoresizingMaskIntoConstraints = false
        addSubview(vuMeterBarL)

        vuMeterFillL.wantsLayer = true
        vuMeterFillL.layer?.backgroundColor = DreamTheme.accentGreen.cgColor
        vuMeterFillL.layer?.cornerRadius = 1
        vuMeterFillL.translatesAutoresizingMaskIntoConstraints = false
        vuMeterBarL.addSubview(vuMeterFillL)

        // Vertical VU meter — right channel
        vuMeterBarR.wantsLayer = true
        vuMeterBarR.layer?.backgroundColor = NSColor(white: 0.12, alpha: 1).cgColor
        vuMeterBarR.layer?.cornerRadius = 1
        vuMeterBarR.translatesAutoresizingMaskIntoConstraints = false
        addSubview(vuMeterBarR)

        vuMeterFillR.wantsLayer = true
        vuMeterFillR.layer?.backgroundColor = DreamTheme.accentGreen.cgColor
        vuMeterFillR.layer?.cornerRadius = 1
        vuMeterFillR.translatesAutoresizingMaskIntoConstraints = false
        vuMeterBarR.addSubview(vuMeterFillR)

        // Peak clip indicator (red dot at top)
        peakIndicator.wantsLayer = true
        peakIndicator.layer?.backgroundColor = NSColor(red: 0.3, green: 0.3, blue: 0.3, alpha: 1).cgColor
        peakIndicator.layer?.cornerRadius = 2
        peakIndicator.translatesAutoresizingMaskIntoConstraints = false
        addSubview(peakIndicator)

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
            soloButton.trailingAnchor.constraint(equalTo: vuMeterBarL.leadingAnchor, constant: -4),
            soloButton.centerYAnchor.constraint(equalTo: centerYAnchor),
            soloButton.widthAnchor.constraint(equalToConstant: 16),
            soloButton.heightAnchor.constraint(equalToConstant: 14),

            // VU meter left channel (vertical bar, near right edge)
            vuMeterBarL.trailingAnchor.constraint(equalTo: vuMeterBarR.leadingAnchor, constant: -2),
            vuMeterBarL.topAnchor.constraint(equalTo: topAnchor, constant: 14),
            vuMeterBarL.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -4),
            vuMeterBarL.widthAnchor.constraint(equalToConstant: 4),

            // VU meter right channel
            vuMeterBarR.trailingAnchor.constraint(equalTo: trackNumberLabel.leadingAnchor, constant: -4),
            vuMeterBarR.topAnchor.constraint(equalTo: topAnchor, constant: 14),
            vuMeterBarR.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -4),
            vuMeterBarR.widthAnchor.constraint(equalToConstant: 4),

            // Peak indicator (above the VU meters)
            peakIndicator.centerXAnchor.constraint(equalTo: vuMeterBarL.trailingAnchor, constant: 1),
            peakIndicator.topAnchor.constraint(equalTo: topAnchor, constant: 4),
            peakIndicator.widthAnchor.constraint(equalToConstant: 10),
            peakIndicator.heightAnchor.constraint(equalToConstant: 4),

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

        // Display instrument/effects info in routing label
        if track.trackType == .midi {
            if let instrument = track.instrument {
                routingLabel.stringValue = instrument.instrumentType.displayName
                routingLabel.textColor = DreamTheme.accentGreen
            } else {
                routingLabel.stringValue = "No Instrument"
                routingLabel.textColor = DreamTheme.textMuted
            }
        } else if track.trackType == .audio {
            if track.effects.isEmpty {
                routingLabel.stringValue = "Main ▾"
                routingLabel.textColor = DreamTheme.textSecondary
            } else {
                routingLabel.stringValue = "FX: \(track.effects.count) ▾"
                routingLabel.textColor = DreamTheme.accentGreen
            }
        } else {
            routingLabel.stringValue = "Master"
            routingLabel.textColor = DreamTheme.textSecondary
        }

        trackNumberLabel.stringValue = "\(trackIndex + 1)"
        updateButtonStates()
        updateVolumeFill()
    }

    private func updateVolumeFill() {
        // Volume fill is now handled by real-time VU meter updates
        // This method only handles the muted visual state
        let fillColor = track.isMuted
            ? NSColor(white: 0.2, alpha: 0.5)
            : DreamTheme.accentGreen
        vuMeterFillL.layer?.backgroundColor = fillColor.cgColor
        vuMeterFillR.layer?.backgroundColor = fillColor.cgColor
    }

    /// Update VU meter levels from AudioLevelMeter (called on display link timer).
    /// `rms` is the RMS level in linear scale (0.0 ... 1.0+), `peak` is peak.
    public func updateMeterLevel(rms: Float, peak: Float) {
        guard !track.isMuted else {
            // Muted: show gray empty bars
            vuMeterFillL.frame = CGRect(x: 0, y: vuMeterBarL.bounds.height, width: vuMeterBarL.bounds.width, height: 0)
            vuMeterFillR.frame = CGRect(x: 0, y: vuMeterBarR.bounds.height, width: vuMeterBarR.bounds.width, height: 0)
            peakIndicator.layer?.backgroundColor = NSColor(white: 0.3, alpha: 1).cgColor
            return
        }

        // Convert linear RMS to visual height (dB scale with floor at -60dB)
        let minDB: Float = -60
        let rmsDB = max(minDB, 20 * log10(max(rms, 1e-8)))
        let normalizedLevel = CGFloat((rmsDB - minDB) / (0 - minDB))  // 0..1 for -60..0 dB

        let barHeight = vuMeterBarL.bounds.height
        let fillHeight = max(0, min(barHeight, barHeight * normalizedLevel))

        // Fill from bottom up (in flipped view, bottom = maxY)
        vuMeterFillL.frame = CGRect(
            x: 0,
            y: barHeight - fillHeight,
            width: vuMeterBarL.bounds.width,
            height: fillHeight
        )
        vuMeterFillR.frame = CGRect(
            x: 0,
            y: barHeight - fillHeight,
            width: vuMeterBarR.bounds.width,
            height: fillHeight
        )

        // Color based on level: green < -6dB, yellow -6..0dB, red > 0dB
        let meterColor: NSColor
        if rmsDB > 0 {
            meterColor = NSColor(red: 1.0, green: 0.2, blue: 0.2, alpha: 1)  // Red: clipping
        } else if rmsDB > -6 {
            meterColor = NSColor(red: 1.0, green: 0.8, blue: 0.1, alpha: 1)  // Yellow: hot
        } else if rmsDB > minDB + 3 {
            meterColor = DreamTheme.accentGreen  // Green: normal
        } else {
            meterColor = NSColor(white: 0.3, alpha: 1)  // Gray: near-silence
        }
        vuMeterFillL.layer?.backgroundColor = meterColor.cgColor
        vuMeterFillR.layer?.backgroundColor = meterColor.cgColor

        // Peak indicator: red if peak > 0dB
        let peakDB = 20 * log10(max(peak, 1e-8))
        if peakDB > 0 {
            peakIndicator.layer?.backgroundColor = NSColor(red: 1.0, green: 0.15, blue: 0.15, alpha: 1).cgColor
        } else if peakDB > -6 {
            peakIndicator.layer?.backgroundColor = NSColor(red: 1.0, green: 0.8, blue: 0.1, alpha: 1).cgColor
        } else {
            peakIndicator.layer?.backgroundColor = NSColor(white: 0.3, alpha: 1).cgColor
        }
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
/// Right-click context menu: Add Audio Track / Add MIDI Track / Delete Track.
/// Synchronized with track lane scroll.
public final class TrackHeadersContainerView: NSView {

    // MARK: - Properties

    public private(set) var headerViews: [TrackHeaderView] = []

    /// Callback when a track's properties change (solo, mute, volume).
    public var onTrackChanged: ((Track) -> Void)?

    /// Callback to add a new track. Bool: isAudio (true = audio, false = MIDI).
    public var onAddTrack: ((Bool) -> Void)?

    /// Callback to delete a track by its UUID.
    public var onDeleteTrack: ((UUID) -> Void)?

    /// Callback when a browser item (instrument/effect) is dropped on a track header.
    /// Parameters: (trackID, nodeType, itemName)
    public var onBrowserItemDropped: ((UUID, String, String) -> Void)?

    public override var isFlipped: Bool { true }

    // MARK: - Initialization

    public override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        setupContextMenu()
        // Register for drag-and-drop of browser items (instruments/effects)
        registerForDraggedTypes([.browserItem, .fileURL])
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    // MARK: - Context Menu

    private func setupContextMenu() {
        let contextMenu = NSMenu(title: "Track Menu")

        let addAudioItem = NSMenuItem(title: "Add Audio Track", action: #selector(contextAddAudioTrack), keyEquivalent: "")
        addAudioItem.target = self
        addAudioItem.image = NSImage(systemSymbolName: "waveform", accessibilityDescription: nil)
        contextMenu.addItem(addAudioItem)

        let addMidiItem = NSMenuItem(title: "Add MIDI Track", action: #selector(contextAddMidiTrack), keyEquivalent: "")
        addMidiItem.target = self
        addMidiItem.image = NSImage(systemSymbolName: "pianokeys", accessibilityDescription: nil)
        contextMenu.addItem(addMidiItem)

        menu = contextMenu
    }

    @objc private func contextAddAudioTrack() {
        onAddTrack?(true)
    }

    @objc private func contextAddMidiTrack() {
        onAddTrack?(false)
    }

    // MARK: - Public API

    public func configure(tracks: [Track], masterTrack: Track? = nil) {
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

        // Master track header at the bottom (compact)
        if let masterTrack = masterTrack {
            // Thicker separator before master
            let separator = NSView()
            separator.wantsLayer = true
            separator.layer?.backgroundColor = DreamTheme.divider.cgColor
            separator.frame = CGRect(x: 0, y: yOffset, width: DreamTheme.trackHeaderWidth, height: 2)
            addSubview(separator)
            yOffset += 2

            let masterHeader = TrackHeaderView(track: masterTrack, index: tracks.count)
            masterHeader.frame = CGRect(x: 0, y: yOffset, width: DreamTheme.trackHeaderWidth, height: masterTrack.height)
            masterHeader.onTrackChanged = { [weak self] track in
                self?.onTrackChanged?(track)
            }
            addSubview(masterHeader)
            headerViews.append(masterHeader)
            yOffset += masterTrack.height
        }

        // Update frame
        frame.size.height = yOffset
    }

    /// Scroll to match the timeline vertical scroll position.
    public func setVerticalOffset(_ offset: CGFloat) {
        setBoundsOrigin(NSPoint(x: 0, y: offset))
    }

    // MARK: - Drag & Drop (Accept instruments/effects on track headers)

    public override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        if sender.draggingPasteboard.string(forType: .browserItem) != nil {
            return .copy
        }
        return []
    }

    public override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        guard let payload = sender.draggingPasteboard.string(forType: .browserItem) else {
            return false
        }

        let parts = payload.split(separator: ":", maxSplits: 1)
        guard parts.count == 2 else { return false }
        let nodeType = String(parts[0])
        let itemName = String(parts[1])

        // Determine which track header was dropped onto
        let location = convert(sender.draggingLocation, from: nil)

        for headerView in headerViews {
            if headerView.frame.contains(location) {
                let trackID = headerView.trackID
                onBrowserItemDropped?(trackID, nodeType, itemName)
                return true
            }
        }

        // Fallback: use the first track if drop is in the container
        if let first = headerViews.first {
            onBrowserItemDropped?(first.trackID, nodeType, itemName)
            return true
        }

        return false
    }
}

