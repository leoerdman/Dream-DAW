import AppKit
import AVFoundation
import SwiftUI
import DreamDAWModels

// MARK: - BrowserSidebarView

/// Left sidebar mimicking Ableton Live's browser panel.
/// Shows Library sections + real sample files from configured samples folder.
/// Users can drag audio files from the browser onto audio tracks.
public final class BrowserSidebarView: NSView {

    // MARK: - Properties

    public var isCollapsed: Bool = false {
        didSet { needsLayout = true }
    }

    private let searchField = NSSearchField()
    private let outlineScrollView = NSScrollView()
    private let outlineView = NSOutlineView()
    private var rootItems: [BrowserNode] = []
    private var samplesObserver: Any?
    private var previewPlayer: AVAudioPlayer?

    public override var isFlipped: Bool { true }

    // MARK: - Initialization

    public override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        setupUI()
        buildTree()
        observeSamplesPath()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    deinit {
        previewPlayer?.stop()
        if let obs = samplesObserver {
            NotificationCenter.default.removeObserver(obs)
        }
    }

    // MARK: - Audio Preview

    /// Play a preview of the selected audio file.
    private func playPreview(url: URL) {
        previewPlayer?.stop()
        do {
            previewPlayer = try AVAudioPlayer(contentsOf: url)
            previewPlayer?.volume = 0.8
            previewPlayer?.play()
        } catch {
            print("[Browser] Preview failed: \(error.localizedDescription)")
        }
    }

    /// Stop any active preview playback.
    public func stopPreview() {
        previewPlayer?.stop()
        previewPlayer = nil
    }

    // MARK: - Setup

    private func setupUI() {
        wantsLayer = true
        layer?.backgroundColor = DreamTheme.bgBrowser.cgColor

        // Search field
        searchField.placeholderString = "Search"
        searchField.font = DreamTheme.fontBody
        searchField.focusRingType = .none
        searchField.appearance = NSAppearance(named: .darkAqua)
        searchField.target = self
        searchField.action = #selector(searchChanged(_:))
        addSubview(searchField)

        // Outline view — displays tree
        outlineView.headerView = nil
        outlineView.rowHeight = 22
        outlineView.indentationPerLevel = 16
        outlineView.style = .sourceList
        outlineView.floatsGroupRows = false
        outlineView.autoresizesSubviews = true

        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("name"))
        column.isEditable = false
        outlineView.addTableColumn(column)
        outlineView.outlineTableColumn = column

        outlineView.dataSource = self
        outlineView.delegate = self

        // Register for drag source
        outlineView.setDraggingSourceOperationMask(.copy, forLocal: false)

