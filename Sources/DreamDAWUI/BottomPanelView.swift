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

        var xOff: CGFloat = 12
        let slotHeight: CGFloat = 48
        let slotWidth: CGFloat = 120
        let slotSpacing: CGFloat = 8

        // --- Instrument slot (MIDI tracks only) ---
        if track.trackType == .midi {
            let instView = NSView(frame: CGRect(x: xOff, y: 8, width: slotWidth, height: slotHeight))
            instView.wantsLayer = true
            instView.layer?.cornerRadius = 6

            if let instrument = track.instrument {
                // Instrument assigned → orange/amber background
                instView.layer?.backgroundColor = NSColor(red: 0.85, green: 0.55, blue: 0.1, alpha: 0.85).cgColor
                instView.layer?.borderWidth = 0

                let instIcon = NSTextField(labelWithString: "♪")
                instIcon.font = NSFont.systemFont(ofSize: 14)
                instIcon.textColor = NSColor.white
                instIcon.frame = CGRect(x: 6, y: 26, width: 20, height: 18)
                instView.addSubview(instIcon)

                let instLabel = NSTextField(labelWithString: instrument.instrumentType.displayName)
                instLabel.font = NSFont.systemFont(ofSize: 10, weight: .semibold)
                instLabel.textColor = NSColor.white
                instLabel.lineBreakMode = NSLineBreakMode.byTruncatingTail
                instLabel.frame = CGRect(x: 6, y: 4, width: slotWidth - 12, height: 22)
                instView.addSubview(instLabel)
            } else {
                // No instrument → empty slot with dashed border
                instView.layer?.backgroundColor = NSColor(white: 0.14, alpha: 1).cgColor
                instView.layer?.borderWidth = 1
                instView.layer?.borderColor = NSColor(white: 0.3, alpha: 0.6).cgColor

                let placeholder = NSTextField(labelWithString: "∅ Instrument")
                placeholder.font = NSFont.systemFont(ofSize: 10, weight: .medium)
                placeholder.textColor = DreamTheme.textMuted
                placeholder.alignment = .center
                placeholder.frame = CGRect(x: 0, y: 14, width: slotWidth, height: 18)
                instView.addSubview(placeholder)
            }

            detailContentView.addSubview(instView)
            xOff += slotWidth + slotSpacing

            // Arrow connector between instrument and effects
            let arrow = NSTextField(labelWithString: "→")
            arrow.font = NSFont.systemFont(ofSize: 16, weight: .light)
            arrow.textColor = DreamTheme.textMuted
            arrow.frame = CGRect(x: xOff, y: 8 + slotHeight / 2 - 10, width: 20, height: 20)
            detailContentView.addSubview(arrow)
            xOff += 24
        }

        // --- Effects chain ---
        if track.effects.isEmpty && track.trackType == .audio {
            // Audio track with no effects — show placeholder centered
            let label = NSTextField(labelWithString: "Drop effects and plugins here…")
            label.font = NSFont.systemFont(ofSize: 12)
            label.textColor = DreamTheme.textMuted
            label.alignment = .center
            label.frame = CGRect(
                x: 0,
                y: detailContentView.bounds.height / 2 - 10,
                width: detailContentView.bounds.width,
                height: 20
            )
            label.autoresizingMask = [.width, .minYMargin, .maxYMargin]
            detailContentView.addSubview(label)
        } else if track.effects.isEmpty && track.trackType == .midi {
            // MIDI track with instrument but no effects — show "add effects" hint
            let label = NSTextField(labelWithString: "← Drop effects here")
            label.font = NSFont.systemFont(ofSize: 11)
            label.textColor = DreamTheme.textMuted
            label.frame = CGRect(x: xOff, y: 8 + slotHeight / 2 - 10, width: 140, height: 20)
            detailContentView.addSubview(label)
        } else {
            // Show effects chain as horizontal slots
            for (index, effect) in track.effects.enumerated() {
                let effectView = NSView(frame: CGRect(x: xOff, y: 8, width: slotWidth, height: slotHeight))
                effectView.wantsLayer = true
                effectView.layer?.backgroundColor = NSColor(white: 0.18, alpha: 1).cgColor
                effectView.layer?.cornerRadius = 6
                effectView.layer?.borderWidth = 1
                effectView.layer?.borderColor = NSColor(white: 0.25, alpha: 1).cgColor

                // Effect number badge
                let badge = NSTextField(labelWithString: "FX\(index + 1)")
                badge.font = NSFont.systemFont(ofSize: 8, weight: .bold)
                badge.textColor = DreamTheme.accentGreen
                badge.frame = CGRect(x: 6, y: 30, width: 40, height: 14)
                effectView.addSubview(badge)

                let nameLabel = NSTextField(labelWithString: effect.effectType.displayName)
                nameLabel.font = NSFont.systemFont(ofSize: 10, weight: .medium)
                nameLabel.textColor = DreamTheme.textPrimary
                nameLabel.lineBreakMode = .byTruncatingTail
                nameLabel.frame = CGRect(x: 6, y: 4, width: slotWidth - 12, height: 22)
                effectView.addSubview(nameLabel)

                detailContentView.addSubview(effectView)
                xOff += slotWidth + slotSpacing

                // Arrow between effects
                if index < track.effects.count - 1 {
                    let arrow = NSTextField(labelWithString: "→")
                    arrow.font = NSFont.systemFont(ofSize: 16, weight: .light)
                    arrow.textColor = DreamTheme.textMuted
                    arrow.frame = CGRect(x: xOff, y: 8 + slotHeight / 2 - 10, width: 20, height: 20)
                    detailContentView.addSubview(arrow)
                    xOff += 24
                }
            }
        }
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
