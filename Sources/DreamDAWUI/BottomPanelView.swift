import AppKit
import Foundation
import DreamDAWModels

// MARK: - BottomPanelView

/// Resizable bottom panel that shows either the track detail view (effects chain)
/// or the Piano Roll editor for MIDI clips.
/// - Click track/clip → Detail tab
/// - Shift+click MIDI clip → Piano Roll tab
public final class BottomPanelView: NSView {

    // Use flipped coordinate system (y=0 at top) for correct layout
    public override var isFlipped: Bool { true }

    // MARK: - Mode

    public enum PanelMode {
        case hidden
        case detail(Track)
        case pianoRoll(Track, MidiClip)
    }

    // MARK: - Properties

    public var mode: PanelMode = .hidden {
        didSet { updateContent() }
    }

    /// Default collapsed height for the panel.
    public static let defaultHeight: CGFloat = 200.0

    /// Current panel height (0 when hidden).
    public var panelHeight: CGFloat {
        switch mode {
        case .hidden: return 0
        case .detail, .pianoRoll: return BottomPanelView.defaultHeight
        }
    }

    /// Callback when MIDI notes are modified in the piano roll.
    public var onNotesChanged: ((Track, MidiClip) -> Void)?

    /// Callback when an effect is dropped on the effects chain panel.
    /// Parameters: trackID, nodeType ("audioEffect"), itemName
    public var onEffectDropped: ((UUID, String, String) -> Void)?

    // Sub-views
    private let headerBar = NSView()
    private let titleLabel = NSTextField(labelWithString: "")
    private let closeButton = NSButton()
    private let pianoRollView = PianoRollView()
    private let detailContentView = NSView()
    private let pianoScrollView = NSScrollView()

    // MARK: - Initialization

    public override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        setupUI()
        registerForDraggedTypes([.browserItem])
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    // MARK: - Setup

    private func setupUI() {
        wantsLayer = true
        layer?.backgroundColor = DreamTheme.bgSecondary.cgColor

        // Header bar
        headerBar.wantsLayer = true
        headerBar.layer?.backgroundColor = DreamTheme.bgHeader.cgColor
        addSubview(headerBar)

        // Title label
        titleLabel.font = NSFont.systemFont(ofSize: 11, weight: .semibold)
        titleLabel.textColor = DreamTheme.textSecondary
        titleLabel.isBezeled = false
        titleLabel.isEditable = false
        titleLabel.backgroundColor = .clear
        addSubview(titleLabel)

        // Close button
        closeButton.title = "✕"
        closeButton.font = NSFont.systemFont(ofSize: 10, weight: .bold)
        closeButton.isBordered = false
        closeButton.target = self
        closeButton.action = #selector(closePanel)
        addSubview(closeButton)

        // Detail content (placeholder for effects chain)
        detailContentView.wantsLayer = true
        detailContentView.layer?.backgroundColor = DreamTheme.bgSecondary.cgColor
        addSubview(detailContentView)

        // Piano roll scroll view
        pianoScrollView.wantsLayer = true
        pianoScrollView.drawsBackground = false
        pianoScrollView.hasVerticalScroller = true
        pianoScrollView.hasHorizontalScroller = true
        pianoScrollView.documentView = pianoRollView
        pianoScrollView.scrollerStyle = .overlay
        addSubview(pianoScrollView)

        // Piano roll note change callback
        pianoRollView.onNotesChanged = { [weak self] clip in
            guard let self = self else { return }
            if case .pianoRoll(let track, _) = self.mode {
                self.onNotesChanged?(track, clip)
            }
        }
    }

    // MARK: - Layout

    public override func layout() {
        super.layout()

        let headerHeight: CGFloat = 24
        headerBar.frame = CGRect(x: 0, y: 0, width: bounds.width, height: headerHeight)
        titleLabel.frame = CGRect(x: 8, y: 4, width: bounds.width - 40, height: 16)
        closeButton.frame = CGRect(x: bounds.width - 24, y: 4, width: 16, height: 16)

        let contentFrame = CGRect(
            x: 0, y: headerHeight,
            width: bounds.width,
            height: max(0, bounds.height - headerHeight)
        )

        detailContentView.frame = contentFrame
        pianoScrollView.frame = contentFrame

        // Resize the piano roll document view
        pianoRollView.frame = NSRect(
            origin: .zero,
            size: pianoRollView.intrinsicContentSize
        )
    }

