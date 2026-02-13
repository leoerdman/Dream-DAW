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

/// Ableton-style browser with two panes:
/// left = categories, right = result list.
public final class BrowserSidebarView: NSView {

    // MARK: - Properties

    public var isCollapsed: Bool = false {
        didSet { needsLayout = true }
    }

    private let searchField = NSSearchField()
    private let searchContainer = NSView()
    private let backgroundView = NSView()

    private let splitView = NSSplitView()

    private let categoriesScrollView = NSScrollView()
    private let categoriesOutlineView = NSOutlineView()

    private let resultsScrollView = NSScrollView()
    private let resultsTableView = NSTableView()

    private var rootItems: [BrowserNode] = []
    private var categoryItems: [BrowserNode] = []
    private var resultItems: [BrowserNode] = []

    private var selectedCategory: BrowserNode?

    private var samplesObserver: Any?
    private var vstObserver: Any?

    private var previewPlayer: AVAudioPlayer?
    private var searchQuery: String = ""

    private var favoriteKeys: Set<String> = []
    private let favoritesDefaultsKey = "DreamDAW.BrowserFavorites.v1"

    private let browserContextMenu = NSMenu(title: "Browser")
    private var contextMenuNode: BrowserNode?

    private let categoryPaneWidthDefaultsKey = "DreamDAW.Browser.CategoryPaneWidth.v1"

    public override var isFlipped: Bool { true }

    // MARK: - Initialization

    public override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        setupUI()
        loadFavorites()
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

    public func stopPreview() {
        previewPlayer?.stop()
        previewPlayer = nil
    }

    // MARK: - Setup

    private func setupUI() {
        wantsLayer = true
        layer?.backgroundColor = DreamTheme.bgBrowser.cgColor

        backgroundView.wantsLayer = true
        backgroundView.layer?.backgroundColor = DreamTheme.bgBrowser.cgColor
        addSubview(backgroundView)

        searchContainer.wantsLayer = true
        searchContainer.layer?.backgroundColor = DreamTheme.bgHeader.cgColor
        searchContainer.layer?.borderColor = DreamTheme.divider.cgColor
        searchContainer.layer?.borderWidth = 1
        addSubview(searchContainer)

        searchField.placeholderString = "Search (Cmd+F)"
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

        setupCategoriesPane()
        setupResultsPane()

        splitView.dividerStyle = .thin
        splitView.isVertical = true
        splitView.delegate = self
        splitView.addArrangedSubview(categoriesScrollView)
        splitView.addArrangedSubview(resultsScrollView)
        addSubview(splitView)

        browserContextMenu.delegate = self
    }

    private func setupCategoriesPane() {
        categoriesOutlineView.headerView = nil
        categoriesOutlineView.rowHeight = 20
        categoriesOutlineView.indentationPerLevel = 14
        categoriesOutlineView.style = .sourceList
        categoriesOutlineView.floatsGroupRows = false

        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("categoryName"))
        column.isEditable = false
        categoriesOutlineView.addTableColumn(column)
        categoriesOutlineView.outlineTableColumn = column

        categoriesOutlineView.dataSource = self
        categoriesOutlineView.delegate = self
        categoriesOutlineView.menu = browserContextMenu

        categoriesOutlineView.setDraggingSourceOperationMask([.copy, .link], forLocal: false)
        categoriesOutlineView.setDraggingSourceOperationMask([.copy, .link], forLocal: true)

