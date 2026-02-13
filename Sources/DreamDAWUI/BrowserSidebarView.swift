import AppKit
import AVFoundation
import DreamDAWModels
import DreamDAWEngine

extension NSPasteboard.PasteboardType {
    static let browserItem = NSPasteboard.PasteboardType("com.dreamdaw.browser-item")
    static let browserCategoryRow = NSPasteboard.PasteboardType("com.dreamdaw.browser-category-row")
}

private final class BrowserFlippedView: NSView {
    override var isFlipped: Bool { true }
}

public final class BrowserSidebarView: NSView {

    private struct BrowserCategory {
        enum Kind {
            case section
            case favorites
            case all
            case sounds
            case drums
            case instruments
            case audioEffects
            case midiEffects
            case plugins
            case clips
            case templates
            case samples
            case userLibrary
            case currentProject
            case customFolder
            case addFolder
        }

        let id: String
        let title: String
        let icon: String
        let kind: Kind
        let folderPath: String?
    }

    private enum ResultTypeFilter: String, CaseIterable {
        case all = "All"
        case audioFiles = "Audio"
        case instruments = "Instruments"
        case audioEffects = "Audio FX"
        case midiEffects = "MIDI FX"
        case plugins = "Plug-ins"
    }

    private enum SourceFilter: String, CaseIterable {
        case all = "Source: All"
        case library = "Source: Library"
        case samples = "Source: Samples"
        case plugins = "Source: Plug-ins"
    }

    private enum FormatFilter: String, CaseIterable {
        case all = "Format: All"
        case wav = "WAV"
        case aiff = "AIFF"
        case mp3 = "MP3"
        case m4a = "M4A"
        case flac = "FLAC"
        case ogg = "OGG"
        case caf = "CAF"
    }

    private enum AudioRoleFilter: String, CaseIterable {
        case all = "Audio: All"
        case loops = "Loops"
        case oneshots = "One Shot"
        case drums = "Drums"
        case vocals = "Vocals"
    }

    private enum SortOrder {
        case nameAsc
        case nameDesc

        var title: String {
            switch self {
            case .nameAsc: return "Name ↑"
            case .nameDesc: return "Name ↓"
            }
        }
    }

    private let backgroundView = NSView()
    private let searchContainer = NSView()
    private let searchField = NSSearchField()

    private let splitView = NSSplitView()

    private let categoriesScrollView = NSScrollView()
    private let categoriesTableView = NSTableView()

    private let resultsContainer = BrowserFlippedView()
    private let resultsToolbar = NSView()
    private let filtersScrollView = NSScrollView()
    private let filtersContentView = BrowserFlippedView()
    private let typeFilterButton = NSPopUpButton(frame: .zero, pullsDown: false)
    private let sourceFilterButton = NSPopUpButton(frame: .zero, pullsDown: false)
    private let formatFilterButton = NSPopUpButton(frame: .zero, pullsDown: false)
    private let audioRoleFilterButton = NSPopUpButton(frame: .zero, pullsDown: false)
    private let favoritesOnlyButton = NSButton(checkboxWithTitle: "Favorites", target: nil, action: nil)
    private let sortOrderButton = NSButton(title: "Name ↑", target: nil, action: nil)
    private let clearFiltersButton = NSButton(title: "Reset", target: nil, action: nil)
    private let resultCountLabel = NSTextField(labelWithString: "0")

    private let resultsScrollView = NSScrollView()
    private let resultsTableView = NSTableView()
    private let previewContainer = NSView()
    private let previewToggleButton = NSButton()
    private let previewWaveformView = BrowserPreviewWaveformView()
    private let previewStatusLabel = NSTextField(labelWithString: "No preview")

    private let appSettings = AppSettings.shared
    private var categories: [BrowserCategory] = []
    private var selectedCategoryID: String = "all"
    private var allLeafNodes: [BrowserNode] = []
    private var resultItems: [BrowserNode] = []

    private var searchQuery: String = ""
    private var typeFilter: ResultTypeFilter = .all
    private var sourceFilter: SourceFilter = .all
    private var formatFilter: FormatFilter = .all
    private var audioRoleFilter: AudioRoleFilter = .all
    private var favoritesOnly = false
    private var sortOrder: SortOrder = .nameAsc
    private var previewEnabled = true

    private var samplesObserver: Any?
    private var vstObserver: Any?
    private var previewPlayer: AVAudioPlayer?
    private var currentPreviewFileURL: URL?

    private var favoriteKeys: Set<String> = []
    private let favoritesDefaultsKey = "DreamDAW.BrowserFavorites.v1"

    private let browserContextMenu = NSMenu(title: "Browser")
    private var contextMenuNode: BrowserNode?
    private var contextMenuCategory: BrowserCategory?

    private let categoryPaneWidthDefaultsKey = "DreamDAW.Browser.CategoryPaneWidth.v1"
    private var didApplyInitialCategoryPaneWidth = false

    public override var isFlipped: Bool { true }

    public override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        setupUI()
        loadFavorites()
        buildCategories()
        rebuildData()
        observeSettings()
        refreshPreviewControls()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    deinit {
        previewPlayer?.stop()
        if let obs = samplesObserver { NotificationCenter.default.removeObserver(obs) }
        if let obs = vstObserver { NotificationCenter.default.removeObserver(obs) }
    }

    // MARK: - Public API

    public func focusSearch() {
        if window?.firstResponder == searchField.currentEditor() {
            searchField.stringValue = ""
            searchQuery = ""
            updateResults()
        }

        window?.makeFirstResponder(searchField)
        searchField.currentEditor()?.selectAll(nil)
    }

    public func stopPreview() {
        previewPlayer?.stop()
        previewPlayer = nil
        refreshPreviewControls()
    }

    // MARK: - UI

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
        searchField.font = NSFont.systemFont(ofSize: 12, weight: .regular)
        searchField.focusRingType = .none
        searchField.isBezeled = true
        searchField.isBordered = true
        searchField.drawsBackground = true
        searchField.backgroundColor = DreamTheme.bgSecondary
        searchField.textColor = DreamTheme.textPrimary
        searchField.appearance = NSAppearance(named: .darkAqua)
        searchField.target = self
        searchField.action = #selector(searchChanged)
        searchContainer.addSubview(searchField)

        setupCategoryPane()
        setupResultsPane()

        splitView.isVertical = true
        splitView.dividerStyle = .thin
        splitView.wantsLayer = true
        splitView.layer?.backgroundColor = DreamTheme.bgBrowser.cgColor
        splitView.delegate = self
        splitView.addArrangedSubview(categoriesScrollView)
        splitView.addArrangedSubview(resultsContainer)
        addSubview(splitView)