    // MARK: - Content Update

    private func updateContent() {
        switch mode {
        case .hidden:
            detailContentView.isHidden = true
            pianoScrollView.isHidden = true
            isHidden = true

        case .detail(let track):
            isHidden = false
            detailContentView.isHidden = false
            pianoScrollView.isHidden = true
            titleLabel.stringValue = track.trackType == .midi
                ? "\(track.name) — Instrument & Effects Chain"
                : "\(track.name) — Effects Chain"
            updateDetailContent(track: track)

        case .pianoRoll(let track, let clip):
            isHidden = false
            detailContentView.isHidden = true
            pianoScrollView.isHidden = false
            titleLabel.stringValue = "\(track.name) — Piano Roll: \(clip.name)"
            pianoRollView.midiClip = clip
            pianoRollView.track = track
            pianoRollView.frame = NSRect(origin: .zero, size: pianoRollView.intrinsicContentSize)
        }

        superview?.needsLayout = true
    }

    private func updateDetailContent(track: Track) {
        // Clear existing detail subviews
        detailContentView.subviews.forEach { $0.removeFromSuperview() }

        var xOff: CGFloat = 8
        let slotHeight: CGFloat = panelContentHeight - 16  // Fit within panel with padding
        let meterWidth: CGFloat = 10
        let meterSpacing: CGFloat = 4
        let slotSpacing: CGFloat = 6
        let yOff: CGFloat = 8

        // ───── Input Signal Meter ─────
        let inputMeter = SignalMeterView(frame: CGRect(x: xOff, y: yOff, width: meterWidth, height: slotHeight))
        inputMeter.level = 0.55  // Simulated input level
        inputMeter.peakLevel = 0.6
        detailContentView.addSubview(inputMeter)
        xOff += meterWidth + meterSpacing

        // Input label
        let inputLabel = NSTextField(labelWithString: "IN")
        inputLabel.font = NSFont.systemFont(ofSize: 7, weight: .bold)
        inputLabel.textColor = NSColor(white: 0.45, alpha: 1)
        inputLabel.alignment = .center
        inputLabel.frame = CGRect(x: xOff - meterWidth - meterSpacing, y: yOff + slotHeight + 1, width: meterWidth + meterSpacing * 2, height: 10)
        detailContentView.addSubview(inputLabel)

        xOff += 4

        // ───── Instrument Slot (MIDI tracks only) ─────
        if track.trackType == .midi {
            let slotWidth: CGFloat = 100
            let instSlot = makeInstrumentSlot(track: track, frame: CGRect(x: xOff, y: yOff, width: slotWidth, height: slotHeight))
            detailContentView.addSubview(instSlot)
            xOff += slotWidth + slotSpacing

            // Post-instrument meter
            let postInstMeter = SignalMeterView(frame: CGRect(x: xOff, y: yOff, width: meterWidth, height: slotHeight))
            postInstMeter.level = 0.50
            postInstMeter.peakLevel = 0.55
            detailContentView.addSubview(postInstMeter)
            xOff += meterWidth + slotSpacing
        }

        // ───── Effects Chain ─────
        if track.effects.isEmpty {
            // Empty chain placeholder
            let placeholder = NSTextField(labelWithString: "Drop effects here…")
            placeholder.font = NSFont.systemFont(ofSize: 11)
            placeholder.textColor = NSColor(white: 0.35, alpha: 1)
            placeholder.frame = CGRect(x: xOff + 8, y: yOff + slotHeight / 2 - 8, width: 160, height: 16)
            detailContentView.addSubview(placeholder)
        } else {
            for (index, effect) in track.effects.enumerated() {
                let slotWidth: CGFloat = effectSlotWidth(for: effect.effectType)
                let effectSlot = makeEffectSlot(effect: effect, index: index,
                                                 frame: CGRect(x: xOff, y: yOff, width: slotWidth, height: slotHeight))
                detailContentView.addSubview(effectSlot)
                xOff += slotWidth + slotSpacing

                // Post-effect signal meter
                let postMeter = SignalMeterView(frame: CGRect(x: xOff, y: yOff, width: meterWidth, height: slotHeight))
                // Simulate different levels per effect
                let level = 0.4 + Float(index) * 0.08
                postMeter.level = min(level, 0.9)
                postMeter.peakLevel = min(level + 0.05, 0.95)
                detailContentView.addSubview(postMeter)
                xOff += meterWidth + slotSpacing
            }
        }

        // ───── Output Meter + Label ─────
        xOff += 4
        let outputMeter = SignalMeterView(frame: CGRect(x: xOff, y: yOff, width: meterWidth, height: slotHeight))
        outputMeter.level = 0.5
        outputMeter.peakLevel = 0.55
        detailContentView.addSubview(outputMeter)

        let outLabel = NSTextField(labelWithString: "OUT")
        outLabel.font = NSFont.systemFont(ofSize: 7, weight: .bold)
        outLabel.textColor = NSColor(white: 0.45, alpha: 1)
        outLabel.alignment = .center
        outLabel.frame = CGRect(x: xOff - 4, y: yOff + slotHeight + 1, width: meterWidth + 8, height: 10)
        detailContentView.addSubview(outLabel)
    }