        categoriesScrollView.wantsLayer = true
        categoriesScrollView.drawsBackground = false
        categoriesScrollView.hasVerticalScroller = true
        categoriesScrollView.hasHorizontalScroller = false
        categoriesScrollView.scrollerStyle = .overlay
        categoriesScrollView.autohidesScrollers = true
        categoriesScrollView.documentView = categoriesOutlineView
    }

    private func setupResultsPane() {
        resultsTableView.headerView = nil
        resultsTableView.rowHeight = 21
        resultsTableView.intercellSpacing = NSSize(width: 0, height: 0)
        resultsTableView.allowsMultipleSelection = false

        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("resultName"))
        column.isEditable = false
        resultsTableView.addTableColumn(column)

        resultsTableView.dataSource = self
        resultsTableView.delegate = self
        resultsTableView.menu = browserContextMenu

        resultsTableView.setDraggingSourceOperationMask([.copy, .link], forLocal: false)
        resultsTableView.setDraggingSourceOperationMask([.copy, .link], forLocal: true)

        resultsScrollView.wantsLayer = true
        resultsScrollView.drawsBackground = false
        resultsScrollView.hasVerticalScroller = true
        resultsScrollView.hasHorizontalScroller = false
        resultsScrollView.scrollerStyle = .overlay
        resultsScrollView.autohidesScrollers = true
        resultsScrollView.documentView = resultsTableView
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

        splitView.frame = CGRect(
            x: 0,
            y: searchAreaH,
            width: bounds.width,
            height: bounds.height - searchAreaH
        )

        if splitView.subviews.count >= 2 {
            let minCategories: CGFloat = 150
            let maxCategories: CGFloat = max(minCategories, bounds.width * 0.6)
            let savedWidth = UserDefaults.standard.double(forKey: categoryPaneWidthDefaultsKey)
            let preferred = savedWidth > 0 ? CGFloat(savedWidth) : bounds.width * 0.38
            let categoryWidth = min(maxCategories, max(minCategories, preferred))

            var leftFrame = splitView.subviews[0].frame
            leftFrame.size.width = categoryWidth
            splitView.setPosition(leftFrame.width, ofDividerAt: 0)
        }
    }

    // MARK: - Tree Building

    private func buildTree() {
        rootItems.removeAll()

        let collections = BrowserNode(name: "Collections", icon: "star.fill", isGroup: true)
        let favoritesNode = BrowserNode(name: "Favorites", icon: "star.fill", isGroup: true)
        collections.children = [favoritesNode]
        rootItems.append(collections)

        let library = BrowserNode(name: "Library", icon: "folder.fill", isGroup: true)

        let instruments = BrowserNode(name: "Instruments", icon: "pianokeys", isGroup: true)
        instruments.children = [
            BrowserNode(name: "Simple Sine Synth", icon: "waveform.path", nodeType: .instrument),
            BrowserNode(name: "Sampler", icon: "waveform.badge.plus", nodeType: .instrument),
        ]

        let audioEffects = BrowserNode(name: "Audio Effects", icon: "wand.and.stars", isGroup: true)
        audioEffects.children = [
            BrowserNode(name: "EQ Eight", icon: "slider.horizontal.3", nodeType: .audioEffect),
            BrowserNode(name: "Compressor", icon: "gauge.with.dots.needle.33percent", nodeType: .audioEffect),
            BrowserNode(name: "Delay", icon: "clock.arrow.2.circlepath", nodeType: .audioEffect),
            BrowserNode(name: "Reverb", icon: "waveform.path.ecg", nodeType: .audioEffect),
            BrowserNode(name: "Chorus-Ensemble", icon: "waveform.path.badge.plus", nodeType: .audioEffect),
            BrowserNode(name: "Utility", icon: "wrench", nodeType: .audioEffect),
        ]

        let midiEffects = BrowserNode(name: "MIDI Effects", icon: "sparkles", isGroup: true)
        midiEffects.children = [
            BrowserNode(name: "Arpeggiator", icon: "arrow.up.right", nodeType: .midiEffect),
            BrowserNode(name: "Chord", icon: "music.note.list", nodeType: .midiEffect),
            BrowserNode(name: "Note Length", icon: "ruler", nodeType: .midiEffect),
            BrowserNode(name: "Scale", icon: "tuningfork", nodeType: .midiEffect),
        ]

        let plugIns = BrowserNode(name: "Plug-Ins", icon: "puzzlepiece.fill", isGroup: true)
        let audioUnits = BrowserNode(name: "Audio Units", icon: "cpu")
        let vsts = loadPlugins()
        plugIns.children = [audioUnits] + vsts

        let allNode = BrowserNode(name: "All", icon: "line.3.horizontal.decrease", isGroup: true)

        library.children = [
            allNode,
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

        let places = BrowserNode(name: "Places", icon: "externaldrive.fill", isGroup: true)
        places.children = [
            BrowserNode(name: "User Library", icon: "person.crop.circle"),
            BrowserNode(name: "Current Project", icon: "doc.fill"),
        ]
        rootItems.append(places)

        let samplesNode = loadSamplesFolder()
        if let samplesNode = samplesNode {
            rootItems.append(samplesNode)
        }

        let allLeafs = collectLeafNodes(from: [library, places, samplesNode].compactMap { $0 })
        allNode.children = allLeafs

        let favoriteLeafs = allLeafs.filter { favoriteKeys.contains(favoriteKey(for: $0)) }
        favoritesNode.children = favoriteLeafs

        categoryItems = rootItems
        categoriesOutlineView.reloadData()

        for item in rootItems {
            categoriesOutlineView.expandItem(item, expandChildren: true)
        }

        if selectedCategory == nil {
            if let defaultNode = findNode(named: "All", in: rootItems) ?? rootItems.first {
                selectCategory(defaultNode)
            }
        } else {
            updateResultItems()
        }
    }

    private func findNode(named name: String, in roots: [BrowserNode]) -> BrowserNode? {
        for root in roots {
            if root.name == name { return root }
            if let found = findNode(named: name, in: root.children) { return found }
        }
        return nil
    }

    private func selectCategory(_ node: BrowserNode) {
        selectedCategory = node
        updateResultItems()
    }

    private func updateResultItems() {
        guard let category = selectedCategory else {
            resultItems = []
            resultsTableView.reloadData()
            return
        }

        let allLeafs = collectLeafNodes(from: [category])
        let filtered = allLeafs.filter { node in
            guard !searchQuery.isEmpty else { return true }
            return node.name.lowercased().contains(searchQuery)
        }

        resultItems = filtered.sorted { a, b in
            if a.nodeType == .audioFile && b.nodeType != .audioFile { return true }
            if a.nodeType != .audioFile && b.nodeType == .audioFile { return false }
            return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
        }

        resultsTableView.reloadData()
    }

    private func loadSamplesFolder() -> BrowserNode? {
        let samplesPath = AppSettings.shared.samplesPath
        guard !samplesPath.isEmpty else { return nil }

        let samplesURL = URL(fileURLWithPath: samplesPath)
        guard FileManager.default.fileExists(atPath: samplesPath) else { return nil }

        let samplesNode = BrowserNode(name: "Samples", icon: "waveform", isGroup: true)
        samplesNode.children = scanDirectory(url: samplesURL, depth: 0, maxDepth: 8)
        return samplesNode
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

    private func favoriteKey(for node: BrowserNode) -> String {
        if let url = node.fileURL {
            return "file:\(url.path)"
        }
        return "\(node.nodeType.rawValue):\(node.name)"
    }

    private func loadFavorites() {
        let array = UserDefaults.standard.stringArray(forKey: favoritesDefaultsKey) ?? []
        favoriteKeys = Set(array)
    }

    private func saveFavorites() {
        UserDefaults.standard.set(Array(favoriteKeys).sorted(), forKey: favoritesDefaultsKey)
    }

    private func toggleFavorite(_ node: BrowserNode) {
        let key = favoriteKey(for: node)
        if favoriteKeys.contains(key) {
            favoriteKeys.remove(key)
        } else {
            favoriteKeys.insert(key)
        }
        saveFavorites()
        buildTree()
    }

    private func collectLeafNodes(from roots: [BrowserNode]) -> [BrowserNode] {
        var out: [BrowserNode] = []
        var seen = Set<String>()

        func visit(_ node: BrowserNode) {
            if node.isGroup {
                for child in node.children {
                    visit(child)
                }
                return
            }

            let key = favoriteKey(for: node)
            guard !seen.contains(key) else { return }
            seen.insert(key)

            let copy = BrowserNode(
                name: node.name,
                icon: node.icon,
                isGroup: false,
                nodeType: node.nodeType,
                fileURL: node.fileURL
            )
            out.append(copy)
        }

        for root in roots {
            visit(root)
        }
        return out
    }

    // MARK: - Search

    public func focusSearch() {
        if window?.firstResponder == searchField.currentEditor() {
            searchField.stringValue = ""
            searchQuery = ""
            updateResultItems()
        }

        window?.makeFirstResponder(searchField)
        searchField.currentEditor()?.selectAll(nil)
    }

    @objc private func searchChanged(_ sender: NSSearchField) {
        self.searchQuery = sender.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        updateResultItems()
    }

    // MARK: - Shared Cell Configuration

    private func iconTint(for node: BrowserNode) -> NSColor {
        if node.isGroup {
            return NSColor(red: 0.50, green: 0.45, blue: 0.37, alpha: 1.0)
        }

        switch node.nodeType {
        case .instrument:
            return NSColor(red: 0.95, green: 0.75, blue: 0.25, alpha: 1.0)
        case .audioEffect:
            return NSColor(red: 0.35, green: 0.70, blue: 0.90, alpha: 1.0)
        case .midiEffect:
            return NSColor(red: 0.65, green: 0.50, blue: 0.90, alpha: 1.0)
        case .audioFile:
            return DreamTheme.textSecondary
        case .vst2, .vst3:
            return NSColor(red: 0.20, green: 0.85, blue: 0.55, alpha: 1.0)
        case .generic:
            if node.name == "Favorites" { return NSColor(red: 0.95, green: 0.78, blue: 0.20, alpha: 1.0) }
            return DreamTheme.textSecondary
        }
    }

    private func configureTextAndIcon(for cellView: NSTableCellView, node: BrowserNode, compactSectionStyle: Bool) {
        if node.isGroup && compactSectionStyle {
            cellView.textField?.stringValue = node.name
            cellView.textField?.font = NSFont.systemFont(ofSize: 10, weight: .semibold)
            cellView.textField?.textColor = NSColor(red: 0.55, green: 0.50, blue: 0.40, alpha: 1.0)
        } else {
            let isFav = favoriteKeys.contains(favoriteKey(for: node))
            cellView.textField?.stringValue = isFav ? "★ \(node.name)" : node.name
            cellView.textField?.font = NSFont.systemFont(ofSize: 11, weight: .regular)
            cellView.textField?.textColor = DreamTheme.textPrimary
        }

        if let symbolImage = NSImage(systemSymbolName: node.icon, accessibilityDescription: nil) {
            let iconSize: CGFloat = node.isGroup && compactSectionStyle ? 9 : 10
            let config = NSImage.SymbolConfiguration(pointSize: iconSize, weight: .medium)
            cellView.imageView?.image = symbolImage.withSymbolConfiguration(config)
            cellView.imageView?.contentTintColor = iconTint(for: node)
        }
    }

    private func makeOrReuseCell(in tableView: NSTableView, id: NSUserInterfaceItemIdentifier) -> NSTableCellView {
        if let reused = tableView.makeView(withIdentifier: id, owner: self) as? NSTableCellView {
            return reused
        }

        let cellView = NSTableCellView()
        cellView.identifier = id

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

        return cellView
    }

    private func pasteboardWriter(for node: BrowserNode) -> NSPasteboardWriting? {
        if let fileURL = node.fileURL, node.nodeType == .audioFile {
            return fileURL as NSURL
        }

        if node.nodeType != .generic {
            let pasteboardItem = NSPasteboardItem()
            let payloadValue: String
            if (node.nodeType == .vst2 || node.nodeType == .vst3), let path = node.fileURL?.path {
                payloadValue = path
            } else {
                payloadValue = node.name
            }
            let payload = "\(node.nodeType.rawValue):\(payloadValue)"
            pasteboardItem.setString(payload, forType: .browserItem)
            return pasteboardItem
        }

        return nil
    }
}

// MARK: - BrowserNode

enum BrowserNodeType: String {
    case generic
    case instrument
    case audioEffect
    case midiEffect
    case audioFile
    case vst2
    case vst3
}

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
}

