import AppKit
import Foundation
import DreamDAWModels

// MARK: - BottomPanelView

/// Resizable bottom panel that shows either the track detail view (effects chain)
/// or the Piano Roll editor for MIDI clips.
/// - Click track/clip → Detail tab
/// - Shift+click MIDI clip → Piano Roll tab
public final class BottomPanelView: NSView {

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
            titleLabel.stringValue = "\(track.name) — Effects Chain"
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

        // Placeholder: show track info
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
}
