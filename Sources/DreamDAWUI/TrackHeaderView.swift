import AppKit
import Foundation
import Combine
import DreamDAWModels

// MARK: - TrackHeaderView (Ableton Live Right-Side Style)

/// Renders a single track header in the Ableton Live style.
/// Layout: [ColoredName] [Routing▾] [S] [Volume] [Pan] [#]
/// Track name is displayed on a colored background strip matching the track color.
extension NSPasteboard.PasteboardType {
    public static let trackID = NSPasteboard.PasteboardType("com.dreamdaw.trackID")
}

public final class TrackHeaderView: NSView {

    // MARK: - Properties

    public private(set) var track: Track
    private var cancellables = Set<AnyCancellable>()
    
    public var isSelected: Bool = false {
        didSet {
            updateSelectionState()
        }
    }
    private let trackIndex: Int

    /// Expose track ID for drag-and-drop hit testing
    public var trackID: UUID { track.id }

    // UI Components
    private let nameBackgroundView = NSView()
    private let nameLabel = NSTextField(labelWithString: "")
    private let trackTypeLabel = NSTextField(labelWithString: "")
    private let routingLabel = NSTextField(labelWithString: "")
    private let soloButton = NSButton()
    private let enableButton = NSButton()     // Track enable/disable (shows track number)
    private let vuMeterBarL = NSView()       // Left channel VU meter background
    private let vuMeterFillL = NSView()      // Left channel filled portion
    private let vuMeterBarR = NSView()       // Right channel VU meter background
    private let vuMeterFillR = NSView()      // Right channel filled portion
    private let peakIndicator = NSView()     // Peak clip indicator

    /// Callback when track settings change.
    public var onTrackChanged: ((Track) -> Void)?

    /// Callback specifically for solo changes (needs to propagate to TrackMixer for solo logic).
    public var onSoloChanged: (() -> Void)?
    
    /// Callback when header is clicked (for track selection).
    public var onHeaderClicked: (() -> Void)?

    // MARK: - Initialization

    public init(track: Track, index: Int) {
        self.track = track
        self.trackIndex = index
        super.init(frame: .zero)
        setupUI()
        updateFromTrack()
        setupSubscriptions()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    private func setupSubscriptions() {
        // Observe all relevant track properties
        track.objectWillChange
            .sink { [weak self] _ in
                // Coalesce updates to Main thread
                DispatchQueue.main.async {
                    self?.updateFromTrack()
                }
            }
            .store(in: &cancellables)
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
        nameLabel.delegate = self
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

        // Peak clip indicator removed — clean meter style without dots

        // Track enable/disable button (shows track number, light green when on, gray when off)
        enableButton.title = "\(trackIndex + 1)"
        enableButton.font = NSFont.monospacedDigitSystemFont(ofSize: 9, weight: .bold)
        enableButton.isBordered = false
        enableButton.wantsLayer = true
        enableButton.layer?.cornerRadius = 3
        enableButton.target = self
        enableButton.action = #selector(enableToggled)
        enableButton.translatesAutoresizingMaskIntoConstraints = false
        addSubview(enableButton)

        // Bottom divider
        let divider = NSView()
        divider.wantsLayer = true
        divider.layer?.backgroundColor = DreamTheme.divider.cgColor
        divider.translatesAutoresizingMaskIntoConstraints = false
        addSubview(divider)

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
            vuMeterBarL.topAnchor.constraint(equalTo: topAnchor, constant: 6),
            vuMeterBarL.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -4),
            vuMeterBarL.widthAnchor.constraint(equalToConstant: 4),

            // VU meter right channel
            vuMeterBarR.trailingAnchor.constraint(equalTo: enableButton.leadingAnchor, constant: -4),
            vuMeterBarR.topAnchor.constraint(equalTo: topAnchor, constant: 6),
            vuMeterBarR.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -4),
            vuMeterBarR.widthAnchor.constraint(equalToConstant: 4),