// MARK: - NSSplitViewDelegate

extension BrowserSidebarView: NSSplitViewDelegate {
    public func splitView(_ splitView: NSSplitView, constrainSplitPosition proposedPosition: CGFloat, ofSubviewAt dividerIndex: Int) -> CGFloat {
        guard dividerIndex == 0 else { return proposedPosition }
        let minLeft: CGFloat = 140
        let maxLeft: CGFloat = max(minLeft, splitView.bounds.width * 0.65)
        return min(maxLeft, max(minLeft, proposedPosition))
    }

    public func splitViewDidResizeSubviews(_ notification: Notification) {
        guard splitView.subviews.count >= 2 else { return }
        let leftWidth = splitView.subviews[0].frame.width
        UserDefaults.standard.set(Double(leftWidth), forKey: categoryPaneWidthDefaultsKey)
    }
}

// MARK: - NSOutlineViewDataSource / Delegate (Categories)

extension BrowserSidebarView: NSOutlineViewDataSource, NSOutlineViewDelegate {
    public func outlineView(_ outlineView: NSOutlineView, numberOfChildrenOfItem item: Any?) -> Int {
        if item == nil { return categoryItems.count }
        if let node = item as? BrowserNode { return node.children.count }
        return 0
    }

    public func outlineView(_ outlineView: NSOutlineView, child index: Int, ofItem item: Any?) -> Any {
        if item == nil { return categoryItems[index] }
        if let node = item as? BrowserNode { return node.children[index] }
        return ""
    }

