// Force Rebuild
import AppKit
import SwiftUI
import Foundation
import DreamDAWModels
import DreamDAWEngine
import os.log

// MARK: - ArrangementViewController

/// Main view controller for the arrangement view — Ableton Live 11 layout.
/// Layout: [ControlBar TOP] → [BrowserSidebar LEFT | Ruler+Canvas CENTER | TrackHeaders RIGHT] → [StatusBar BOTTOM]
/// Manages synchronized scrolling and zoom state.
public final class ArrangementViewController: NSViewController {



    // MARK: - Edit Actions (Menu & Keyboard Shortcuts)

    @objc public func cut(_ sender: Any?) {
        canvasView.copySelection()
        canvasView.deleteSelection()
    }

    @objc public func copy(_ sender: Any?) {
        canvasView.copySelection()
    }

    @objc public func paste(_ sender: Any?) {
        canvasView.pasteClipsAtEditCursor()
    }

    @objc public func delete(_ sender: Any?) {
        if canvasView.hasSelection {
            canvasView.deleteSelection()
        } else if let selectedID = project.selectedTrackID {
            deleteTrack(id: selectedID)
        }
    }

    @objc public override func selectAll(_ sender: Any?) {
        canvasView.selectAllClips()
    }

    @objc public func duplicate(_ sender: Any?) {
        canvasView.duplicateSelection()
    }

    @objc public func split(_ sender: Any?) {
        canvasView.splitClipsAtEditCursor()
    }

