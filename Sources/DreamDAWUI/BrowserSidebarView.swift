import AppKit
import SwiftUI
import DreamDAWModels

// MARK: - BrowserSidebarView

/// Left sidebar mimicking Ableton Live's browser panel.
/// Contains: Search, Collections, Library tree, Places.
public final class BrowserSidebarView: NSView {

    // MARK: - Properties

    public var isCollapsed: Bool = false {
        didSet { needsLayout = true }
    }

    private let searchField = NSSearchField()
    private let scrollView = NSScrollView()
    private let contentView = NSView()
    private var sectionViews: [NSView] = []

    public override var isFlipped: Bool { true }

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
        layer?.backgroundColor = DreamTheme.bgBrowser.cgColor

        // Search field
        searchField.placeholderString = "Search (Cmd+F)"
        searchField.font = DreamTheme.fontBody
        searchField.focusRingType = .none
        searchField.appearance = NSAppearance(named: .darkAqua)
        searchField.translatesAutoresizingMaskIntoConstraints = false
        addSubview(searchField)

        // Scroll view for content
        scrollView.wantsLayer = true
        scrollView.drawsBackground = false
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = false
        scrollView.scrollerStyle = .overlay
        scrollView.autohidesScrollers = true
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        scrollView.documentView = contentView
        contentView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(scrollView)

        NSLayoutConstraint.activate([
            searchField.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 6),
            searchField.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -6),
            searchField.topAnchor.constraint(equalTo: topAnchor, constant: 6),
            searchField.heightAnchor.constraint(equalToConstant: 22),

            scrollView.leadingAnchor.constraint(equalTo: leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: trailingAnchor),
            scrollView.topAnchor.constraint(equalTo: searchField.bottomAnchor, constant: 6),
            scrollView.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])

        buildSections()
    }

    // MARK: - Sections

    private func buildSections() {
        // Remove old sections
        sectionViews.forEach { $0.removeFromSuperview() }
        sectionViews.removeAll()

        var yOffset: CGFloat = 0

        // Collections
        yOffset = addSection(title: "Collections", items: [
            BrowserItem(icon: "star.fill", label: "Favorites", iconColor: .systemYellow),
            BrowserItem(icon: "circle.fill", label: "Yellow", iconColor: .systemYellow),
        ], yOffset: yOffset)

        // Library
        yOffset = addSection(title: "Library", items: [
            BrowserItem(icon: "folder.fill", label: "All", iconColor: .systemGray),
            BrowserItem(icon: "music.note", label: "Sounds", iconColor: .systemBlue),
            BrowserItem(icon: "waveform", label: "Samples", iconColor: .systemGreen),
            BrowserItem(icon: "drum.fill", label: "Drums", iconColor: .systemOrange),
            BrowserItem(icon: "pianokeys", label: "Instruments", iconColor: .systemPurple),
            BrowserItem(icon: "wand.and.stars", label: "Audio Effects", iconColor: .systemCyan),
            BrowserItem(icon: "sparkles", label: "MIDI Effects", iconColor: .systemPink),
            BrowserItem(icon: "slider.horizontal.3", label: "Modulators", iconColor: .systemTeal),
            BrowserItem(icon: "puzzlepiece.fill", label: "Plug-Ins", iconColor: .systemIndigo),
            BrowserItem(icon: "film", label: "Clips", iconColor: .systemMint),
            BrowserItem(icon: "waveform.path", label: "Grooves", iconColor: .systemBrown),
            BrowserItem(icon: "tuningfork", label: "Tunings", iconColor: .systemGray),
            BrowserItem(icon: "doc.text", label: "Templates", iconColor: .systemGray),
        ], yOffset: yOffset)

        // Places
        yOffset = addSection(title: "Places", items: [
            BrowserItem(icon: "shippingbox.fill", label: "Packs", iconColor: .systemGray),
            BrowserItem(icon: "person.crop.circle", label: "User Library", iconColor: .systemBlue),
            BrowserItem(icon: "doc.fill", label: "Current Project", iconColor: .systemGreen),
        ], yOffset: yOffset)

        // Update content size
        contentView.frame = CGRect(x: 0, y: 0, width: bounds.width, height: yOffset)
    }

    private func addSection(title: String, items: [BrowserItem], yOffset: CGFloat) -> CGFloat {
        var y = yOffset

        // Section title
        let titleLabel = NSTextField(labelWithString: title)
        titleLabel.font = NSFont.systemFont(ofSize: 10, weight: .semibold)
        titleLabel.textColor = DreamTheme.textMuted
        titleLabel.frame = CGRect(x: 10, y: y, width: bounds.width - 20, height: 18)
        contentView.addSubview(titleLabel)
        sectionViews.append(titleLabel)
        y += 20

        // Items
        for item in items {
            let itemView = BrowserItemView(item: item)
            itemView.frame = CGRect(x: 0, y: y, width: bounds.width, height: 22)
            contentView.addSubview(itemView)
            sectionViews.append(itemView)
            y += 22
        }

        y += 8 // spacing between sections
        return y
    }
}

// MARK: - BrowserItem

struct BrowserItem {
    let icon: String
    let label: String
    let iconColor: NSColor
}

// MARK: - BrowserItemView

/// Single row in the browser sidebar.
final class BrowserItemView: NSView {

    private let item: BrowserItem
    private var isHovered = false
    private var trackingArea: NSTrackingArea?

    init(item: BrowserItem) {
        self.item = item
        super.init(frame: .zero)
        wantsLayer = true
        setupTracking()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override var isFlipped: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }

        // Hover state
        if isHovered {
            ctx.setFillColor(DreamTheme.bgBrowserItem.cgColor)
            ctx.fill(bounds)
        }

        // Icon
        let iconRect = CGRect(x: 14, y: 3, width: 14, height: 14)
        if let symbolImage = NSImage(systemSymbolName: item.icon, accessibilityDescription: nil) {
            let config = NSImage.SymbolConfiguration(pointSize: 10, weight: .medium)
            let configured = symbolImage.withSymbolConfiguration(config) ?? symbolImage
            configured.draw(in: iconRect, from: .zero, operation: .sourceOver, fraction: 1.0)
        }

        // Label
        let attrs: [NSAttributedString.Key: Any] = [
            .font: DreamTheme.fontBrowser,
            .foregroundColor: DreamTheme.textPrimary
        ]
        let labelStr = NSAttributedString(string: item.label, attributes: attrs)
        labelStr.draw(at: CGPoint(x: 34, y: 3))
    }

    private func setupTracking() {
        let area = NSTrackingArea(
            rect: bounds,
            options: [.activeInActiveApp, .mouseEnteredAndExited, .inVisibleRect],
            owner: self,
            userInfo: nil
        )
        addTrackingArea(area)
        trackingArea = area
    }

    override func mouseEntered(with event: NSEvent) {
        isHovered = true
        needsDisplay = true
    }

    override func mouseExited(with event: NSEvent) {
        isHovered = false
        needsDisplay = true
    }
}