        browserContextMenu.delegate = self
        resultsTableView.menu = browserContextMenu
        categoriesTableView.menu = browserContextMenu
    }

    private func setupCategoryPane() {
        categoriesTableView.headerView = nil
        categoriesTableView.rowHeight = 22
        categoriesTableView.intercellSpacing = NSSize(width: 0, height: 0)
        categoriesTableView.allowsEmptySelection = false
        categoriesTableView.allowsMultipleSelection = false
        categoriesTableView.registerForDraggedTypes([.browserCategoryRow])
        categoriesTableView.setDraggingSourceOperationMask(.move, forLocal: true)
        categoriesTableView.setDraggingSourceOperationMask([], forLocal: false)

        let col = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("category"))
        col.isEditable = false
        categoriesTableView.addTableColumn(col)

        categoriesTableView.delegate = self
        categoriesTableView.dataSource = self

        categoriesScrollView.drawsBackground = false
        categoriesScrollView.wantsLayer = true
        categoriesScrollView.layer?.backgroundColor = DreamTheme.bgBrowser.cgColor
        categoriesScrollView.hasVerticalScroller = true
        categoriesScrollView.hasHorizontalScroller = false
        categoriesScrollView.scrollerStyle = .overlay
        categoriesScrollView.autohidesScrollers = true
        categoriesScrollView.documentView = categoriesTableView
    }

    private func setupResultsPane() {
        resultsContainer.wantsLayer = true
        resultsContainer.layer?.backgroundColor = DreamTheme.bgBrowser.cgColor
        resultsContainer.layer?.masksToBounds = true

        resultsToolbar.wantsLayer = true
        resultsToolbar.layer?.backgroundColor = DreamTheme.bgHeader.cgColor
        resultsToolbar.layer?.borderColor = DreamTheme.divider.cgColor
        resultsToolbar.layer?.borderWidth = 1
        resultsToolbar.layer?.masksToBounds = true
        resultsContainer.addSubview(resultsToolbar)

        filtersScrollView.drawsBackground = false
        filtersScrollView.hasVerticalScroller = true
        filtersScrollView.hasHorizontalScroller = false
        filtersScrollView.scrollerStyle = .overlay
        filtersScrollView.autohidesScrollers = true
        filtersScrollView.documentView = filtersContentView
        resultsToolbar.addSubview(filtersScrollView)

        filtersContentView.wantsLayer = true
        filtersContentView.layer?.backgroundColor = DreamTheme.bgHeader.cgColor

        typeFilterButton.addItems(withTitles: ResultTypeFilter.allCases.map { $0.rawValue })
        typeFilterButton.controlSize = .small
        typeFilterButton.font = NSFont.systemFont(ofSize: 11, weight: .medium)
        typeFilterButton.target = self
        typeFilterButton.action = #selector(typeFilterChanged)
        filtersContentView.addSubview(typeFilterButton)

        sourceFilterButton.addItems(withTitles: SourceFilter.allCases.map { $0.rawValue })
        sourceFilterButton.controlSize = .small
        sourceFilterButton.font = NSFont.systemFont(ofSize: 11, weight: .medium)
        sourceFilterButton.target = self
        sourceFilterButton.action = #selector(sourceFilterChanged)
        filtersContentView.addSubview(sourceFilterButton)

        formatFilterButton.addItems(withTitles: FormatFilter.allCases.map { $0.rawValue })
        formatFilterButton.controlSize = .small
        formatFilterButton.font = NSFont.systemFont(ofSize: 11, weight: .medium)
        formatFilterButton.target = self
        formatFilterButton.action = #selector(formatFilterChanged)
        filtersContentView.addSubview(formatFilterButton)

        audioRoleFilterButton.addItems(withTitles: AudioRoleFilter.allCases.map { $0.rawValue })
        audioRoleFilterButton.controlSize = .small
        audioRoleFilterButton.font = NSFont.systemFont(ofSize: 11, weight: .medium)
        audioRoleFilterButton.target = self
        audioRoleFilterButton.action = #selector(audioRoleFilterChanged)
        filtersContentView.addSubview(audioRoleFilterButton)

        favoritesOnlyButton.font = NSFont.systemFont(ofSize: 11, weight: .medium)
        favoritesOnlyButton.target = self
        favoritesOnlyButton.action = #selector(favoritesOnlyChanged)
        filtersContentView.addSubview(favoritesOnlyButton)

        sortOrderButton.bezelStyle = .rounded
        sortOrderButton.font = NSFont.systemFont(ofSize: 11, weight: .medium)
        sortOrderButton.target = self
        sortOrderButton.action = #selector(toggleSortOrder)
        filtersContentView.addSubview(sortOrderButton)

        clearFiltersButton.bezelStyle = .rounded
        clearFiltersButton.font = NSFont.systemFont(ofSize: 11, weight: .medium)
        clearFiltersButton.target = self
        clearFiltersButton.action = #selector(resetFilters)
        filtersContentView.addSubview(clearFiltersButton)

        resultCountLabel.font = NSFont.monospacedDigitSystemFont(ofSize: 10, weight: .medium)
        resultCountLabel.textColor = DreamTheme.textSecondary
        resultCountLabel.alignment = .right
        filtersContentView.addSubview(resultCountLabel)

        resultsTableView.headerView = nil
        resultsTableView.rowHeight = 21
        resultsTableView.intercellSpacing = NSSize(width: 0, height: 0)
        resultsTableView.allowsMultipleSelection = false

        let col = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("result"))
        col.isEditable = false
        resultsTableView.addTableColumn(col)

        resultsTableView.delegate = self
        resultsTableView.dataSource = self
        resultsTableView.setDraggingSourceOperationMask([.copy, .link], forLocal: false)
        resultsTableView.setDraggingSourceOperationMask([.copy, .link], forLocal: true)

        resultsScrollView.drawsBackground = false
        resultsScrollView.wantsLayer = true
        resultsScrollView.layer?.backgroundColor = DreamTheme.bgBrowser.cgColor
        resultsScrollView.hasVerticalScroller = true
        resultsScrollView.hasHorizontalScroller = false
        resultsScrollView.scrollerStyle = .overlay
        resultsScrollView.autohidesScrollers = true
        resultsScrollView.documentView = resultsTableView
        resultsContainer.addSubview(resultsScrollView)

        previewContainer.wantsLayer = true
        previewContainer.layer?.backgroundColor = DreamTheme.bgBrowser.cgColor
        previewContainer.layer?.borderColor = DreamTheme.divider.cgColor
        previewContainer.layer?.borderWidth = 1
        previewContainer.layer?.masksToBounds = true
        resultsContainer.addSubview(previewContainer)

        previewToggleButton.title = ""
        previewToggleButton.bezelStyle = .texturedRounded
        previewToggleButton.font = NSFont.systemFont(ofSize: 12, weight: .semibold)
        previewToggleButton.image = NSImage(systemSymbolName: "headphones", accessibilityDescription: "Preview")
        previewToggleButton.imagePosition = .imageOnly
        previewToggleButton.target = self
        previewToggleButton.action = #selector(togglePreviewEnabled)
        previewContainer.addSubview(previewToggleButton)

        previewWaveformView.wantsLayer = true
        previewWaveformView.layer?.cornerRadius = 3
        previewWaveformView.layer?.masksToBounds = true
        previewWaveformView.layer?.backgroundColor = DreamTheme.bgSecondary.cgColor
        previewContainer.addSubview(previewWaveformView)

        previewStatusLabel.font = NSFont.systemFont(ofSize: 10, weight: .medium)
        previewStatusLabel.textColor = DreamTheme.textSecondary
        previewStatusLabel.alignment = .right
        previewContainer.addSubview(previewStatusLabel)
    }

    public override func layout() {
        super.layout()

        backgroundView.frame = bounds

        let searchHeight: CGFloat = 38
        searchContainer.frame = CGRect(x: 0, y: 0, width: bounds.width, height: searchHeight)
        searchField.frame = CGRect(x: 8, y: 7, width: max(120, bounds.width - 16), height: 24)

        splitView.frame = CGRect(x: 0, y: searchHeight, width: bounds.width, height: max(0, bounds.height - searchHeight))

        if splitView.subviews.count >= 2 {
            let splitWidth = splitView.bounds.width
            if splitWidth > 20 {
                let minLeft: CGFloat = 110
                let maxLeft: CGFloat = max(minLeft, splitView.bounds.width * 0.7)
                let saved = CGFloat(appSettings.browserCategoryPaneWidth ?? 0)
                let currentLeftWidth = splitView.subviews[0].frame.width
                let desired = saved > 0 ? saved : splitWidth * 0.42
                let needsRecovery = !didApplyInitialCategoryPaneWidth || currentLeftWidth < 60
                if needsRecovery {
                    splitView.setPosition(min(maxLeft, max(minLeft, desired)), ofDividerAt: 0)
                    didApplyInitialCategoryPaneWidth = true
                }
            }
        }

        let toolbarHeight: CGFloat = 76
        let previewHeight: CGFloat = 48
        resultsToolbar.frame = CGRect(x: 0, y: 0, width: resultsContainer.bounds.width, height: toolbarHeight)
        filtersScrollView.frame = CGRect(x: 0, y: 0, width: resultsToolbar.bounds.width, height: toolbarHeight)
        let filtersHeight = layoutFiltersContent(width: filtersScrollView.bounds.width)
        filtersContentView.frame = CGRect(x: 0, y: 0, width: filtersScrollView.bounds.width, height: filtersHeight)

        previewContainer.frame = CGRect(
            x: 0,
            y: max(0, resultsContainer.bounds.height - previewHeight),
            width: resultsContainer.bounds.width,
            height: previewHeight
        )
        let previewPad: CGFloat = 8
        let toggleW: CGFloat = 22
        previewToggleButton.frame = CGRect(x: previewPad, y: 13, width: toggleW, height: 22)
        let showStatus = previewContainer.bounds.width >= 240
        let statusW: CGFloat = showStatus ? 72 : 0
        if showStatus {
            previewStatusLabel.isHidden = false
            previewStatusLabel.frame = CGRect(
                x: previewContainer.bounds.width - previewPad - statusW,
                y: 16,
                width: statusW,
                height: 16
            )
        } else {
            previewStatusLabel.isHidden = true
        }
        let waveformX = previewToggleButton.frame.maxX + 6
        let waveformRightInset = previewPad + (showStatus ? statusW + 6 : 0)
        previewWaveformView.frame = CGRect(
            x: waveformX,
            y: 10,
            width: max(64, previewContainer.bounds.width - waveformX - waveformRightInset),
            height: 28
        )

        resultsScrollView.frame = CGRect(
            x: 0,
            y: toolbarHeight,
            width: resultsContainer.bounds.width,
            height: max(0, resultsContainer.bounds.height - toolbarHeight - previewHeight)
        )
    }

    // MARK: - Data

    private func buildCategories() {
        let fixed: [BrowserCategory] = [
            BrowserCategory(id: "section.collections", title: "Collections", icon: "star.fill", kind: .section, folderPath: nil),
            BrowserCategory(id: "favorites", title: "Favorites", icon: "star.fill", kind: .favorites, folderPath: nil),

            BrowserCategory(id: "section.library", title: "Library", icon: "folder.fill", kind: .section, folderPath: nil),
            BrowserCategory(id: "all", title: "All", icon: "line.3.horizontal.decrease", kind: .all, folderPath: nil),
            BrowserCategory(id: "sounds", title: "Sounds", icon: "music.note", kind: .sounds, folderPath: nil),
            BrowserCategory(id: "drums", title: "Drums", icon: "square.grid.2x2", kind: .drums, folderPath: nil),
            BrowserCategory(id: "instruments", title: "Instruments", icon: "pianokeys", kind: .instruments, folderPath: nil),
            BrowserCategory(id: "audioEffects", title: "Audio Effects", icon: "wand.and.stars", kind: .audioEffects, folderPath: nil),
            BrowserCategory(id: "midiEffects", title: "MIDI Effects", icon: "sparkles", kind: .midiEffects, folderPath: nil),
            BrowserCategory(id: "plugins", title: "Plug-Ins", icon: "puzzlepiece.fill", kind: .plugins, folderPath: nil),
            BrowserCategory(id: "clips", title: "Clips", icon: "film", kind: .clips, folderPath: nil),
            BrowserCategory(id: "templates", title: "Templates", icon: "doc.text", kind: .templates, folderPath: nil),

            BrowserCategory(id: "section.places", title: "Places", icon: "externaldrive.fill", kind: .section, folderPath: nil),
            BrowserCategory(id: "userLibrary", title: "User Library", icon: "person.crop.circle", kind: .userLibrary, folderPath: nil),
            BrowserCategory(id: "currentProject", title: "Current Project", icon: "doc.fill", kind: .currentProject, folderPath: nil),
            BrowserCategory(id: "samples", title: "Samples", icon: "waveform", kind: .samples, folderPath: nil),
        ]

        let custom = appSettings.browserPinnedFolders.map { path -> BrowserCategory in
            let url = URL(fileURLWithPath: path)
            return BrowserCategory(
                id: "folder:\(path)",
                title: url.lastPathComponent.isEmpty ? path : url.lastPathComponent,
                icon: "folder",
                kind: .customFolder,
                folderPath: path
            )
        }
        let addFolder = BrowserCategory(id: "addFolder", title: "Add Folder...", icon: "plus.square.on.square", kind: .addFolder, folderPath: nil)

        var merged = fixed + custom
        let savedOrder = appSettings.browserSidebarOrder
        if !savedOrder.isEmpty {
            var byID: [String: BrowserCategory] = Dictionary(uniqueKeysWithValues: merged.map { ($0.id, $0) })
            var ordered: [BrowserCategory] = []
            for id in savedOrder {
                if let item = byID.removeValue(forKey: id) {
                    ordered.append(item)
                }
            }
            ordered.append(contentsOf: byID.values.sorted { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending })
            merged = ordered
        }
        categories = merged + [addFolder]
    }

    private func rebuildData() {
        allLeafNodes = buildLeafNodes()
        categoriesTableView.reloadData()

        if let idx = categories.firstIndex(where: { $0.id == selectedCategoryID }) {
            categoriesTableView.selectRowIndexes(IndexSet(integer: idx), byExtendingSelection: false)
        } else if let idx = categories.firstIndex(where: { $0.id == "all" }) {
            selectedCategoryID = "all"
            categoriesTableView.selectRowIndexes(IndexSet(integer: idx), byExtendingSelection: false)
        }

        updateResults()
    }

    private func buildLeafNodes() -> [BrowserNode] {
        var roots: [BrowserNode] = []

        let instruments = BrowserNode(name: "Simple Sine Synth", icon: "waveform.path", nodeType: .instrument, source: .library)
        let sampler = BrowserNode(name: "Sampler", icon: "waveform.badge.plus", nodeType: .instrument, source: .library)

        let fx = [
            BrowserNode(name: "EQ Eight", icon: "slider.horizontal.3", nodeType: .audioEffect, source: .library),
            BrowserNode(name: "Compressor", icon: "gauge.with.dots.needle.33percent", nodeType: .audioEffect, source: .library),
            BrowserNode(name: "Delay", icon: "clock.arrow.2.circlepath", nodeType: .audioEffect, source: .library),
            BrowserNode(name: "Reverb", icon: "waveform.path.ecg", nodeType: .audioEffect, source: .library),
            BrowserNode(name: "Utility", icon: "wrench", nodeType: .audioEffect, source: .library),
        ]

        let midiFx = [
            BrowserNode(name: "Arpeggiator", icon: "arrow.up.right", nodeType: .midiEffect, source: .library),
            BrowserNode(name: "Chord", icon: "music.note.list", nodeType: .midiEffect, source: .library),
            BrowserNode(name: "Note Length", icon: "ruler", nodeType: .midiEffect, source: .library),
            BrowserNode(name: "Scale", icon: "tuningfork", nodeType: .midiEffect, source: .library),
        ]

        roots.append(instruments)
        roots.append(sampler)
        roots.append(contentsOf: fx)
        roots.append(contentsOf: midiFx)

        let plugins = PluginManager.shared.availablePlugins
        for plugin in plugins {
            let nType: BrowserNodeType = (plugin.type == .vst2) ? .vst2 : .vst3
            let node = BrowserNode(
                name: plugin.name,
                icon: nType == .vst2 ? "puzzlepiece.extension.fill" : "puzzlepiece.fill",
                nodeType: nType,
                source: .plugins
            )
            node.fileURL = URL(fileURLWithPath: plugin.path)
            roots.append(node)
        }

        if let samplesRoot = loadSamplesFolderNode() {
            roots.append(contentsOf: flattenLeafs(from: samplesRoot))
        }
        for path in appSettings.browserPinnedFolders {
            if let customRoot = loadCustomFolderNode(path: path) {
                roots.append(contentsOf: flattenLeafs(from: customRoot))
            }
        }

        return dedupe(roots)
    }

    private func flattenLeafs(from node: BrowserNode) -> [BrowserNode] {
        if !node.isGroup {
            return [node]
        }
        return node.children.flatMap { flattenLeafs(from: $0) }
    }

    private func dedupe(_ input: [BrowserNode]) -> [BrowserNode] {
        var seen = Set<String>()
        var out: [BrowserNode] = []
        for node in input {
            let key = favoriteKey(for: node)
            if seen.insert(key).inserted {
                out.append(node)
            }
        }
        return out
    }

    private func loadSamplesFolderNode() -> BrowserNode? {
        let samplesPath = AppSettings.shared.samplesPath
        guard !samplesPath.isEmpty else { return nil }
        let rootURL = URL(fileURLWithPath: samplesPath)
        guard FileManager.default.fileExists(atPath: samplesPath) else { return nil }

        let root = BrowserNode(name: "Samples", icon: "waveform", isGroup: true, source: .samples, categoryID: "samples")
        root.children = scanDirectory(url: rootURL, depth: 0, maxDepth: 8, source: .samples, categoryID: "samples")
        return root
    }

    private func loadCustomFolderNode(path: String) -> BrowserNode? {
        guard !path.isEmpty else { return nil }
        guard FileManager.default.fileExists(atPath: path) else { return nil }
        let rootURL = URL(fileURLWithPath: path)
        let categoryID = "folder:\(path)"
        let title = rootURL.lastPathComponent.isEmpty ? path : rootURL.lastPathComponent
        let root = BrowserNode(name: title, icon: "folder", isGroup: true, source: .customFolder, categoryID: categoryID)
        root.children = scanDirectory(url: rootURL, depth: 0, maxDepth: 8, source: .customFolder, categoryID: categoryID)
        return root
    }

    private func scanDirectory(
        url: URL,
        depth: Int,
        maxDepth: Int,
        source: BrowserSource,
        categoryID: String
    ) -> [BrowserNode] {
        guard depth < maxDepth else { return [] }

        let audioExt = Set(["wav", "aiff", "aif", "mp3", "m4a", "flac", "ogg", "caf"])
        guard let contents = try? FileManager.default.contentsOfDirectory(
            at: url,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        ) else {
            return []
        }

        let sorted = contents.sorted { $0.lastPathComponent.localizedCaseInsensitiveCompare($1.lastPathComponent) == .orderedAscending }

        var nodes: [BrowserNode] = []
        for item in sorted {
            let isDir = (try? item.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory ?? false
            if isDir {
                let folder = BrowserNode(name: item.lastPathComponent, icon: "folder.fill", isGroup: true, source: source, categoryID: categoryID)
                folder.children = scanDirectory(url: item, depth: depth + 1, maxDepth: maxDepth, source: source, categoryID: categoryID)
                if !folder.children.isEmpty { nodes.append(folder) }
            } else if audioExt.contains(item.pathExtension.lowercased()) {
                let file = BrowserNode(name: item.lastPathComponent, icon: "waveform", nodeType: .audioFile, source: source, categoryID: categoryID)
                file.fileURL = item
                nodes.append(file)
            }
        }

        return nodes
    }

    private func updateResults() {
        var base = allLeafNodes

        guard let selectedCategory = categories.first(where: { $0.id == selectedCategoryID }) else {
            resultItems = []
            resultCountLabel.stringValue = "0"
            resultsTableView.reloadData()
            return
        }

        switch selectedCategory.kind {
        case .section:
            resultItems = []
            resultCountLabel.stringValue = "0"
            resultsTableView.reloadData()
            return
        case .favorites:
            base = base.filter { favoriteKeys.contains(favoriteKey(for: $0)) }
        case .all:
            break
        case .sounds:
            base = base.filter { $0.nodeType == .audioFile }
        case .drums:
            base = base.filter { node in
                guard node.nodeType == .audioFile else { return false }
                let n = node.name.lowercased()
                return n.contains("drum") || n.contains("kick") || n.contains("snare") || n.contains("hihat") || n.contains("clap")
            }
        case .instruments:
            base = base.filter { $0.nodeType == .instrument }
        case .audioEffects:
            base = base.filter { $0.nodeType == .audioEffect }
        case .midiEffects:
            base = base.filter { $0.nodeType == .midiEffect }
        case .plugins:
            base = base.filter { $0.nodeType == .vst2 || $0.nodeType == .vst3 }
        case .clips:
            base = base.filter { $0.nodeType == .audioFile }
        case .templates:
            base = []
        case .samples:
            base = base.filter { $0.nodeType == .audioFile }
        case .userLibrary:
            base = base.filter { $0.nodeType == .audioFile }
        case .currentProject:
            base = base.filter { $0.nodeType == .audioFile }
        case .customFolder:
            if let categoryID = selectedCategory.folderPath.map({ "folder:\($0)" }) {
                base = base.filter { $0.categoryID == categoryID && $0.nodeType == .audioFile }
            } else {
                base = []
            }
        case .addFolder:
            base = []
        }

        if favoritesOnly {
            base = base.filter { favoriteKeys.contains(favoriteKey(for: $0)) }
        }
        base = applyTypeFilter(base)
        base = applySourceFilter(base)
        base = applyFormatFilter(base)
        base = applyAudioRoleFilter(base)
        base = applySearchFilter(base)
        base = applySort(base)

        resultItems = base
        resultCountLabel.stringValue = "\(base.count)"
        resultsTableView.reloadData()
    }

    private func applyTypeFilter(_ input: [BrowserNode]) -> [BrowserNode] {
        switch typeFilter {
        case .all:
            return input
        case .audioFiles:
            return input.filter { $0.nodeType == .audioFile }
        case .instruments:
            return input.filter { $0.nodeType == .instrument }
        case .audioEffects:
            return input.filter { $0.nodeType == .audioEffect }
        case .midiEffects:
            return input.filter { $0.nodeType == .midiEffect }
        case .plugins:
            return input.filter { $0.nodeType == .vst2 || $0.nodeType == .vst3 }
        }
    }

    private func applySourceFilter(_ input: [BrowserNode]) -> [BrowserNode] {
        switch sourceFilter {
        case .all:
            return input
        case .library:
            return input.filter { $0.source == .library }
        case .samples:
            return input.filter { $0.source == .samples || $0.source == .customFolder }
        case .plugins:
            return input.filter { $0.source == .plugins }
        }
    }

    private func applyFormatFilter(_ input: [BrowserNode]) -> [BrowserNode] {
        guard formatFilter != .all else { return input }
        let wanted = formatFilter.rawValue.lowercased()
        return input.filter { node in
            guard node.nodeType == .audioFile else { return false }
            guard let ext = node.fileURL?.pathExtension.lowercased(), !ext.isEmpty else { return false }
            if formatFilter == .aiff {
                return ext == "aif" || ext == "aiff"
            }
            return ext == wanted
        }
    }

    private func applyAudioRoleFilter(_ input: [BrowserNode]) -> [BrowserNode] {
        guard audioRoleFilter != .all else { return input }
        return input.filter { node in
            guard node.nodeType == .audioFile else { return false }
            let value = node.name.lowercased()
            switch audioRoleFilter {
            case .all:
                return true
            case .loops:
                return value.contains("loop")
            case .oneshots:
                return value.contains("one shot") || value.contains("oneshot")
            case .drums:
                return value.contains("drum") || value.contains("kick") || value.contains("snare") || value.contains("hihat") || value.contains("clap")
            case .vocals:
                return value.contains("vocal") || value.contains("vox") || value.contains("acapella")
            }
        }
    }

    private func applySearchFilter(_ input: [BrowserNode]) -> [BrowserNode] {
        guard !searchQuery.isEmpty else { return input }
        return input.filter { $0.name.lowercased().contains(searchQuery) }
    }

    private func applySort(_ input: [BrowserNode]) -> [BrowserNode] {
        switch sortOrder {
        case .nameAsc:
            return input.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        case .nameDesc:
            return input.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedDescending }
        }
    }

    // MARK: - Settings / Favorites

    private func observeSettings() {
        samplesObserver = NotificationCenter.default.addObserver(
            forName: .samplesPathDidChange,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.rebuildData()
        }

        vstObserver = NotificationCenter.default.addObserver(
            forName: .vstPathsDidChange,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.rebuildData()
        }
    }

    private func favoriteKey(for node: BrowserNode) -> String {
        if let url = node.fileURL { return "file:\(url.path)" }
        return "\(node.nodeType.rawValue):\(node.name)"
    }

    private func loadFavorites() {
        let persisted = appSettings.browserFavorites
        if persisted.isEmpty {
            favoriteKeys = Set(UserDefaults.standard.stringArray(forKey: favoritesDefaultsKey) ?? [])
        } else {
            favoriteKeys = Set(persisted)
        }
    }

    private func saveFavorites() {
        let sorted = Array(favoriteKeys).sorted()
        appSettings.browserFavorites = sorted
        UserDefaults.standard.set(sorted, forKey: favoritesDefaultsKey)
    }

    private func toggleFavorite(_ node: BrowserNode) {
        let key = favoriteKey(for: node)
        if favoriteKeys.contains(key) {
            favoriteKeys.remove(key)
        } else {
            favoriteKeys.insert(key)
        }
        saveFavorites()
        updateResults()
    }

    // MARK: - Actions

    @objc private func searchChanged() {
        searchQuery = searchField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        updateResults()
    }

    @objc private func typeFilterChanged() {
        let title = typeFilterButton.titleOfSelectedItem ?? ResultTypeFilter.all.rawValue
        typeFilter = ResultTypeFilter.allCases.first(where: { $0.rawValue == title }) ?? .all
        updateResults()
    }

    @objc private func sourceFilterChanged() {
        let title = sourceFilterButton.titleOfSelectedItem ?? SourceFilter.all.rawValue
        sourceFilter = SourceFilter.allCases.first(where: { $0.rawValue == title }) ?? .all
        updateResults()
    }

    @objc private func formatFilterChanged() {
        let title = formatFilterButton.titleOfSelectedItem ?? FormatFilter.all.rawValue
        formatFilter = FormatFilter.allCases.first(where: { $0.rawValue == title }) ?? .all
        updateResults()
    }

    @objc private func audioRoleFilterChanged() {
        let title = audioRoleFilterButton.titleOfSelectedItem ?? AudioRoleFilter.all.rawValue
        audioRoleFilter = AudioRoleFilter.allCases.first(where: { $0.rawValue == title }) ?? .all
        updateResults()
    }

    @objc private func favoritesOnlyChanged() {
        favoritesOnly = (favoritesOnlyButton.state == .on)
        updateResults()
    }

    @objc private func toggleSortOrder() {
        sortOrder = (sortOrder == .nameAsc) ? .nameDesc : .nameAsc
        sortOrderButton.title = sortOrder.title
        updateResults()
    }

    @objc private func resetFilters() {
        searchQuery = ""
        searchField.stringValue = ""
        typeFilter = .all
        sourceFilter = .all
        formatFilter = .all
        audioRoleFilter = .all
        favoritesOnly = false
        typeFilterButton.selectItem(withTitle: typeFilter.rawValue)
        sourceFilterButton.selectItem(withTitle: sourceFilter.rawValue)
        formatFilterButton.selectItem(withTitle: formatFilter.rawValue)
        audioRoleFilterButton.selectItem(withTitle: audioRoleFilter.rawValue)
        favoritesOnlyButton.state = .off
        updateResults()
    }

    @objc private func togglePreviewEnabled() {
        previewEnabled.toggle()
        if !previewEnabled {
            stopPreview()
        } else if let url = currentPreviewFileURL {
            playPreview(url: url)
        }
        refreshPreviewControls()
    }

    private func refreshPreviewControls() {
        previewToggleButton.contentTintColor = previewEnabled
            ? DreamTheme.accentSecondary
            : DreamTheme.textMuted
        if currentPreviewFileURL == nil {
            previewStatusLabel.stringValue = previewEnabled ? "No preview" : "Preview Off"
        } else if let url = currentPreviewFileURL {
            previewStatusLabel.stringValue = previewEnabled ? url.pathExtension.uppercased() : "Preview Off"
        }
    }

    private func loadWaveformPreview(from url: URL?) {
        guard let url = url else {
            currentPreviewFileURL = nil
            previewWaveformView.samples = []
            previewWaveformView.placeholderText = "No sample selected"
            refreshPreviewControls()
            return
        }

        currentPreviewFileURL = url
        refreshPreviewControls()
        do {
            let file = try AVAudioFile(forReading: url)
            let frameCount = Int(file.length)
            let channelCount = Int(file.processingFormat.channelCount)
            guard frameCount > 0, channelCount > 0 else {
                previewWaveformView.samples = []
                previewWaveformView.placeholderText = "Empty sample"
                return
            }

            guard let buffer = AVAudioPCMBuffer(
                pcmFormat: file.processingFormat,
                frameCapacity: AVAudioFrameCount(frameCount)
            ) else {
                previewWaveformView.samples = []
                previewWaveformView.placeholderText = "Preview unavailable"
                return
            }
            try file.read(into: buffer)
            guard let channels = buffer.floatChannelData else {
                previewWaveformView.samples = []
                previewWaveformView.placeholderText = "Preview unavailable"
                return
            }

            let validFrames = Int(buffer.frameLength)
            let targetPoints = 280
            let step = max(1, validFrames / targetPoints)
            var output: [CGFloat] = []
            output.reserveCapacity(targetPoints)
            var i = 0
            while i < validFrames {
                let end = min(validFrames, i + step)
                var peak: Float = 0
                for sampleIndex in i..<end {
                    var mixed: Float = 0
                    for ch in 0..<channelCount {
                        mixed += abs(channels[ch][sampleIndex])
                    }
                    mixed /= Float(channelCount)
                    if mixed > peak { peak = mixed }
                }
                output.append(CGFloat(min(1.0, peak)))
                i += step
            }

            previewWaveformView.samples = output
            previewWaveformView.placeholderText = output.isEmpty ? "No waveform data" : ""
        } catch {
            previewWaveformView.samples = []
            previewWaveformView.placeholderText = "Preview error"
        }
    }

    private func playPreview(url: URL) {
        guard previewEnabled else { return }
        previewPlayer?.stop()
        do {
            previewPlayer = try AVAudioPlayer(contentsOf: url)
            previewPlayer?.volume = 0.8
            previewPlayer?.play()
        } catch {
            print("[Browser] Preview failed: \(error.localizedDescription)")
        }
    }

    private func iconTint(for category: BrowserCategory) -> NSColor {
        if category.kind == .section {
            return NSColor(red: 0.55, green: 0.50, blue: 0.40, alpha: 1.0)
        }
        switch category.kind {
        case .instruments:
            return NSColor(red: 0.95, green: 0.75, blue: 0.25, alpha: 1.0)
        case .audioEffects:
            return NSColor(red: 0.35, green: 0.70, blue: 0.90, alpha: 1.0)
        case .midiEffects:
            return NSColor(red: 0.65, green: 0.50, blue: 0.90, alpha: 1.0)
        case .plugins:
            return NSColor(red: 0.20, green: 0.85, blue: 0.55, alpha: 1.0)
        default:
            return DreamTheme.textSecondary
        }
    }

    private func iconTint(for node: BrowserNode) -> NSColor {
        switch node.nodeType {
        case .instrument:
            return NSColor(red: 0.95, green: 0.75, blue: 0.25, alpha: 1.0)
        case .audioEffect:
            return NSColor(red: 0.35, green: 0.70, blue: 0.90, alpha: 1.0)
        case .midiEffect:
            return NSColor(red: 0.65, green: 0.50, blue: 0.90, alpha: 1.0)
        case .vst2, .vst3:
            return NSColor(red: 0.20, green: 0.85, blue: 0.55, alpha: 1.0)
        case .audioFile, .generic:
            return DreamTheme.textSecondary
        }
    }

    private func pasteboardWriter(for node: BrowserNode) -> NSPasteboardWriting? {
        if let fileURL = node.fileURL, node.nodeType == .audioFile {
            return fileURL as NSURL
        }

        if node.nodeType != .generic {
            let item = NSPasteboardItem()
            let payloadValue: String
            if (node.nodeType == .vst2 || node.nodeType == .vst3), let path = node.fileURL?.path {
                payloadValue = path
            } else {
                payloadValue = node.name
            }
            item.setString("\(node.nodeType.rawValue):\(payloadValue)", forType: .browserItem)
            return item
        }

        return nil
    }

    private func persistCategoryOrder() {
        let ids = categories
            .filter { $0.kind != .addFolder }
            .map(\.id)
        appSettings.browserSidebarOrder = ids
    }

    private func canReorderCategory(at row: Int) -> Bool {
        guard row >= 0, row < categories.count else { return false }
        return categories[row].kind != .addFolder
    }

    private func openAddFolderPanel() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = false
        panel.prompt = "Add Folder"
        panel.message = "Choose a folder to pin in the browser."
        if panel.runModal() == .OK, let url = panel.url {
            addPinnedFolder(url.path)
        }
    }

    private func addPinnedFolder(_ path: String) {
        let normalized = URL(fileURLWithPath: path).standardizedFileURL.path
        guard FileManager.default.fileExists(atPath: normalized) else { return }
        if appSettings.browserPinnedFolders.contains(normalized) {
            return
        }
        appSettings.browserPinnedFolders.append(normalized)
        buildCategories()
        persistCategoryOrder()
        rebuildData()
    }

    private func layoutFiltersContent(width: CGFloat) -> CGFloat {
        let controls: [(NSView, CGFloat)] = [
            (typeFilterButton, 96),
            (sourceFilterButton, 116),
            (formatFilterButton, 92),
            (audioRoleFilterButton, 100),
            (sortOrderButton, 84),
            (clearFiltersButton, 64),
            (favoritesOnlyButton, 96),
            (resultCountLabel, 52)
        ]
        let padX: CGFloat = 8
        let padY: CGFloat = 6
        let gapX: CGFloat = 6
        let gapY: CGFloat = 6
        let rowHeight: CGFloat = 22
        let lineHeight: CGFloat = 22
        let usableWidth = max(80, width - (padX * 2))

        var x = padX
        var y = padY

        for (view, preferredWidth) in controls {
            let fitW = max(preferredWidth, view.fittingSize.width + 6)
            let w = min(max(56, fitW), usableWidth)
            if x > padX && (x + w > width - padX) {
                x = padX
                y += lineHeight + gapY
            }
            let h = (view === favoritesOnlyButton) ? 18 : rowHeight
            let yOffset = (view === favoritesOnlyButton) ? 2 : 0
            view.frame = CGRect(x: x, y: y + yOffset, width: w, height: h)
            x += w + gapX
        }
        return y + lineHeight + padY
    }

    private func removePinnedFolder(_ path: String) {
        guard let idx = appSettings.browserPinnedFolders.firstIndex(of: path) else { return }
        appSettings.browserPinnedFolders.remove(at: idx)
        if selectedCategoryID == "folder:\(path)" {
            selectedCategoryID = "all"
        }
        buildCategories()
        persistCategoryOrder()
        rebuildData()
    }
}

