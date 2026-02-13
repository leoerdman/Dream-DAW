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
    private let volumeSlider = NSSlider(value: 0, minValue: Double(Track.minFaderDecibels), maxValue: Double(Track.maxFaderDecibels), target: nil, action: nil)
    private let volumeDbLabel = NSTextField(labelWithString: "0.0")
    private let soloButton = NSButton()
    private let collapseButton = NSButton()
    private let enableButton = NSButton()     // Track enable/disable (shows track number)
    private let vuMeterBarL = NSView()       // Left channel VU meter background
    private let vuMeterFillL = NSView()      // Left channel filled portion
    private let vuMeterBarR = NSView()       // Right channel VU meter background
    private let vuMeterFillR = NSView()      // Right channel filled portion
    private let peakIndicator = NSView()     // Peak clip indicator
    private let divider = NSView()           // Bottom divider
    
    // Group UI components
    private let groupIndicatorContainer = NSView()
    private var dividerLeadingConstraint: NSLayoutConstraint?
    private var nameLeadingConstraint: NSLayoutConstraint?
    private var nameBackgroundLeadingConstraint: NSLayoutConstraint?
    private var nameBackgroundWidthConstraint: NSLayoutConstraint?
    private var maxDepth: Int = 0
    private var trackDepth: Int = 0
    private let colorAreaBaseWidth: CGFloat = 120
    
    /// Grouping: Whether this track is the last visible member of its group (used for closing separator).
    public var isLastInGroup: Bool = false

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

        // Volume fader (dB) + value label
        volumeSlider.target = self
        volumeSlider.action = #selector(volumeFaderChanged)
        volumeSlider.isContinuous = true
        volumeSlider.controlSize = .mini
        volumeSlider.translatesAutoresizingMaskIntoConstraints = false
        addSubview(volumeSlider)

        volumeDbLabel.font = NSFont.monospacedDigitSystemFont(ofSize: 9, weight: .semibold)
        volumeDbLabel.textColor = DreamTheme.textSecondary
        volumeDbLabel.alignment = .right
        volumeDbLabel.translatesAutoresizingMaskIntoConstraints = false
        addSubview(volumeDbLabel)

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

        // Group Indicator Container (holds multiple bars for nesting)
        groupIndicatorContainer.wantsLayer = true
        groupIndicatorContainer.translatesAutoresizingMaskIntoConstraints = false
        addSubview(groupIndicatorContainer)

        // Bottom horizontal divider (Added AFTER indicators for z-order overlap)
        divider.wantsLayer = true
        divider.layer?.backgroundColor = DreamTheme.divider.cgColor
        divider.translatesAutoresizingMaskIntoConstraints = false
        addSubview(divider)

        // VU Meters setup
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
        NSLayoutConstraint.activate([
            groupIndicatorContainer.leadingAnchor.constraint(equalTo: leadingAnchor),
            groupIndicatorContainer.topAnchor.constraint(equalTo: topAnchor),
            groupIndicatorContainer.bottomAnchor.constraint(equalTo: bottomAnchor),
            
            nameBackgroundView.topAnchor.constraint(equalTo: topAnchor),
            nameBackgroundView.bottomAnchor.constraint(equalTo: bottomAnchor),

            nameLabel.trailingAnchor.constraint(equalTo: nameBackgroundView.trailingAnchor, constant: -2),
            nameLabel.centerYAnchor.constraint(equalTo: centerYAnchor),

            trackTypeLabel.leadingAnchor.constraint(equalTo: nameBackgroundView.trailingAnchor, constant: 4),
            trackTypeLabel.centerYAnchor.constraint(equalTo: centerYAnchor, constant: -6),

            routingLabel.leadingAnchor.constraint(equalTo: nameBackgroundView.trailingAnchor, constant: 4),
            routingLabel.centerYAnchor.constraint(equalTo: centerYAnchor, constant: 6),

            volumeDbLabel.trailingAnchor.constraint(equalTo: soloButton.leadingAnchor, constant: -4),
            volumeDbLabel.centerYAnchor.constraint(equalTo: centerYAnchor, constant: 7),
            volumeDbLabel.widthAnchor.constraint(equalToConstant: 32),

            volumeSlider.leadingAnchor.constraint(equalTo: nameBackgroundView.trailingAnchor, constant: 4),
            volumeSlider.trailingAnchor.constraint(equalTo: volumeDbLabel.leadingAnchor, constant: -3),
            volumeSlider.centerYAnchor.constraint(equalTo: centerYAnchor, constant: 7),
            volumeSlider.heightAnchor.constraint(equalToConstant: 12),

            soloButton.trailingAnchor.constraint(equalTo: vuMeterBarL.leadingAnchor, constant: -4),
            soloButton.topAnchor.constraint(equalTo: topAnchor, constant: 3),
            soloButton.widthAnchor.constraint(equalToConstant: 18),
            soloButton.heightAnchor.constraint(equalToConstant: 13),

            collapseButton.trailingAnchor.constraint(equalTo: nameBackgroundView.trailingAnchor, constant: -4),
            collapseButton.centerYAnchor.constraint(equalTo: centerYAnchor),
            collapseButton.widthAnchor.constraint(equalToConstant: 12),
            collapseButton.heightAnchor.constraint(equalToConstant: 12),

            enableButton.trailingAnchor.constraint(equalTo: vuMeterBarL.leadingAnchor, constant: -4),
            enableButton.topAnchor.constraint(equalTo: soloButton.bottomAnchor, constant: 2),
            enableButton.widthAnchor.constraint(equalToConstant: 18),
            enableButton.heightAnchor.constraint(equalToConstant: 13),

            vuMeterBarL.trailingAnchor.constraint(equalTo: vuMeterBarR.leadingAnchor, constant: -2),
            vuMeterBarL.topAnchor.constraint(equalTo: topAnchor, constant: 3),
            vuMeterBarL.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -4),
            vuMeterBarL.widthAnchor.constraint(equalToConstant: 4),

            vuMeterBarR.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -4),
            vuMeterBarR.topAnchor.constraint(equalTo: topAnchor, constant: 6),
            vuMeterBarR.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -4),
            vuMeterBarR.widthAnchor.constraint(equalToConstant: 4),

            divider.trailingAnchor.constraint(equalTo: trailingAnchor),
            divider.bottomAnchor.constraint(equalTo: bottomAnchor),
            divider.heightAnchor.constraint(equalToConstant: 1)
        ])

        // Keep group indicators inside the colored area.
        NSLayoutConstraint.activate([
            groupIndicatorContainer.trailingAnchor.constraint(equalTo: nameBackgroundView.trailingAnchor)
        ])
        
        // Save dynamic constraints
        nameBackgroundLeadingConstraint = nameBackgroundView.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 0)
        nameBackgroundLeadingConstraint?.isActive = true
        nameBackgroundWidthConstraint = nameBackgroundView.widthAnchor.constraint(equalToConstant: colorAreaBaseWidth)
        nameBackgroundWidthConstraint?.isActive = true

        nameLeadingConstraint = nameLabel.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 4)
        nameLeadingConstraint?.isActive = true
        
        dividerLeadingConstraint = divider.leadingAnchor.constraint(equalTo: leadingAnchor)
        dividerLeadingConstraint?.isActive = true
    }

    public override func layout() {
        super.layout()
        updateVolumeFill()
        
        // Mini-Mode: Hide secondary labels at small heights
        let isMini = bounds.height < 45
        routingLabel.isHidden = isMini
        trackTypeLabel.isHidden = isMini
        volumeSlider.isHidden = false
        volumeDbLabel.isHidden = false
        
        // Adjust nameLabel position if mini
        if isMini {
            // Mini layout adjustments
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
        volumeSlider.doubleValue = Double(track.volumeDecibels)
        updateVolumeDbLabel()
        updateButtonStates()
        updateVolumeFill()
        updateCollapseButtonState()
    }

    private func updateVolumeDbLabel() {
        let db = track.volumeDecibels
        if db <= Track.minFaderDecibels + 0.1 {
            volumeDbLabel.stringValue = "-inf"
        } else {
            volumeDbLabel.stringValue = String(format: "%.1f", db)
        }
    }

    public func configure(maxDepth: Int, depth: Int, isLastInGroup: Bool) {
        self.maxDepth = maxDepth
        self.trackDepth = depth
        self.isLastInGroup = isLastInGroup
        refreshDependentUI()
    }

    public func refreshDependentUI() {
        // Clear old indicators
        groupIndicatorContainer.subviews.forEach { $0.removeFromSuperview() }
        
        updateRoutingLabel()
        
        // 1. Calculate Indentation
        // ABLETON STYLE: 8px per depth level.
        // nameLeadingConstraint constant handles the label and controls offset.
        let indentStep: CGFloat = 8
        let indent: CGFloat = CGFloat(trackDepth) * indentStep
        nameBackgroundLeadingConstraint?.constant = indent
        nameBackgroundWidthConstraint?.constant = max(52, colorAreaBaseWidth - indent)
        nameLeadingConstraint?.constant = indent + 9 // Standard 9px padding after indent
        
        // 2. Build Indicators
        // We draw bars for ALL parent groups.
        if let resolver = trackResolver {
            var parents: [Track] = []
            var curr = track.parentTrackID
            var visited = Set<UUID>()
            while let pID = curr, let p = resolver(pID) {
                if visited.contains(pID) {
                    break
                }
                visited.insert(pID)
                parents.insert(p, at: 0)
                curr = p.parentTrackID
                if parents.count > 20 { break }
            }
            
            for (i, _) in parents.enumerated() {
                // Group spine line (Ableton-style hierarchy marker).
                let depthIndex = CGFloat(i + 1)
                let x = depthIndex * indentStep
                let isImmediateParent = (i == parents.count - 1)
                let lineHeight = (isImmediateParent && isLastInGroup) ? bounds.height * 0.5 : bounds.height
                
                let spine = NSView(frame: CGRect(x: x, y: 0, width: 1, height: lineHeight))
                spine.wantsLayer = true
                spine.layer?.backgroundColor = DreamTheme.divider.withAlphaComponent(0.95).cgColor
                groupIndicatorContainer.addSubview(spine)
                
                // Close branch for last child in a group.
                if isImmediateParent && isLastInGroup {
                    let cap = NSView(frame: CGRect(x: x, y: bounds.height * 0.5, width: 7, height: 1))
                    cap.wantsLayer = true
                    cap.layer?.backgroundColor = DreamTheme.divider.withAlphaComponent(0.95).cgColor
                    groupIndicatorContainer.addSubview(cap)
                }
            }
        }
        
        let isGroupHeader = track.trackType == .group
        
        // 3. Special Case: Group Header
        // If it's a group header, it also gets its OWN color bar at its specific depth.
        if isGroupHeader {
            let x = indent
            let spine = NSView(frame: CGRect(x: x, y: 0, width: 1, height: bounds.height))
            spine.wantsLayer = true
            spine.layer?.backgroundColor = DreamTheme.divider.withAlphaComponent(0.95).cgColor
            groupIndicatorContainer.addSubview(spine)
        }
        
        // 4. Update Dividers
        // Horizontal line starts at indent + 8 to perfectly overlap the vertical border and seal corner gaps.
        // UNLESS it's the last track (or group end), then it starts at 0px to cleanly close the strip.
        // Divider should remain consistent; for children it starts at indent, never disappears.
        dividerLeadingConstraint?.constant = indent
        divider.isHidden = false

        // 5. Update routing text
        updateRoutingLabel()
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
        let isMaster = track.trackType == .master

        if isMaster {
            // Master is always active and should not expose solo/enable controls.
            if track.isMuted { track.isMuted = false }
            if track.isSoloed { track.isSoloed = false }
            soloButton.isHidden = true
            enableButton.isHidden = true
        } else {
            soloButton.isHidden = false
            enableButton.isHidden = false
        }

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
    private var resizeStartWindowY: CGFloat = 0
    private var resizeStartHeight: CGFloat = 0
    private let resizeThreshold: CGFloat = 6.0

    private func isInResizeHandle(_ location: NSPoint) -> Bool {
        // Non-flipped TrackHeaderView: bottom edge is y ~= 0.
        location.y <= resizeThreshold
    }

    private func quantizedTrackHeight(_ rawHeight: CGFloat) -> CGFloat {
        let clamped = min(DreamTheme.maxTrackHeight, max(DreamTheme.minTrackHeight, rawHeight))
        let stepped = (clamped / DreamTheme.trackResizeStep).rounded() * DreamTheme.trackResizeStep
        return min(DreamTheme.maxTrackHeight, max(DreamTheme.minTrackHeight, stepped))
    }

    public override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for area in trackingAreas { removeTrackingArea(area) }
        let options: NSTrackingArea.Options = [.activeInActiveApp, .mouseMoved, .cursorUpdate]
        addTrackingArea(NSTrackingArea(rect: bounds, options: options, owner: self, userInfo: nil))
    }

    public override func cursorUpdate(with event: NSEvent) {
        let location = convert(event.locationInWindow, from: nil)
        if isInResizeHandle(location) {
            NSCursor.resizeUpDown.set()
        } else {
            NSCursor.arrow.set()
        }
    }

    public override func mouseMoved(with event: NSEvent) {
        let location = convert(event.locationInWindow, from: nil)
        if isInResizeHandle(location) {
            NSCursor.resizeUpDown.set()
        } else {
            NSCursor.arrow.set()
        }
    }
    
    public override func mouseDown(with event: NSEvent) {
        let location = convert(event.locationInWindow, from: nil)
        
        // 1. Check for Resizing (Bottom edge in non-flipped view)
        if isInResizeHandle(location) {
            isResizing = true
            resizeStartWindowY = event.locationInWindow.y
            resizeStartHeight = track.height
            NSCursor.resizeUpDown.set()
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
            // Dragging down should increase row height.
            let deltaY = resizeStartWindowY - event.locationInWindow.y
            let newHeight = quantizedTrackHeight(resizeStartHeight + deltaY)
            if abs(track.height - newHeight) >= 0.5 {
                track.height = newHeight
                onLayoutRequested?()
            }
        }
    }

    public override func mouseUp(with event: NSEvent) {
        if isResizing {
            isResizing = false
            NSCursor.arrow.set()
            onLayoutRequested?()
            // Mark project dirty on resize end
            onExpansionChanged?() // Reuse for dirtying or specific resize end
        }
    }

    // MARK: - Actions

    @objc private func soloToggled() {
        guard track.trackType != .master else { return }
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
        guard track.trackType != .master else { return }
        track.isMuted.toggle()
        updateButtonStates()
        updateVolumeFill()
        onTrackChanged?(track)
    }

    @objc private func volumeFaderChanged() {
        track.volumeDecibels = Float(volumeSlider.doubleValue)
        updateVolumeDbLabel()
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

    /// Update selection visual on all headers.
    public func updateSelection(selectedID: UUID?) {
        for header in headerViews {
            header.isSelected = (header.trackID == selectedID)
        }
    }

    public func configure(tracks: [Track], viewportHeight: CGFloat) {
        // DISABLE implicit animations (fly-in/out) during layout updates
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        defer { CATransaction.commit() }

        // ABLETON STYLE: Calculate max depth and indentation
        // We need a helper to resolve depths within this local list
        NSLog("[TrackHeaders] configure: creating trackMap...")
        let trackMap = Dictionary(uniqueKeysWithValues: tracks.map { ($0.id, $0) })
        NSLog("[TrackHeaders] configure: trackMap created.")
        func getDepth(for tID: UUID?) -> Int {
            var d = 0
            var curr = tID
            var visited = Set<UUID>()
            while let pID = curr, let p = trackMap[pID] {
                if visited.contains(pID) {
                    break
                }
                visited.insert(pID)
                d += 1
                curr = p.parentTrackID
                if d > 20 { 
                    NSLog("[TrackHeaders] ERROR: Depth exceeded 20, breaking.")
                    break 
                }
            }
            return d
        }
        
        NSLog("[TrackHeaders] configure: calculating maxD...")
        var maxD = 0
        for t in tracks {
            NSLog("[TrackHeaders] configure: getting depth for \(t.name)")
            let d = getDepth(for: t.parentTrackID)
            if d > maxD { maxD = d }
        }
        NSLog("[TrackHeaders] configure: maxD = \(maxD)")

        NSLog("[TrackHeaders] configure: checking currentIDs...")
        let currentIDs = headerViews.map { $0.trackID }
        let newIDs = tracks.map { $0.id }
        
        NSLog("[TrackHeaders] configure: currentIDs vs newIDs check...")
        if currentIDs == newIDs {
            // Reuse existing views! Just update layout/depth properties.
            var yOffset: CGFloat = 0
            for (index, header) in headerViews.enumerated() {
                let track = tracks[index]
                
                // Determine if this track is the last visible member of its group.
                var isLastInGroup = false
                if let currentParent = track.parentTrackID {
                    if index + 1 < tracks.count {
                        let nextTrack = tracks[index + 1]
                        if nextTrack.parentTrackID != currentParent {
                            isLastInGroup = true
                        }
                    } else {
                        isLastInGroup = true
                    }
                }
                
                // Update frame width based on depth
                let baseWidth = DreamTheme.trackHeaderWidth
                let dynamicWidth = baseWidth + CGFloat(maxD * 8)
                header.frame = CGRect(x: 0, y: yOffset, width: dynamicWidth, height: track.height)
                
                // Update depth configuration
                let trackDepth = getDepth(for: track.parentTrackID)
                header.configure(maxDepth: maxD, depth: trackDepth, isLastInGroup: isLastInGroup)
                
                yOffset += track.height
            }
            
            // PULL MASTER TO BOTTOM: If it's the last track and there's space, offset it.
            if let last = headerViews.last, last.track.trackType == .master {
                let currentBottom = last.frame.maxY
                if currentBottom < viewportHeight {
                    last.frame.origin.y = viewportHeight - last.frame.height
                }
            }
            
            frame.size.height = max(yOffset, viewportHeight)
            return
        }

        // existing logic: full rebuild
        headerViews.forEach { $0.removeFromSuperview() }
        headerViews.removeAll()
        
        var yOffset: CGFloat = 0
        for (index, track) in tracks.enumerated() {
            let header = TrackHeaderView(track: track, index: index)
            
            // Dynamic width based on depth (8px per level + base width)
            let baseWidth = DreamTheme.trackHeaderWidth
            let dynamicWidth = baseWidth + CGFloat(maxD * 8)
            header.frame = CGRect(x: 0, y: yOffset, width: dynamicWidth, height: track.height)
            
            // Determine if this track is the last visible member of its group.
            var isLastInGroup = false
            if let currentParent = track.parentTrackID {
                if index + 1 < tracks.count {
                    let nextTrack = tracks[index + 1]
                    if nextTrack.parentTrackID != currentParent {
                        isLastInGroup = true
                    }
                } else {
                    isLastInGroup = true
                }
            }
            
            // Inject resolvers and state
            header.trackResolver = trackResolver
            header.routingDestinationProvider = routingDestinationProvider
            header.isLastInGroup = isLastInGroup
            
            // Important: Add to superview BEFORE initial UI refresh
            addSubview(header)
            
            
            // selection state restored later in arrangement view controller lifecycle

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
            
            // Trigger refresh after setting all properties and adding to superview
            let trackDepth = getDepth(for: track.parentTrackID)
            header.configure(maxDepth: maxD, depth: trackDepth, isLastInGroup: isLastInGroup)
            
            headerViews.append(header)
            yOffset += track.height
        }

        // PULL MASTER TO BOTTOM: If it's the last track and there's space, offset it.
        if let last = headerViews.last, last.track.trackType == .master {
            if yOffset < viewportHeight {
                last.frame.origin.y = viewportHeight - last.frame.height
            }
        }

        // Update frame
        frame.size.height = max(yOffset, viewportHeight)
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
