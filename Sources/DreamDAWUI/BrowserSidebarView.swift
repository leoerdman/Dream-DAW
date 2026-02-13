import AppKit
import AVFoundation
import DreamDAWModels
import DreamDAWEngine

extension NSPasteboard.PasteboardType {
    static let browserItem = NSPasteboard.PasteboardType("com.dreamdaw.browser-item")
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
        }

        let title: String
        let icon: String
        let kind: Kind
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

    private let resultsContainer = NSView()
    private let resultsToolbar = NSView()
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

    private var categories: [BrowserCategory] = []
    private var selectedCategoryKind: BrowserCategory.Kind = .all
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

        let col = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("category"))
        col.isEditable = false
        categoriesTableView.addTableColumn(col)

        categoriesTableView.delegate = self
        categoriesTableView.dataSource = self

        categoriesScrollView.drawsBackground = false
        categoriesScrollView.hasVerticalScroller = true
        categoriesScrollView.hasHorizontalScroller = false
        categoriesScrollView.scrollerStyle = .overlay
        categoriesScrollView.autohidesScrollers = true
        categoriesScrollView.documentView = categoriesTableView
    }

    private func setupResultsPane() {
        resultsContainer.wantsLayer = true
        resultsContainer.layer?.backgroundColor = DreamTheme.bgBrowser.cgColor

        resultsToolbar.wantsLayer = true
        resultsToolbar.layer?.backgroundColor = DreamTheme.bgHeader.cgColor
        resultsToolbar.layer?.borderColor = DreamTheme.divider.cgColor
        resultsToolbar.layer?.borderWidth = 1
        resultsContainer.addSubview(resultsToolbar)

        typeFilterButton.addItems(withTitles: ResultTypeFilter.allCases.map { $0.rawValue })
        typeFilterButton.target = self
        typeFilterButton.action = #selector(typeFilterChanged)
        resultsToolbar.addSubview(typeFilterButton)

        sourceFilterButton.addItems(withTitles: SourceFilter.allCases.map { $0.rawValue })
        sourceFilterButton.target = self
        sourceFilterButton.action = #selector(sourceFilterChanged)
        resultsToolbar.addSubview(sourceFilterButton)

        formatFilterButton.addItems(withTitles: FormatFilter.allCases.map { $0.rawValue })
        formatFilterButton.target = self
        formatFilterButton.action = #selector(formatFilterChanged)
        resultsToolbar.addSubview(formatFilterButton)

        audioRoleFilterButton.addItems(withTitles: AudioRoleFilter.allCases.map { $0.rawValue })
        audioRoleFilterButton.target = self
        audioRoleFilterButton.action = #selector(audioRoleFilterChanged)
        resultsToolbar.addSubview(audioRoleFilterButton)

        favoritesOnlyButton.font = NSFont.systemFont(ofSize: 11, weight: .medium)
        favoritesOnlyButton.target = self
        favoritesOnlyButton.action = #selector(favoritesOnlyChanged)
        resultsToolbar.addSubview(favoritesOnlyButton)

        sortOrderButton.bezelStyle = .rounded
        sortOrderButton.font = NSFont.systemFont(ofSize: 11, weight: .medium)
        sortOrderButton.target = self
        sortOrderButton.action = #selector(toggleSortOrder)
        resultsToolbar.addSubview(sortOrderButton)

        clearFiltersButton.bezelStyle = .rounded
        clearFiltersButton.font = NSFont.systemFont(ofSize: 11, weight: .medium)
        clearFiltersButton.target = self
        clearFiltersButton.action = #selector(resetFilters)
        resultsToolbar.addSubview(clearFiltersButton)

        resultCountLabel.font = NSFont.monospacedDigitSystemFont(ofSize: 10, weight: .medium)
        resultCountLabel.textColor = DreamTheme.textSecondary
        resultCountLabel.alignment = .right
        resultsToolbar.addSubview(resultCountLabel)

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
        resultsScrollView.hasVerticalScroller = true
        resultsScrollView.hasHorizontalScroller = false
        resultsScrollView.scrollerStyle = .overlay
        resultsScrollView.autohidesScrollers = true
        resultsScrollView.documentView = resultsTableView
        resultsContainer.addSubview(resultsScrollView)

        previewContainer.wantsLayer = true
        previewContainer.layer?.backgroundColor = DreamTheme.bgHeader.cgColor
        previewContainer.layer?.borderColor = DreamTheme.divider.cgColor
        previewContainer.layer?.borderWidth = 1
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

        if splitView.subviews.count >= 2 && !didApplyInitialCategoryPaneWidth {
            let minLeft: CGFloat = 170
            let maxLeft: CGFloat = max(minLeft, splitView.bounds.width * 0.7)
            let saved = CGFloat(UserDefaults.standard.double(forKey: categoryPaneWidthDefaultsKey))
            let desired = saved > 0 ? saved : splitView.bounds.width * 0.42
            splitView.setPosition(min(maxLeft, max(minLeft, desired)), ofDividerAt: 0)
            didApplyInitialCategoryPaneWidth = true
        }

        let toolbarHeight: CGFloat = 56
        let previewHeight: CGFloat = 48
        resultsToolbar.frame = CGRect(x: 0, y: 0, width: resultsContainer.bounds.width, height: toolbarHeight)

        let rowPadding: CGFloat = 8
        let gap: CGFloat = 6
        let rowHeight: CGFloat = 22
        let availableWidth = max(240, resultsToolbar.bounds.width - (rowPadding * 2))
        let firstColumnW = min(112, max(78, floor((availableWidth - gap * 3) * 0.26)))
        let secondColumnW = min(118, max(78, floor((availableWidth - gap * 3) * 0.26)))
        let thirdColumnW = min(102, max(70, floor((availableWidth - gap * 3) * 0.22)))
        let fourthColumnW = max(70, availableWidth - firstColumnW - secondColumnW - thirdColumnW - gap * 3)

        typeFilterButton.frame = CGRect(x: rowPadding, y: 4, width: firstColumnW, height: rowHeight)
        sourceFilterButton.frame = CGRect(x: typeFilterButton.frame.maxX + gap, y: 4, width: secondColumnW, height: rowHeight)
        formatFilterButton.frame = CGRect(x: sourceFilterButton.frame.maxX + gap, y: 4, width: thirdColumnW, height: rowHeight)
        audioRoleFilterButton.frame = CGRect(x: formatFilterButton.frame.maxX + gap, y: 4, width: fourthColumnW, height: rowHeight)

        let secondRowY: CGFloat = 30
        let countWidth: CGFloat = 84
        let sortWidth: CGFloat = 88
        let resetWidth: CGFloat = 70
        sortOrderButton.frame = CGRect(x: rowPadding, y: secondRowY, width: sortWidth, height: rowHeight)
        clearFiltersButton.frame = CGRect(x: sortOrderButton.frame.maxX + gap, y: secondRowY, width: resetWidth, height: rowHeight)
        favoritesOnlyButton.frame = CGRect(
            x: clearFiltersButton.frame.maxX + gap,
            y: secondRowY + 2,
            width: max(84, resultsToolbar.bounds.width - (clearFiltersButton.frame.maxX + gap + countWidth + rowPadding)),
            height: 18
        )
        resultCountLabel.frame = CGRect(
            x: resultsToolbar.bounds.width - rowPadding - countWidth,
            y: secondRowY + 3,
            width: countWidth,
            height: 16
        )

        previewContainer.frame = CGRect(
            x: 0,
            y: max(0, resultsContainer.bounds.height - previewHeight),
            width: resultsContainer.bounds.width,
            height: previewHeight
        )
        previewToggleButton.frame = CGRect(x: 8, y: 13, width: 22, height: 22)
        previewWaveformView.frame = CGRect(
            x: 36,
            y: 10,
            width: max(120, previewContainer.bounds.width - 124),
            height: 28
        )
        previewStatusLabel.frame = CGRect(
            x: previewContainer.bounds.width - 82,
            y: 16,
            width: 72,
            height: 16
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
        categories = [
            BrowserCategory(title: "Collections", icon: "star.fill", kind: .section),
            BrowserCategory(title: "Favorites", icon: "star.fill", kind: .favorites),

            BrowserCategory(title: "Library", icon: "folder.fill", kind: .section),
            BrowserCategory(title: "All", icon: "line.3.horizontal.decrease", kind: .all),
            BrowserCategory(title: "Sounds", icon: "music.note", kind: .sounds),
            BrowserCategory(title: "Drums", icon: "music.quarternote.3", kind: .drums),
            BrowserCategory(title: "Instruments", icon: "pianokeys", kind: .instruments),
            BrowserCategory(title: "Audio Effects", icon: "wand.and.stars", kind: .audioEffects),
            BrowserCategory(title: "MIDI Effects", icon: "sparkles", kind: .midiEffects),
            BrowserCategory(title: "Plug-Ins", icon: "puzzlepiece.fill", kind: .plugins),
            BrowserCategory(title: "Clips", icon: "film", kind: .clips),
            BrowserCategory(title: "Templates", icon: "doc.text", kind: .templates),

            BrowserCategory(title: "Places", icon: "externaldrive.fill", kind: .section),
            BrowserCategory(title: "User Library", icon: "person.crop.circle", kind: .userLibrary),
            BrowserCategory(title: "Current Project", icon: "doc.fill", kind: .currentProject),
            BrowserCategory(title: "Samples", icon: "waveform", kind: .samples),
        ]
    }

    private func rebuildData() {
        allLeafNodes = buildLeafNodes()
        categoriesTableView.reloadData()

        if let idx = categories.firstIndex(where: { $0.kind == selectedCategoryKind }) {
            categoriesTableView.selectRowIndexes(IndexSet(integer: idx), byExtendingSelection: false)
        } else if let idx = categories.firstIndex(where: { $0.kind == .all }) {
            selectedCategoryKind = .all
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

        let root = BrowserNode(name: "Samples", icon: "waveform", isGroup: true, source: .samples)
        root.children = scanDirectory(url: rootURL, depth: 0, maxDepth: 8)
        return root
    }

    private func scanDirectory(url: URL, depth: Int, maxDepth: Int) -> [BrowserNode] {
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
                let folder = BrowserNode(name: item.lastPathComponent, icon: "folder.fill", isGroup: true, source: .samples)
                folder.children = scanDirectory(url: item, depth: depth + 1, maxDepth: maxDepth)
                if !folder.children.isEmpty { nodes.append(folder) }
            } else if audioExt.contains(item.pathExtension.lowercased()) {
                let file = BrowserNode(name: item.lastPathComponent, icon: "waveform", nodeType: .audioFile, source: .samples)
                file.fileURL = item
                nodes.append(file)
            }
        }

        return nodes
    }

    private func updateResults() {
        var base = allLeafNodes

        switch selectedCategoryKind {
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
            return input.filter { $0.source == .samples }
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
        favoriteKeys = Set(UserDefaults.standard.stringArray(forKey: favoritesDefaultsKey) ?? [])
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
}

// MARK: - Node Model

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
    case plugins
}