// MARK: - Node Model

final class BrowserPreviewWaveformView: NSView {
    var samples: [CGFloat] = [] {
        didSet { needsDisplay = true }
    }
    var placeholderText: String = "No preview" {
        didSet { needsDisplay = true }
    }

    override var isFlipped: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }

        ctx.setFillColor(DreamTheme.bgSurface.cgColor)
        ctx.fill(bounds)

        if samples.isEmpty {
            let attrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 10, weight: .medium),
                .foregroundColor: DreamTheme.textMuted
            ]
            let str = NSAttributedString(string: placeholderText, attributes: attrs)
            let size = str.size()
            let pt = CGPoint(
                x: max(4, (bounds.width - size.width) * 0.5),
                y: max(2, (bounds.height - size.height) * 0.5)
            )
            str.draw(at: pt)
            return
        }

        ctx.setStrokeColor(DreamTheme.accentSecondary.cgColor)
        ctx.setLineWidth(1)
        let midY = bounds.midY
        let width = max(1, Int(bounds.width))
        let sampleStep = max(1, samples.count / width)
        var x: CGFloat = 0
        var sampleIndex = 0
        while x <= bounds.width, sampleIndex < samples.count {
            let amp = min(1, max(0, samples[sampleIndex]))
            let half = amp * (bounds.height * 0.46)
            ctx.move(to: CGPoint(x: x, y: midY - half))
            ctx.addLine(to: CGPoint(x: x, y: midY + half))
            x += 1
            sampleIndex += sampleStep
        }
        ctx.strokePath()
    }
}