    public func outlineView(_ outlineView: NSOutlineView, isItemExpandable item: Any) -> Bool {
        guard let node = item as? BrowserNode else { return false }
        return node.isGroup && !node.children.isEmpty
    }

    public func outlineView(_ outlineView: NSOutlineView, viewFor tableColumn: NSTableColumn?, item: Any) -> NSView? {
        guard let node = item as? BrowserNode else { return nil }
        let cell = makeOrReuseCell(in: categoriesOutlineView, id: NSUserInterfaceItemIdentifier("CategoryCell"))
        configureTextAndIcon(for: cell, node: node, compactSectionStyle: true)
        return cell
    }

    public func outlineView(_ outlineView: NSOutlineView, shouldSelectItem item: Any) -> Bool {
        guard let node = item as? BrowserNode else { return false }
        // Top-level section labels are not selectable; all others are.
        if categoryItems.contains(where: { $0 === node }) {
            return false
        }
        return true
    }

    public func outlineViewSelectionDidChange(_ notification: Notification) {
        guard notification.object as AnyObject? === categoriesOutlineView else { return }
        let row = categoriesOutlineView.selectedRow
        guard row >= 0, let node = categoriesOutlineView.item(atRow: row) as? BrowserNode else { return }
        selectCategory(node)
    }