    public func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        // Always enable for now, or add logic to check if clips are selected
        return true
    }

    // MARK: - Public Properties

    public let project: Project
    public let audioEngine: AudioEngine
    public let transportController: TransportController
    public let trackMixer: TrackMixer
    public let playbackScheduler: PlaybackScheduler
    public let waveformCache: WaveformCache
    public let audioLevelMeter = AudioLevelMeter()
    public let actionHistory = ActionHistory()
    public let orchestrator: ArrangementOrchestrator

    // VU meter update timer
    private var meterTimer: Timer?

    // Loading overlay
    private var loadingOverlay: NSView?
    private let logger = Logger(subsystem: "com.dreamdaw", category: "ArrangementVC")

    // UI Components
    private let rulerView = TimelineRulerView()
    private let trackHeaders = TrackHeadersContainerView()
    private let canvasView = TimelineCanvasView()
    private let canvasScrollView = NSScrollView()
    private let headerScrollView = DragForwardingScrollView()
    private let browserSidebar = BrowserSidebarView()
    private var transportHostingView: NSHostingView<TransportBarView>?
    private var statusBarHostingView: NSHostingView<StatusBarView>?
    private let cornerViewLeft = NSView()   // Top-left corner (above browser + ruler join)
    private let cornerViewRight = NSView()  // Top-right corner (above track headers)
    private let vertDividerLeft = NSView()  // Between browser and canvas
    private let vertDividerRight = NSView() // Between canvas and track headers
    private let browserToggleView = NSView() // Browser show/hide handle
    private let bottomPanel = BottomPanelView()
    private let bottomPanelDivider = NSView()

    // Pinned master track (always visible at bottom of track area)
    private var masterHeaderView: TrackHeaderView?
    private let masterLaneView = NSView()           // Canvas-width lane for master
    private let masterSeparator = NSView()           // Divider above master lane

    // State
    private var pixelsPerBeat: CGFloat = DreamTheme.defaultPixelsPerBeat
    private var isBrowserVisible: Bool = true
    private var keyEventMonitor: Any?

    /// Current view mode: arrangement (timeline) or mixer.
    private enum ViewMode {
        case arrangement
        case mixer
    }
    private var viewMode: ViewMode = .arrangement
    private var mixerHostingView: NSHostingView<MixerView>?

    /// Whether the render dialog is currently shown.
    private var isRenderDialogShown: Bool = false
    /// Weak reference to the render dialog panel (avoids fragile title-based lookup).
    private weak var renderPanel: NSPanel?

    // MARK: - Initialization

    public init(project: Project) {
        self.project = project
        self.audioEngine = AudioEngine()
        self.transportController = TransportController()
        self.waveformCache = WaveformCache()
        self.trackMixer = TrackMixer(audioEngine: audioEngine)
        self.playbackScheduler = PlaybackScheduler(audioEngine: audioEngine, trackMixer: trackMixer)
        self.orchestrator = ArrangementOrchestrator(project: project, actionHistory: actionHistory)

        super.init(nibName: nil, bundle: nil)

        // Sync transport with project
        transportController.bpm = project.bpm
        transportController.timeSignature = project.timeSignature
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    // MARK: - View Lifecycle

    public override func loadView() {
        view = FlippedView()
        view.wantsLayer = true
        view.layer?.backgroundColor = DreamTheme.bgPrimary.cgColor
    }

    public override func viewDidLoad() {
        super.viewDidLoad()
        setupUI()
        setupAudioEngine()
        setupBindings()
        configureProject()
        installGlobalKeyMonitor()
        startMeterTimer()
    }
    
    // MARK: - View Persistence
    
    private func restoreViewState() {
        // Restore view state (Zoom & Scroll)
        if let savedZoom = project.viewZoomScale {
            self.pixelsPerBeat = CGFloat(savedZoom)
            self.rulerView.pixelsPerBeat = CGFloat(savedZoom)
            self.canvasView.pixelsPerBeat = CGFloat(savedZoom)
            // Restore scroll if present
            if let savedScrollBeats = project.viewScrollPosition {
                 DispatchQueue.main.async {
                     let scrollX = CGFloat(savedScrollBeats) * CGFloat(savedZoom)
                     let point = NSPoint(x: scrollX, y: 0)
                     self.canvasScrollView.contentView.scroll(to: point)
                     self.rulerView.scroll(NSPoint(x: scrollX, y: 0))
                 }
            }
        }
    }

    deinit {
        if let monitor = keyEventMonitor {
            NSEvent.removeMonitor(monitor)
        }
        meterTimer?.invalidate()
        audioLevelMeter.removeAllTaps()
    }

    /// Install an application-level key event monitor that intercepts
    /// Space, Return, and Escape BEFORE any SwiftUI control can consume them.
    /// This guarantees transport shortcuts always work regardless of focus.
    private func installGlobalKeyMonitor() {
        keyEventMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self = self else { return event }
            // Only intercept when our window is key
            guard event.window === self.view.window else { return event }

            switch event.keyCode {
            case 49: // Space — toggle play/pause from edit cursor
                if !self.transportController.isPlaying {
                    // Start from edit cursor if one is set
                    if let cursor = self.canvasView.editCursor {
                        self.transportController.seek(to: cursor.position)
                    }
                }
                self.transportController.togglePlayPause()
                return nil // consume the event (no bonk)

            case 36: // Return
                // If a text field has focus, let Return commit the field value, then blur
                if let firstResponder = self.view.window?.firstResponder,
                   firstResponder is NSTextView,
                   let fieldEditor = firstResponder as? NSTextView,
                   fieldEditor.isFieldEditor {
                    // Let the text field handle Return (commit), then blur
                    DispatchQueue.main.async {
                        self.view.window?.makeFirstResponder(self.view)
                    }
                    return event // pass through so onCommit fires
                }
                // No text field focused — Return = Stop transport
                if !event.modifierFlags.contains(.command) {
                    self.transportController.stop()
                    return nil
                }
                return event

            case 53: // Escape — blur any focused text field
                if let firstResponder = self.view.window?.firstResponder,
                   firstResponder is NSTextView {
                    self.view.window?.makeFirstResponder(self.view)
                    return nil
                }
                return event

            default:
                return event
            }
        }
    }

    public override func viewDidLayout() {
        super.viewDidLayout()
        layoutSubviews()
    }

    // MARK: - Setup

    private func setupUI() {
        // ===== TOP: Control Bar (Transport) =====
        let transportView = TransportBarView(
            transportController: transportController,
            project: project
        )
        let hostingView = NSHostingView(rootView: transportView)
        hostingView.wantsLayer = true
        view.addSubview(hostingView)
        self.transportHostingView = hostingView

        // Browser and Left Corner moved to end for Z-order (stay on top of canvas)


        // ===== CENTER-TOP: Ruler =====
        rulerView.wantsLayer = true
        view.addSubview(rulerView)

        // ===== CENTER-TOP RIGHT: Corner (above track headers) =====
        cornerViewRight.wantsLayer = true
        cornerViewRight.layer?.backgroundColor = DreamTheme.bgHeader.cgColor
        view.addSubview(cornerViewRight)

        // ===== CENTER: Canvas Scroll View =====
        canvasScrollView.wantsLayer = true
        canvasScrollView.drawsBackground = false
        canvasScrollView.hasVerticalScroller = true
        canvasScrollView.hasHorizontalScroller = true
        canvasScrollView.autohidesScrollers = false
        
        // Use custom clip view to valid hard-clamp scrolling (stop rubber-banding)
        let clipView = ClampedClipView()
        canvasScrollView.contentView = clipView
        
        canvasScrollView.documentView = canvasView
        canvasScrollView.scrollerStyle = .overlay
        // Disable elastic bounce — no over-scrolling past content boundaries
        canvasScrollView.horizontalScrollElasticity = .none
        canvasScrollView.verticalScrollElasticity = .none
        view.addSubview(canvasScrollView)

        // Register for drag and drop (audio files + browser items like instruments/effects)
        canvasView.registerForDraggedTypes([.fileURL, .browserItem])

        // ===== RIGHT: Track Headers Scroll View =====
        headerScrollView.wantsLayer = true
        headerScrollView.drawsBackground = false
        headerScrollView.hasVerticalScroller = false
        headerScrollView.hasHorizontalScroller = false
        
        let headerClipView = ClampedClipView()
        headerScrollView.contentView = headerClipView
        
        headerScrollView.documentView = trackHeaders
        // Match canvas: no elastic bounce
        headerScrollView.horizontalScrollElasticity = .none
        headerScrollView.verticalScrollElasticity = .none
        view.addSubview(headerScrollView)

        // ===== BOTTOM: Status Bar =====
        let statusView = StatusBarView(
            transportController: transportController,
            project: project
        )
        let statusHosting = NSHostingView(rootView: statusView)
        statusHosting.wantsLayer = true
        view.addSubview(statusHosting)
        self.statusBarHostingView = statusHosting

        // ===== Dividers =====
        vertDividerLeft.wantsLayer = true
        vertDividerLeft.layer?.backgroundColor = DreamTheme.divider.cgColor
        view.addSubview(vertDividerLeft)

        vertDividerRight.wantsLayer = true
        vertDividerRight.layer?.backgroundColor = DreamTheme.divider.cgColor
        view.addSubview(vertDividerRight)

        // ===== BOTTOM: Bottom Panel (Piano Roll / Track Detail) =====
        bottomPanel.isHidden = true
        bottomPanel.audioLevelMeter = audioLevelMeter
        view.addSubview(bottomPanel)

        // Horizontal divider above bottom panel
        bottomPanelDivider.wantsLayer = true
        bottomPanelDivider.layer?.backgroundColor = DreamTheme.divider.cgColor
        view.addSubview(bottomPanelDivider)

        // ===== PINNED MASTER TRACK (bottom of track area) =====
        masterSeparator.wantsLayer = true
        masterSeparator.layer?.backgroundColor = DreamTheme.divider.cgColor
        view.addSubview(masterSeparator)

        masterLaneView.wantsLayer = true
        masterLaneView.layer?.backgroundColor = NSColor(white: 0.14, alpha: 1).cgColor  // Slightly lighter
        view.addSubview(masterLaneView)

        // ===== LEFT: Browser Sidebar (On TOP of Canvas) =====
        browserSidebar.wantsLayer = true
        browserSidebar.layer?.backgroundColor = DreamTheme.bgBrowser.cgColor
        browserSidebar.layer?.isOpaque = true
        view.addSubview(browserSidebar)

        // ===== CENTER-TOP: Left corner (On TOP of Canvas/Ruler) =====
        cornerViewLeft.wantsLayer = true
        cornerViewLeft.layer?.backgroundColor = DreamTheme.bgHeader.cgColor
        cornerViewLeft.layer?.isOpaque = true
        view.addSubview(cornerViewLeft)
    }

    // MARK: - Layout (Ableton Style)
    //
    // ┌──────────────────────────────────────────────────────────┐
    // │                    CONTROL BAR (32px)                     │
    // ├──────────┬──────────────────────────────┬────────────────┤
    // │          │       RULER (22px)            │   RightCorner  │
    // │ BROWSER  ├──────────────────────────────┤────────────────│
    // │ SIDEBAR  │                              │  TRACK HEADERS │
    // │ (240px)  │     ARRANGEMENT CANVAS        │   (220px)      │
    // │          │                              │                │
    // ├──────────┴──────────────────────────────┴────────────────┤
    // │                    STATUS BAR (20px)                      │
    // └──────────────────────────────────────────────────────────┘

    private func layoutSubviews() {
        let bounds = view.bounds
        let controlBarH = DreamTheme.controlBarHeight
        let rulerH = DreamTheme.rulerHeight
        let statusBarH = DreamTheme.statusBarHeight
        let headerW = DreamTheme.trackHeaderWidth
        let browserW = isBrowserVisible ? DreamTheme.browserWidth : 0
        let bottomPanelH = bottomPanel.panelHeight

        // Calculate title bar offset (fullSizeContentView pushes content behind title bar)
        let titleBarH: CGFloat
        if let window = view.window {
            let contentLayoutRect = window.contentLayoutRect
            let contentFrame = window.contentView?.frame ?? bounds
            titleBarH = contentFrame.height - contentLayoutRect.height
        } else {
            titleBarH = 28  // Standard macOS title bar height fallback
        }

        // Control bar (TOP, below title bar, full width)
        transportHostingView?.frame = CGRect(
            x: 0, y: titleBarH,
            width: bounds.width,
            height: controlBarH
        )

        // Status bar (BOTTOM, full width)
        statusBarHostingView?.frame = CGRect(
            x: 0,
            y: bounds.height - statusBarH,
            width: bounds.width,
            height: statusBarH
        )

        // Content area (between control bar, status bar, and bottom panel)
        let contentTop = titleBarH + controlBarH
        let contentHeight = bounds.height - titleBarH - controlBarH - statusBarH - bottomPanelH

        // Browser sidebar (LEFT)
        browserSidebar.isHidden = !isBrowserVisible
        browserSidebar.frame = CGRect(
            x: 0,
            y: contentTop,
            width: browserW,
            height: contentHeight
        )

        // Left divider (between browser and canvas)
        vertDividerLeft.isHidden = !isBrowserVisible
        vertDividerLeft.frame = CGRect(
            x: browserW,
            y: contentTop,
            width: 1,
            height: contentHeight
        )

        // Canvas area start X
        let canvasStartX = browserW + (isBrowserVisible ? 1 : 0)
        let canvasEndX = bounds.width - headerW - 1
        let canvasWidth = canvasEndX - canvasStartX

        // Master track height (pinned at bottom of content area)
        let masterH: CGFloat = project.masterTrack.height
        let masterSepH: CGFloat = 2
        let masterRegionH: CGFloat = masterH + masterSepH

        // Ruler (top of content area, between browser and headers)
        rulerView.frame = CGRect(
            x: canvasStartX,
            y: contentTop,
            width: canvasWidth,
            height: rulerH
        )

        // Right corner (above track headers)
        cornerViewRight.frame = CGRect(
            x: canvasEndX + 1,
            y: contentTop,
            width: headerW,
            height: rulerH
        )

        // Canvas scroll view (center) — reduced by master region
        let canvasTop = contentTop + rulerH
        let canvasAreaHeight = contentHeight - rulerH - masterRegionH
        canvasScrollView.frame = CGRect(
            x: canvasStartX,
            y: canvasTop,
            width: canvasWidth,
            height: canvasAreaHeight
        )

        // Canvas document size — only regular tracks (not master)
        let totalTrackHeight = project.tracks.reduce(CGFloat(0)) { $0 + $1.height }
        let totalWidth = CGFloat(project.totalDuration.beats) * pixelsPerBeat
        canvasView.frame = NSRect(
            x: 0, y: 0,
            width: max(totalWidth, canvasWidth),
            height: max(totalTrackHeight, canvasAreaHeight)
        )

        // Right divider (between canvas and track headers)
        vertDividerRight.frame = CGRect(
            x: canvasEndX,
            y: contentTop,
            width: 1,
            height: contentHeight
        )

        // Track headers scroll view (RIGHT) — reduced by master region
        headerScrollView.frame = CGRect(
            x: canvasEndX + 1,
            y: canvasTop,
            width: headerW,
            height: canvasAreaHeight
        )

        // ===== Pinned Master Track (below scroll area, above bottom panel) =====
        let masterTop = canvasTop + canvasAreaHeight

        // Separator line
        masterSeparator.frame = CGRect(
            x: canvasStartX,
            y: masterTop,
            width: bounds.width - canvasStartX,
            height: masterSepH
        )

        // Master lane background (center column)
        masterLaneView.frame = CGRect(
            x: canvasStartX,
            y: masterTop + masterSepH,
            width: canvasWidth,
            height: masterH
        )

        // Master header (right column)
        masterHeaderView?.frame = CGRect(
            x: canvasEndX + 1,
            y: masterTop + masterSepH,
            width: headerW,
            height: masterH
        )

        // Bottom panel
        if bottomPanelH > 0 {
            bottomPanel.isHidden = false
            bottomPanel.frame = CGRect(
                x: 0,
                y: bounds.height - statusBarH - bottomPanelH,
                width: bounds.width,
                height: bottomPanelH
            )
            // Divider above bottom panel
            bottomPanelDivider.isHidden = false
            bottomPanelDivider.frame = CGRect(
                x: 0,
                y: bounds.height - statusBarH - bottomPanelH - 1,
                width: bounds.width,
                height: 1
            )
        } else {
            bottomPanel.isHidden = true
            bottomPanelDivider.isHidden = true
        }

        // Track headers document size
        trackHeaders.frame.size.width = headerW

        // Mixer hosting view (when in mixer mode) — takes full content area
        if let mixerHosting = mixerHostingView {
            mixerHosting.frame = CGRect(
                x: 0,
                y: contentTop,
                width: bounds.width,
                height: contentHeight
            )
        }
    }

    // MARK: - Audio Engine
    
    private func setupAudioEngine() {
        do {
            try audioEngine.start()
        } catch {
            logger.error("Audio engine failed to start: \(error)")
        }

        trackMixer.configureTracks(project.tracks)

        // Apply master track volume/pan to the engine master mixer
        trackMixer.applyMasterSettings(project.masterTrack)

        // Install metering taps on all track mixer nodes
        installMeteringTaps()

        // Connect waveform renderer callback → canvas redraw
        let renderer = WaveformRenderer(waveformCache: waveformCache)
        renderer.onWaveformReady = { [weak self] in
            self?.canvasView.needsDisplay = true
        }
        canvasView.waveformRenderer = renderer
    }

    /// Install audio level meter taps on all track mixer nodes and the master mixer.
    private func installMeteringTaps() {
        audioLevelMeter.removeAllTaps()

        for track in project.tracks {
            if let mixerNode = trackMixer.mixerNode(for: track.id) {
                audioLevelMeter.installTap(trackID: track.id, on: mixerNode)
            }
        }

        audioLevelMeter.installMasterTap(on: audioEngine.masterMixer)
        logger.info("Installed metering taps on \(self.project.tracks.count) tracks + master")
    }

    // MARK: - VU Meter Timer

    /// Start a repeating timer that pushes audio levels to the track header VU meters.
    private func startMeterTimer() {
        meterTimer?.invalidate()
        meterTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in
            self?.updateVUMeters()
        }
    }

    /// Push current audio levels from AudioLevelMeter to each track header's VU meter.
    private func updateVUMeters() {
        for headerView in trackHeaders.headerViews {
            let trackID = headerView.trackID
            let level = audioLevelMeter.level(for: trackID)
            headerView.updateMeterLevel(rms: level.rms, peak: level.peak)
        }

        // Pinned master header VU meter
        if let masterHeader = masterHeaderView {
            let level = audioLevelMeter.masterLevelValue()
            masterHeader.updateMeterLevel(rms: level.rms, peak: level.peak)
        }
    }


    // MARK: - Loading Overlay

    /// Show a centered loading overlay with spinner and message.
    private func showLoadingOverlay(message: String = "Loading Project…") {
        guard loadingOverlay == nil else { return }

        let overlay = NSView(frame: view.bounds)
        overlay.wantsLayer = true
        overlay.layer?.backgroundColor = NSColor(white: 0, alpha: 0.6).cgColor
        overlay.autoresizingMask = [.width, .height]

        // Center container (pill-shaped background)
        let container = NSView(frame: NSRect(x: 0, y: 0, width: 240, height: 70))
        container.wantsLayer = true
        container.layer?.backgroundColor = NSColor(white: 0.15, alpha: 1).cgColor
        container.layer?.cornerRadius = 12
        container.translatesAutoresizingMaskIntoConstraints = false
        overlay.addSubview(container)

        // Spinner
        let spinner = NSProgressIndicator()
        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.startAnimation(nil)
        spinner.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(spinner)

        // Label
        let label = NSTextField(labelWithString: message)
        label.font = NSFont.systemFont(ofSize: 13, weight: .medium)
        label.textColor = .white
        label.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(label)

        NSLayoutConstraint.activate([
            container.centerXAnchor.constraint(equalTo: overlay.centerXAnchor),
            container.centerYAnchor.constraint(equalTo: overlay.centerYAnchor),
            container.widthAnchor.constraint(equalToConstant: 240),
            container.heightAnchor.constraint(equalToConstant: 70),

            spinner.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 20),
            spinner.centerYAnchor.constraint(equalTo: container.centerYAnchor),

            label.leadingAnchor.constraint(equalTo: spinner.trailingAnchor, constant: 12),
            label.centerYAnchor.constraint(equalTo: container.centerYAnchor),
        ])

        view.addSubview(overlay)
        loadingOverlay = overlay
    }

    /// Dismiss the loading overlay.
    private func hideLoadingOverlay() {
        loadingOverlay?.removeFromSuperview()
        loadingOverlay = nil
    }

    // MARK: - Bindings

    private func setupBindings() {
        // Sync vertical scrolling between canvas and track headers
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(canvasScrolled(_:)),
            name: NSView.boundsDidChangeNotification,
            object: canvasScrollView.contentView
        )
        canvasScrollView.contentView.postsBoundsChangedNotifications = true

        // Sync horizontal scroll with ruler
        canvasView.onClickPosition = { [weak self] position in
            self?.transportController.seek(to: position)
        }

        trackHeaders.onAddTrack = { [weak self] isAudio in
            self?.orchestrator.addTrack(type: isAudio ? .audio : .midi)
            self?.reloadTracks()
        }

        trackHeaders.onDeleteTrack = { [weak self] trackID in
            self?.deleteTrack(id: trackID)
        }

        trackHeaders.onHeaderClicked = { [weak self] trackID in
            self?.selectTrack(trackID)
        }

        // Transport position updates → canvas and ruler
        transportController.onPlayheadUpdate = { [weak self] position in
            guard let self = self else { return }
            self.canvasView.playheadPosition = position
            self.rulerView.playheadPosition = position

            // Sync loop toggle state (transport → ruler)
            if self.rulerView.isLooping != self.transportController.isLooping {
                self.rulerView.isLooping = self.transportController.isLooping
            }
            // Persist loop toggle state
            if self.project.isLooping != self.transportController.isLooping {
                self.project.isLooping = self.transportController.isLooping
            }
        }

        // Ruler click → set playhead
        rulerView.onClickPosition = { [weak self] position in
            self?.transportController.seek(to: position)
        }

        // Sync view state to project on changes
        canvasView.onZoomChanged = { [weak self] newPPB, newScrollX in
            guard let self = self else { return }
            self.pixelsPerBeat = newPPB
            self.canvasView.pixelsPerBeat = newPPB
            self.rulerView.pixelsPerBeat = newPPB
            
            // Persist zoom
            self.project.viewZoomScale = Double(newPPB)
            
            self.layoutSubviews()
        }
        
        NotificationCenter.default.addObserver(
            forName: NSView.boundsDidChangeNotification,
            object: canvasScrollView.contentView,
            queue: .main
        ) { [weak self] _ in
             guard let self = self else { return }
             // Persist horizontal scroll position
             let visibleRect = self.canvasScrollView.contentView.documentVisibleRect
             let scrollX = visibleRect.origin.x
             // Convert pixels to beats
             let scrollBeats = Double(scrollX) / Double(self.pixelsPerBeat)
             self.project.viewScrollPosition = scrollBeats
        }

        // ━━━━━ Loop Marker Wiring ━━━━━

        // Initialize ruler loop state from transport controller
        if let loopStart = project.loopStart { transportController.loopStart = loopStart }
        if let loopEnd = project.loopEnd { transportController.loopEnd = loopEnd }
        transportController.isLooping = project.isLooping
        rulerView.isLooping = transportController.isLooping

        // Ruler loop marker dragged → update transport & project
        rulerView.onLoopStartChanged = { [weak self] position in
            guard let self = self else { return }
            self.transportController.loopStart = position
            self.project.loopStart = position
        }

        rulerView.onLoopEndChanged = { [weak self] position in
            guard let self = self else { return }
            self.transportController.loopEnd = position
            self.project.loopEnd = position
        }

        // Track changes → mixer (mute/volume/pan)
        trackHeaders.onTrackChanged = { [weak self] track in
            guard let self = self else { return }
            if track.trackType == .master {
                self.trackMixer.applyMasterSettings(track)
            } else {
                self.trackMixer.applyTrackSettings(track)
            }
            self.canvasView.needsDisplay = true
        }

        // Solo state changes → apply solo logic across all tracks
        trackHeaders.onSoloChanged = { [weak self] in
            guard let self = self else { return }
            self.trackMixer.applySoloLogic(self.project.tracks)
        }

        // Right-click context menu: Add Audio / MIDI Track
        trackHeaders.onAddTrack = { [weak self] isAudio in
            guard let self = self else { return }
            let trackType: TrackType = isAudio ? .audio : .midi
            let track = Track(
                name: "\(isAudio ? "Audio" : "MIDI") \(self.project.tracks.count + 1)",
                trackType: trackType,
                color: TrackColor.forIndex(self.project.tracks.count)
            )
            let action = AddTrackAction(track: track)
            self.actionHistory.perform(action, on: self.project)
            self.reloadTracks()
        }

        // Track headers: browser item dropped (instrument or effect)
        trackHeaders.onBrowserItemDropped = { [weak self] trackID, nodeType, itemName in
            self?.handleBrowserItemDrop(trackID: trackID, nodeType: nodeType, itemName: itemName)
        }

        // Transport state → PlaybackScheduler
        // Play → stop browser preview + schedule all clips; Pause/Stop → stop all players
        transportController.onStateChange = { [weak self] state in
            guard let self = self else { return }
            NSLog("[ArrangementVC] Transport state changed to: %@", "\(state)")
            switch state {
            case .playing:
                self.browserSidebar.stopPreview()
                self.playbackScheduler.schedulePlayback(
                    project: self.project,
                    from: self.transportController.playheadPosition,
                    looping: self.transportController.isLooping,
                    loopStart: self.transportController.loopStart,
                    loopEnd: self.transportController.loopEnd
                )
            case .paused, .stopped:
                self.playbackScheduler.stopAll()
            }
        }

        // Loop wrap → stop current audio + re-schedule from loop start
        // Loop wrap → do nothing for audio (handled by gapless queueing)
        transportController.onLoopWrap = { [weak self] in
            // Visuals are handled by TransportController updates.
            // Audio is pre-scheduled via queue, so we do NOT restart here.
            NSLog("[ArrangementVC] Loop Wrapped (Gapless)")
        }

        // Canvas → bottom panel: click track → show detail & select track
        canvasView.onTrackClicked = { [weak self] trackID in
            self?.selectTrack(trackID)
        }

        // Canvas → bottom panel: Shift+click MIDI clip → open piano roll
        canvasView.onMidiClipShiftClicked = { [weak self] trackID, clipID in
            guard let self = self,
                  let track = self.project.tracks.first(where: { $0.id == trackID }),
                  let clip = track.midiClips.first(where: { $0.id == clipID }) else { return }
            
            // Ensure track is selected
            self.selectTrack(trackID)
            
            self.bottomPanel.showPianoRoll(track: track, clip: clip)
            self.layoutSubviews()
        }
        
        // Canvas → audio engine: clips modified (move/resize/delete) → hot-reload if playing
        canvasView.onClipsModified = { [weak self] in
            self?.refreshAudio()
        }

        // Canvas → clip selection → select track too
        canvasView.onClipSelected = { [weak self] trackID, _ in
            // If we select a clip, implicitly select the track (but don't necessarily toggle bottom panel unless needed)
            // For now, let's enforce track selection on clip click
            if self?.project.selectedTrackID != trackID {
                self?.selectTrack(trackID)
            }
        }
        
        // Track Headers → Click → Select Track
        trackHeaders.onHeaderClicked = { [weak self] trackID in
            self?.selectTrack(trackID)
        }

        // Canvas → track: browser item dropped (instrument or effect)
        canvasView.onBrowserItemDropped = { [weak self] trackID, nodeType, itemName in
            self?.handleBrowserItemDrop(trackID: trackID, nodeType: nodeType, itemName: itemName)
        }

        // Canvas → host: zoom changed (Cmd+scroll) — sync ruler and scroll
        canvasView.onZoomChanged = { [weak self] newPPB, newScrollX in
            guard let self = self else { return }
            // Update shared zoom level
            self.pixelsPerBeat = newPPB
            self.canvasView.pixelsPerBeat = newPPB
            self.rulerView.pixelsPerBeat = newPPB

            // Recompute document size for the new zoom
            self.layoutSubviews()

            // Apply the scroll position to keep playhead centered
            let scrollView = self.canvasScrollView
            let maxScrollX = max(0, scrollView.documentView!.frame.width - scrollView.contentView.bounds.width)
            let clampedX = max(0, min(newScrollX, maxScrollX))
            scrollView.contentView.scroll(to: NSPoint(x: clampedX, y: scrollView.contentView.bounds.origin.y))
            scrollView.reflectScrolledClipView(scrollView.contentView)

            // Sync ruler scroll offset
            self.rulerView.scrollOffset = clampedX
        }

        // Bottom panel → project: note changes from piano roll
        bottomPanel.onNotesChanged = { [weak self] track, updatedClip in
            guard let self = self,
                  let trackIndex = self.project.tracks.firstIndex(where: { $0.id == track.id }),
                  let clipIndex = self.project.tracks[trackIndex].midiClips.firstIndex(where: { $0.id == updatedClip.id })
            else { return }
            self.project.tracks[trackIndex].midiClips[clipIndex] = updatedClip
            self.canvasView.needsDisplay = true
            
            // Hot-reload if playing
            self.refreshAudio()
        }

        // Bottom panel → project: effect dropped on effects chain
        bottomPanel.onEffectDropped = { [weak self] trackID, nodeType, itemName in
            guard let self = self else { return }
            self.handleBrowserItemDrop(trackID: trackID, nodeType: nodeType, itemName: itemName)
            // Refresh the bottom panel to show the newly added effect
            if let track = self.project.tracks.first(where: { $0.id == trackID }) {
                self.bottomPanel.showDetail(for: track)
            }
        }

        // Bottom panel → audio engine: effect parameter changed (e.g. Utility gain knob)
        bottomPanel.onEffectParameterChanged = { [weak self] trackID in
            guard let self = self else { return }
            if let track = self.project.tracks.first(where: { $0.id == trackID }) {
                self.trackMixer.applyTrackSettings(track)
            }
        }
    }

    // MARK: - Browser Item Drop Handler (shared by canvas + track headers)

    /// Handles a browser item drop (instrument, audioEffect, midiEffect) on a track.
    private func handleBrowserItemDrop(trackID: UUID, nodeType: String, itemName: String) {
        guard let track = project.tracks.first(where: { $0.id == trackID }) else { return }

        switch nodeType {
        case "instrument":
            // Only MIDI tracks accept instruments
            guard track.trackType == .midi else { return }
            let instrumentType: InstrumentType
            switch itemName {
            case "Simple Sine Synth": instrumentType = .sineSynth
            case "Sampler":          instrumentType = .sampler
            default: return
            }
            track.instrument = InstrumentConfig(instrumentType: instrumentType)

        case "audioEffect":
            // Any track accepts audio effects — map browser name to effect type
            let effectType: AudioEffectType
            switch itemName {
            case "EQ Eight":          effectType = .eq
            case "Utility":           effectType = .utility
            case "Compressor":        effectType = .compressor
            case "Delay":             effectType = .delay
            case "Reverb":            effectType = .reverb
            case "Chorus-Ensemble":   effectType = .chorus
            default:                  effectType = .eq
            }
            let effect = AudioEffectConfig(effectType: effectType)
            track.effects.append(effect)

        case "midiEffect":
            // Only MIDI tracks accept MIDI effects (future implementation)
            guard track.trackType == .midi else { return }
            // TODO: Implement MIDI effect types when available
            break

        default:
            break
        }

        // Refresh track headers to reflect the change
        trackHeaders.configure(tracks: project.tracks)
        configureMasterHeader()
        canvasView.needsDisplay = true
        
        // AUTO-SELECT track and SHOW details in bottom panel
        selectTrack(trackID)
        
        // Force refresh bottom panel mode for the selected track
        if let updatedTrack = project.tracks.first(where: { $0.id == trackID }) {
            bottomPanel.mode = .detail(updatedTrack)
        }
    }

    // MARK: - Master Header Management

    /// Create or update the pinned master track header.
    private func configureMasterHeader() {
        // Remove old master header
        masterHeaderView?.removeFromSuperview()
        masterHeaderView = nil

        let masterTrack = project.masterTrack

        let header = TrackHeaderView(track: masterTrack, index: project.tracks.count)
        header.onTrackChanged = { [weak self] track in
            self?.trackHeaders.onTrackChanged?(track)
        }
        header.onSoloChanged = { [weak self] in
            self?.trackHeaders.onSoloChanged?()
        }
        // Slightly lighter background to distinguish master
        header.wantsLayer = true
        header.layer?.backgroundColor = NSColor(white: 0.14, alpha: 1).cgColor
        view.addSubview(header)
        masterHeaderView = header
        layoutSubviews()
    }

    @objc private func canvasScrolled(_ notification: Notification) {
        let clipBounds = canvasScrollView.contentView.bounds

        // Sync track headers vertical position
        trackHeaders.setVerticalOffset(clipBounds.origin.y)

        // Sync ruler horizontal position
        rulerView.scrollOffset = clipBounds.origin.x

        // Canvas draws in document coordinates — no need to pass scrollOffset.
        // The NSScrollView handles viewport clipping automatically.
    }

    // MARK: - Configure



    // MARK: - Public API

    /// Zoom in/out the timeline.
    public func setZoom(_ ppb: CGFloat) {
        pixelsPerBeat = min(DreamTheme.maxPixelsPerBeat, max(DreamTheme.minPixelsPerBeat, ppb))
        rulerView.pixelsPerBeat = pixelsPerBeat
        canvasView.pixelsPerBeat = pixelsPerBeat
        layoutSubviews()
    }

    /// Reload track headers and canvas after tracks are added/removed.
    public func reloadTracks() {
        trackHeaders.configure(tracks: project.tracks)
        configureMasterHeader()
        trackMixer.configureTracks(project.tracks)
        trackMixer.applyMasterSettings(project.masterTrack)
        canvasView.project = project
        canvasView.needsDisplay = true
        layoutSubviews()
    }

    /// Toggle browser sidebar visibility.
    public func toggleBrowser() {
        isBrowserVisible.toggle()
        layoutSubviews()
    }

    /// Handle keyboard shortcuts at the arrangement level.
    public override func keyDown(with event: NSEvent) {
        let flags = event.modifierFlags
        switch event.keyCode {
        case 49: // Space — handled by installGlobalKeyMonitor
            break
        case 36: // Return — handled by installGlobalKeyMonitor
            break
        case 24 where flags.contains(.command): // Cmd+=  zoom in
            setZoom(pixelsPerBeat * 1.3)
        case 27 where flags.contains(.command): // Cmd+-  zoom out
            setZoom(pixelsPerBeat / 1.3)
        case 6 where flags.contains(.command) && flags.contains(.shift): // Cmd+Shift+Z — redo
            performRedo()
        case 6 where flags.contains(.command): // Cmd+Z — undo
            performUndo()
        case 11 where flags.contains(.command) && flags.contains(.option): // Cmd+Opt+B toggle browser
            toggleBrowser()
        case 48 where flags.contains(.shift): // Shift+Tab — toggle bottom panel (detail/clip view)
            toggleBottomPanel()
        case 48: // Tab — toggle arrangement/mixer view
            toggleMixerView()
        case 15 where flags.contains(.command) && flags.contains(.shift): // Cmd+Shift+R — render
            showRenderDialog()
        case 1 where flags.contains(.command) && flags.contains(.shift): // Cmd+Shift+S — save as
            saveProjectAs()
        case 1 where flags.contains(.command): // Cmd+S — save
            saveProject()
        case 31 where flags.contains(.command): // Cmd+O — open
            openProject(nil)
        default:
            super.keyDown(with: event)
        }
    }

    public override var acceptsFirstResponder: Bool { true }

    // MARK: - Mouse Events (Zoom/Resize)
    
    public override func scrollWheel(with event: NSEvent) {
        let flags = event.modifierFlags
        
        // --- Option + Scroll: Vertical Track Resizing (Ableton Style) ---
        if flags.contains(.option) {
            let delta = event.scrollingDeltaY
            let resizeFactor: CGFloat = delta > 0 ? 1.1 : 0.9
            
            // Apply resize to ALL tracks for global vertical zoom
            // Or only the one under the mouse (Enterprise refinement)
            for track in project.tracks {
                let newHeight = track.height * resizeFactor
                track.height = max(30, min(300, newHeight))
            }
            
            // Refresh UI
            reloadTracks()
            canvasView.needsDisplay = true
            return
        }
        
        // Fallback to default scrolling
        super.scrollWheel(with: event)
    }

    // MARK: - Undo/Redo

    /// Perform undo — called from keyDown or Edit menu responder chain.
    private func performUndo() {
        guard actionHistory.canUndo else { return }
        actionHistory.undo(on: project)
        reloadTracks()
        logger.info("Undo performed")
    }

    /// Perform redo — called from keyDown or Edit menu responder chain.
    private func performRedo() {
        guard actionHistory.canRedo else { return }
        actionHistory.redo(on: project)
        reloadTracks()
        logger.info("Redo performed")
    }

    /// Responder chain target for Edit > Undo menu item.
    @objc public func undo(_ sender: Any?) {
        performUndo()
    }

    /// Responder chain target for Edit > Redo menu item.
    @objc public func redo(_ sender: Any?) {
        performRedo()
    }

    // MARK: - Mixer View Toggle

    private func toggleMixerView() {
        switch viewMode {
        case .arrangement:
            viewMode = .mixer
            showMixerView()
        case .mixer:
            viewMode = .arrangement
            hideMixerView()
        }
    }

    private func showMixerView() {
        // Hide ALL arrangement-specific views
        canvasScrollView.isHidden = true
        headerScrollView.isHidden = true
        rulerView.isHidden = true
        vertDividerRight.isHidden = true
        vertDividerLeft.isHidden = true
        cornerViewRight.isHidden = true
        cornerViewLeft.isHidden = true
        browserSidebar.isHidden = true
        bottomPanel.isHidden = true
        bottomPanelDivider.isHidden = true

        // Create and show mixer view
        let mixerView = MixerView(project: project) { [weak self] track in
            self?.trackMixer.applyTrackSettings(track)
            self?.trackMixer.applySoloLogic(self?.project.tracks ?? [])
            self?.trackMixer.applyMasterSettings(self?.project.masterTrack ?? track)
        }

        let hostingView = NSHostingView(rootView: mixerView)
        hostingView.frame = view.bounds
        view.addSubview(hostingView)
        self.mixerHostingView = hostingView

        layoutSubviews()
    }

    private func hideMixerView() {
        mixerHostingView?.removeFromSuperview()
        mixerHostingView = nil

        // Restore ALL arrangement views
        canvasScrollView.isHidden = false
        headerScrollView.isHidden = false
        rulerView.isHidden = false
        cornerViewRight.isHidden = false
        cornerViewLeft.isHidden = false
        browserSidebar.isHidden = !isBrowserVisible
        vertDividerLeft.isHidden = !isBrowserVisible
        bottomPanelDivider.isHidden = bottomPanel.panelHeight == 0

        layoutSubviews()
    }

    // MARK: - Bottom Panel Toggle (Shift+Tab)

    /// Toggles the bottom panel between hidden, track detail, and clip view modes.
    /// - Hidden → shows detail for currently selected track (or first track)
    /// - Detail showing → hides the panel
    private func toggleBottomPanel() {
        switch bottomPanel.mode {
        case .hidden:
            // Show detail for current track (use first track as fallback)
            if let track = project.tracks.first {
                bottomPanel.mode = .detail(track)
            }
        case .detail, .pianoRoll:
            bottomPanel.mode = .hidden
        }
        layoutSubviews()
    }

    // MARK: - Render Dialog

    private func showRenderDialog() {
        guard !isRenderDialogShown else { return }
        isRenderDialogShown = true

        let renderView = RenderDialogView(project: project) { [weak self] in
            self?.dismissRenderDialog()
        }

        let hostingView = NSHostingView(rootView: renderView)
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 500, height: 420),
            styleMask: [.titled, .closable, .utilityWindow],
            backing: .buffered,
            defer: false
        )
        panel.title = "Render to Audio"
        panel.contentView = hostingView
        panel.appearance = NSAppearance(named: .darkAqua)
        panel.center()
        panel.isReleasedWhenClosed = false
        panel.makeKeyAndOrderFront(nil)
        self.renderPanel = panel

        // Track panel close
        NotificationCenter.default.addObserver(
            forName: NSWindow.willCloseNotification,
            object: panel,
            queue: .main
        ) { [weak self] _ in
            self?.isRenderDialogShown = false
        }
    }

    private func dismissRenderDialog() {
        guard isRenderDialogShown, let panel = renderPanel else { return }
        isRenderDialogShown = false
        panel.close()
        view.window?.makeKeyAndOrderFront(nil)
    }



    // MARK: - Project File Operations

    /// Save the current project (Cmd+S).
    private func saveProject() {
        let fm = ProjectFileManager.shared

        if fm.projectFolderURL != nil {
            showLoadingOverlay(message: "Saving Project...")
            Task {
                do {
                    let url = try await fm.save(project: project)
                    updateWindowTitle()
                    logger.info("Saved: \(url.lastPathComponent)")
                } catch {
                    logger.error("Save failed: \(error.localizedDescription)")
                    if case ProjectFileError.noProjectFolder = error {
                        saveProjectAs()
                    } else {
                        let alert = NSAlert(error: error)
                        alert.runModal()
                    }
                }
                hideLoadingOverlay()
            }
        } else {
            saveProjectAs()
        }
    }

    /// Save the current project to a new location (Cmd+Shift+S).
    /// Opens a full Finder-style NSSavePanel for filename and location.
    private func saveProjectAs() {
        let panel = NSSavePanel()
        let fm = ProjectFileManager.shared

        // Pre-fill filename with current project name
        let currentVersion = fm.projectFolderURL != nil ? fm.currentVersion : 1
        panel.nameFieldStringValue = "\(project.name) V\(currentVersion)"
        panel.allowedContentTypes = [.init(filenameExtension: ProjectFileManager.fileExtension) ?? .data]
        panel.canCreateDirectories = true
        panel.title = "Save Project"
        panel.prompt = "Save"
        panel.message = "Choose where to save \"\(project.name)\"."
        panel.appearance = NSAppearance(named: .darkAqua)

        // Open at the current project folder if one exists, otherwise Documents
        if let projectFolder = fm.projectFolderURL {
            panel.directoryURL = projectFolder
        } else if let fileURL = project.fileURL {
            panel.directoryURL = fileURL.deletingLastPathComponent()
        } else {
            panel.directoryURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Documents")
        }

        // Use runModal() for a full-size standalone Finder window
        let response = panel.runModal()
        guard response == .OK, let fileURL = panel.url else { return }

        showLoadingOverlay(message: "Saving Project...")
        Task {
            do {
                let savedURL = try await ProjectFileManager.shared.saveToFile(project: self.project, fileURL: fileURL)
                self.updateWindowTitle()
                self.logger.info("Saved as: \(savedURL.lastPathComponent)")
            } catch {
                let alert = NSAlert(error: error)
                alert.runModal()
            }
            self.hideLoadingOverlay()
        }
    }


    /// Open a project file (Cmd+O).
    @IBAction func openProject(_ sender: Any?) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowedContentTypes = [.init(filenameExtension: ProjectFileManager.fileExtension) ?? .data]
        panel.allowsMultipleSelection = false
        panel.prompt = "Open"
        panel.message = "Select a Dream DAW project file (.ddpj)"
        panel.appearance = NSAppearance(named: .darkAqua)

        panel.beginSheetModal(for: view.window!) { [weak self] response in
            guard response == .OK,
                  let fileURL = panel.url,
                  let self = self else { return }

            self.showLoadingOverlay(message: "Loading Project…")

            Task {
                do {
                    let openedProject = try await ProjectFileManager.shared.open(fileURL: fileURL)

                    // Update the current project in-place (don't resize window)
                    self.project.name = openedProject.name
                    self.project.bpm = openedProject.bpm
                    self.project.timeSignature = openedProject.timeSignature
                    self.project.sampleRate = openedProject.sampleRate
                    self.project.tracks = openedProject.tracks
                    self.project.masterTrack = openedProject.masterTrack
                    self.project.loopStart = openedProject.loopStart
                    self.project.loopEnd = openedProject.loopEnd
                    self.project.fileURL = openedProject.fileURL

                    // Reconfigure audio engine for the new tracks
                    self.trackMixer.configureTracks(self.project.tracks)
                    self.trackMixer.applyMasterSettings(self.project.masterTrack)
                    self.installMeteringTaps()
                    
                    // FIX: Helper methods
                    self.reloadTracks()
                    self.configureProject()
                    self.updateWindowTitle()
                    
                    self.logger.info("Opened project: \(openedProject.name)")
                } catch {
                    let alert = NSAlert(error: error)
                    alert.runModal()
                }
                self.hideLoadingOverlay()
            }
        }
    }

    // MARK: - Helper Methods
    

    func updateWindowTitle() {
        let fm = ProjectFileManager.shared
        let versionTag = fm.projectFolderURL != nil ? " V\(fm.currentVersion)" : ""
        view.window?.title = "\(project.name)\(versionTag) — Dream DAW"
    }

    func configureProject() {
        canvasView.project = project
        canvasView.pixelsPerBeat = pixelsPerBeat
        canvasView.orchestrator = orchestrator

        rulerView.pixelsPerBeat = pixelsPerBeat
        rulerView.bpm = project.bpm
        rulerView.timeSignature = project.timeSignature

        // Sync loop state from project → transport & ruler
        if let ls = project.loopStart {
            transportController.loopStart = ls
            rulerView.loopStart = ls
        }
        if let le = project.loopEnd {
            transportController.loopEnd = le
            rulerView.loopEnd = le
        }

        trackHeaders.configure(tracks: project.tracks)
        configureMasterHeader()
        
        // Restore additional state
        restoreViewState()
        if let selectedID = project.selectedTrackID {
            selectTrack(selectedID)
        }
        showNotification(title: "Project Loaded", message: project.name)
    }


    

    

    
    // MARK: - Safe Selection Logic
    
    private func selectTrack(_ trackID: UUID) {
        // 1. Update Project State
        project.selectedTrackID = trackID
        
        // 2. Update Track Headers Visual State
        for header in trackHeaders.headerViews {
            header.isSelected = (header.trackID == trackID)
        }
        
        // 3. Show Details in Bottom Panel
        if let track = project.tracks.first(where: { $0.id == trackID }) {
            bottomPanel.showDetail(for: track)
            
            // Ensure bottom panel is visible and layout is updated (unless it's hidden explicitly by user, but usually selection implies showing it)
            if bottomPanel.isHidden {
                // If the user selects a track, we generally want to show its details
                 bottomPanel.mode = .detail(track)
                 layoutSubviews()
            } else if case .pianoRoll = bottomPanel.mode {
                // If piano roll is open, maybe keep it open?
                // But for now, let's switch to detail to show track controls
                bottomPanel.mode = .detail(track)
                layoutSubviews()
            } else {
                 bottomPanel.mode = .detail(track)
                 layoutSubviews()
            }
        }
    }

    private func deleteTrack(id: UUID) {
        // Prevent deleting Master track
        guard id != project.masterTrack.id else { return }
        
        // Use Orchestrator for business logic & undo history
        orchestrator.deleteTrack(id: id)
        
        // Track-specific cleanup
        trackMixer.stopPlayer(for: id)
        
        if project.selectedTrackID == id {
            project.selectedTrackID = nil
            bottomPanel.mode = .hidden
            layoutSubviews()
        }
        
        reloadTracks()
        logger.info("Deleted track ID: \(id)")
        
        // Refresh audio context
        refreshAudio()
    }

    /// Flushes and re-schedules audio playback from the current position.
    /// Used for "hot-reloading" edits (moving, resizing, deleting clips) during playback.
    private func refreshAudio() {
        guard transportController.isPlaying else { return }
        
        logger.info("Hot-reloading playback from beat \(self.transportController.playheadPosition.beats)")
        
        playbackScheduler.schedulePlayback(
            project: project,
            from: transportController.playheadPosition,
            looping: transportController.isLooping,
            loopStart: transportController.loopStart,
            loopEnd: transportController.loopEnd
        )
    }

    private func showNotification(title: String, message: String) {
        logger.info("\(title): \(message)")
    }
}

// MARK: - FlippedView

/// NSView subclass with flipped coordinate system (y=0 at top).
/// Required because all layout math in layoutSubviews() uses top-down coordinates.
private final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}

