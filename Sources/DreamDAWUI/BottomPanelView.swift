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
        didSet { 
            // Fix: Prevent redundant redraws/animations if mode hasn't changed
            guard oldValue != mode else { return }
            updateContent() 
        }
    }
    
    /// Explicitly refresh content (e.g. after adding an effect to the same track).
    public func refresh() {
        updateContent()
    }

    /// Default height for the panel.
    public static var defaultHeight: CGFloat = 200.0

    /// Current panel height (0 when hidden).
    public var panelHeight: CGFloat {
        switch mode {
        case .hidden: return 0
        case .detail, .pianoRoll, .audioClip: return BottomPanelView.defaultHeight
        }
    }

    /// Callback when MIDI notes are modified in the piano roll.
    public var onNotesChanged: ((Track, MidiClip) -> Void)?

    /// Callback when a browser item (instrument, effect, or sample) is dropped on the panel.
    public var onBrowserItemDropped: ((UUID, String, String, URL?) -> Void)?

    /// Callback when an effect parameter is changed (e.g. Utility gain knob).
    /// Parameter: trackID
    public var onEffectParameterChanged: ((UUID) -> Void)?
    /// Callback when an instrument parameter is changed (e.g. Sampler ADSR).
    /// Parameter: trackID
    public var onInstrumentParameterChanged: ((UUID) -> Void)?

    /// Callback when a sample is changed in the Sampler instrument.
    /// Parameters: trackID, oldURL, newURL
    public var onSamplerSampleChanged: ((UUID, URL?, URL) -> Void)?

    /// Callback when a plugin's settings button is clicked.
    public var onPluginSettingsClicked: ((UUID, AudioEffectConfig?, InstrumentConfig?) -> Void)?
    
    /// Callback when a plugin's eye (GUI) button is clicked.
    public var onPluginEyeClicked: ((UUID, AudioEffectConfig?, InstrumentConfig?) -> Void)?

    /// Reference to the audio level meter for real-time signal chain metering.
    public weak var audioLevelMeter: AudioLevelMeter?

    // MARK: - Meter Animation

    /// Timer for updating signal chain meters at 30fps.
    private var meterTimer: Timer?

    /// Tagged signal meters in the current chain (for efficient timer updates).
    private var chainMeters: [SignalMeterView] = []

    /// Track ID of the currently displayed detail track.
    private var currentTrackID: UUID?
    
    /// Type of the current track (for meter signal type selection).
    private var currentTrackType: TrackType = .audio

    // Sub-views
    private let blurView = NSVisualEffectView()
    private let headerBar = NSView()
    private let titleLabel = NSTextField(labelWithString: "")
    private let closeButton = NSButton()
    private let pianoRollView = PianoRollView()
    private let detailScrollView = NSScrollView()
    private let detailContentView = NSView()
    private let pianoEditorContainer = NSView()
    private let pianoInspectorScrollView = NSScrollView()
    private let pianoInspectorContentView = NSView()
    private let pianoScrollView = NSScrollView()
    private let gridSnapPopup = NSPopUpButton()
    private var pianoInspectorWidth: CGFloat = 220

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

        // Piano roll editor container (left inspector + right editor)
        pianoEditorContainer.wantsLayer = true
        pianoEditorContainer.layer?.backgroundColor = DreamTheme.bgSecondary.cgColor
        addSubview(pianoEditorContainer)

        pianoInspectorScrollView.wantsLayer = true
        pianoInspectorScrollView.drawsBackground = false
        pianoInspectorScrollView.hasVerticalScroller = true
        pianoInspectorScrollView.hasHorizontalScroller = false
        pianoInspectorScrollView.scrollerStyle = .overlay
        pianoInspectorScrollView.documentView = pianoInspectorContentView
        pianoEditorContainer.addSubview(pianoInspectorScrollView)

        pianoInspectorContentView.wantsLayer = true
        pianoInspectorContentView.layer?.backgroundColor = DreamTheme.bgHeader.withAlphaComponent(0.65).cgColor

        // Piano roll scroll view (right pane)
        pianoScrollView.wantsLayer = true
        pianoScrollView.drawsBackground = false
        pianoScrollView.hasVerticalScroller = true
        pianoScrollView.hasHorizontalScroller = true
        pianoScrollView.documentView = pianoRollView
        pianoScrollView.scrollerStyle = .overlay
        pianoEditorContainer.addSubview(pianoScrollView)

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
        pianoEditorContainer.frame = contentFrame

        let dynamicInspectorMax = max(180, min(320, contentFrame.width * 0.45))
        pianoInspectorWidth = min(dynamicInspectorMax, max(180, pianoInspectorWidth))
        pianoInspectorScrollView.frame = CGRect(
            x: 0,
            y: 0,
            width: pianoInspectorWidth,
            height: contentFrame.height
        )
        pianoScrollView.frame = CGRect(
            x: pianoInspectorWidth + 1,
            y: 0,
            width: max(0, contentFrame.width - pianoInspectorWidth - 1),
            height: contentFrame.height
        )

        updatePianoRollDocumentFrame()
        if case .pianoRoll(let track, let clip) = mode {
            updatePianoInspector(track: track, clip: clip)
        }
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
            detailScrollView.isHidden = true
            pianoEditorContainer.isHidden = true

        case .detail(let track):
            detailContentView.isHidden = false
            detailScrollView.isHidden = false
            pianoEditorContainer.isHidden = true
            titleLabel.stringValue = track.trackType == .midi
                ? "\(track.name) — Instrument & Effects Chain"
                : "\(track.name) — Effects Chain"
            currentTrackType = track.trackType
            updateDetailContent(track: track)

        case .pianoRoll(let track, let clip):
            detailContentView.isHidden = true
            detailScrollView.isHidden = true
            pianoEditorContainer.isHidden = false
            currentTrackType = track.trackType
            titleLabel.stringValue = "\(track.name) — Piano Roll: \(clip.name)"
            pianoRollView.midiClip = clip
            pianoRollView.track = track
            updatePianoInspector(track: track, clip: clip)
            updatePianoRollDocumentFrame()

        case .audioClip(let track, let clip):
            detailContentView.isHidden = false
            detailScrollView.isHidden = false
            pianoEditorContainer.isHidden = true
            currentTrackType = track.trackType
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
        if case .pianoRoll(let track, let clip) = mode {
            updatePianoInspector(track: track, clip: clip)
        }
    }

    @objc private func pianoZoomHorizontalIn() {
        pianoRollView.pixelsPerBeat = min(320, pianoRollView.pixelsPerBeat * 1.2)
        updatePianoRollDocumentFrame()
    }

    @objc private func pianoZoomHorizontalOut() {
        pianoRollView.pixelsPerBeat = max(16, pianoRollView.pixelsPerBeat / 1.2)
        updatePianoRollDocumentFrame()
    }

    @objc private func pianoZoomVerticalIn() {
        pianoRollView.pitchRowHeight = min(24, pianoRollView.pitchRowHeight * 1.15)
        updatePianoRollDocumentFrame()
    }

    @objc private func pianoZoomVerticalOut() {
        pianoRollView.pitchRowHeight = max(6, pianoRollView.pitchRowHeight / 1.15)
        updatePianoRollDocumentFrame()
    }

    private func updatePianoRollDocumentFrame() {
        let viewportWidth = max(0, pianoScrollView.contentView.bounds.width)
        pianoRollView.minimumContentWidth = viewportWidth
        let size = pianoRollView.intrinsicContentSize
        pianoRollView.frame = NSRect(origin: .zero, size: size)
    }

    private func updatePianoInspector(track: Track, clip: MidiClip) {
        pianoInspectorContentView.subviews.forEach { $0.removeFromSuperview() }

        let contentWidth = max(120, pianoInspectorScrollView.bounds.width - 16)
        let fieldHeight: CGFloat = 18
        let rowGap: CGFloat = 6
        var y: CGFloat = 10

        func makeLabel(_ text: String, font: NSFont, color: NSColor) -> NSTextField {
            let label = NSTextField(labelWithString: text)
            label.font = font
            label.textColor = color
            label.lineBreakMode = .byTruncatingTail
            return label
        }

        func addHeader(_ text: String) {
            let label = makeLabel(text, font: NSFont.systemFont(ofSize: 10, weight: .semibold), color: DreamTheme.textSecondary)
            label.frame = CGRect(x: 8, y: y, width: contentWidth, height: 14)
            pianoInspectorContentView.addSubview(label)
            y += 16
        }

        func addField(_ title: String, _ value: String) {
            let titleLabel = makeLabel(title, font: NSFont.systemFont(ofSize: 10, weight: .medium), color: DreamTheme.textMuted)
            titleLabel.frame = CGRect(x: 8, y: y, width: 70, height: fieldHeight)
            pianoInspectorContentView.addSubview(titleLabel)

            let valueLabel = makeLabel(value, font: NSFont.monospacedSystemFont(ofSize: 10, weight: .regular), color: DreamTheme.textPrimary)
            valueLabel.frame = CGRect(x: 82, y: y, width: max(40, contentWidth - 74), height: fieldHeight)
            pianoInspectorContentView.addSubview(valueLabel)
            y += fieldHeight + 2
        }

        func addZoomRow(title: String, minusAction: Selector, plusAction: Selector) {
            let titleLabel = makeLabel(title, font: NSFont.systemFont(ofSize: 10, weight: .medium), color: DreamTheme.textMuted)
            titleLabel.frame = CGRect(x: 8, y: y + 2, width: 78, height: 16)
            pianoInspectorContentView.addSubview(titleLabel)

            let minus = NSButton(title: "−", target: self, action: minusAction)
            minus.bezelStyle = .rounded
            minus.font = NSFont.systemFont(ofSize: 11, weight: .bold)
            minus.frame = CGRect(x: 90, y: y, width: 26, height: 20)
            pianoInspectorContentView.addSubview(minus)

            let plus = NSButton(title: "+", target: self, action: plusAction)
            plus.bezelStyle = .rounded
            plus.font = NSFont.systemFont(ofSize: 11, weight: .bold)
            plus.frame = CGRect(x: 122, y: y, width: 26, height: 20)
            pianoInspectorContentView.addSubview(plus)

            y += 24
        }

        addHeader("Clip")
        addField("Name", clip.name)
        addField("Track", track.name)
        addField("Start", formatBeatPosition(clip.position.beats))
        addField("Length", String(format: "%.2f beats", clip.duration.beats))
        addField("End", formatBeatPosition(clip.endPosition.beats))
        addField("Notes", "\(clip.notes.count)")

        y += rowGap
        addHeader("Editor")
        addField("Grid", gridSnapPopup.titleOfSelectedItem ?? "1/16 Grid")
        addField("Time Zoom", String(format: "%.1f px/beat", pianoRollView.pixelsPerBeat))
        addField("Pitch Zoom", String(format: "%.1f px", pianoRollView.pitchRowHeight))
        addZoomRow(title: "Time Zoom", minusAction: #selector(pianoZoomHorizontalOut), plusAction: #selector(pianoZoomHorizontalIn))
        addZoomRow(title: "Pitch Zoom", minusAction: #selector(pianoZoomVerticalOut), plusAction: #selector(pianoZoomVerticalIn))

        let minHeight = pianoInspectorScrollView.bounds.height
        let contentHeight = max(minHeight, y + 10)
        pianoInspectorContentView.frame = CGRect(x: 0, y: 0, width: pianoInspectorScrollView.bounds.width, height: contentHeight)
    }

    private func formatBeatPosition(_ beats: Double) -> String {
        let beatsPerBar = 4.0
        let bar = Int(floor(beats / beatsPerBar)) + 1
        let beatInBar = Int(floor(beats.truncatingRemainder(dividingBy: beatsPerBar))) + 1
        let sixteenth = Int(floor((beats - floor(beats)) * 4.0)) + 1
        return "\(bar).\(beatInBar).\(sixteenth)"
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
        let midiActivity = meter.midiLevel(for: trackID)
        let isMidiTrack = (currentTrackType == .midi)

        for (index, chainMeter) in chainMeters.enumerated() {
            if index == 0 {
                // Input meter 
                if isMidiTrack {
                    // Show MIDI activity for MIDI tracks
                    chainMeter.level = midiActivity
                } else {
                    // Show Pre-FX RMS for Audio tracks
                    chainMeter.level = preLevel.rms
                }
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
        guard let type = type else { return 180 }
        switch type {
        case .sampler: return 500 // Wide sampler view
        default:       return 180
        }
    }

    /// Returns the slot width for a given effect type.
    private func effectSlotWidth(for type: AudioEffectType) -> CGFloat {
        switch type {
        case .utility:    return 100  // Still compact but wider
        case .eq:         return 400  // Large Ableton-style EQ Eight UI
        case .compressor: return 180  // Multiple knobs for dynamics
        case .delay:      return 180  // Time, feedback, mix
        case .reverb:     return 180  // Preset and mix
        default:          return 180  // Default square width
        }
    }

    // MARK: - Effect Slot Builder

    private func makeEffectSlot(effect: AudioEffectConfig, index: Int, track: Track, frame: CGRect) -> NSView {
        let slot = PluginSlotView(title: effect.computedDisplayName, frame: frame)
        slot.isEnabled = effect.isEnabled
        slot.onToggle = { [weak effect, weak self] newState in
            effect?.isEnabled = newState
            self?.onEffectParameterChanged?(track.id)
        }
        
        slot.onSettingsClicked = { [weak self, weak effect] in 
            self?.onPluginSettingsClicked?(track.id, effect, nil)
        }
        
        slot.onEyeClicked = { [weak self, weak effect] in
            guard let eff = effect else { return }
            self?.onPluginEyeClicked?(eff.id, eff, nil)
        }

        // ── Plugin-specific content ──
        let contentH = frame.height - 18 - 4
        let contentWrap = NSView(frame: CGRect(x: 0, y: 0, width: frame.width, height: contentH))
            switch effect.effectType {
        case .utility:
            // Gain knob centered
            let knobSize: CGFloat = min(contentH - 8, 50)
            let knob = KnobView(frame: CGRect(
                x: (frame.width - knobSize) / 2,
                y: (contentH - knobSize - 14) / 2,
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
                self?.onEffectParameterChanged?(track.id)
            }
            contentWrap.addSubview(knob)

            // "Gain" label
            let gainLabel = NSTextField(labelWithString: "Gain")
            gainLabel.font = NSFont.systemFont(ofSize: 8, weight: .medium)
            gainLabel.textColor = NSColor(white: 0.5, alpha: 1)
            gainLabel.alignment = .center
            gainLabel.frame = CGRect(x: 0, y: 2, width: frame.width, height: 10)
            contentWrap.addSubview(gainLabel)

        case .eq:
            if let meter = audioLevelMeter {
                let eqView = EQEightView(config: effect, trackID: track.id, levelMeter: meter)
                eqView.frame = CGRect(x: 0, y: 0, width: frame.width, height: contentH)
                eqView.onConfigChanged = { [weak self] (_: AudioEffectConfig) in
                    self?.onEffectParameterChanged?(track.id)
                }
                contentWrap.addSubview(eqView)
            } else {
                // Fallback to mini curve if meter is not injected
                let curveView = MiniEQCurveView(frame: CGRect(x: 4, y: 4, width: frame.width - 8, height: contentH - 8))
                curveView.bands = effect.eqBands
                contentWrap.addSubview(curveView)
            }

        case .compressor:
            // Threshold Knob
            let tKnob = makeKnob(
                x: 10, y: 10, size: 40, 
                value: effect.threshold, min: -40, max: 0, def: -20, suffix: " dB", label: "Thr",
                color: .orange
            ) { [weak effect, weak self] v in
                effect?.threshold = v
                self?.onEffectParameterChanged?(track.id)
            }
            contentWrap.addSubview(tKnob)
            
            // Ratio Knob
            let rKnob = makeKnob(
                x: 60, y: 10, size: 40, 
                value: effect.ratio, min: 1, max: 20, def: 2, suffix: ":1", label: "Ratio",
                color: .orange
            ) { [weak effect, weak self] v in
                effect?.ratio = v
                self?.onEffectParameterChanged?(track.id)
            }
            contentWrap.addSubview(rKnob)
            
            // Attack Knob
            let aKnob = makeKnob(
                x: 110, y: 10, size: 40, 
                value: effect.attack * 1000, min: 0.1, max: 100, def: 3, suffix: " ms", label: "Att",
                color: .orange
            ) { [weak effect, weak self] v in
                effect?.attack = v / 1000.0
                self?.onEffectParameterChanged?(track.id)
            }
            contentWrap.addSubview(aKnob)

        case .delay:
            // Time Knob
            let dKnob = makeKnob(
                x: 10, y: 10, size: 40, 
                value: Float(effect.delayTime * 1000), min: 1, max: 1000, def: 250, suffix: " ms", label: "Time",
                color: .green
            ) { [weak effect, weak self] v in
                effect?.delayTime = Double(v) / 1000.0
                self?.onEffectParameterChanged?(track.id)
            }
            contentWrap.addSubview(dKnob)
            
            // Feedback Knob
            let fKnob = makeKnob(
                x: 60, y: 10, size: 40, 
                value: effect.feedback, min: 0, max: 100, def: 30, suffix: "%", label: "Fbk",
                color: .green
            ) { [weak effect, weak self] v in
                effect?.feedback = v
                self?.onEffectParameterChanged?(track.id)
            }
            contentWrap.addSubview(fKnob)
            
            // Mix Knob
            let mKnob = makeKnob(
                x: 110, y: 10, size: 40, 
                value: effect.wetDryMix, min: 0, max: 100, def: 20, suffix: "%", label: "Mix",
                color: .green
            ) { [weak effect, weak self] v in
                effect?.wetDryMix = v
                self?.onEffectParameterChanged?(track.id)
            }
            contentWrap.addSubview(mKnob)

        case .reverb:
            // Preset Popup (simplified as a knob for index for now)
            let pKnob = makeKnob(
                x: 15, y: 10, size: 40, 
                value: Float(effect.reverbPreset), min: 0, max: 5, def: 0, suffix: " Pst", label: "Type",
                color: .purple
            ) { [weak effect, weak self] v in
                effect?.reverbPreset = Int(v)
                self?.onEffectParameterChanged?(track.id)
            }
            contentWrap.addSubview(pKnob)
            
            // Mix Knob
            let rmKnob = makeKnob(
                x: 65, y: 10, size: 40, 
                value: effect.reverbMix, min: 0, max: 100, def: 30, suffix: "%", label: "Mix",
                color: .purple
            ) { [weak effect, weak self] v in
                effect?.reverbMix = v
                self?.onEffectParameterChanged?(track.id)
            }
            contentWrap.addSubview(rmKnob)

        default:
            // Generic effect — show type icon and "No Controls" placeholder
            let iconSize: CGFloat = 24
            if let symbolImage = NSImage(systemSymbolName: effect.effectType.icon, accessibilityDescription: nil) {
                let config = NSImage.SymbolConfiguration(pointSize: 14, weight: .medium)
                let iconView = NSImageView(frame: CGRect(
                    x: (frame.width - iconSize) / 2,
                    y: (contentH - iconSize) / 2 - 6,
                    width: iconSize,
                    height: iconSize
                ))
                iconView.image = symbolImage.withSymbolConfiguration(config)
                iconView.contentTintColor = NSColor(white: 0.5, alpha: 1)
                contentWrap.addSubview(iconView)
            }

            let typeLabel = NSTextField(labelWithString: effect.effectType.displayName)
            typeLabel.font = NSFont.systemFont(ofSize: 8, weight: .regular)
            typeLabel.textColor = NSColor(white: 0.4, alpha: 1)
            typeLabel.alignment = .center
            typeLabel.frame = CGRect(x: 0, y: contentH - 14, width: frame.width, height: 12)
            contentWrap.addSubview(typeLabel)
        }

        slot.addPluginContent(contentWrap)
        return slot
    }

    /// Creates the instrument slot for MIDI tracks.
    private func makeInstrumentSlot(track: Track, frame: CGRect) -> NSView {
        let slot = NSView(frame: frame)
        slot.wantsLayer = true
        slot.layer?.cornerRadius = 4
        if let instrument = track.instrument {
            if instrument.instrumentType == .sampler {
                let samplerBody = SamplerView(config: instrument, track: track)
                samplerBody.onSampleURLChanged = { [weak self, weak instrument] newURL in
                    guard let self = self, let instrument = instrument else { return }
                    let oldURL = instrument.sampleURL
                    self.onSamplerSampleChanged?(track.id, oldURL, newURL) 
                }
                samplerBody.onParameterChanged = { [weak self] in
                    guard let self = self else { return }
                    self.onInstrumentParameterChanged?(track.id)
                }
                
                let slot = PluginSlotView(title: instrument.computedDisplayName, frame: frame)
                slot.isEnabled = instrument.isEnabled
                slot.onToggle = { [weak instrument, weak self] newState in
                    instrument?.isEnabled = newState
                    self?.onInstrumentParameterChanged?(track.id)
                }
                
                slot.onSettingsClicked = { [weak self, weak instrument] in
                    self?.onPluginSettingsClicked?(track.id, nil, instrument)
                }
                
                slot.onEyeClicked = { [weak self, weak instrument] in
                    self?.onPluginEyeClicked?(track.id, nil, instrument)
                }
                
                // Add Edit/Ctrl Tabs to Header
                let editTab = NSButton(title: "Edit", target: self, action: #selector(samplerTabTriggered(_:)))
                let ctrlTab = NSButton(title: "Ctrl", target: self, action: #selector(samplerTabTriggered(_:)))
                [editTab, ctrlTab].forEach { btn in
                    btn.bezelStyle = .recessed
                    btn.setButtonType(.pushOnPushOff)
                    btn.controlSize = .mini
                    btn.font = NSFont.systemFont(ofSize: 8, weight: .bold)
                    slot.extraHeaderStack.addArrangedSubview(btn)
                }
                editTab.state = .on
                editTab.tag = 0
                ctrlTab.tag = 1
                
                // Associated Body reference for callback
                objc_setAssociatedObject(slot, "samplerBody", samplerBody, .OBJC_ASSOCIATION_RETAIN)
                
                slot.addPluginContent(samplerBody)
                return slot
            }

            // Default instrument slot for other types
            let slot = PluginSlotView(title: instrument.computedDisplayName, frame: frame)
            slot.isEnabled = instrument.isEnabled
            slot.onToggle = { [weak instrument, weak self] newState in
                instrument?.isEnabled = newState
                self?.onInstrumentParameterChanged?(track.id)
            }

            slot.onSettingsClicked = { [weak self, weak instrument] in
                self?.onPluginSettingsClicked?(track.id, nil, instrument)
            }
            
            slot.onEyeClicked = { [weak self, weak instrument] in
                self?.onPluginEyeClicked?(track.id, nil, instrument)
            }

            let iconSize: CGFloat = 20
            if let symbolImage = NSImage(systemSymbolName: instrument.instrumentType.icon, accessibilityDescription: nil) {
                let config = NSImage.SymbolConfiguration(pointSize: 12, weight: .medium)
                let iconView = NSImageView(frame: CGRect(
                    x: (frame.width - iconSize) / 2,
                    y: (frame.height - 18 - iconSize) / 2,
                    width: iconSize,
                    height: iconSize
                ))
                iconView.image = symbolImage.withSymbolConfiguration(config)
                iconView.contentTintColor = NSColor(red: 0.95, green: 0.70, blue: 0.25, alpha: 1)
                
                let wrap = NSView(frame: CGRect(x: 0, y: 0, width: frame.width, height: frame.height - 18))
                wrap.addSubview(iconView)
                slot.addPluginContent(wrap)
            }
            return slot
        } else {
            // Enterprise "Add Instrument" Placeholder
            let slot = NSView(frame: frame)
            slot.wantsLayer = true
            slot.layer?.cornerRadius = 4
            slot.layer?.backgroundColor = NSColor(white: 0.1, alpha: 0.4).cgColor
            
            // Dashed border (layer-backed for performance)
            let dashLayer = CAShapeLayer()
            dashLayer.strokeColor = NSColor(white: 0.3, alpha: 0.6).cgColor
            dashLayer.fillColor = nil
            dashLayer.lineDashPattern = [4, 4]
            dashLayer.path = NSBezierPath(roundedRect: slot.bounds.insetBy(dx: 4, dy: 4), xRadius: 4, yRadius: 4).asCGPath
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

    @objc private func samplerTabTriggered(_ sender: NSButton) {
        // sender -> extraHeaderStack -> headerView -> PluginSlotView
        guard let slot = sender.superview?.superview?.superview as? PluginSlotView,
              let samplerBody = objc_getAssociatedObject(slot, "samplerBody") as? SamplerView else { return }
        
        // Mutually exclusive tabs
        if let stack = sender.superview as? NSStackView {
            for view in stack.arrangedSubviews {
                if let btn = view as? NSButton {
                    btn.state = (btn == sender) ? .on : .off
                }
            }
        }
        
        samplerBody.setCurrentTab(sender.tag)
    }

    /// Returns a header color for effect types.
    private func effectHeaderColor(for type: AudioEffectType) -> NSColor {
        switch type {
        case .eq:         return NSColor(red: 0.35, green: 0.55, blue: 0.85, alpha: 1.0)  // Blue
        case .utility:    return NSColor(red: 0.50, green: 0.50, blue: 0.50, alpha: 1.0)  // Gray
        case .compressor: return NSColor(red: 0.70, green: 0.40, blue: 0.25, alpha: 1.0)  // Warm brown
        case .delay:      return NSColor(red: 0.40, green: 0.65, blue: 0.45, alpha: 1.0)  // Green
        case .reverb:     return NSColor(red: 0.55, green: 0.40, blue: 0.75, alpha: 1.0)  // Purple
        case .chorus:     return NSColor(red: 0.65, green: 0.50, blue: 0.30, alpha: 1.0)  // Gold-brown
        case .vst2, .vst3: return NSColor(red: 0.20, green: 0.60, blue: 0.40, alpha: 1.0) // Teal for VST
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

    // MARK: - Drag & Drop

    public override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        let pb = sender.draggingPasteboard
        // Only accept if we have a current track context
        guard currentTrackID != nil else { return [] }
        
        if pb.string(forType: .browserItem) != nil {
            return .copy
        }
        return []
    }

    public override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        return currentTrackID != nil ? .copy : []
    }

    public override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let pb = sender.draggingPasteboard
        guard let trackID = currentTrackID,
              let payload = pb.string(forType: .browserItem) else {
            return false
        }

        let parts = payload.split(separator: ":", maxSplits: 1)
        guard parts.count == 2 else { return false }
        
        let nodeType = String(parts[0])
        let itemName = String(parts[1])

        onBrowserItemDropped?(trackID, nodeType, itemName, nil)
        return true
    }
}