    public func outlineView(_ outlineView: NSOutlineView, pasteboardWriterForItem item: Any) -> NSPasteboardWriting? {
        guard let node = item as? BrowserNode else { return nil }
        return pasteboardWriter(for: node)
    }
}

// MARK: - NSTableViewDataSource / Delegate (Results)

extension BrowserSidebarView: NSTableViewDataSource, NSTableViewDelegate {
    public func numberOfRows(in tableView: NSTableView) -> Int {
        if tableView === resultsTableView {
            return resultItems.count
        }
        return 0
    }

    public func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        guard tableView === resultsTableView,
              row >= 0, row < resultItems.count else { return nil }

        let node = resultItems[row]
        let cell = makeOrReuseCell(in: resultsTableView, id: NSUserInterfaceItemIdentifier("ResultCell"))
        configureTextAndIcon(for: cell, node: node, compactSectionStyle: false)
        return cell
    }

    public func tableViewSelectionDidChange(_ notification: Notification) {
        guard notification.object as AnyObject? === resultsTableView else { return }
        let row = resultsTableView.selectedRow
        guard row >= 0, row < resultItems.count else {
            stopPreview()
            return
        }

        let node = resultItems[row]
        if let fileURL = node.fileURL, node.nodeType == .audioFile {
            playPreview(url: fileURL)
        } else {
            stopPreview()
        }
    }

    public func tableView(_ tableView: NSTableView, pasteboardWriterForRow row: Int) -> NSPasteboardWriting? {
        guard tableView === resultsTableView,
              row >= 0, row < resultItems.count else { return nil }
        return pasteboardWriter(for: resultItems[row])
    }
}

// MARK: - Browser Context Menu

extension BrowserSidebarView: NSMenuDelegate {
    public func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()

        var node: BrowserNode?

        if resultsTableView.clickedRow >= 0,
           resultsTableView.clickedRow < resultItems.count {
            node = resultItems[resultsTableView.clickedRow]
        } else if categoriesOutlineView.clickedRow >= 0,
                  let clicked = categoriesOutlineView.item(atRow: categoriesOutlineView.clickedRow) as? BrowserNode,
                  !clicked.isGroup {
            node = clicked
        }

        guard let contextNode = node else { return }
        contextMenuNode = contextNode

        let key = favoriteKey(for: contextNode)
        let isFav = favoriteKeys.contains(key)

        let favTitle = isFav ? "Remove from Favorites" : "Add to Favorites"
        let favItem = NSMenuItem(title: favTitle, action: #selector(toggleFavoriteFromMenu), keyEquivalent: "")
        favItem.target = self
        menu.addItem(favItem)

        if contextNode.fileURL != nil {
            menu.addItem(NSMenuItem.separator())
            let revealItem = NSMenuItem(title: "Reveal in Finder", action: #selector(revealInFinderFromMenu), keyEquivalent: "")
            revealItem.target = self
            menu.addItem(revealItem)
        }
    }

    @objc private func toggleFavoriteFromMenu() {
        guard let node = contextMenuNode else { return }
        toggleFavorite(node)
    }

    @objc private func revealInFinderFromMenu() {
        guard let url = contextMenuNode?.fileURL else { return }
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }
}
