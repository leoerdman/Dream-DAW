import AppKit
import AVFoundation
import SwiftUI
import DreamDAWModels

// MARK: - Custom Pasteboard Type for browser items (instruments, effects)

extension NSPasteboard.PasteboardType {
    static let browserItem = NSPasteboard.PasteboardType("com.dreamdaw.browser-item")
}

// MARK: - BrowserSidebarView

/// Left sidebar mimicking Ableton Live's browser panel.
/// Shows Library sections + real sample files from configured samples folder.
/// Users can drag audio files from the browser onto audio tracks.
public final class BrowserSidebarView: NSView {

    // MARK: - Properties

    public var isCollapsed: Bool = false {
        didSet { needsLayout = true }
    }

    private let searchField = NSTextField()
    private let searchIcon = NSImageView()
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

        // Search icon — small magnifying glass
        if let mag = NSImage(systemSymbolName: "magnifyingglass", accessibilityDescription: "Search") {
            let config = NSImage.SymbolConfiguration(pointSize: 10, weight: .medium)
            searchIcon.image = mag.withSymbolConfiguration(config)
        }
        searchIcon.contentTintColor = DreamTheme.textMuted
        addSubview(searchIcon)

        // Search field — completely flat, same bg as panel, no bezel
        searchField.placeholderString = "Search"
        searchField.font = NSFont.systemFont(ofSize: 11, weight: .regular)
        searchField.focusRingType = .none
        searchField.isBordered = false
        searchField.isBezeled = false
        searchField.drawsBackground = false  // Transparent — panel bg shows through
        searchField.textColor = DreamTheme.textPrimary
        searchField.appearance = NSAppearance(named: .darkAqua)
        searchField.target = self
        searchField.action = #selector(searchChanged(_:))
        addSubview(searchField)

        // Outline view — Ableton-style compact tree
        outlineView.headerView = nil
        outlineView.rowHeight = 20  // Compact density matching Ableton
        outlineView.indentationPerLevel = 14  // Slightly tighter indentation
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
        let searchAreaH: CGFloat = 28
        let hPad: CGFloat = 8
        let topPad: CGFloat = 5
        let iconSize: CGFloat = 14

        // Magnifying glass icon
        searchIcon.frame = CGRect(
            x: hPad,
            y: topPad + (searchAreaH - iconSize) / 2 - topPad,
            width: iconSize,
            height: iconSize
        )

        // Text field after icon
        let fieldX = hPad + iconSize + 4
        searchField.frame = CGRect(
            x: fieldX,
            y: topPad,
            width: bounds.width - fieldX - hPad,
            height: searchAreaH - topPad * 2
        )

        outlineScrollView.frame = CGRect(
            x: 0,
            y: searchAreaH,
            width: bounds.width,
            height: bounds.height - searchAreaH
        )
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
            BrowserNode(name: "Simple Sine Synth", icon: "waveform.path", nodeType: .instrument),
            BrowserNode(name: "Sampler", icon: "waveform.badge.plus", nodeType: .instrument),
        ]

        // Audio Effects
        let audioEffects = BrowserNode(name: "Audio Effects", icon: "wand.and.stars", isGroup: true)
        audioEffects.children = [
            BrowserNode(name: "EQ Eight", icon: "slider.horizontal.3", nodeType: .audioEffect),
            BrowserNode(name: "Compressor", icon: "gauge.with.dots.needle.33percent", nodeType: .audioEffect),
            BrowserNode(name: "Delay", icon: "clock.arrow.2.circlepath", nodeType: .audioEffect),
            BrowserNode(name: "Reverb", icon: "waveform.path.ecg", nodeType: .audioEffect),
            BrowserNode(name: "Chorus-Ensemble", icon: "waveform.path.badge.plus", nodeType: .audioEffect),
            BrowserNode(name: "Utility", icon: "wrench", nodeType: .audioEffect),
        ]

        // MIDI Effects
        let midiEffects = BrowserNode(name: "MIDI Effects", icon: "sparkles", isGroup: true)
        midiEffects.children = [
            BrowserNode(name: "Arpeggiator", icon: "arrow.up.right", nodeType: .midiEffect),
            BrowserNode(name: "Chord", icon: "music.note.list", nodeType: .midiEffect),
            BrowserNode(name: "Note Length", icon: "ruler", nodeType: .midiEffect),
            BrowserNode(name: "Scale", icon: "tuningfork", nodeType: .midiEffect),
        ]

        // Plug-Ins (AU / VST)
        let plugIns = BrowserNode(name: "Plug-Ins", icon: "puzzlepiece.fill", isGroup: true)
        plugIns.children = [
            BrowserNode(name: "Audio Units", icon: "cpu"),
        ]

        library.children = [
            BrowserNode(name: "Sounds", icon: "music.note"),
            BrowserNode(name: "Drums", icon: "drum.fill"),
            instruments,
            audioEffects,
            midiEffects,
            plugIns,
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

    @objc private func searchChanged(_ sender: NSTextField) {
        // TODO: implement search filtering
        outlineView.reloadData()
    }
}

