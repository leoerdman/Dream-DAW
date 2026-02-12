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
    private let collapseButton = NSButton()
    private let enableButton = NSButton()     // Track enable/disable (shows track number)
    private let vuMeterBarL = NSView()       // Left channel VU meter background
    private let vuMeterFillL = NSView()      // Left channel filled portion
    private let vuMeterBarR = NSView()       // Right channel VU meter background
    private let vuMeterFillR = NSView()      // Right channel filled portion
    private let peakIndicator = NSView()     // Peak clip indicator
    
    // Group UI components
    private let groupIndicatorBG = NSView()   // Indentation background
    private let groupIndicatorLine = NSView() // Thin vertical line (solid color block)
    private let groupDividerLine = NSView()   // Thin divider between indicator and track content

    /// Callback when track settings change.
    public var onTrackChanged: ((Track) -> Void)?

    /// Callback specifically for solo changes (needs to propagate to TrackMixer for solo logic).
    public var onSoloChanged: (() -> Void)?
    
    /// Callback when header is clicked (for track selection). Bool: isShiftPressed
    public var onHeaderClicked: ((UUID, Bool) -> Void)?
    public var onExpansionChanged: (() -> Void)?
    public var onLayoutRequested: (() -> Void)?
    public var onGroupTracks: (() -> Void)?
    public var onUngroupTracks: (() -> Void)?
    
    /// Closure to resolve a track by UUID (for routing label display).
    public var trackResolver: ((UUID) -> Track?)?
    
    /// Closure to get all available tracks for routing (excluding self and children).
    public var routingDestinationProvider: (() -> [Track])?
    
    /// Callback when Output routing changes.
    public var onOutputChanged: ((UUID?) -> Void)?
    
    /// Callback when a browser item is dropped on this specific header.
    public var onBrowserItemDropped: ((UUID, String, String, URL?) -> Void)?

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
        
        // Make routing area clickable
        let routingClickView = NSView()
        routingClickView.translatesAutoresizingMaskIntoConstraints = false
        routingClickView.wantsLayer = true
        // routingClickView.layer?.backgroundColor = NSColor.red.withAlphaComponent(0.2).cgColor // Debug
        addSubview(routingClickView)
        
        NSLayoutConstraint.activate([
            routingClickView.leadingAnchor.constraint(equalTo: routingLabel.leadingAnchor, constant: -2),
            routingClickView.trailingAnchor.constraint(equalTo: routingLabel.trailingAnchor, constant: 2),
            routingClickView.topAnchor.constraint(equalTo: routingLabel.topAnchor, constant: -2),
            routingClickView.bottomAnchor.constraint(equalTo: routingLabel.bottomAnchor, constant: 2)
        ])
        
        let gesture = NSClickGestureRecognizer(target: self, action: #selector(routingClicked))
        routingClickView.addGestureRecognizer(gesture)

        // Solo button (S)
        soloButton.title = "S"
        soloButton.font = NSFont.systemFont(ofSize: 8, weight: .bold)
        soloButton.isBordered = false
        soloButton.wantsLayer = true
        soloButton.target = self
        soloButton.action = #selector(soloToggled)
        soloButton.translatesAutoresizingMaskIntoConstraints = false
        addSubview(soloButton)

        // Collapse button (for group tracks)
        collapseButton.bezelStyle = .disclosure
        collapseButton.setButtonType(.pushOnPushOff)
        collapseButton.imagePosition = .imageOnly
        collapseButton.target = self
        collapseButton.action = #selector(toggleCollapse)
        collapseButton.translatesAutoresizingMaskIntoConstraints = false
        addSubview(collapseButton)

        // Group Indicator UI
        groupIndicatorBG.wantsLayer = true
        groupIndicatorBG.translatesAutoresizingMaskIntoConstraints = false
        addSubview(groupIndicatorBG)
        
        groupIndicatorLine.wantsLayer = true
        groupIndicatorLine.translatesAutoresizingMaskIntoConstraints = false
        addSubview(groupIndicatorLine)
        
        groupDividerLine.wantsLayer = true
        groupDividerLine.layer?.backgroundColor = DreamTheme.bgPrimary.cgColor // Dark divider color
        groupDividerLine.translatesAutoresizingMaskIntoConstraints = false
        addSubview(groupDividerLine)

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
            // Group Indicators
            groupIndicatorBG.leadingAnchor.constraint(equalTo: leadingAnchor),
            groupIndicatorBG.topAnchor.constraint(equalTo: topAnchor),
            groupIndicatorBG.bottomAnchor.constraint(equalTo: bottomAnchor),
            groupIndicatorBG.widthAnchor.constraint(equalToConstant: 10),
            
            groupIndicatorLine.leadingAnchor.constraint(equalTo: groupIndicatorBG.leadingAnchor),
            groupIndicatorLine.topAnchor.constraint(equalTo: topAnchor),
            groupIndicatorLine.bottomAnchor.constraint(equalTo: bottomAnchor),
            groupIndicatorLine.widthAnchor.constraint(equalToConstant: 10),

            // Indentation Divider
            groupDividerLine.leadingAnchor.constraint(equalTo: groupIndicatorBG.trailingAnchor),
            groupDividerLine.topAnchor.constraint(equalTo: topAnchor),
            groupDividerLine.bottomAnchor.constraint(equalTo: bottomAnchor),
            groupDividerLine.widthAnchor.constraint(equalToConstant: 1),

            // Name background (colored strip) — left portion
            nameBackgroundView.leadingAnchor.constraint(equalTo: track.parentTrackID != nil ? groupDividerLine.trailingAnchor : leadingAnchor),
            nameBackgroundView.topAnchor.constraint(equalTo: topAnchor),
            nameBackgroundView.bottomAnchor.constraint(equalTo: bottomAnchor),
            nameBackgroundView.widthAnchor.constraint(equalToConstant: 80),

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
            soloButton.trailingAnchor.constraint(equalTo: enableButton.leadingAnchor, constant: -2),
            soloButton.centerYAnchor.constraint(equalTo: centerYAnchor),
            soloButton.widthAnchor.constraint(equalToConstant: 20),
            soloButton.heightAnchor.constraint(equalToConstant: 18),

            // Collapse button (for group tracks)
            collapseButton.trailingAnchor.constraint(equalTo: nameBackgroundView.trailingAnchor, constant: -4),
            collapseButton.centerYAnchor.constraint(equalTo: nameLabel.centerYAnchor),
            collapseButton.widthAnchor.constraint(equalToConstant: 16),
            collapseButton.heightAnchor.constraint(equalToConstant: 16),

            // Enable button (On/Off — shows track number)
            enableButton.trailingAnchor.constraint(equalTo: vuMeterBarL.leadingAnchor, constant: -4),
            enableButton.centerYAnchor.constraint(equalTo: centerYAnchor),
            enableButton.widthAnchor.constraint(equalToConstant: 22),
            enableButton.heightAnchor.constraint(equalToConstant: 18),

            // VU meter left channel (vertical bar, near right edge)
            vuMeterBarL.trailingAnchor.constraint(equalTo: vuMeterBarR.leadingAnchor, constant: -2),
            vuMeterBarL.topAnchor.constraint(equalTo: topAnchor, constant: 6),
            vuMeterBarL.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -4),
            vuMeterBarL.widthAnchor.constraint(equalToConstant: 4),

            // VU meter right channel (outmost)
            vuMeterBarR.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -4),
            vuMeterBarR.topAnchor.constraint(equalTo: topAnchor, constant: 6),
            vuMeterBarR.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -4),
            vuMeterBarR.widthAnchor.constraint(equalToConstant: 4),

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

        // Display Routing Destination info in routing label
        // (Instead of instrument name, as requested by Enterprise requirement)
        updateRoutingLabel()

        enableButton.title = "\(trackIndex + 1)"
        updateButtonStates()
        updateVolumeFill()
        updateCollapseButtonState()
    }

    private func updateRoutingLabel() {
        guard let destID = track.outputDestinationID,
              let resolver = trackResolver,
              let destTrack = resolver(destID) else {
            // Default to Master
            routingLabel.stringValue = "Master ▾"
            routingLabel.textColor = DreamTheme.textSecondary
            return
        }
        routingLabel.stringValue = "\(destTrack.name) ▾"
        routingLabel.textColor = DreamTheme.accentSecondary
        
        // Update Group Indicators
        // User feedback: "Hide divider line and indicator for group tracks themselves"
        let isGroupHeader = track.trackType == .group
        
        if let parentID = track.parentTrackID, let resolver = trackResolver, let parent = resolver(parentID), !isGroupHeader {
            groupIndicatorBG.isHidden = false
            groupIndicatorLine.isHidden = false
            groupDividerLine.isHidden = false
            groupIndicatorBG.layer?.backgroundColor = parent.color.nsColor.withAlphaComponent(0.15).cgColor
            groupIndicatorLine.layer?.backgroundColor = parent.color.nsColor.cgColor
        } else {
            groupIndicatorBG.isHidden = true
            groupIndicatorLine.isHidden = true
            groupDividerLine.isHidden = true
        }
    }

    private func updateVolumeFill() {
        // Volume fill is now handled by real-time VU meter updates
        // This method only handles the muted visual state
        let isMuted = track.isMuted
        let isMidiNoInstrument = track.trackType == .midi && track.instrument == nil
        
        let fillColor: NSColor
        if isMuted {
            fillColor = NSColor(white: 0.2, alpha: 0.5)
        } else if isMidiNoInstrument {
            fillColor = DreamTheme.midiIndicator
        } else {
            fillColor = DreamTheme.accentGreen
        }
        
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

        // ━━━ VU meter color depends on signal type ━━━
        let meterColor: NSColor
        let hasInstrument = track.instrument != nil
        
        if track.trackType == .midi && !hasInstrument {
            // Raw MIDI Signal (Yellow)
            if rmsDB > minDB + 3 {
                meterColor = DreamTheme.midiIndicator
            } else {
                meterColor = NSColor(white: 0.3, alpha: 1)
            }
        } else {
            // Audio Signal (Green -> Yellow -> Red)
            if rmsDB > 0 {
                meterColor = NSColor(red: 1.0, green: 0.2, blue: 0.2, alpha: 1)  // Clipping
            } else if rmsDB > -6 {
                meterColor = NSColor(red: 1.0, green: 0.8, blue: 0.1, alpha: 1)  // Hot
            } else if rmsDB > minDB + 3 {
                meterColor = DreamTheme.accentGreen  // Normal
            } else {
                meterColor = NSColor(white: 0.3, alpha: 1)  // Near-silence
            }
        }
        vuMeterFillL.layer?.backgroundColor = meterColor.cgColor
        vuMeterFillR.layer?.backgroundColor = meterColor.cgColor
    }

    private func updateButtonStates() {
        // Standardized Button Style (Genius Grade)
        soloButton.wantsLayer = true
        soloButton.layer?.cornerRadius = 3
        soloButton.isBordered = false
        
        enableButton.wantsLayer = true
        enableButton.layer?.cornerRadius = 3
        enableButton.isBordered = false

        // Solo button: Blue when active, gray when inactive
        if track.isSoloed {
            soloButton.contentTintColor = .white
            soloButton.layer?.backgroundColor = DreamTheme.soloButton.cgColor
        } else {
            soloButton.contentTintColor = DreamTheme.textMuted
            soloButton.layer?.backgroundColor = NSColor(white: 0.25, alpha: 1).cgColor
        }

        // Enable (On/Off) button: Green when active, gray when inactive
        if track.isMuted {
            enableButton.contentTintColor = DreamTheme.textMuted
            enableButton.layer?.backgroundColor = NSColor(white: 0.25, alpha: 1).cgColor
            nameBackgroundView.alphaValue = 0.4
            nameLabel.alphaValue = 0.4
        } else {
            enableButton.contentTintColor = .white
            enableButton.layer?.backgroundColor = DreamTheme.accentGreen.withAlphaComponent(0.8).cgColor
            nameBackgroundView.alphaValue = 1.0
            nameLabel.alphaValue = 1.0
        }
    }

    private func updateCollapseButtonState() {
        collapseButton.state = track.isExpanded ? .on : .off
        collapseButton.isHidden = track.trackType != .group
        // Set image based on state
        if track.isExpanded {
            collapseButton.image = NSImage(systemSymbolName: "chevron.down", accessibilityDescription: "Collapse Group")
        } else {
            collapseButton.image = NSImage(systemSymbolName: "chevron.right", accessibilityDescription: "Expand Group")
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
        
        let groupItem = NSMenuItem(title: "Group Tracks", action: #selector(contextGroupTracks), keyEquivalent: "g")
        groupItem.keyEquivalentModifierMask = .command
        groupItem.target = self
        menu.addItem(groupItem)
        
        if track.trackType == .group {
            let ungroupItem = NSMenuItem(title: "Ungroup Pack", action: #selector(contextUngroupTrack), keyEquivalent: "g")
            ungroupItem.keyEquivalentModifierMask = [.command, .shift]
            ungroupItem.target = self
            menu.addItem(ungroupItem)
        }
        
        menu.addItem(NSMenuItem.separator())
        
        let renameItem = NSMenuItem(title: "Rename Track", action: #selector(renameTrack), keyEquivalent: "")
        renameItem.target = self
        renameItem.image = NSImage(systemSymbolName: "pencil", accessibilityDescription: nil)
        menu.addItem(renameItem)

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
        let isShift = event.modifierFlags.contains(.shift)
        onHeaderClicked?(track.id, isShift)
        
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
            onLayoutRequested?()
        }
    }

    public override func mouseUp(with event: NSEvent) {
        if isResizing {
            isResizing = false
            // Mark project dirty on resize end
                onExpansionChanged?() // Reuse for dirtying or specific resize end
        }
    }

    // MARK: - Actions

    @objc private func soloToggled() {
        track.isSoloed.toggle()
        updateButtonStates()
        onTrackChanged?(track)
        onSoloChanged?()
    }

    @objc private func routingClicked() {
        guard let provider = routingDestinationProvider else { return }
        let availableTracks = provider()
        
        let menu = NSMenu(title: "Output")
        
        // 1. Master item
        let masterItem = NSMenuItem(title: "Master", action: #selector(selectOutput(_:)), keyEquivalent: "")
        masterItem.target = self
        masterItem.representedObject = nil // Nil = Master
        if track.outputDestinationID == nil {
            masterItem.state = .on
        }
        menu.addItem(masterItem)
        menu.addItem(NSMenuItem.separator())
        
        // 2. All other tracks (excluding self and circular dependencies)
        for dest in availableTracks where dest.id != track.id && dest.trackType != .master {
            let item = NSMenuItem(title: dest.name, action: #selector(selectOutput(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = dest.id
            if track.outputDestinationID == dest.id {
                item.state = .on
            }
            menu.addItem(item)
        }
        
        // Show menu below the label
        let rect = routingLabel.bounds
        menu.popUp(positioning: nil, at: NSPoint(x: rect.minX, y: rect.maxY), in: routingLabel)
    }
    
    @objc private func selectOutput(_ sender: NSMenuItem) {
        let newDestID = sender.representedObject as? UUID
        track.outputDestinationID = newDestID
        onOutputChanged?(newDestID)
        updateRoutingLabel()
        onTrackChanged?(track)
    }

    @objc private func enableToggled() {
        track.isMuted.toggle()
        updateButtonStates()
        updateVolumeFill()
        onTrackChanged?(track)
    }

    @objc private func toggleCollapse() {
        track.isExpanded.toggle()
        updateCollapseButtonState()
        onTrackChanged?(track) // Notify that track properties changed
        onExpansionChanged?() // Notify specifically about expansion change
    }
    
    @objc private func renameTrack() {
        startRenaming()
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
    
    @objc private func contextGroupTracks() {
        onGroupTracks?()
    }
    
    @objc private func contextUngroupTrack() {
        onUngroupTracks?()
    }
}

extension TrackHeaderView: NSTextFieldDelegate {
    public func controlTextDidEndEditing(_ obj: Notification) {
        nameLabel.isEditable = false
        nameLabel.drawsBackground = false
        track.name = nameLabel.stringValue
        onTrackChanged?(track)
    }
}

// MARK: - NSDraggingDestination

extension TrackHeaderView {
    public override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        let pb = sender.draggingPasteboard
        if pb.string(forType: .browserItem) != nil {
            return .copy
        }
        return []
    }

    public override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let pb = sender.draggingPasteboard
        guard let payload = pb.string(forType: .browserItem) else {
            return false
        }

        let parts = payload.split(separator: ":", maxSplits: 1)
        guard parts.count == 2 else { return false }
        let nodeType = String(parts[0])
        let itemName = String(parts[1])

        onBrowserItemDropped?(track.id, nodeType, itemName, nil)
        return true
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

    /// Returns the IDs of all currently selected tracks.
    public var selectedTrackIDs: [UUID] {
        headerViews.filter { $0.isSelected }.map { $0.trackID }
    }

    /// Callback when a track's properties change (solo, mute, volume).
    public var onTrackChanged: ((Track) -> Void)?

    /// Callback when any track's solo state changes (needs to propagate to TrackMixer).
    public var onSoloChanged: (() -> Void)?

    /// Callback to add a new track. Bool: isAudio (true = audio, false = MIDI).
    public var onAddTrack: ((Bool) -> Void)?

    /// Callback for reorder drag updates (target index). Used for synchronization with the timeline.
    public var onReorderDragUpdate: ((Int?) -> Void)?

    /// Callback when reorder is completed. Parameters: (fromIndex, toIndex)
    public var onMoveTrack: ((Int, Int) -> Void)?

    /// Callback to delete a track by its UUID.
    public var onDeleteTrack: ((UUID) -> Void)?

    /// Callback when a browser item (instrument/effect) is dropped on a track header.
    /// Parameters: (trackID, nodeType, itemName, fileURL)
    public var onBrowserItemDropped: ((UUID, String, String, URL?) -> Void)?

    /// Callback when a specific header is clicked (for selection). Bool: isShiftPressed
    public var onHeaderClicked: ((UUID, Bool) -> Void)?

    public var onExpansionChanged: (() -> Void)?
    public var onLayoutRequested: (() -> Void)?
    public var onGroupTracks: (() -> Void)?
    public var onUngroupTracks: (() -> Void)?
    
    /// Callback when Output routing changes.
    public var onOutputChanged: ((UUID, UUID?) -> Void)?
    
    /// Injected closure for resolving tracks by UUID (passed to each header for routing display).
    public var trackResolver: ((UUID) -> Track?)?
    
    /// Injected closure to get all available tracks for routing.
    public var routingDestinationProvider: (() -> [Track])?
    
    public override var isFlipped: Bool { true }

    // Visual drop indicator (cyan line)
    private let dropIndicatorLayer = CALayer()
    private var currentInsertionIndex: Int?

    // MARK: - Initialization

    public override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        setupContextMenu()
        setupDropIndicator()
        // Register for drag-and-drop
        registerForDraggedTypes([.fileURL, .browserItem, .trackID])
    }

    private func setupDropIndicator() {
        dropIndicatorLayer.backgroundColor = NSColor.systemCyan.cgColor
        dropIndicatorLayer.isHidden = true
        dropIndicatorLayer.zPosition = 1000 // Always on top
        layer?.addSublayer(dropIndicatorLayer)

        // Pulsing animation
        let pulse = CABasicAnimation(keyPath: "opacity")
        pulse.fromValue = 0.4
        pulse.toValue = 1.0
        pulse.duration = 0.6
        pulse.autoreverses = true
        pulse.repeatCount = .infinity
        pulse.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        dropIndicatorLayer.add(pulse, forKey: "pulse")
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
            header.onHeaderClicked = { [weak self] trackID, isShift in
                self?.onHeaderClicked?(trackID, isShift)
            }
            header.onExpansionChanged = { [weak self] in
                self?.onExpansionChanged?()
            }
            header.onLayoutRequested = { [weak self] in
                self?.onLayoutRequested?()
            }
            header.onGroupTracks = { [weak self] in
                self?.onGroupTracks?()
            }
            header.onUngroupTracks = { [weak self] in
                self?.onUngroupTracks?()
            }
            header.onOutputChanged = { [weak self] newDestID in
                self?.onOutputChanged?(track.id, newDestID)
            }
            header.onBrowserItemDropped = { [weak self] trackID, nodeType, itemName, fileURL in
                self?.onBrowserItemDropped?(trackID, nodeType, itemName, fileURL)
            }
            header.trackResolver = trackResolver
            header.routingDestinationProvider = routingDestinationProvider
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
            dropIndicatorLayer.isHidden = false
            return .move
        }
        if pb.string(forType: .browserItem) != nil {
            return .copy
        }
        return []
    }

    public override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        let pb = sender.draggingPasteboard
        let location = convert(sender.draggingLocation, from: nil)
        
        if pb.string(forType: .trackID) != nil {
            // Calculate insertion index
            var targetIndex = headerViews.count
            var lineY: CGFloat = frame.height // Default to bottom
            
            var currentY: CGFloat = 0
            for (index, header) in headerViews.enumerated() {
                // If we are in the top half of a track, we insert before it
                if location.y < currentY + header.frame.height / 2 {
                    targetIndex = index
                    lineY = currentY
                    break
                }
                currentY += header.frame.height
                
                // If we are in the bottom half of the last track
                if index == headerViews.count - 1 {
                    lineY = currentY
                }
            }
            
            // Highlight the insertion point
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            dropIndicatorLayer.frame = CGRect(x: 0, y: lineY - 1, width: bounds.width, height: 2)
            dropIndicatorLayer.isHidden = false
            CATransaction.commit()
            
            if currentInsertionIndex != targetIndex {
                currentInsertionIndex = targetIndex
                onReorderDragUpdate?(targetIndex)
            }
            
            return .move
        }
        
        return .copy
    }

    public override func draggingExited(_ sender: NSDraggingInfo?) {
        dropIndicatorLayer.isHidden = true
        currentInsertionIndex = nil
        onReorderDragUpdate?(nil)
    }

    public override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let pb = sender.draggingPasteboard
        
        // Hide indicator immediately
        dropIndicatorLayer.isHidden = true
        let finalIndex = currentInsertionIndex
        currentInsertionIndex = nil
        onReorderDragUpdate?(nil)

        // 1. Handle Track Reordering
        if let trackIDString = pb.string(forType: .trackID), let draggedID = UUID(uuidString: trackIDString) {
            // Perform move if valid
            if let targetIndex = finalIndex,
               let sourceIndex = headerViews.firstIndex(where: { $0.trackID == draggedID }) {
                if sourceIndex != targetIndex && sourceIndex != targetIndex - 1 {
                    onMoveTrack?(sourceIndex, targetIndex)
                    return true
                }
            }
            return false
        }
        
        // 2. Handle Browser Items / Files
        guard let payload = pb.string(forType: .browserItem) else {
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
                onBrowserItemDropped?(headerView.trackID, nodeType, itemName, nil)
                return true
            }
        }

        // Fallback: use the first track if drop is in the container
        if let first = headerViews.first {
            onBrowserItemDropped?(first.trackID, nodeType, itemName, nil)
            return true
        }

        return false
    }
}

