import AppKit
import AVFoundation
import SwiftUI
import DreamDAWModels
import DreamDAWEngine

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

    private let searchField = NSSearchField()
    private let searchContainer = NSView()
    private let backgroundView = NSView()
    private let outlineScrollView = NSScrollView()
    private let outlineView = NSOutlineView()
    private var rootItems: [BrowserNode] = []
    private var filteredItems: [BrowserNode] = []
    private var samplesObserver: Any?
    private var vstObserver: Any?
    private var previewPlayer: AVAudioPlayer?
    private var searchQuery: String = ""

    public override var isFlipped: Bool { true }

    // MARK: - Initialization

    public override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        setupUI()
        buildTree()
        observeSettings()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    deinit {
        previewPlayer?.stop()
        if let obs = samplesObserver {
            NotificationCenter.default.removeObserver(obs)
        }
        if let obs = vstObserver {
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

        // Solid background (Professional/Enterprise Opaque)
        backgroundView.wantsLayer = true
        backgroundView.layer?.backgroundColor = DreamTheme.bgBrowser.cgColor
        addSubview(backgroundView)

        // Search field — explicit visible panel for reliable UX.
        searchContainer.wantsLayer = true
        searchContainer.layer?.backgroundColor = DreamTheme.bgHeader.cgColor
        searchContainer.layer?.borderColor = DreamTheme.divider.cgColor
        searchContainer.layer?.borderWidth = 1
        addSubview(searchContainer)

        searchField.placeholderString = "Search"
        searchField.font = NSFont.systemFont(ofSize: 11, weight: .regular)
        searchField.focusRingType = .none
        searchField.isBezeled = true
        searchField.isBordered = true
        searchField.drawsBackground = true
        searchField.backgroundColor = DreamTheme.bgSecondary
        searchField.textColor = DreamTheme.textPrimary
        searchField.appearance = NSAppearance(named: .darkAqua)
        searchField.sendsSearchStringImmediately = true
        searchField.target = self
        searchField.action = #selector(searchChanged(_:))
        searchContainer.addSubview(searchField)

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
        outlineView.setDraggingSourceOperationMask([.copy, .link], forLocal: false) // 'false' is fine for both as long as mask is broad
        outlineView.setDraggingSourceOperationMask([.copy, .link], forLocal: true)

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
        backgroundView.frame = bounds
        let searchAreaH: CGFloat = 32
        let hPad: CGFloat = 8
        let topPad: CGFloat = 5
        searchContainer.frame = CGRect(x: 0, y: 0, width: bounds.width, height: searchAreaH)
        searchField.frame = CGRect(
            x: hPad,
            y: topPad,
            width: searchContainer.bounds.width - hPad * 2,
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
        
        // AU - placeholder for now
        let audioUnits = BrowserNode(name: "Audio Units", icon: "cpu")
        
        // VSTs from PluginManager
        let vsts = loadPlugins()
        
        plugIns.children = [audioUnits] + vsts

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

        // Expand all groups
        for item in rootItems {
            outlineView.expandItem(item)
        }
        
        // Initialize filtered items
        updateFilteredItems()
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

    private func loadPlugins() -> [BrowserNode] {
        let plugins = PluginManager.shared.availablePlugins
        var nodes: [BrowserNode] = []
        
        for plugin in plugins {
            let nType: BrowserNodeType = (plugin.type == .vst2) ? .vst2 : .vst3
            let node = BrowserNode(
                name: plugin.name, 
                icon: (nType == .vst2) ? "puzzlepiece.extension.fill" : "puzzlepiece.fill",
                nodeType: nType
            )
            node.fileURL = URL(fileURLWithPath: plugin.path)
            nodes.append(node)
        }
        
        return nodes
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
                let fileNode = BrowserNode(name: item.lastPathComponent, icon: "waveform", nodeType: .audioFile)
                fileNode.fileURL = item
                nodes.append(fileNode)
            }
        }
        return nodes
    }

    // MARK: - Observe Settings Changes

    private func observeSettings() {
        samplesObserver = NotificationCenter.default.addObserver(
            forName: .samplesPathDidChange, object: nil, queue: .main
        ) { [weak self] _ in
            self?.buildTree()
        }
        
        vstObserver = NotificationCenter.default.addObserver(
            forName: .vstPathsDidChange, object: nil, queue: .main
        ) { [weak self] _ in
            self?.buildTree()
        }
    }

    // MARK: - Search

    /// Focus the search field, selecting all text. If already focused, clear it.
    public func focusSearch() {
        if window?.firstResponder == searchField.currentEditor() {
            searchField.stringValue = ""
            searchQuery = ""
            updateFilteredItems()
        }
        
        window?.makeFirstResponder(searchField)
        searchField.currentEditor()?.selectAll(nil)
    }

    @objc private func searchChanged(_ sender: NSSearchField) {
        self.searchQuery = sender.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        updateFilteredItems()
    }

    private func updateFilteredItems() {
        if searchQuery.isEmpty {
            filteredItems = rootItems
        } else {
            // Filter and sort: Bring audio files and instruments to top, categories further down
            let results = rootItems.compactMap { $0.filteredClone(query: searchQuery) }
            filteredItems = results.sorted { a, b in
                if a.nodeType == .audioFile && b.nodeType != .audioFile { return true }
                if a.nodeType != .audioFile && b.nodeType == .audioFile { return false }
                return false
            }
        }
        outlineView.reloadData()
        
        // Expand everything if searching to show results
        if !searchQuery.isEmpty {
            for item in filteredItems {
                outlineView.expandItem(item, expandChildren: true)
            }
        }
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
    case vst2         // External VST2 plugin
    case vst3         // External VST3 plugin
}

/// Tree node for the browser outline view.
class BrowserNode: NSObject {
    let name: String
    let icon: String
    let isGroup: Bool
    let nodeType: BrowserNodeType
    var children: [BrowserNode] = []
    var fileURL: URL?

    init(name: String, icon: String, isGroup: Bool = false, nodeType: BrowserNodeType = .generic, fileURL: URL? = nil) {
        self.name = name
        self.icon = icon
        self.isGroup = isGroup
        self.nodeType = nodeType
        self.fileURL = fileURL
        super.init()
    }

    /// Returns a clone of this node and its children that match the search query.
    /// If a node matches, it is included. If a child matches, the parent is included too.
    func filteredClone(query: String) -> BrowserNode? {
        // Recursive step: filter children
        let filteredChildren = children.compactMap { $0.filteredClone(query: query) }
        
        // Inclusion condition: self matches OR has matching children
        let selfMatches = name.lowercased().contains(query)
        
        if selfMatches || !filteredChildren.isEmpty {
            let newNode = BrowserNode(name: name, icon: icon, isGroup: isGroup, nodeType: nodeType, fileURL: fileURL)
            newNode.children = filteredChildren
            return newNode
        }
        
        return nil
    }
}

// MARK: - NSOutlineViewDataSource

extension BrowserSidebarView: NSOutlineViewDataSource {

    public func outlineView(_ outlineView: NSOutlineView, numberOfChildrenOfItem item: Any?) -> Int {
        if item == nil { return filteredItems.count }
        if let node = item as? BrowserNode { return node.children.count }
        return 0
    }

    public func outlineView(_ outlineView: NSOutlineView, child index: Int, ofItem item: Any?) -> Any {
        if item == nil { return filteredItems[index] }
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
        if let fileURL = node.fileURL, node.nodeType == .audioFile {
            return fileURL as NSURL
        }

        // Instruments / Effects → drag as custom pasteboard item
        if node.nodeType != .generic {
            let pasteboardItem = NSPasteboardItem()
            
            // For external plugins, we use the path as the payload to ensure we can load them
            let payloadValue: String
            if (node.nodeType == .vst2 || node.nodeType == .vst3), let path = node.fileURL?.path {
                payloadValue = path
            } else {
                payloadValue = node.name
            }
            
            // Encode as "type:payload" — e.g. "instrument:Simple Sine Synth" or "vst3:/Path/To/Plugin.vst3"
            let payload = "\(node.nodeType.rawValue):\(payloadValue)"
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
        case .vst2, .vst3:
            return NSColor(red: 0.20, green: 0.85, blue: 0.55, alpha: 1.0)  // Mint green — VSTs
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

        if let fileURL = node.fileURL, node.nodeType == .audioFile {
            playPreview(url: fileURL)
        } else {
            stopPreview()
        }
    }
}