enum BrowserNodeType: String {
    case generic
    case instrument
    case audioEffect
    case midiEffect
    case audioFile
    case vst2
    case vst3
}

enum BrowserSource {
    case library
    case samples
    case customFolder
    case plugins
}

final class BrowserNode: NSObject {
    let name: String
    let icon: String
    let isGroup: Bool
    let nodeType: BrowserNodeType
    let source: BrowserSource
    var categoryID: String?
    var children: [BrowserNode] = []
    var fileURL: URL?

    init(
        name: String,
        icon: String,
        isGroup: Bool = false,
        nodeType: BrowserNodeType = .generic,
        source: BrowserSource = .library,
        categoryID: String? = nil,
        fileURL: URL? = nil
    ) {
        self.name = name
        self.icon = icon
        self.isGroup = isGroup
        self.nodeType = nodeType
        self.source = source
        self.categoryID = categoryID
        self.fileURL = fileURL
        super.init()
    }
}

// MARK: - Split

extension BrowserSidebarView: NSSplitViewDelegate {
    public func splitView(_ splitView: NSSplitView, constrainSplitPosition proposedPosition: CGFloat, ofSubviewAt dividerIndex: Int) -> CGFloat {
        guard dividerIndex == 0 else { return proposedPosition }
        let minLeft: CGFloat = 110
        let maxLeft: CGFloat = max(minLeft, splitView.bounds.width * 0.7)
        return min(maxLeft, max(minLeft, proposedPosition))
    }