            // Enable button (far right — shows track number)
            enableButton.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -4),
            enableButton.centerYAnchor.constraint(equalTo: centerYAnchor),
            enableButton.widthAnchor.constraint(equalToConstant: 22),
            enableButton.heightAnchor.constraint(equalToConstant: 18),

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
        
        // Mini-Mode: Hide secondary labels at small heights
        let isMini = bounds.height < 45
        routingLabel.isHidden = isMini
        trackTypeLabel.isHidden = isMini
        soloButton.isHidden = isMini
        
        // Adjust nameLabel position if mini
        if isMini {
            nameLabel.centerYAnchor.constraint(equalTo: centerYAnchor).isActive = true
        } else {
            // Default setup from setupUI handles non-mini case via constraints usually,
            // but since constraints are static, let's toggle them or just adjust constants if needed.
            // For simplicity in this layout, we'll let constraints handle it and just hide/show.
        }
    }

    private func updateFromTrack() {
        nameLabel.stringValue = track.name

        nameBackgroundView.layer?.backgroundColor = track.color.nsColor.cgColor
        // Force refresh selection visual
        updateSelectionState()
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

        enableButton.title = "\(trackIndex + 1)"
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

        // Fill from bottom up — vuMeterBarL/R are non-flipped NSViews,
        // so y=0 is the physical bottom of the bar.
        vuMeterFillL.frame = CGRect(
            x: 0,
            y: 0,
            width: vuMeterBarL.bounds.width,
            height: fillHeight
        )
        vuMeterFillR.frame = CGRect(
            x: 0,
            y: 0,
            width: vuMeterBarR.bounds.width,
            height: fillHeight
        )

        // ━━━ VU meter color depends on track type ━━━
        let meterColor: NSColor
        if track.trackType == .midi {
            // MIDI tracks: pure yellow signal
            if rmsDB > minDB + 3 {
                meterColor = NSColor(red: 1.0, green: 0.85, blue: 0.15, alpha: 1)  // Yellow
            } else {
                meterColor = NSColor(white: 0.3, alpha: 1)  // Gray: silence
            }
        } else {
            // Audio tracks & Master: green → yellow → red
            if rmsDB > 0 {
                meterColor = NSColor(red: 1.0, green: 0.2, blue: 0.2, alpha: 1)  // Red: clipping
            } else if rmsDB > -6 {
                meterColor = NSColor(red: 1.0, green: 0.8, blue: 0.1, alpha: 1)  // Yellow: hot
            } else if rmsDB > minDB + 3 {
                meterColor = DreamTheme.accentGreen  // Green: normal
            } else {
                meterColor = NSColor(white: 0.3, alpha: 1)  // Gray: near-silence
            }
        }
        vuMeterFillL.layer?.backgroundColor = meterColor.cgColor
        vuMeterFillR.layer?.backgroundColor = meterColor.cgColor
    }

    private func updateButtonStates() {
        // Solo button
        let soloColor = track.isSoloed ? DreamTheme.soloButton : DreamTheme.textMuted
        soloButton.contentTintColor = soloColor
        soloButton.layer?.backgroundColor = track.isSoloed
            ? DreamTheme.soloButton.withAlphaComponent(0.2).cgColor
            : NSColor.clear.cgColor
        soloButton.layer?.cornerRadius = 2

        // Enable button: light green when enabled, gray when disabled
        if track.isMuted {
            enableButton.contentTintColor = NSColor(white: 0.5, alpha: 1)
            enableButton.layer?.backgroundColor = NSColor(white: 0.25, alpha: 1).cgColor
            nameBackgroundView.alphaValue = 0.4
            nameLabel.alphaValue = 0.4
        } else {
            enableButton.contentTintColor = .white
            enableButton.layer?.backgroundColor = NSColor(red: 0.35, green: 0.75, blue: 0.35, alpha: 0.8).cgColor
            nameBackgroundView.alphaValue = 1.0
            nameLabel.alphaValue = 1.0
        }
    }
    
    private func updateSelectionState() {
        if isSelected {
            // Selected: brighter background, WHITE border (Ableton style)
            layer?.backgroundColor = DreamTheme.bgTrackHeader.blended(withFraction: 0.1, of: .white)?.cgColor
            layer?.borderWidth = 2.0
            layer?.borderColor = NSColor.white.cgColor
        } else {
            // Unselected: default background, no border
            layer?.backgroundColor = DreamTheme.bgTrackHeader.cgColor
            layer?.borderWidth = 0.0
        }
    }

    // MARK: - Context Menu
    
    public override func menu(for event: NSEvent) -> NSMenu? {
        let menu = NSMenu(title: "Track Options")
        
        let colorMenu = NSMenu(title: "Track Color")
        for color in TrackColor.allCases {
            let item = NSMenuItem(title: String(describing: color).capitalized, action: #selector(changeColor(_:)), keyEquivalent: "")
            item.target = self
            // Store color name in representedObject
            item.representedObject = color
            
            // Show checkmark if current color
            if track.color == color {
                item.state = NSControl.StateValue.on
            }
            
            // Add color swatch icon
            let swatch = NSImage(size: NSSize(width: 12, height: 12), flipped: false) { rect in
                color.nsColor.setFill()
                rect.fill()
                return true
            }
            item.image = swatch
            
            colorMenu.addItem(item)
        }
        
        let colorItem = NSMenuItem(title: "Color", action: nil, keyEquivalent: "")
        colorItem.submenu = colorMenu
        menu.addItem(colorItem)
        
        menu.addItem(NSMenuItem.separator())
        
        let deleteItem = NSMenuItem(title: "Delete Track", action: #selector(deleteTrack), keyEquivalent: "")
        deleteItem.target = self
        deleteItem.image = NSImage(systemSymbolName: "trash", accessibilityDescription: nil)
        menu.addItem(deleteItem)
        
        return menu
    }
    
    @objc private func changeColor(_ sender: NSMenuItem) {
        guard let color = sender.representedObject as? TrackColor else { return }
        
        // Update track color
        track.color = color
        
        // Update all clips on this track to match
        for i in 0..<track.clips.count {
            track.clips[i].colorOverride = nil // Reset overrides if any
        }
        for i in 0..<track.midiClips.count {
            track.midiClips[i].colorOverride = nil
        }
        
        // Notify changes
        onTrackChanged?(track)
        updateFromTrack()
        updateTrackingAreas()
    }
    
    // MARK: - Mouse Events (Resizing & Selection)
    
    private var isResizing = false
    private let resizeThreshold: CGFloat = 4.0

    public override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for area in trackingAreas { removeTrackingArea(area) }
        let options: NSTrackingArea.Options = [.activeInActiveApp, .mouseMoved, .cursorUpdate]
        addTrackingArea(NSTrackingArea(rect: bounds, options: options, owner: self, userInfo: nil))
    }

    public override func cursorUpdate(with event: NSEvent) {
        let location = convert(event.locationInWindow, from: nil)
        if location.y >= bounds.height - resizeThreshold {
            NSCursor.resizeUpDown.set()
        } else {
            NSCursor.arrow.set()
        }
    }

    public override func mouseMoved(with event: NSEvent) {
        let location = convert(event.locationInWindow, from: nil)
        if location.y >= bounds.height - resizeThreshold {
            NSCursor.resizeUpDown.set()
        } else {
            NSCursor.arrow.set()
        }
    }
    
    public override func mouseDown(with event: NSEvent) {
        let location = convert(event.locationInWindow, from: nil)
        
        // 1. Check for Resizing (Bottom edge in non-flipped view)
        if location.y <= resizeThreshold {
            isResizing = true
            return
        }
        
        // 2. Otherwise: Handle Selection and Reordering
        onHeaderClicked?()
        
        let pbItem = NSPasteboardItem()
        pbItem.setString(track.id.uuidString, forType: .trackID)
        let dragItem = NSDraggingItem(pasteboardWriter: pbItem)
        dragItem.draggingFrame = bounds
        beginDraggingSession(with: [dragItem], event: event, source: self)
    }

    public override func mouseDragged(with event: NSEvent) {
        if isResizing {
            let location = convert(event.locationInWindow, from: nil)
            // location.y is the new height directly since it's bottom-relative
            let newHeight = max(24, min(300, location.y))
            track.height = newHeight
            
            // Notify UI to refresh layout in-place
            if let container = superview as? TrackHeadersContainerView,
               let arrangement = container.nextResponder as? ArrangementViewController {
                arrangement.updateTrackLayout() 
            }
        }
    }

    public override func mouseUp(with event: NSEvent) {
        if isResizing {
            isResizing = false
            // Mark project dirty on resize end
            if let container = superview as? TrackHeadersContainerView,
               let arrangement = container.nextResponder as? ArrangementViewController {
                 arrangement.project.isDirty = true
            }
        }
    }

    // MARK: - Actions

    @objc private func soloToggled() {
        track.isSoloed.toggle()
        updateButtonStates()
        onTrackChanged?(track)
        onSoloChanged?()
    }

    @objc private func enableToggled() {
        track.isMuted.toggle()
        updateButtonStates()
        updateVolumeFill()
        onTrackChanged?(track)
    }
    
    @objc private func deleteTrack() {
        // Find container and trigger deletion
        if let container = superview as? TrackHeadersContainerView {
            container.onDeleteTrack?(track.id)
        }
    }

    // MARK: - Renaming

    public func startRenaming() {
        nameLabel.isEditable = true
        nameLabel.backgroundColor = NSColor.white.withAlphaComponent(0.1)
        nameLabel.drawsBackground = true
        window?.makeFirstResponder(nameLabel)
    }
}

