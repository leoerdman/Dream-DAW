import AppKit
import Foundation
import DreamDAWModels
import DreamDAWEngine

// MARK: - BottomPanelView

/// Resizable bottom panel that shows either the track detail view (effects chain)
/// or the Piano Roll editor for MIDI clips.
/// - Click track/clip → Detail tab
/// - Shift+click MIDI clip → Piano Roll tab
public final class BottomPanelView: NSView {

    // Use flipped coordinate system (y=0 at top) for correct layout
    public override var isFlipped: Bool { true }

    // MARK: - Mode

    public enum PanelMode: Equatable {
        case hidden
        case detail(Track)
        case pianoRoll(Track, MidiClip)
        case audioClip(Track, AudioClip)
        
        public static func == (lhs: PanelMode, rhs: PanelMode) -> Bool {
            switch (lhs, rhs) {
            case (.hidden, .hidden): return true
            case (.detail(let t1), .detail(let t2)): return t1.id == t2.id
            case (.pianoRoll(let t1, let c1), .pianoRoll(let t2, let c2)): return t1.id == t2.id && c1.id == c2.id
            case (.audioClip(let t1, let c1), .audioClip(let t2, let c2)): return t1.id == t2.id && c1.id == c2.id
            default: return false
            }
        }
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
        case .detail, .pianoRoll, .audioClip: return BottomPanelView.defaultHeight
        }
    }

    /// Callback when MIDI notes are modified in the piano roll.
    public var onNotesChanged: ((Track, MidiClip) -> Void)?

    /// Callback when an effect is dropped on the effects chain panel.
    /// Parameters: trackID, nodeType ("audioEffect"), itemName
    public var onEffectDropped: ((UUID, String, String) -> Void)?

    /// Callback when an effect parameter is changed (e.g. Utility gain knob).
    /// Parameter: trackID
    /// Callback when an effect parameter is changed (e.g. Utility gain knob).
    /// Parameter: trackID
    public var onEffectParameterChanged: ((UUID) -> Void)?

    /// Callback when an instrument parameter is changed (e.g. Sampler ADSR).
    /// Parameter: trackID
    public var onInstrumentParameterChanged: ((UUID) -> Void)?

    /// Callback when a sample is changed in the Sampler instrument.
    /// Parameters: trackID, oldURL, newURL
    public var onSamplerSampleChanged: ((UUID, URL?, URL) -> Void)?

    /// Reference to the audio level meter for real-time signal chain metering.
    public weak var audioLevelMeter: AudioLevelMeter?

    // MARK: - Meter Animation

    /// Timer for updating signal chain meters at 30fps.
    private var meterTimer: Timer?

    /// Tagged signal meters in the current chain (for efficient timer updates).
    private var chainMeters: [SignalMeterView] = []

    /// Track ID of the currently displayed detail track.
    private var currentTrackID: UUID?

    // Sub-views
    private let blurView = NSVisualEffectView()
    private let headerBar = NSView()
    private let titleLabel = NSTextField(labelWithString: "")
    private let closeButton = NSButton()
    private let pianoRollView = PianoRollView()
    private let detailScrollView = NSScrollView()
    private let detailContentView = NSView()
    private let pianoScrollView = NSScrollView()
    private let gridSnapPopup = NSPopUpButton()

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
        layer?.backgroundColor = .clear // Transparent to let blur show through

        // Blur background (Liquid Glass)
        blurView.material = DreamTheme.glassMaterial
        blurView.blendingMode = DreamTheme.glassBlending
        blurView.state = .active
        blurView.wantsLayer = true
        blurView.layer?.cornerRadius = 0
        addSubview(blurView)

        // Header bar
        headerBar.wantsLayer = true
        headerBar.layer?.backgroundColor = DreamTheme.bgHeader.withAlphaComponent(0.6).cgColor
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

        // Detail content view (effects/instruments) with scroll support
        detailScrollView.wantsLayer = true
        detailScrollView.drawsBackground = false
        detailScrollView.hasHorizontalScroller = true
        detailScrollView.hasVerticalScroller = false
        detailScrollView.documentView = detailContentView
        addSubview(detailScrollView)

        detailContentView.wantsLayer = true
        detailContentView.layer?.backgroundColor = DreamTheme.bgSecondary.cgColor

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
        
        // Grid Snap Popup
        gridSnapPopup.bezelStyle = .recessed
        gridSnapPopup.font = NSFont.systemFont(ofSize: 10, weight: .medium)
        gridSnapPopup.addItems(withTitles: ["1/4 Grid", "1/8 Grid", "1/16 Grid", "1/32 Grid", "Adaptive"])
        gridSnapPopup.target = self
        gridSnapPopup.action = #selector(gridSnapChanged(_:))
        gridSnapPopup.isHidden = true
        addSubview(gridSnapPopup)
    }

    // MARK: - Layout

    public override func layout() {
        super.layout()

        blurView.frame = bounds
        let headerHeight: CGFloat = 24
        headerBar.frame = CGRect(x: 0, y: 0, width: bounds.width, height: headerHeight)
        titleLabel.frame = CGRect(x: 8, y: 4, width: bounds.width - 150, height: 16)
        closeButton.frame = CGRect(x: bounds.width - 24, y: 4, width: 16, height: 16)
        gridSnapPopup.frame = CGRect(x: bounds.width - 140, y: 3, width: 100, height: 18)

        let contentFrame = CGRect(
            x: 0, y: headerHeight,
            width: bounds.width,
            height: max(0, bounds.height - headerHeight)
        )

        detailScrollView.frame = contentFrame
        pianoScrollView.frame = contentFrame

        // Resize the piano roll document view
        pianoRollView.frame = NSRect(
            origin: .zero,
            size: pianoRollView.intrinsicContentSize
        )
    }

    // MARK: - Content Update

    private func updateContent() {
        let targetHeight = panelHeight
        let isHiding = (mode == .hidden)
        
        // Animate visibility and height
        NSAnimationContext.runAnimationGroup { context in
            context.duration = DreamTheme.standardAnimation
            context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            
            if isHiding {
                self.animator().alphaValue = 0
            } else {
                self.isHidden = false
                self.animator().alphaValue = 1
            }
            
            // Trigger layout on superview to animate the height change
            self.superview?.needsLayout = true
        } completionHandler: {
            if isHiding {
                self.isHidden = true
                self.stopMeterTimer()
            }
        }

        switch mode {
        case .hidden:
            detailContentView.isHidden = true
            pianoScrollView.isHidden = true

        case .detail(let track):
            detailContentView.isHidden = false
            detailScrollView.isHidden = false
            pianoScrollView.isHidden = true
            titleLabel.stringValue = track.trackType == .midi
                ? "\(track.name) — Instrument & Effects Chain"
                : "\(track.name) — Effects Chain"
            updateDetailContent(track: track)

        case .pianoRoll(let track, let clip):
            detailContentView.isHidden = true
            pianoScrollView.isHidden = false
            titleLabel.stringValue = "\(track.name) — Piano Roll: \(clip.name)"
            pianoRollView.midiClip = clip
            pianoRollView.track = track
            pianoRollView.frame = NSRect(origin: .zero, size: pianoRollView.intrinsicContentSize)

        case .audioClip(let track, let clip):
            detailContentView.isHidden = false
            pianoScrollView.isHidden = true
            titleLabel.stringValue = "\(track.name) — Sample Editor: \(clip.name)"
            updateAudioClipEditor(track: track, clip: clip)
        }
        
        gridSnapPopup.isHidden = true
        if case .pianoRoll = mode {
            gridSnapPopup.isHidden = false
        }
    }
    
    @objc private func gridSnapChanged(_ sender: NSPopUpButton) {
        let values: [Double] = [1.0, 0.5, 0.25, 0.125, 0.0625] // 1/4, 1/8, 1/16, 1/32, 1/64
        let idx = sender.indexOfSelectedItem
        guard idx >= 0 && idx < values.count else { return }
        
        // Update PianoRollView grid snap
        pianoRollView.gridSnap = values[idx]
        pianoRollView.needsDisplay = true
    }

    private func updateDetailContent(track: Track) {
        // Clear existing detail subviews and meter references
        detailContentView.subviews.forEach { $0.removeFromSuperview() }
        chainMeters.removeAll()
        currentTrackID = track.id

        var xOff: CGFloat = 8
        let slotHeight: CGFloat = panelContentHeight - 16
        let meterWidth: CGFloat = 10
        let meterSpacing: CGFloat = 4
        let slotSpacing: CGFloat = 6
        let yOff: CGFloat = 8

        let isMIDI = track.trackType == .midi
        let hasEffects = !track.effects.isEmpty

        // ═════════════════════════════════════════════════════
        //  Signal Chain Layout:
        //
        //  MIDI track:   IN(yellow) → [Synth] → (green)* → [FX1] → (green)* → ... → OUT(green)
        //  Audio track:  IN(green)  →             [FX1] → (green)* → ... → OUT(green)
        //
        //  * Inter-stage meters appear ONLY between adjacent processing stages.
        //    If there's nothing after the synth/effect, the OUTPUT meter serves
        //    as the final meter — no duplicate.
        // ═════════════════════════════════════════════════════

        // ───── Input Signal Meter ─────
        let inputMeter = SignalMeterView(frame: CGRect(x: xOff, y: yOff, width: meterWidth, height: slotHeight))
        inputMeter.signalType = isMIDI ? .midi : .audio
        detailContentView.addSubview(inputMeter)
        chainMeters.append(inputMeter)
        xOff += meterWidth + meterSpacing

        // Input label
        let inputLabel = NSTextField(labelWithString: "IN")
        inputLabel.font = NSFont.systemFont(ofSize: 7, weight: .bold)
        inputLabel.textColor = NSColor(white: 0.45, alpha: 1)
        inputLabel.alignment = .center
        inputLabel.frame = CGRect(
            x: xOff - meterWidth - meterSpacing,
            y: yOff + slotHeight + 1,
            width: meterWidth + meterSpacing * 2,
            height: 10
        )
        detailContentView.addSubview(inputLabel)

        xOff += 4

        // ───── Instrument Slot (MIDI tracks only) ─────
        if isMIDI {
            let slotWidth = instrumentSlotWidth(for: track.instrument?.instrumentType)
            let instSlot = makeInstrumentSlot(track: track, frame: CGRect(x: xOff, y: yOff, width: slotWidth, height: slotHeight))
            detailContentView.addSubview(instSlot)
            xOff += slotWidth + slotSpacing

            // Post-instrument meter appears ONLY if there are effects following.
            // Otherwise the OUTPUT meter serves as the post-instrument meter.
            if hasEffects {
                let postInstMeter = SignalMeterView(frame: CGRect(x: xOff, y: yOff, width: meterWidth, height: slotHeight))
                postInstMeter.signalType = .audio  // MIDI→audio conversion complete
                detailContentView.addSubview(postInstMeter)
                chainMeters.append(postInstMeter)
                xOff += meterWidth + slotSpacing
            }
        }

        // ───── Effects Chain ─────
        if hasEffects {
            for (index, effect) in track.effects.enumerated() {
                let slotWidth: CGFloat = effectSlotWidth(for: effect.effectType)
                let effectSlot = makeEffectSlot(
                    effect: effect, index: index, track: track,
                    frame: CGRect(x: xOff, y: yOff, width: slotWidth, height: slotHeight)
                )
                detailContentView.addSubview(effectSlot)
                xOff += slotWidth + slotSpacing

                // Inter-effect meter: only if there's ANOTHER effect after this one.
                // The last effect's output is shown by the OUTPUT meter.
                let isLastEffect = (index == track.effects.count - 1)
                if !isLastEffect {
                    let postMeter = SignalMeterView(frame: CGRect(x: xOff, y: yOff, width: meterWidth, height: slotHeight))
                    postMeter.signalType = .audio
                    detailContentView.addSubview(postMeter)
                    chainMeters.append(postMeter)
                    xOff += meterWidth + slotSpacing
                }
            }
        }

        // ───── Output Meter + Label ─────
        xOff += 4
        let outputMeter = SignalMeterView(frame: CGRect(x: xOff, y: yOff, width: meterWidth, height: slotHeight))
        outputMeter.signalType = .audio  // Output is always audio
        detailContentView.addSubview(outputMeter)
        chainMeters.append(outputMeter)

        let outLabel = NSTextField(labelWithString: "OUT")
        outLabel.font = NSFont.systemFont(ofSize: 7, weight: .bold)
        outLabel.textColor = NSColor(white: 0.45, alpha: 1)
        outLabel.alignment = .center
        outLabel.frame = CGRect(x: xOff - 4, y: yOff + slotHeight + 1, width: meterWidth + 8, height: 10)
        detailContentView.addSubview(outLabel)
        
        xOff += meterWidth + 20 // Padding
        
        // Finalize content size for scrolling
        detailContentView.frame = CGRect(x: 0, y: 0, width: xOff, height: detailScrollView.bounds.height)

        // Start meter animation timer
        startMeterTimer()
    }

    private func updateAudioClipEditor(track: Track, clip: AudioClip) {
        detailContentView.subviews.forEach { $0.removeFromSuperview() }
        
        let container = NSView(frame: detailContentView.bounds)
        container.autoresizingMask = [.width, .height]
        
        let infoLabel = NSTextField(labelWithString: "AUDIO CLIP: \(clip.name)\nLength: \(String(format: "%.3f", clip.duration.beats)) Beats")
        infoLabel.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .bold)
        infoLabel.textColor = DreamTheme.accent
        infoLabel.frame = CGRect(x: 20, y: 40, width: 400, height: 60)
        container.addSubview(infoLabel)
        
        let hintLabel = NSTextField(labelWithString: "Professional Sample Editor coming in next iteration...")
        hintLabel.font = NSFont.systemFont(ofSize: 10, weight: .medium)
        hintLabel.textColor = .lightGray
        hintLabel.frame = CGRect(x: 20, y: 20, width: 400, height: 20)
        container.addSubview(hintLabel)
        
        detailContentView.addSubview(container)
    }

    // MARK: - Meter Animation Timer

    /// Start the 30fps timer that reads real-time levels from AudioLevelMeter.
    private func startMeterTimer() {
        meterTimer?.invalidate()
        meterTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in
            self?.updateChainMeters()
        }
    }

    /// Stop the meter animation timer (when panel hides).
    /// Stop the meter animation timer (when panel hides).
    private func stopMeterTimer() {
        meterTimer?.invalidate()
        meterTimer = nil
    }

    /// Read real-time level from AudioLevelMeter and apply to all chain meters.
    private func updateChainMeters() {
        guard let trackID = currentTrackID,
              let meter = audioLevelMeter else {
            // No meter source — decay existing levels gracefully
            for m in chainMeters { m.decay() }
            return
        }

        let preLevel = meter.level(for: trackID, point: .preEffects)
        let postLevel = meter.level(for: trackID, point: .postEffects)

        for (index, chainMeter) in chainMeters.enumerated() {
            if index == 0 {
                // Input meter — show Pre-FX RMS
                chainMeter.level = preLevel.rms
            } else if index == chainMeters.count - 1 {
                // Output meter — show Post-FX RMS
                chainMeter.level = postLevel.rms
            } else {
                // For inter-stage meters (visual only), show Post-FX 
                chainMeter.level = postLevel.rms
            }
        }
    }
    private func instrumentSlotWidth(for type: InstrumentType?) -> CGFloat {
        guard let type = type else { return 100 }
        switch type {
        case .sampler: return 500 // Wide sampler view
        default:       return 100
        }
    }

    /// Returns the slot width for a given effect type.
    private func effectSlotWidth(for type: AudioEffectType) -> CGFloat {
        switch type {
        case .utility:    return 80   // Compact — just a knob
        case .eq:         return 140  // Wider for EQ curve
        case .compressor: return 160  // Multiple knobs for dynamics
        case .delay:      return 160  // Time, feedback, mix
        case .reverb:     return 120  // Preset and mix
        default:          return 100  // Default for other effects
        }
    }

    // MARK: - Effect Slot Builder

    /// Creates an Ableton-style effect slot view.
    private func makeEffectSlot(effect: AudioEffectConfig, index: Int, track: Track, frame: CGRect) -> NSView {
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
            knob.onValueChanged = { [weak effect, weak self] newValue in
                effect?.gainDB = newValue
                // Notify the audio engine to re-apply track settings
                self?.onEffectParameterChanged?(track.id)
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

        case .compressor:
            // Threshold Knob
            let tKnob = makeKnob(
                x: 10, y: contentY + 10, size: 40, 
                value: effect.threshold, min: -40, max: 0, def: -20, suffix: " dB", label: "Thr",
                color: .orange
            ) { [weak effect, weak self] v in
                effect?.threshold = v
                self?.onEffectParameterChanged?(track.id)
            }
            slot.addSubview(tKnob)
            
            // Ratio Knob
            let rKnob = makeKnob(
                x: 60, y: contentY + 10, size: 40, 
                value: effect.ratio, min: 1, max: 20, def: 2, suffix: ":1", label: "Ratio",
                color: .orange
            ) { [weak effect, weak self] v in
                effect?.ratio = v
                self?.onEffectParameterChanged?(track.id)
            }
            slot.addSubview(rKnob)
            
            // Attack Knob
            let aKnob = makeKnob(
                x: 110, y: contentY + 10, size: 40, 
                value: effect.attack * 1000, min: 0.1, max: 100, def: 3, suffix: " ms", label: "Att",
                color: .orange
            ) { [weak effect, weak self] v in
                effect?.attack = v / 1000.0
                self?.onEffectParameterChanged?(track.id)
            }
            slot.addSubview(aKnob)

        case .delay:
            // Time Knob
            let dKnob = makeKnob(
                x: 10, y: contentY + 10, size: 40, 
                value: Float(effect.delayTime * 1000), min: 1, max: 1000, def: 250, suffix: " ms", label: "Time",
                color: .green
            ) { [weak effect, weak self] v in
                effect?.delayTime = Double(v) / 1000.0
                self?.onEffectParameterChanged?(track.id)
            }
            slot.addSubview(dKnob)
            
            // Feedback Knob
            let fKnob = makeKnob(
                x: 60, y: contentY + 10, size: 40, 
                value: effect.feedback, min: 0, max: 100, def: 30, suffix: "%", label: "Fbk",
                color: .green
            ) { [weak effect, weak self] v in
                effect?.feedback = v
                self?.onEffectParameterChanged?(track.id)
            }
            slot.addSubview(fKnob)
            
            // Mix Knob
            let mKnob = makeKnob(
                x: 110, y: contentY + 10, size: 40, 
                value: effect.wetDryMix, min: 0, max: 100, def: 20, suffix: "%", label: "Mix",
                color: .green
            ) { [weak effect, weak self] v in
                effect?.wetDryMix = v
                self?.onEffectParameterChanged?(track.id)
            }
            slot.addSubview(mKnob)

        case .reverb:
            // Preset Popup (simplified as a knob for index for now)
            let pKnob = makeKnob(
                x: 15, y: contentY + 10, size: 40, 
                value: Float(effect.reverbPreset), min: 0, max: 5, def: 0, suffix: " Pst", label: "Type",
                color: .purple
            ) { [weak effect, weak self] v in
                effect?.reverbPreset = Int(v)
                self?.onEffectParameterChanged?(track.id)
            }
            slot.addSubview(pKnob)
            
            // Mix Knob
            let rmKnob = makeKnob(
                x: 65, y: contentY + 10, size: 40, 
                value: effect.reverbMix, min: 0, max: 100, def: 30, suffix: "%", label: "Mix",
                color: .purple
            ) { [weak effect, weak self] v in
                effect?.reverbMix = v
                self?.onEffectParameterChanged?(track.id)
            }
            slot.addSubview(rmKnob)

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
            if instrument.instrumentType == .sampler {
                let samplerView = SamplerView(config: instrument, track: track)
                samplerView.frame = frame
                samplerView.onSampleURLChanged = { [weak self, weak instrument] newURL in
                    guard let self = self, let instrument = instrument else { return }
                    let oldURL = instrument.sampleURL
                    self.onSamplerSampleChanged?(track.id, oldURL, newURL) 
                }
                samplerView.onParameterChanged = { [weak self] in
                    guard let self = self else { return }
                    self.onInstrumentParameterChanged?(track.id)
                }
                return samplerView
            }

            // Default instrument slot for other types
            slot.layer?.backgroundColor = NSColor(red: 0.14, green: 0.12, blue: 0.10, alpha: 1).cgColor
            slot.layer?.borderWidth = 1
            slot.layer?.borderColor = NSColor(red: 0.85, green: 0.55, blue: 0.1, alpha: 0.5).cgColor

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
            // Enterprise "Add Instrument" Placeholder
            slot.layer?.backgroundColor = NSColor(white: 0.1, alpha: 0.4).cgColor
            
            // Dashed border (layer-backed for performance)
            let dashLayer = CAShapeLayer()
            dashLayer.strokeColor = NSColor(white: 0.3, alpha: 0.6).cgColor
            dashLayer.fillColor = nil
            dashLayer.lineDashPattern = [4, 4]
            dashLayer.path = NSBezierPath(roundedRect: slot.bounds.insetBy(dx: 4, dy: 4), xRadius: 4, yRadius: 4).cgPath
            slot.layer?.addSublayer(dashLayer)

            let stack = NSStackView(frame: slot.bounds)
            stack.orientation = .vertical
            stack.spacing = 8
            stack.alignment = .centerX
            stack.distribution = .gravityAreas
            
            let iconView = NSImageView(frame: CGRect(x: 0, y: 0, width: 24, height: 24))
            iconView.image = NSImage(systemSymbolName: "plus.circle.fill", accessibilityDescription: nil)
            iconView.contentTintColor = NSColor.systemOrange.withAlphaComponent(0.6)
            
            let label = NSTextField(labelWithString: "Add Instrument")
            label.font = NSFont.systemFont(ofSize: 10, weight: .bold)
            label.textColor = NSColor(white: 0.5, alpha: 1)
            
            let hint = NSTextField(labelWithString: "Drop from Browser")
            hint.font = NSFont.systemFont(ofSize: 8, weight: .medium)
            hint.textColor = NSColor(white: 0.35, alpha: 1)
            
            stack.addArrangedSubview(iconView)
            stack.addArrangedSubview(label)
            stack.addArrangedSubview(hint)
            
            // Center the stack
            stack.translatesAutoresizingMaskIntoConstraints = false
            slot.addSubview(stack)
            NSLayoutConstraint.activate([
                stack.centerXAnchor.constraint(equalTo: slot.centerXAnchor),
                stack.centerYAnchor.constraint(equalTo: slot.centerYAnchor)
            ])
        }

        return slot
    }

    /// Helper to create a configured KnobView.
    private func makeKnob(
        x: CGFloat, y: CGFloat, size: CGFloat,
        value: Float, min: Float, max: Float, def: Float,
        suffix: String, label: String, color: NSColor,
        onChanged: @escaping (Float) -> Void
    ) -> KnobView {
        let knob = KnobView(frame: CGRect(x: x, y: y, width: size, height: size + 14))
        knob.value = value
        knob.minValue = min
        knob.maxValue = max
        knob.defaultValue = def
        knob.valueSuffix = suffix
        knob.arcColor = color
        knob.onValueChanged = onChanged
        
        let labelField = NSTextField(labelWithString: label)
        labelField.font = NSFont.systemFont(ofSize: 8, weight: .medium)
        labelField.textColor = NSColor(white: 0.5, alpha: 1)
        labelField.alignment = .center
        labelField.frame = CGRect(x: x, y: y - 10, width: size, height: 10)
        // Note: Slot builder will handle adding labels if needed, 
        // but adding it here is convenient if we adjust y.
        return knob
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
                if nodeType == "audioEffect" || nodeType == "instrument" {
                    NSCursor.dragCopy.set() // Force plus cursor
                    return .copy
                }
            }
        }
        return []
    }

    public override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        return draggingEntered(sender)
    }

    public override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        guard case .detail(let track) = mode,
              let data = sender.draggingPasteboard.data(forType: .browserItem),
              let payload = String(data: data, encoding: .utf8) else { return false }

        let parts = payload.split(separator: ":", maxSplits: 1)
        guard parts.count == 2 else { return false }

        let nodeType = String(parts[0])
        let itemName = String(parts[1])

        if nodeType == "audioEffect" {
            onEffectDropped?(track.id, nodeType, itemName)
            return true
        } else if nodeType == "instrument" && track.trackType == .midi {
            // Re-use logic for instruments dropped on header
            if let container = superview?.superview?.superview as? TrackHeadersContainerView {
                container.onBrowserItemDropped?(track.id, nodeType, itemName)
                return true
            }
        }

        return false
    }
}