        // Scroll view
        outlineScrollView.wantsLayer = true
        outlineScrollView.drawsBackground = false
        outlineScrollView.hasVerticalScroller = true
        outlineScrollView.hasHorizontalScroller = false
        outlineScrollView.scrollerStyle = .overlay
        outlineScrollView.autohidesScrollers = true
        outlineScrollView.documentView = outlineView
        addSubview(outlineScrollView)
    }

    public override func layout() {
        super.layout()
        let searchHeight: CGFloat = 28
        let padding: CGFloat = 6
        searchField.frame = CGRect(x: padding, y: padding, width: bounds.width - padding * 2, height: searchHeight - padding)
        outlineScrollView.frame = CGRect(x: 0, y: searchHeight, width: bounds.width, height: bounds.height - searchHeight)
    }

    // MARK: - Tree Building

    private func buildTree() {
        rootItems.removeAll()

        // Collections
        let collections = BrowserNode(name: "Collections", icon: "star.fill", isGroup: true)
        collections.children = [
            BrowserNode(name: "Favorites", icon: "star.fill"),
        ]
        rootItems.append(collections)

        // Library
        let library = BrowserNode(name: "Library", icon: "folder.fill", isGroup: true)

        // Instruments sub-category with built-in synths
        let instruments = BrowserNode(name: "Instruments", icon: "pianokeys", isGroup: true)
        instruments.children = [
            BrowserNode(name: "Simple Sine Synth", icon: "waveform.path"),
        ]

        library.children = [
            BrowserNode(name: "Sounds", icon: "music.note"),
            BrowserNode(name: "Drums", icon: "drum.fill"),
            instruments,
            BrowserNode(name: "Audio Effects", icon: "wand.and.stars"),
            BrowserNode(name: "MIDI Effects", icon: "sparkles"),
            BrowserNode(name: "Plug-Ins", icon: "puzzlepiece.fill"),
            BrowserNode(name: "Clips", icon: "film"),
            BrowserNode(name: "Templates", icon: "doc.text"),
        ]
        rootItems.append(library)

        // Places
        let places = BrowserNode(name: "Places", icon: "externaldrive.fill", isGroup: true)
        places.children = [
            BrowserNode(name: "User Library", icon: "person.crop.circle"),
            BrowserNode(name: "Current Project", icon: "doc.fill"),
        ]
        rootItems.append(places)

        // Samples (from user settings)
        loadSamplesFolder()

        outlineView.reloadData()

        // Expand all groups
        for item in rootItems {
            outlineView.expandItem(item)
        }
    }

    private func loadSamplesFolder() {
        let samplesPath = AppSettings.shared.samplesPath
        guard !samplesPath.isEmpty else { return }

        let samplesURL = URL(fileURLWithPath: samplesPath)
        guard FileManager.default.fileExists(atPath: samplesPath) else { return }

        let samplesNode = BrowserNode(name: "Samples", icon: "waveform", isGroup: true)
        samplesNode.children = scanDirectory(url: samplesURL, depth: 0, maxDepth: 8)
        rootItems.append(samplesNode)
    }

    private func scanDirectory(url: URL, depth: Int, maxDepth: Int) -> [BrowserNode] {
        guard depth < maxDepth else { return [] }

        let audioExtensions = Set(["wav", "aiff", "aif", "mp3", "m4a", "flac", "ogg", "caf"])
        var nodes: [BrowserNode] = []

        guard let contents = try? FileManager.default.contentsOfDirectory(
            at: url,
            includingPropertiesForKeys: [.isDirectoryKey, .isRegularFileKey],
            options: [.skipsHiddenFiles]
        ) else { return [] }

        // Sort: directories first, then files
        let sorted = contents.sorted { a, b in
            let aIsDir = (try? a.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory ?? false
            let bIsDir = (try? b.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory ?? false
            if aIsDir != bIsDir { return aIsDir }
            return a.lastPathComponent.localizedCaseInsensitiveCompare(b.lastPathComponent) == .orderedAscending
        }

        for item in sorted {
            let isDir = (try? item.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory ?? false

            if isDir {
                let dirNode = BrowserNode(name: item.lastPathComponent, icon: "folder.fill", isGroup: true)
                dirNode.children = scanDirectory(url: item, depth: depth + 1, maxDepth: maxDepth)
                if !dirNode.children.isEmpty {
                    nodes.append(dirNode)
                }
            } else if audioExtensions.contains(item.pathExtension.lowercased()) {
                let fileNode = BrowserNode(name: item.lastPathComponent, icon: "waveform")
                fileNode.fileURL = item
                nodes.append(fileNode)
            }
        }
        return nodes
    }

    // MARK: - Observe Samples Path Changes

    private func observeSamplesPath() {
        samplesObserver = NotificationCenter.default.addObserver(
            forName: .samplesPathDidChange, object: nil, queue: .main
        ) { [weak self] _ in
            self?.buildTree()
        }
    }

    // MARK: - Search

    @objc private func searchChanged(_ sender: NSSearchField) {
        // TODO: implement search filtering
        outlineView.reloadData()
    }
}

// MARK: - BrowserNode

/// Tree node for the browser outline view.
class BrowserNode: NSObject {
    let name: String
    let icon: String
    let isGroup: Bool
    var children: [BrowserNode] = []
    var fileURL: URL?

    init(name: String, icon: String, isGroup: Bool = false) {
        self.name = name
        self.icon = icon
        self.isGroup = isGroup
        super.init()
    }
}

// MARK: - NSOutlineViewDataSource

extension BrowserSidebarView: NSOutlineViewDataSource {

    public func outlineView(_ outlineView: NSOutlineView, numberOfChildrenOfItem item: Any?) -> Int {
        if item == nil { return rootItems.count }
        if let node = item as? BrowserNode { return node.children.count }
        return 0
    }

    public func outlineView(_ outlineView: NSOutlineView, child index: Int, ofItem item: Any?) -> Any {
        if item == nil { return rootItems[index] }
        if let node = item as? BrowserNode { return node.children[index] }
        return ""
    }

    public func outlineView(_ outlineView: NSOutlineView, isItemExpandable item: Any) -> Bool {
        if let node = item as? BrowserNode { return node.isGroup && !node.children.isEmpty }
        return false
    }

    // MARK: - Drag Source (provide file URL for audio files)

    public func outlineView(_ outlineView: NSOutlineView, pasteboardWriterForItem item: Any) -> NSPasteboardWriting? {
        guard let node = item as? BrowserNode,
              let fileURL = node.fileURL else { return nil }
        return fileURL as NSURL
    }
}

// MARK: - NSOutlineViewDelegate

extension BrowserSidebarView: NSOutlineViewDelegate {

    public func outlineView(_ outlineView: NSOutlineView, viewFor tableColumn: NSTableColumn?, item: Any) -> NSView? {
        guard let node = item as? BrowserNode else { return nil }

        let cellID = NSUserInterfaceItemIdentifier("BrowserCell")
        let cellView: NSTableCellView

        if let reused = outlineView.makeView(withIdentifier: cellID, owner: self) as? NSTableCellView {
            cellView = reused
        } else {
            cellView = NSTableCellView()
            cellView.identifier = cellID

            let imageView = NSImageView()
            imageView.translatesAutoresizingMaskIntoConstraints = false
            cellView.addSubview(imageView)
            cellView.imageView = imageView

            let textField = NSTextField(labelWithString: "")
            textField.translatesAutoresizingMaskIntoConstraints = false
            textField.lineBreakMode = .byTruncatingTail
            cellView.addSubview(textField)
            cellView.textField = textField

            NSLayoutConstraint.activate([
                imageView.leadingAnchor.constraint(equalTo: cellView.leadingAnchor, constant: 2),
                imageView.centerYAnchor.constraint(equalTo: cellView.centerYAnchor),
                imageView.widthAnchor.constraint(equalToConstant: 14),
                imageView.heightAnchor.constraint(equalToConstant: 14),

                textField.leadingAnchor.constraint(equalTo: imageView.trailingAnchor, constant: 6),
                textField.trailingAnchor.constraint(equalTo: cellView.trailingAnchor, constant: -4),
                textField.centerYAnchor.constraint(equalTo: cellView.centerYAnchor),
            ])
        }

        // Configure cell
        if node.isGroup {
            cellView.textField?.stringValue = node.name.uppercased()
            cellView.textField?.font = NSFont.systemFont(ofSize: 10, weight: .semibold)
            cellView.textField?.textColor = DreamTheme.textMuted
        } else {
            cellView.textField?.stringValue = node.name
            cellView.textField?.font = DreamTheme.fontBrowser
            cellView.textField?.textColor = DreamTheme.textPrimary
        }

        if let symbolImage = NSImage(systemSymbolName: node.icon, accessibilityDescription: nil) {
            let config = NSImage.SymbolConfiguration(pointSize: 10, weight: .medium)
            cellView.imageView?.image = symbolImage.withSymbolConfiguration(config)
            cellView.imageView?.contentTintColor = node.isGroup ? DreamTheme.textMuted : DreamTheme.textSecondary
        }

        return cellView
    }

    public func outlineView(_ outlineView: NSOutlineView, isGroupItem item: Any) -> Bool {
        false // We handle group styling manually
    }

    public func outlineView(_ outlineView: NSOutlineView, shouldSelectItem item: Any) -> Bool {
        if let node = item as? BrowserNode {
            return !node.isGroup // Only leaf items are selectable
        }
        return false
    }

    /// Play preview when a file is selected (clicked) in the browser.
    public func outlineViewSelectionDidChange(_ notification: Notification) {
        let row = outlineView.selectedRow
        guard row >= 0,
              let node = outlineView.item(atRow: row) as? BrowserNode else {
            stopPreview()
            return
        }

        if let fileURL = node.fileURL {
            playPreview(url: fileURL)
        } else {
            stopPreview()
        }
    }
}