// MARK: - BrowserNode

/// Type classification for browser items.
enum BrowserNodeType: String {
    case generic      // Non-draggable items (folders, groups, labels)
    case instrument   // Synths, samplers → drag onto MIDI tracks
    case audioEffect  // EQ, Compressor, etc. → drag onto any track
    case midiEffect   // Arpeggiator, etc. → drag onto MIDI tracks
    case audioFile    // .wav, .aif, .mp3 → drag onto audio tracks
}

/// Tree node for the browser outline view.
class BrowserNode: NSObject {
    let name: String
    let icon: String
    let isGroup: Bool
    let nodeType: BrowserNodeType
    var children: [BrowserNode] = []
    var fileURL: URL?

    init(name: String, icon: String, isGroup: Bool = false, nodeType: BrowserNodeType = .generic) {
        self.name = name
        self.icon = icon
        self.isGroup = isGroup
        self.nodeType = nodeType
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

    // MARK: - Drag Source (provide file URL for audio files, custom type for instruments/effects)

    public func outlineView(_ outlineView: NSOutlineView, pasteboardWriterForItem item: Any) -> NSPasteboardWriting? {
        guard let node = item as? BrowserNode else { return nil }

        // Audio files → drag as file URL
        if let fileURL = node.fileURL {
            return fileURL as NSURL
        }

        // Instruments / Effects → drag as custom pasteboard item
        if node.nodeType != .generic {
            let pasteboardItem = NSPasteboardItem()
            // Encode as "type:name" — e.g. "instrument:Simple Sine Synth"
            let payload = "\(node.nodeType.rawValue):\(node.name)"
            pasteboardItem.setString(payload, forType: .browserItem)
            return pasteboardItem
        }

        return nil  // Groups and generic nodes are not draggable
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

        // Configure cell — Ableton-style visual hierarchy
        if node.isGroup {
            // Section headers: mixed-case, muted accent color (like Ableton's golden section labels)
            cellView.textField?.stringValue = node.name
            cellView.textField?.font = NSFont.systemFont(ofSize: 10, weight: .semibold)
            cellView.textField?.textColor = NSColor(red: 0.55, green: 0.50, blue: 0.40, alpha: 1.0)  // Warm muted gold
        } else {
            cellView.textField?.stringValue = node.name
            cellView.textField?.font = NSFont.systemFont(ofSize: 11, weight: .regular)
            cellView.textField?.textColor = DreamTheme.textPrimary
        }

        // Icons with section-aware coloring (Ableton uses colored icons per category)
        if let symbolImage = NSImage(systemSymbolName: node.icon, accessibilityDescription: nil) {
            let iconSize: CGFloat = node.isGroup ? 9 : 10
            let config = NSImage.SymbolConfiguration(pointSize: iconSize, weight: .medium)
            cellView.imageView?.image = symbolImage.withSymbolConfiguration(config)
            cellView.imageView?.contentTintColor = iconTint(for: node)
        }

        return cellView
    }

    /// Returns the appropriate icon tint color for a browser node,
    /// matching Ableton's per-section icon coloring.
    private func iconTint(for node: BrowserNode) -> NSColor {
        if node.isGroup {
            return NSColor(red: 0.50, green: 0.45, blue: 0.37, alpha: 1.0)  // Warm muted gold for headers
        }

        switch node.nodeType {
        case .instrument:
            return NSColor(red: 0.95, green: 0.75, blue: 0.25, alpha: 1.0)  // Gold — instruments
        case .audioEffect:
            return NSColor(red: 0.35, green: 0.70, blue: 0.90, alpha: 1.0)  // Blue — audio effects
        case .midiEffect:
            return NSColor(red: 0.65, green: 0.50, blue: 0.90, alpha: 1.0)  // Purple — MIDI effects
        case .audioFile:
            return DreamTheme.textSecondary
        case .generic:
            // Special icon coloring for specific items
            if node.name == "Favorites" { return NSColor(red: 0.95, green: 0.78, blue: 0.20, alpha: 1.0) }  // Yellow star
            return DreamTheme.textSecondary
        }
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