    public func splitView(
        _ splitView: NSSplitView,
        effectiveRect proposedEffectiveRect: NSRect,
        forDrawnRect drawnRect: NSRect,
        ofDividerAt dividerIndex: Int
    ) -> NSRect {
        guard dividerIndex == 0 else { return proposedEffectiveRect }
        return drawnRect.insetBy(dx: -4, dy: 0)
    }

    public func splitViewDidResizeSubviews(_ notification: Notification) {
        guard splitView.subviews.count >= 2 else { return }
        let width = Double(splitView.subviews[0].frame.width)
        appSettings.browserCategoryPaneWidth = width
        UserDefaults.standard.set(width, forKey: categoryPaneWidthDefaultsKey)
    }
}

// MARK: - Table Delegate/DataSource

extension BrowserSidebarView: NSTableViewDataSource, NSTableViewDelegate {
    public func numberOfRows(in tableView: NSTableView) -> Int {
        if tableView === categoriesTableView { return categories.count }
        if tableView === resultsTableView { return resultItems.count }
        return 0
    }

    public func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        if tableView === categoriesTableView {
            guard row >= 0, row < categories.count else { return nil }
            let category = categories[row]
            let id = NSUserInterfaceItemIdentifier("CategoryCell")

            let cell: NSTableCellView
            if let reuse = tableView.makeView(withIdentifier: id, owner: self) as? NSTableCellView {
                cell = reuse
            } else {
                cell = NSTableCellView()
                cell.identifier = id

                let icon = NSImageView()
                icon.translatesAutoresizingMaskIntoConstraints = false
                cell.addSubview(icon)
                cell.imageView = icon

                let text = NSTextField(labelWithString: "")
                text.translatesAutoresizingMaskIntoConstraints = false
                text.lineBreakMode = .byTruncatingTail
                cell.addSubview(text)
                cell.textField = text

                let dragHandle = NSImageView()
                dragHandle.translatesAutoresizingMaskIntoConstraints = false
                dragHandle.tag = 9001
                cell.addSubview(dragHandle)

                NSLayoutConstraint.activate([
                    icon.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 6),
                    icon.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
                    icon.widthAnchor.constraint(equalToConstant: 14),
                    icon.heightAnchor.constraint(equalToConstant: 14),

                    text.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 6),
                    text.trailingAnchor.constraint(equalTo: dragHandle.leadingAnchor, constant: -4),
                    text.centerYAnchor.constraint(equalTo: cell.centerYAnchor),

                    dragHandle.trailingAnchor.constraint(equalTo: cell.trailingAnchor, constant: -6),
                    dragHandle.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
                    dragHandle.widthAnchor.constraint(equalToConstant: 10),
                    dragHandle.heightAnchor.constraint(equalToConstant: 10),
                ])
            }

            cell.textField?.stringValue = category.title
            cell.textField?.font = category.kind == .section
                ? NSFont.systemFont(ofSize: 11, weight: .semibold)
                : NSFont.systemFont(ofSize: 12, weight: .regular)
            cell.textField?.textColor = category.kind == .section
                ? NSColor(red: 0.55, green: 0.50, blue: 0.40, alpha: 1.0)
                : DreamTheme.textPrimary

            if let image = NSImage(systemSymbolName: category.icon, accessibilityDescription: nil) {
                let cfg = NSImage.SymbolConfiguration(pointSize: 10, weight: .medium)
                cell.imageView?.image = image.withSymbolConfiguration(cfg)
                cell.imageView?.contentTintColor = iconTint(for: category)
            }

            if let handle = cell.viewWithTag(9001) as? NSImageView {
                if category.kind == .section || category.kind == .addFolder {
                    handle.image = nil
                } else {
                    let cfg = NSImage.SymbolConfiguration(pointSize: 8, weight: .regular)
                    handle.image = NSImage(systemSymbolName: "line.3.horizontal", accessibilityDescription: nil)?.withSymbolConfiguration(cfg)
                    handle.contentTintColor = DreamTheme.textMuted
                }
            }

            return cell
        }

        guard tableView === resultsTableView,
              row >= 0, row < resultItems.count else {
            return nil
        }

        let node = resultItems[row]
        let id = NSUserInterfaceItemIdentifier("ResultCell")

        let cell: NSTableCellView
        if let reuse = tableView.makeView(withIdentifier: id, owner: self) as? NSTableCellView {
            cell = reuse
        } else {
            cell = NSTableCellView()
            cell.identifier = id

            let icon = NSImageView()
            icon.translatesAutoresizingMaskIntoConstraints = false
            cell.addSubview(icon)
            cell.imageView = icon

            let text = NSTextField(labelWithString: "")
            text.translatesAutoresizingMaskIntoConstraints = false
            text.lineBreakMode = .byTruncatingTail
            cell.addSubview(text)
            cell.textField = text

            NSLayoutConstraint.activate([
                icon.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 6),
                icon.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
                icon.widthAnchor.constraint(equalToConstant: 14),
                icon.heightAnchor.constraint(equalToConstant: 14),

                text.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 6),
                text.trailingAnchor.constraint(equalTo: cell.trailingAnchor, constant: -4),
                text.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
            ])
        }

        let isFav = favoriteKeys.contains(favoriteKey(for: node))
        cell.textField?.stringValue = isFav ? "★ \(node.name)" : node.name
        cell.textField?.font = NSFont.systemFont(ofSize: 11, weight: .regular)
        cell.textField?.textColor = DreamTheme.textPrimary

        if let image = NSImage(systemSymbolName: node.icon, accessibilityDescription: nil) {
            let cfg = NSImage.SymbolConfiguration(pointSize: 10, weight: .medium)
            cell.imageView?.image = image.withSymbolConfiguration(cfg)
            cell.imageView?.contentTintColor = iconTint(for: node)
        }

        return cell
    }

    public func tableView(_ tableView: NSTableView, shouldSelectRow row: Int) -> Bool {
        if tableView === categoriesTableView {
            guard row >= 0, row < categories.count else { return false }
            return categories[row].kind != .section
        }
        return true
    }

    public func tableViewSelectionDidChange(_ notification: Notification) {
        if notification.object as AnyObject? === categoriesTableView {
            let row = categoriesTableView.selectedRow
            guard row >= 0, row < categories.count else { return }
            let category = categories[row]
            if category.kind == .addFolder {
                openAddFolderPanel()
                if let previousIndex = categories.firstIndex(where: { $0.id == selectedCategoryID }) {
                    categoriesTableView.selectRowIndexes(IndexSet(integer: previousIndex), byExtendingSelection: false)
                }
                return
            }
            selectedCategoryID = category.id
            updateResults()
            return
        }

        if notification.object as AnyObject? === resultsTableView {
            let row = resultsTableView.selectedRow
            guard row >= 0, row < resultItems.count else {
                stopPreview()
                loadWaveformPreview(from: nil)
                return
            }
            let node = resultItems[row]
            if let fileURL = node.fileURL, node.nodeType == .audioFile {
                loadWaveformPreview(from: fileURL)
                playPreview(url: fileURL)
            } else {
                stopPreview()
                loadWaveformPreview(from: nil)
            }
        }
    }

    public func tableView(_ tableView: NSTableView, pasteboardWriterForRow row: Int) -> NSPasteboardWriting? {
        if tableView === resultsTableView {
            guard row >= 0, row < resultItems.count else { return nil }
            return pasteboardWriter(for: resultItems[row])
        }
        if tableView === categoriesTableView {
            guard canReorderCategory(at: row) else { return nil }
            let item = NSPasteboardItem()
            item.setString(String(row), forType: .browserCategoryRow)
            return item
        }
        return nil
    }

    public func tableView(_ tableView: NSTableView, validateDrop info: NSDraggingInfo, proposedRow row: Int, proposedDropOperation dropOperation: NSTableView.DropOperation) -> NSDragOperation {
        guard tableView === categoriesTableView else { return [] }
        tableView.setDropRow(row, dropOperation: .above)
        guard info.draggingSource as AnyObject? === tableView else { return [] }
        return .move
    }

    public func tableView(_ tableView: NSTableView, acceptDrop info: NSDraggingInfo, row: Int, dropOperation: NSTableView.DropOperation) -> Bool {
        guard tableView === categoriesTableView else { return false }
        guard let text = info.draggingPasteboard.string(forType: .browserCategoryRow),
              let fromRow = Int(text),
              canReorderCategory(at: fromRow) else {
            return false
        }

        var toRow = max(0, min(row, categories.count - 1))
        if categories.indices.contains(toRow), categories[toRow].kind == .addFolder {
            toRow = categories.count - 1
        }
        if fromRow == toRow { return false }

        var reordered = categories
        let moved = reordered.remove(at: fromRow)
        if toRow > fromRow { toRow -= 1 }
        reordered.insert(moved, at: max(0, min(toRow, reordered.count)))

        if let addIndex = reordered.firstIndex(where: { $0.kind == .addFolder }) {
            let addRow = reordered.remove(at: addIndex)
            reordered.append(addRow)
        }

        categories = reordered
        persistCategoryOrder()
        categoriesTableView.reloadData()
        if let selected = categories.firstIndex(where: { $0.id == selectedCategoryID }) {
            categoriesTableView.selectRowIndexes(IndexSet(integer: selected), byExtendingSelection: false)
        }
        return true
    }
}