    /// Returns the slot width for a given effect type.
    private func effectSlotWidth(for type: AudioEffectType) -> CGFloat {
        switch type {
        case .utility: return 80   // Compact — just a knob
        case .eq:      return 140  // Wider for EQ curve
        default:       return 100  // Default for other effects
        }
    }

    // MARK: - Effect Slot Builder

    /// Creates an Ableton-style effect slot view.
    private func makeEffectSlot(effect: AudioEffectConfig, index: Int, frame: CGRect) -> NSView {
        let slot = NSView(frame: frame)
        slot.wantsLayer = true
        slot.layer?.cornerRadius = 4
        slot.layer?.backgroundColor = NSColor(white: 0.13, alpha: 1).cgColor
        slot.layer?.borderWidth = 1
        slot.layer?.borderColor = NSColor(white: 0.22, alpha: 1).cgColor

        // ── Colored header bar (effect type color) ──
        let headerH: CGFloat = 18
        let headerBar = NSView(frame: CGRect(x: 0, y: 0, width: frame.width, height: headerH))
        headerBar.wantsLayer = true
        headerBar.layer?.cornerRadius = 4
        headerBar.layer?.maskedCorners = [.layerMinXMinYCorner, .layerMaxXMinYCorner]
        headerBar.layer?.backgroundColor = effectHeaderColor(for: effect.effectType).cgColor
        slot.addSubview(headerBar)

        // Effect name in header
        let nameLabel = NSTextField(labelWithString: effect.effectType.displayName)
        nameLabel.font = NSFont.systemFont(ofSize: 9, weight: .semibold)
        nameLabel.textColor = .white
        nameLabel.lineBreakMode = .byTruncatingTail
        nameLabel.frame = CGRect(x: 4, y: 1, width: frame.width - 20, height: 16)
        headerBar.addSubview(nameLabel)

        // Power indicator (enabled/disabled)
        let powerDot = NSView(frame: CGRect(x: frame.width - 12, y: 5, width: 6, height: 6))
        powerDot.wantsLayer = true
        powerDot.layer?.cornerRadius = 3
        powerDot.layer?.backgroundColor = effect.isEnabled
            ? NSColor(red: 0.3, green: 0.9, blue: 0.4, alpha: 1).cgColor
            : NSColor(white: 0.4, alpha: 1).cgColor
        headerBar.addSubview(powerDot)

        // ── Plugin-specific content ──
        let contentY = headerH + 2
        let contentH = frame.height - headerH - 4

        switch effect.effectType {
        case .utility:
            // Gain knob centered
            let knobSize: CGFloat = min(contentH - 8, 50)
            let knob = KnobView(frame: CGRect(
                x: (frame.width - knobSize) / 2,
                y: contentY + (contentH - knobSize - 14) / 2,
                width: knobSize,
                height: knobSize + 14
            ))
            knob.value = effect.gainDB
            knob.minValue = -60.0
            knob.maxValue = 6.0
            knob.defaultValue = 0.0
            knob.valueSuffix = " dB"
            knob.arcColor = NSColor(red: 0.95, green: 0.75, blue: 0.25, alpha: 1.0)
            knob.onValueChanged = { [weak effect] newValue in
                effect?.gainDB = newValue
            }
            slot.addSubview(knob)

            // "Gain" label
            let gainLabel = NSTextField(labelWithString: "Gain")
            gainLabel.font = NSFont.systemFont(ofSize: 8, weight: .medium)
            gainLabel.textColor = NSColor(white: 0.5, alpha: 1)
            gainLabel.alignment = .center
            gainLabel.frame = CGRect(x: 0, y: contentY + 2, width: frame.width, height: 10)
            slot.addSubview(gainLabel)

        case .eq:
            // Mini EQ curve visualization
            let curveView = MiniEQCurveView(frame: CGRect(x: 4, y: contentY + 4, width: frame.width - 8, height: contentH - 8))
            curveView.bands = effect.eqBands
            slot.addSubview(curveView)

        default:
            // Generic effect — show type icon and "No Controls" placeholder
            let iconSize: CGFloat = 24
            if let symbolImage = NSImage(systemSymbolName: effect.effectType.icon, accessibilityDescription: nil) {
                let config = NSImage.SymbolConfiguration(pointSize: 14, weight: .medium)
                let iconView = NSImageView(frame: CGRect(
                    x: (frame.width - iconSize) / 2,
                    y: contentY + (contentH - iconSize) / 2 - 6,
                    width: iconSize,
                    height: iconSize
                ))
                iconView.image = symbolImage.withSymbolConfiguration(config)
                iconView.contentTintColor = NSColor(white: 0.5, alpha: 1)
                slot.addSubview(iconView)
            }

            let typeLabel = NSTextField(labelWithString: effect.effectType.displayName)
            typeLabel.font = NSFont.systemFont(ofSize: 8, weight: .regular)
            typeLabel.textColor = NSColor(white: 0.4, alpha: 1)
            typeLabel.alignment = .center
            typeLabel.frame = CGRect(x: 0, y: contentY + contentH - 14, width: frame.width, height: 12)
            slot.addSubview(typeLabel)
        }

        return slot
    }