extension TrackHeaderView: NSTextFieldDelegate {
    public func controlTextDidEndEditing(_ obj: Notification) {
        nameLabel.isEditable = false
        nameLabel.drawsBackground = false
        track.name = nameLabel.stringValue
        onTrackChanged?(track)
        
        // Mark project dirty
        if let container = superview as? TrackHeadersContainerView,
           let arrangement = container.nextResponder as? ArrangementViewController {
            arrangement.project.isDirty = true
            arrangement.updateWindowTitle()
        }
    }
}

// MARK: - NSDraggingSource

extension TrackHeaderView: NSDraggingSource {
    public func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation {
        return .move
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

    /// Callback when any track's solo state changes (needs to propagate to TrackMixer).
    public var onSoloChanged: (() -> Void)?

    /// Callback to add a new track. Bool: isAudio (true = audio, false = MIDI).
    public var onAddTrack: ((Bool) -> Void)?

    /// Callback to delete a track by its UUID.
    public var onDeleteTrack: ((UUID) -> Void)?

    /// Callback when a browser item (instrument/effect) is dropped on a track header.
    /// Parameters: (trackID, nodeType, itemName)
    public var onBrowserItemDropped: ((UUID, String, String) -> Void)?

    /// Callback when a specific header is clicked (for selection).
    public var onHeaderClicked: ((UUID) -> Void)?
    
    public override var isFlipped: Bool { true }

    // MARK: - Initialization

    public override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        setupContextMenu()
        // Register for drag-and-drop
        registerForDraggedTypes([.browserItem, .fileURL, .trackID])
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    // MARK: - Context Menu

    private func setupContextMenu() {
        let contextMenu = NSMenu(title: "Track Menu")

        let addMidiItem = NSMenuItem(title: "Add MIDI Track", action: #selector(contextAddMidiTrack), keyEquivalent: "")
        addMidiItem.target = self
        addMidiItem.image = NSImage(systemSymbolName: "pianokeys", accessibilityDescription: nil)
        contextMenu.addItem(addMidiItem)

        let addAudioItem = NSMenuItem(title: "Add Audio Track", action: #selector(contextAddAudioTrack), keyEquivalent: "")
        addAudioItem.target = self
        addAudioItem.image = NSImage(systemSymbolName: "waveform", accessibilityDescription: nil)
        contextMenu.addItem(addAudioItem)

        menu = contextMenu
    }

    @objc private func contextAddAudioTrack() {
        onAddTrack?(true)
    }

    @objc private func contextAddMidiTrack() {
        onAddTrack?(false)
    }

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
            header.onSoloChanged = { [weak self] in
                self?.onSoloChanged?()
            }
            header.onHeaderClicked = { [weak self] in
                self?.onHeaderClicked?(track.id)
            }
            addSubview(header)
            headerViews.append(header)

            yOffset += track.height
        }

        // Update frame (only regular tracks — master is pinned separately)
        frame.size.height = yOffset
    }
    
    /// Update existing header frames without recreation.
    public func updateLayoutInPlace() {
        var yOffset: CGFloat = 0
        for header in headerViews {
            header.frame = CGRect(x: 0, y: yOffset, width: DreamTheme.trackHeaderWidth, height: header.track.height)
            yOffset += header.track.height
        }
        frame.size.height = yOffset
    }

    /// Scroll to match the timeline vertical scroll position.
    public func setVerticalOffset(_ offset: CGFloat) {
        setBoundsOrigin(NSPoint(x: 0, y: offset))
    }

    // MARK: - Drag & Drop (Accept instruments/effects on track headers)

    public override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        let pb = sender.draggingPasteboard
        if pb.string(forType: .trackID) != nil {
            return .move
        }
        if pb.string(forType: .browserItem) != nil {
            return .copy
        }
        return []
    }

    public override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let pb = sender.draggingPasteboard
        
        // 1. Handle Track Reordering
        if let trackIDString = pb.string(forType: .trackID), let draggedID = UUID(uuidString: trackIDString) {
            let location = convert(sender.draggingLocation, from: nil)
            
            // Find target index
            var targetIndex = headerViews.count
            for (index, header) in headerViews.enumerated() {
                if location.y < header.frame.midY {
                    targetIndex = index
                    break
                }
            }
            
            // Perform move if valid
            if let sourceIndex = headerViews.firstIndex(where: { $0.trackID == draggedID }) {
                if sourceIndex != targetIndex && sourceIndex != targetIndex - 1 {
                    // Trigger reorder in parent
                    if let arrangement = nextResponder as? ArrangementViewController {
                        arrangement.moveTrack(from: sourceIndex, to: targetIndex)
                        return true
                    }
                }
            }
            return false
        }
        
        // 2. Handle Browser Items / Files
        guard let payload = pb.string(forType: .browserItem) else {
            return false
        }
        // ... rest of item drop logic ...

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