final class BrowserNode: NSObject {
    let name: String
    let icon: String
    let isGroup: Bool
    let nodeType: BrowserNodeType
    let source: BrowserSource
    var children: [BrowserNode] = []
    var fileURL: URL?

    init(
        name: String,
        icon: String,
        isGroup: Bool = false,
        nodeType: BrowserNodeType = .generic,
        source: BrowserSource = .library,
        fileURL: URL? = nil
    ) {
        self.name = name
        self.icon = icon
        self.isGroup = isGroup
        self.nodeType = nodeType
        self.source = source
        self.fileURL = fileURL
        super.init()
    }
}

// MARK: - Split

extension BrowserSidebarView: NSSplitViewDelegate {
    public func splitView(_ splitView: NSSplitView, constrainSplitPosition proposedPosition: CGFloat, ofSubviewAt dividerIndex: Int) -> CGFloat {
        guard dividerIndex == 0 else { return proposedPosition }
        let minLeft: CGFloat = 170
        let maxLeft: CGFloat = max(minLeft, splitView.bounds.width * 0.7)
        return min(maxLeft, max(minLeft, proposedPosition))
    }

    public func splitViewDidResizeSubviews(_ notification: Notification) {
        guard splitView.subviews.count >= 2 else { return }
        UserDefaults.standard.set(Double(splitView.subviews[0].frame.width), forKey: categoryPaneWidthDefaultsKey)
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
            selectedCategoryKind = categories[row].kind
            updateResults()
            return
        }

        if notification.object as AnyObject? === resultsTableView {
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
    }

    public func tableView(_ tableView: NSTableView, pasteboardWriterForRow row: Int) -> NSPasteboardWriting? {
        guard tableView === resultsTableView,
              row >= 0, row < resultItems.count else { return nil }
        return pasteboardWriter(for: resultItems[row])
    }
}

// MARK: - Context Menu

extension BrowserSidebarView: NSMenuDelegate {
    public func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()

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
}