    /// Creates the instrument slot for MIDI tracks.
    private func makeInstrumentSlot(track: Track, frame: CGRect) -> NSView {
        let slot = NSView(frame: frame)
        slot.wantsLayer = true
        slot.layer?.cornerRadius = 4

        let headerH: CGFloat = 18

        if let instrument = track.instrument {
            // Instrument assigned — warm amber background
            slot.layer?.backgroundColor = NSColor(red: 0.14, green: 0.12, blue: 0.10, alpha: 1).cgColor
            slot.layer?.borderWidth = 1
            slot.layer?.borderColor = NSColor(red: 0.85, green: 0.55, blue: 0.1, alpha: 0.5).cgColor

            // Colored header
            let header = NSView(frame: CGRect(x: 0, y: 0, width: frame.width, height: headerH))
            header.wantsLayer = true
            header.layer?.cornerRadius = 4
            header.layer?.maskedCorners = [.layerMinXMinYCorner, .layerMaxXMinYCorner]
            header.layer?.backgroundColor = NSColor(red: 0.85, green: 0.55, blue: 0.1, alpha: 0.85).cgColor
            slot.addSubview(header)

            let nameLabel = NSTextField(labelWithString: instrument.instrumentType.displayName)
            nameLabel.font = NSFont.systemFont(ofSize: 9, weight: .semibold)
            nameLabel.textColor = .white
            nameLabel.lineBreakMode = .byTruncatingTail
            nameLabel.frame = CGRect(x: 4, y: 1, width: frame.width - 8, height: 16)
            header.addSubview(nameLabel)

            // Instrument icon
            let iconSize: CGFloat = 20
            if let symbolImage = NSImage(systemSymbolName: instrument.instrumentType.icon, accessibilityDescription: nil) {
                let config = NSImage.SymbolConfiguration(pointSize: 12, weight: .medium)
                let iconView = NSImageView(frame: CGRect(
                    x: (frame.width - iconSize) / 2,
                    y: headerH + (frame.height - headerH - iconSize) / 2,
                    width: iconSize,
                    height: iconSize
                ))
                iconView.image = symbolImage.withSymbolConfiguration(config)
                iconView.contentTintColor = NSColor(red: 0.95, green: 0.70, blue: 0.25, alpha: 1)
                slot.addSubview(iconView)
            }
        } else {
            // Empty instrument slot
            slot.layer?.backgroundColor = NSColor(white: 0.12, alpha: 1).cgColor
            slot.layer?.borderWidth = 1
            slot.layer?.borderColor = NSColor(white: 0.25, alpha: 0.5).cgColor

            let placeholder = NSTextField(labelWithString: "∅ Instrument")
            placeholder.font = NSFont.systemFont(ofSize: 9, weight: .medium)
            placeholder.textColor = NSColor(white: 0.35, alpha: 1)
            placeholder.alignment = .center
            placeholder.frame = CGRect(x: 0, y: (frame.height - 14) / 2, width: frame.width, height: 14)
            slot.addSubview(placeholder)
        }

        return slot
    }