// MARK: - Context Menu

extension BrowserSidebarView: NSMenuDelegate {
    public func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        contextMenuNode = nil
        contextMenuCategory = nil

        if categoriesTableView.clickedRow >= 0 || categoriesTableView.window?.firstResponder === categoriesTableView {
            let row = categoriesTableView.clickedRow >= 0 ? categoriesTableView.clickedRow : categoriesTableView.selectedRow
            guard row >= 0, row < categories.count else { return }
            let category = categories[row]
            contextMenuCategory = category

            if category.kind == .customFolder, category.folderPath != nil {
                let remove = NSMenuItem(title: "Remove Folder", action: #selector(removePinnedFolderFromMenu), keyEquivalent: "")
                remove.target = self
                menu.addItem(remove)
                menu.addItem(.separator())
            }
            let add = NSMenuItem(title: "Add Folder...", action: #selector(addFolderFromMenu), keyEquivalent: "")
            add.target = self
            menu.addItem(add)
            return
        }

        let row = resultsTableView.clickedRow >= 0 ? resultsTableView.clickedRow : resultsTableView.selectedRow
        guard row >= 0, row < resultItems.count else { return }

        let node = resultItems[row]
        contextMenuNode = node

        let isFav = favoriteKeys.contains(favoriteKey(for: node))
        let favTitle = isFav ? "Remove from Favorites" : "Add to Favorites"
        let favItem = NSMenuItem(title: favTitle, action: #selector(toggleFavoriteFromMenu), keyEquivalent: "")
        favItem.target = self
        menu.addItem(favItem)

        if node.fileURL != nil {
            menu.addItem(.separator())
            let reveal = NSMenuItem(title: "Reveal in Finder", action: #selector(revealInFinderFromMenu), keyEquivalent: "")
            reveal.target = self
            menu.addItem(reveal)
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

    @objc private func addFolderFromMenu() {
        openAddFolderPanel()
    }

    @objc private func removePinnedFolderFromMenu() {
        guard let path = contextMenuCategory?.folderPath else { return }
        removePinnedFolder(path)
    }
}