    /// Returns the header color for an effect type.
    private func effectHeaderColor(for type: AudioEffectType) -> NSColor {
        switch type {
        case .eq:         return NSColor(red: 0.35, green: 0.55, blue: 0.85, alpha: 1.0)  // Blue
        case .utility:    return NSColor(red: 0.50, green: 0.50, blue: 0.50, alpha: 1.0)  // Gray
        case .compressor: return NSColor(red: 0.70, green: 0.40, blue: 0.25, alpha: 1.0)  // Warm brown
        case .delay:      return NSColor(red: 0.40, green: 0.65, blue: 0.45, alpha: 1.0)  // Green
        case .reverb:     return NSColor(red: 0.55, green: 0.40, blue: 0.75, alpha: 1.0)  // Purple
        case .chorus:     return NSColor(red: 0.65, green: 0.50, blue: 0.30, alpha: 1.0)  // Gold-brown
        }
    }

    /// Content height excluding header.
    private var panelContentHeight: CGFloat {
        max(64, panelHeight - 24 - 8)  // panel minus header minus padding
    }

    // MARK: - Public API

    /// Show the detail panel for a track.
    public func showDetail(for track: Track) {
        mode = .detail(track)
    }

    /// Show the piano roll for a specific MIDI clip.
    public func showPianoRoll(track: Track, clip: MidiClip) {
        mode = .pianoRoll(track, clip)
    }

    /// Hide the panel.
    public func hidePanel() {
        mode = .hidden
    }

    @objc private func closePanel() {
        hidePanel()
    }

    // MARK: - Drag and Drop (Effects)

    public override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        guard case .detail = mode else { return [] }

        if let data = sender.draggingPasteboard.data(forType: .browserItem),
           let payload = String(data: data, encoding: .utf8) {
            let parts = payload.split(separator: ":", maxSplits: 1)
            if parts.count == 2 {
                let nodeType = String(parts[0])
                if nodeType == "audioEffect" {
                    return .copy
                }
            }
        }
        return []
    }

    public override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        guard case .detail(let track) = mode,
              let data = sender.draggingPasteboard.data(forType: .browserItem),
              let payload = String(data: data, encoding: .utf8) else { return false }

        let parts = payload.split(separator: ":", maxSplits: 1)
        guard parts.count == 2 else { return false }

        let nodeType = String(parts[0])
        let itemName = String(parts[1])

        guard nodeType == "audioEffect" else { return false }

        onEffectDropped?(track.id, nodeType, itemName)
        return true
    }
}
