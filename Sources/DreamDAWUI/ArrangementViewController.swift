import AppKit
import SwiftUI
import Foundation
import Combine
import DreamDAWModels
import DreamDAWEngine
import os.log

// MARK: - Helper Views

/// Simple NSView subclass that flips the coordinate system (0,0 at top-left).
public final class FlippedView: NSView {
    public override var isFlipped: Bool { true }
}

// MARK: - ArrangementViewController

/// Main view controller for the arrangement view.
/// Layout: [ControlBar TOP] → [BrowserSidebar LEFT | Ruler+Canvas CENTER | TrackHeaders RIGHT] → [StatusBar BOTTOM]
/// This implementation uses a robust Manual Layout (frames) for maximum performance and stability.
public final class ArrangementViewController: NSViewController {

    // MARK: - Properties
    
    private let project: Project
    public let sharedEngine: SharedEngine
    private var interactionCoordinator: TimelineInteractionCoordinator!
    private var rendererCoordinator: ArrangementRendererCoordinator!
    private var orchestrator: ArrangementOrchestrator!
    private var cancellables = Set<AnyCancellable>()
    private let logger = Logger(subsystem: "com.dreamdaw", category: "ArrangementVC")

    // MARK: - UI Components
    
    private let rulerView = TimelineRulerView()
    private let trackHeaders = TrackHeadersContainerView()
    private let canvasView = TimelineCanvasView()
    private let masterLaneView = MasterLaneView()
    private let canvasScrollView = NSScrollView()
    private let headerScrollView = DragForwardingScrollView()
    private let browserSidebar = BrowserSidebarView()
    private let bottomPanel = BottomPanelView()
    private var masterHeaderView: TrackHeaderView?
    
    private let vertDividerLeft = NSView()
    private let vertDividerRight = NSView()
    private let bottomPanelDivider = NSView()
    private let cornerViewLeft = NSView()
    private let cornerViewRight = NSView()
    private var waveformRenderer: WaveformRenderer?
    
    // SwiftUI Hosting Views
    private var transportHostingView: NSHostingView<TransportBarView>?
    private var statusBarHostingView: NSHostingView<StatusBarView>?

    // State
    private var pixelsPerBeat: CGFloat = DreamTheme.defaultPixelsPerBeat
    private var isBrowserVisible: Bool = true {
        didSet { view.needsLayout = true }
    }
    private var browserWidth: CGFloat = DreamTheme.browserWidth
    private var keyEventMonitor: Any?
    private var meterUpdateTimer: Timer?
    private var pendingHorizontalScrollX: CGFloat?
    
    // Bottom Panel Dragging State
    private var isDraggingBottomDivider = false
    private var dragStartY: CGFloat = 0
    private var initialPanelHeight: CGFloat = 0
    private var dividerTrackingArea: NSTrackingArea?
    private var isDraggingBrowserDivider = false
    private var dragStartX: CGFloat = 0
    private var initialBrowserWidth: CGFloat = 0

    // MARK: - Absolute Architecture (Phase 1)
    /// Enterprise layout engine: O(1) Y lookup, O(log N) hit-testing.
    private let layoutEngine = TrackLayoutEngine()
    /// Sample-based viewport matrix for anchor zoom (will replace pixelsPerBeat in Sprint 2).
    private var viewportMatrix = ViewportMatrix()
    /// Phantom UX state machine: zero model mutations during drag.
    private let interactionSM = InteractionStateMachine()
    /// Tempo map for sample ↔ beat conversion.
    private var pulseMap = PulseMap(bpm: 120, sampleRate: 44100)

    // MARK: - Initialization

    public init(project: Project, sharedEngine: SharedEngine) {
        self.project = project
        self.sharedEngine = sharedEngine
        self.orchestrator = ArrangementOrchestrator(project: project, actionHistory: project.actionHistory)
        super.init(nibName: nil, bundle: nil)
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

    private func log(_ message: String) {
        NSLog("[ArrangementVC] \(message)")
    }

    public override func viewDidLoad() {
        super.viewDidLoad()
        
        // 1. Dependency Injection for Coordinators
        self.interactionCoordinator = TimelineInteractionCoordinator()
        self.interactionCoordinator.delegate = self

        self.rendererCoordinator = ArrangementRendererCoordinator(metalCanvas: self.canvasView)
        self.rendererCoordinator.delegate = self
        
        // 2. Setup Hierarchy
        setupHierarchy()
        
        // 3. System Config
        self.canvasView.interactionCoordinator = self.interactionCoordinator
        self.rulerView.interactionCoordinator = self.interactionCoordinator
        self.waveformRenderer = WaveformRenderer(waveformCache: sharedEngine.waveformCache)
        canvasView.waveformRenderer = self.waveformRenderer
        canvasView.project = project
        rulerView.timeSignature = project.timeSignature
        
        // Synchronize pixelsPerBeat
        rulerView.pixelsPerBeat = pixelsPerBeat
        canvasView.pixelsPerBeat = pixelsPerBeat
        
        // Sync Absolute Architecture systems with project state
        pulseMap.setConstantTempo(Double(project.bpm))
        
        setupAudioEngine()
        setupBindings()
        configureProject()
        installGlobalKeyMonitor()
        
        transportController.onPlayRequested = { [weak self] in
            self?.preparePlaybackPosition()
        }
        
        log("viewDidLoad finished. Project assigned. PPB: \(pixelsPerBeat)")
    }

    public override func viewDidLayout() {
        super.viewDidLayout()
        performManualLayout()
    }

    deinit {
        meterUpdateTimer?.invalidate()
        meterUpdateTimer = nil
        if let monitor = keyEventMonitor {
            NSEvent.removeMonitor(monitor)
        }
    }

    // MARK: - Setup Hierarchy

    private func setupHierarchy() {
        // Timeline & Ruler
        rulerView.wantsLayer = true
        view.addSubview(rulerView)
        
        canvasScrollView.wantsLayer = true
        canvasScrollView.drawsBackground = false
        canvasScrollView.hasVerticalScroller = true
        canvasScrollView.hasHorizontalScroller = true
        canvasScrollView.documentView = canvasView
        canvasScrollView.scrollerStyle = .overlay
        canvasScrollView.horizontalScrollElasticity = .none
        canvasScrollView.verticalScrollElasticity = .none
        view.addSubview(canvasScrollView)
        
        // Headers Layer
        headerScrollView.wantsLayer = true
        headerScrollView.drawsBackground = false
        headerScrollView.documentView = trackHeaders
        headerScrollView.hasVerticalScroller = false
        view.addSubview(headerScrollView)

        // Pinned master lane (always visible at bottom of arrangement)
        masterLaneView.wantsLayer = true
        masterLaneView.pixelsPerBeat = pixelsPerBeat
        masterLaneView.timeSignature = project.timeSignature
        view.addSubview(masterLaneView)
        
        // Dividers
        [vertDividerLeft, vertDividerRight, bottomPanelDivider].forEach { d in
            d.wantsLayer = true
            d.layer?.backgroundColor = DreamTheme.divider.cgColor
            view.addSubview(d)
        }
        
        // SwiftUI Containers
        let transportView = TransportBarView(
            transportController: sharedEngine.transportController,
            project: project
        )
        let tHosting = NSHostingView(rootView: transportView)
        tHosting.wantsLayer = true
        view.addSubview(tHosting)
        self.transportHostingView = tHosting
        
        let statusView = StatusBarView(
            transportController: sharedEngine.transportController,
            project: project
        )
        let sHosting = NSHostingView(rootView: statusView)
        sHosting.wantsLayer = true
        view.addSubview(sHosting)
        self.statusBarHostingView = sHosting
        
        // Panels
        bottomPanel.wantsLayer = true
        view.addSubview(bottomPanel)
        
        browserSidebar.wantsLayer = true
        browserSidebar.layer?.backgroundColor = DreamTheme.bgBrowser.cgColor
        view.addSubview(browserSidebar)
        
        cornerViewLeft.wantsLayer = true
        cornerViewLeft.layer?.backgroundColor = DreamTheme.bgHeader.cgColor
        view.addSubview(cornerViewLeft)
        
        cornerViewRight.wantsLayer = true
        cornerViewRight.layer?.backgroundColor = DreamTheme.bgHeader.cgColor
        view.addSubview(cornerViewRight)

        // Pinned master header (always visible at bottom of track headers column)
        let masterHeader = TrackHeaderView(track: project.masterTrack, index: project.tracks.count)
        masterHeader.onHeaderClicked = { [weak self] trackID, isShift in
            self?.handleTrackSelection(trackID, isShift: isShift)
        }
        masterHeader.onTrackChanged = { [weak self] track in
            guard let self = self else { return }
            self.sharedEngine.trackMixer.applyMasterSettings(track)
            self.reloadTracks()
        }
        masterHeader.onSoloChanged = { [weak self] in
            guard let self = self else { return }
            self.sharedEngine.trackMixer.applySoloLogic(self.project.tracks + [self.project.masterTrack])
        }
        masterHeader.onLayoutRequested = { [weak self] in
            self?.handleTrackHeightLayoutUpdate(interactive: true)
        }
        masterHeader.onExpansionChanged = { [weak self] in
            self?.handleTrackHeightLayoutUpdate(interactive: false)
        }
        masterHeader.trackResolver = { [weak self] id in
            guard let self = self else { return nil }
            return (self.project.tracks + [self.project.masterTrack]).first(where: { $0.id == id })
        }
        masterHeader.routingDestinationProvider = { [weak self] in
            guard let self = self else { return [] }
            return self.project.tracks + [self.project.masterTrack]
        }
        masterHeader.onOutputChanged = { _ in
            // Master output stays hardware-bound.
        }
        masterHeader.isHidden = false
        view.addSubview(masterHeader)
        self.masterHeaderView = masterHeader
    }

    // MARK: - Manual Layout

    private func performManualLayout() {
        guard view.window != nil else { return } // Not yet attached — skip layout.
        let bounds = view.bounds
        let titleBarH: CGFloat = 28
        let controlBarH = DreamTheme.controlBarHeight
        let statusBarH = DreamTheme.statusBarHeight
        let rulerH = DreamTheme.rulerHeight
        let dynamicBrowserMax = max(
            DreamTheme.browserMinWidth,
            min(DreamTheme.browserMaxWidth, bounds.width * 0.45)
        )
        let clampedBrowserWidth = min(dynamicBrowserMax, max(DreamTheme.browserMinWidth, browserWidth))
        browserWidth = clampedBrowserWidth
        let browserW = isBrowserVisible ? clampedBrowserWidth : 0
        let bottomPanelH = bottomPanel.isHidden ? 0 : bottomPanel.panelHeight
        let masterLaneH = project.masterTrack.height
        
        let headerW = DreamTheme.trackHeaderWidth + CGFloat(project.maxTrackDepth * 8)
        
        transportHostingView?.frame = CGRect(x: 0, y: titleBarH, width: bounds.width, height: controlBarH)
        statusBarHostingView?.frame = CGRect(x: 0, y: bounds.height - statusBarH, width: bounds.width, height: statusBarH)
        
        let contentTop = titleBarH + controlBarH
        let contentBottom = bounds.height - statusBarH - bottomPanelH
        let contentHeight = contentBottom - contentTop
        
        browserSidebar.frame = CGRect(x: 0, y: contentTop, width: browserW, height: contentHeight)
        browserSidebar.isHidden = !isBrowserVisible
        vertDividerLeft.frame = CGRect(x: browserW, y: contentTop, width: 1, height: contentHeight)
        vertDividerLeft.isHidden = !isBrowserVisible
        
        let mainStartX = browserW + (isBrowserVisible ? 1 : 0)
        let mainEndX = bounds.width - headerW - 1
        let mainWidth = mainEndX - mainStartX
        
        rulerView.frame = CGRect(x: mainStartX, y: contentTop, width: mainWidth, height: rulerH)
        cornerViewLeft.frame = CGRect(x: 0, y: contentTop, width: mainStartX, height: rulerH)
        cornerViewRight.frame = CGRect(x: mainEndX + 1, y: contentTop, width: headerW, height: rulerH)
        
        let canvasTop = contentTop + rulerH
        let scrollAreaH = max(0, contentHeight - rulerH - masterLaneH)

        canvasScrollView.frame = CGRect(x: mainStartX, y: canvasTop, width: mainWidth, height: scrollAreaH)
        headerScrollView.frame = CGRect(x: mainEndX + 1, y: canvasTop, width: headerW, height: scrollAreaH)
        masterLaneView.frame = CGRect(x: mainStartX, y: canvasTop + scrollAreaH, width: mainWidth, height: masterLaneH)
        masterHeaderView?.frame = CGRect(x: mainEndX + 1, y: canvasTop + scrollAreaH, width: headerW, height: masterLaneH)
        vertDividerRight.frame = CGRect(x: mainEndX, y: contentTop, width: 1, height: contentHeight)
        
        if !bottomPanel.isHidden {
            bottomPanel.frame = CGRect(x: 0, y: contentBottom, width: bounds.width, height: bottomPanelH)
            bottomPanelDivider.frame = CGRect(x: 0, y: contentBottom - 1, width: bounds.width, height: 1)
            bottomPanelDivider.isHidden = false
        } else {
            bottomPanelDivider.isHidden = true
        }
        
        let visibleTracks = project.allVisibleTracks.filter { $0.trackType != .master }
        // 1. Sync Foundations
        layoutEngine.rebuildCache(visibleTracks: visibleTracks)
        canvasView.layoutEngine = self.layoutEngine
        
        viewportMatrix.viewportWidth = Double(mainWidth)
        viewportMatrix.viewportHeight = Double(scrollAreaH)
        canvasView.viewportMatrix = self.viewportMatrix
        canvasView.interactionSM = self.interactionSM

        let totalTrackH = layoutEngine.totalHeight
        let canvasW = CGFloat(viewportMatrix.visibleEndSample / viewportMatrix.samplesPerPixel)
        
        canvasView.frame = NSRect(x: 0, y: 0, width: max(canvasW, mainWidth), height: max(totalTrackH, scrollAreaH))
        trackHeaders.frame = NSRect(x: 0, y: 0, width: headerW, height: max(totalTrackH, scrollAreaH))
        
        trackHeaders.configure(tracks: visibleTracks, viewportHeight: scrollAreaH)
        masterHeaderView?.configure(maxDepth: project.maxTrackDepth, depth: 0, isLastInGroup: true)
        masterHeaderView?.isSelected = (project.selectedTrackID == project.masterTrack.id)
        masterLaneView.isSelected = (project.selectedTrackID == project.masterTrack.id)
        masterLaneView.pixelsPerBeat = pixelsPerBeat
        masterLaneView.timeSignature = project.timeSignature
        masterLaneView.scrollOffset = canvasScrollView.contentView.bounds.origin.x

        let clampedX = canvasScrollView.contentView.bounds.origin.x
        let clampedY = canvasScrollView.contentView.bounds.origin.y
        canvasScrollView.contentView.scroll(to: NSPoint(x: clampedX, y: clampedY))
        canvasScrollView.reflectScrolledClipView(canvasScrollView.contentView)
        headerScrollView.contentView.scroll(to: NSPoint(x: 0, y: clampedY))
        headerScrollView.reflectScrolledClipView(headerScrollView.contentView)
        masterLaneView.scrollOffset = clampedX
        
        // Force refresh after frame assignment
        setupDividerTrackingArea()
        canvasView.updateArrangementLayers(fullRedraw: true)
        log("performManualLayout finished. Matrix visibleStartSample: \(viewportMatrix.visibleStartSample)")
    }

    // MARK: - Public API

    @objc public func reloadTracks() {
        let nonMasterTracks = project.allVisibleTracks.filter { $0.trackType != .master }
        trackHeaders.configure(tracks: nonMasterTracks, viewportHeight: canvasScrollView.bounds.height)
        masterHeaderView?.configure(maxDepth: project.maxTrackDepth, depth: 0, isLastInGroup: true)
        masterHeaderView?.isSelected = (project.selectedTrackID == project.masterTrack.id)
        masterLaneView.isSelected = (project.selectedTrackID == project.masterTrack.id)
        canvasView.updateArrangementLayers()
        rendererCoordinator.rebuildSpatialIndex(with: project)
        view.needsLayout = true
    }

    public func setZoom(_ ppb: CGFloat) {
        applyZoom(ppb, anchoredScrollX: nil)
    }

    private func applyZoom(_ ppb: CGFloat, anchoredScrollX: CGFloat?) {
        self.pixelsPerBeat = min(DreamTheme.maxPixelsPerBeat, max(DreamTheme.minPixelsPerBeat, ppb))
        canvasView.pixelsPerBeat = pixelsPerBeat
        rulerView.pixelsPerBeat = pixelsPerBeat
        masterLaneView.pixelsPerBeat = pixelsPerBeat
        project.viewZoomScale = Double(pixelsPerBeat)
        if let x = anchoredScrollX {
            pendingHorizontalScrollX = x
            project.viewScrollPosition = Double(x)
        }
        view.needsLayout = true
    }

    public var transportController: TransportController {
        return sharedEngine.transportController
    }
    
    @objc public func undo(_ sender: Any?) {
        // Redo/Undo logic usually lives in orchestrator or similar
        reloadTracks()
    }
    
    @objc public func redo(_ sender: Any?) {
        reloadTracks()
    }

    @objc public func duplicate(_ sender: Any?) {
        canvasView.duplicateSelection()
    }
    @objc public func split(_ sender: Any?) {
        canvasView.splitClipsAtEditCursor()
    }

    private func setupAudioEngine() {
        sharedEngine.trackMixer.configureTracks(project.tracks, masterTrack: project.masterTrack)
        sharedEngine.trackMixer.applyMasterSettings(project.masterTrack)
        sharedEngine.trackMixer.applySoloLogic(project.tracks + [project.masterTrack])
        
        transportController.bpm = project.bpm
        transportController.timeSignature = project.timeSignature
        transportController.isLooping = project.isLooping
        transportController.loopStart = project.loopStart ?? .zero
        transportController.loopEnd = project.loopEnd ?? TimePosition(bars: 4)
        
        transportController.onStateChange = { [weak self] state in
            self?.handleTransportStateChange(state)
        }
        transportController.onLoopWrap = { [weak self] in
            self?.reschedulePlaybackFromCurrentPosition()
        }

        do {
            try sharedEngine.audioEngine.start()
        } catch {
            logger.error("Failed to start audio engine: \(error.localizedDescription)")
        }
    }

    private func setupBindings() {
        // Vertical Scroll Sync
        NotificationCenter.default.addObserver(
            forName: NSView.boundsDidChangeNotification,
            object: canvasScrollView.contentView,
            queue: .main
        ) { [weak self] _ in
            guard let self = self else { return }
            let canvasX = self.canvasScrollView.contentView.bounds.origin.x
            let canvasY = self.canvasScrollView.contentView.bounds.origin.y
            self.project.viewScrollPosition = Double(canvasX)
            self.masterLaneView.scrollOffset = canvasX
            self.headerScrollView.contentView.scroll(to: NSPoint(x: 0, y: canvasY))
        }
        canvasScrollView.contentView.postsBoundsChangedNotifications = true

        // Transport -> UI
        transportController.onPlayheadUpdate = { [weak self] position in
            guard let self = self else { return }
            self.project.playheadPosition = position
            self.canvasView.playheadPosition = position
            self.rulerView.playheadPosition = position
        }
        
        // Ruler -> Transport
        rulerView.onClickPosition = { [weak self] position in
            self?.transportController.seek(to: position)
        }

        canvasView.onZoomChanged = { [weak self] newPPB, newScrollX in
            self?.applyZoom(newPPB, anchoredScrollX: newScrollX)
        }
        canvasView.onTrackClicked = { [weak self] trackID in
            self?.handleTrackSelection(trackID, isShift: false)
        }
        canvasView.onClipSelected = { [weak self] trackID, clipID in
            guard let self = self else { return }
            self.project.primarySelectedClipID = clipID
            self.handleTrackSelection(trackID, isShift: false)
            guard let track = self.project.allVisibleTracks.first(where: { $0.id == trackID }),
                  let state = self.project.panelState(for: trackID) else { return }
            switch state.kind {
            case .pianoRoll:
                if let clip = track.midiClips.first(where: { $0.id == clipID }) {
                    self.setBottomPanelMode(.pianoRoll(track, clip))
                }
            case .audioClip:
                if let clip = track.clips.first(where: { $0.id == clipID }) {
                    self.setBottomPanelMode(.audioClip(track, clip))
                }
            case .detail:
                break
            }
        }
        canvasView.onMidiClipDoubleClicked = { [weak self] trackID, clipID in
            guard let self = self,
                  let track = self.project.allVisibleTracks.first(where: { $0.id == trackID }),
                  let clip = track.midiClips.first(where: { $0.id == clipID }) else { return }
            self.project.primarySelectedClipID = clipID
            self.setBottomPanelMode(.pianoRoll(track, clip))
            self.project.selectedTrackID = trackID
            self.trackHeaders.updateSelection(selectedID: trackID)
            self.masterHeaderView?.isSelected = (trackID == self.project.masterTrack.id)
            self.masterLaneView.isSelected = (trackID == self.project.masterTrack.id)
            self.bottomPanel.isHidden = false
            self.view.needsLayout = true
        }
        
        // Selection Logic
        trackHeaders.onHeaderClicked = { [weak self] trackID, isShift in
            self?.handleTrackSelection(trackID, isShift: isShift)
        }
        trackHeaders.onTrackChanged = { [weak self] track in
            guard let self = self else { return }
            self.sharedEngine.trackMixer.applyTrackSettings(track)
            self.reloadTracks()
        }
        trackHeaders.onSoloChanged = { [weak self] in
            guard let self = self else { return }
            self.sharedEngine.trackMixer.applySoloLogic(self.project.tracks + [self.project.masterTrack])
        }
        trackHeaders.onLayoutRequested = { [weak self] in
            self?.handleTrackHeightLayoutUpdate(interactive: true)
        }
        trackHeaders.onExpansionChanged = { [weak self] in
            self?.handleTrackHeightLayoutUpdate(interactive: false)
        }
        masterLaneView.trackID = project.masterTrack.id
        masterLaneView.onTrackClicked = { [weak self] in
            guard let self = self else { return }
            self.handleTrackSelection(self.project.masterTrack.id, isShift: false)
        }
        masterLaneView.onEditCursorChanged = { [weak self] position in
            self?.transportController.seek(to: position)
        }
        
        startHeaderMeteringTimer()
    }

    private func handleTrackHeightLayoutUpdate(interactive: Bool) {
        guard isViewLoaded else { return }
        view.needsLayout = true
        if interactive {
            view.layoutSubtreeIfNeeded()
            return
        }
        rendererCoordinator.rebuildSpatialIndex(with: project)
        canvasView.updateArrangementLayers(fullRedraw: true)
    }

    private func handleTrackSelection(_ trackID: UUID, isShift: Bool) {
        project.selectedTrackID = trackID
        trackHeaders.updateSelection(selectedID: trackID)
        masterHeaderView?.isSelected = (trackID == project.masterTrack.id)
        masterLaneView.isSelected = (trackID == project.masterTrack.id)
        
        if let track = project.allVisibleTracks.first(where: { $0.id == trackID }) {
            restoreBottomPanelMode(for: track)
            bottomPanel.isHidden = false
            view.needsLayout = true
        }
    }

    private func restoreBottomPanelMode(for track: Track) {
        guard let state = project.panelState(for: track.id) else {
            setBottomPanelMode(.detail(track))
            return
        }

        switch state.kind {
        case .detail:
            setBottomPanelMode(.detail(track))
        case .pianoRoll:
            let clip = state.midiClipID.flatMap { id in track.midiClips.first(where: { $0.id == id }) } ?? track.midiClips.first
            if let clip = clip {
                setBottomPanelMode(.pianoRoll(track, clip))
            } else {
                setBottomPanelMode(.detail(track))
            }
        case .audioClip:
            let clip = state.audioClipID.flatMap { id in track.clips.first(where: { $0.id == id }) } ?? track.clips.first
            if let clip = clip {
                setBottomPanelMode(.audioClip(track, clip))
            } else {
                setBottomPanelMode(.detail(track))
            }
        }
    }

    private func setBottomPanelMode(_ mode: BottomPanelView.PanelMode) {
        bottomPanel.mode = mode
        switch mode {
        case .hidden:
            break
        case .detail(let track):
            project.setPanelState(for: track.id, state: TrackPanelState(kind: .detail))
        case .pianoRoll(let track, let clip):
            project.setPanelState(
                for: track.id,
                state: TrackPanelState(kind: .pianoRoll, midiClipID: clip.id, audioClipID: nil)
            )
        case .audioClip(let track, let clip):
            project.setPanelState(
                for: track.id,
                state: TrackPanelState(kind: .audioClip, midiClipID: nil, audioClipID: clip.id)
            )
        }
    }
    
    private func preparePlaybackPosition() {
        // Resume from pause without jumping.
        guard transportController.state == .stopped else { return }

        // Deterministic start point: edit cursor.
        transportController.seek(to: project.editCursorPosition)
    }

    private func startHeaderMeteringTimer() {
        meterUpdateTimer?.invalidate()
        meterUpdateTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in
            self?.refreshHeaderMeterLevels()
        }
        if let timer = meterUpdateTimer {
            RunLoop.main.add(timer, forMode: .common)
        }
    }

    private func refreshHeaderMeterLevels() {
        let meter = sharedEngine.audioLevelMeter
        for header in trackHeaders.headerViews {
            guard let track = project.tracks.first(where: { $0.id == header.trackID }) else { continue }
            if track.trackType == .midi && track.instrument == nil {
                let midi = meter.midiLevel(for: track.id)
                header.updateMeterLevel(rms: midi, peak: midi)
            } else {
                let post = meter.level(for: track.id, point: .postEffects)
                header.updateMeterLevel(rms: post.rms, peak: post.peak)
            }
        }

        if let masterHeaderView = masterHeaderView {
            let master = meter.masterLevelValue()
            masterHeaderView.updateMeterLevel(rms: master.rms, peak: master.peak)
        }
    }

    private func handleTransportStateChange(_ state: TransportState) {
        switch state {
        case .playing:
            sharedEngine.trackMixer.configureTracks(project.tracks, masterTrack: project.masterTrack)
            sharedEngine.trackMixer.applyMasterSettings(project.masterTrack)
            sharedEngine.trackMixer.applySoloLogic(project.tracks + [project.masterTrack])

            do {
                try sharedEngine.audioEngine.start()
            } catch {
                logger.error("Audio engine start failed on play: \(error.localizedDescription)")
            }

            reschedulePlaybackFromCurrentPosition()
        case .paused:
            sharedEngine.playbackScheduler.stop()
            sharedEngine.trackMixer.stopAll()
        case .stopped:
            sharedEngine.playbackScheduler.stop()
            sharedEngine.playbackScheduler.stopAll()
        }
    }

    private func reschedulePlaybackFromCurrentPosition() {
        let startPosition = transportController.playheadPosition
        sharedEngine.playbackScheduler.schedulePlaybackAsync(
            project: project,
            from: startPosition,
            looping: transportController.isLooping,
            loopStart: transportController.loopStart,
            loopEnd: transportController.loopEnd
        ) { [weak self] startTime in
            self?.transportController.start(at: startTime, notify: false)
        }
    }

    private func configureProject() {
        isBrowserVisible = true
        if let savedBrowserWidth = project.viewBrowserWidth {
            browserWidth = min(DreamTheme.browserMaxWidth, max(DreamTheme.browserMinWidth, CGFloat(savedBrowserWidth)))
        } else {
            browserWidth = DreamTheme.browserWidth
        }
        if let savedZoom = project.viewZoomScale {
            setZoom(CGFloat(savedZoom))
        }
        if let savedScroll = project.viewScrollPosition {
            pendingHorizontalScrollX = CGFloat(savedScroll)
        }
        transportController.seek(to: project.playheadPosition)
        
        // PHASE 9.2: Initial Project Synchronization
        // Ensures all existing clips have sample-accurate bounds for Metal rendering.
        let pm = PulseMap(bpm: project.bpm, sampleRate: project.sampleRate)
        for track in project.tracks {
            for i in 0..<track.clips.count {
                track.clips[i].synchronize(with: pm)
            }
            for i in 0..<track.midiClips.count {
                track.midiClips[i].synchronize(with: pm)
            }
        }
        
        reloadTracks()
        if let selectedID = project.primarySelectedTrackID,
           project.allVisibleTracks.contains(where: { $0.id == selectedID }) {
            handleTrackSelection(selectedID, isShift: false)
        } else if let first = project.allVisibleTracks.first {
            handleTrackSelection(first.id, isShift: false)
        }
    }

    private func installGlobalKeyMonitor() {
        keyEventMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self = self else { return event }

            // Never intercept text input/editing shortcuts.
            if let editor = self.view.window?.firstResponder as? NSTextView, editor.isEditable {
                return event
            }

            if event.keyCode == 49 { // Space
                self.transportController.togglePlayPause()
                return nil
            }
            
            // Shift + Tab (48 + shift modifier)
            if event.keyCode == 48 && event.modifierFlags.contains(.shift) {
                self.toggleBottomPanelEditor()
                return nil
            }
            
            return event
        }
    }
    
    private func toggleBottomPanelEditor() {
        guard let trackID = project.primarySelectedTrackID,
              let track = project.allVisibleTracks.first(where: { $0.id == trackID }) else { return }
        
        switch bottomPanel.mode {
        case .detail:
            // Switch to Editor
            if track.trackType == .midi {
                // Find primary clip or first available
                let clipID = project.primarySelectedClipID ?? track.midiClips.first?.id
                if let cid = clipID, let clip = track.midiClips.first(where: { $0.id == cid }) {
                    setBottomPanelMode(.pianoRoll(track, clip))
                } else if let first = track.midiClips.first {
                    setBottomPanelMode(.pianoRoll(track, first))
                }
            } else if track.trackType == .audio {
                let clipID = project.primarySelectedClipID ?? track.clips.first?.id
                if let cid = clipID, let clip = track.clips.first(where: { $0.id == cid }) {
                    setBottomPanelMode(.audioClip(track, clip))
                } else if let first = track.clips.first {
                    setBottomPanelMode(.audioClip(track, first))
                }
            }
        case .pianoRoll, .audioClip:
            // Switch to Devices
            setBottomPanelMode(.detail(track))
        default:
            break
        }
    }
}

extension ArrangementViewController: TimelineInteractionDelegate {
    public func interactionDidRequestTrackSelection(id: UUID, isShift: Bool) {
        handleTrackSelection(id, isShift: isShift)
    }
    
    public func interactionDidRequestSeek(to position: TimePosition, on trackID: UUID?) {
        transportController.seek(to: position)
        project.editCursorPosition = position
        if let id = trackID {
            project.primarySelectedTrackID = id
        }
    }
    
    public func interactionDidUpdateSelection(clipIDs: [UUID], isShift: Bool) {
        let clipSet = Set(clipIDs)
        if isShift {
            project.selectedClipIDs.formUnion(clipSet)
        } else {
            project.selectedClipIDs = clipSet
        }
        
        if let first = clipIDs.first {
            project.primarySelectedClipID = first
        }
    }
    
    public func interactionDidCommitClipsModification(finalState: InteractionState) {
        log("interactionDidCommitClipsModification with state: \(finalState)")
        
        switch finalState {
        case .marqueeSelecting(let startX, let currentX, let startY, let currentY):
            // Perform marquee selection query
            let minX = min(startX, currentX)
            let maxX = max(startX, currentX)
            let minY = min(startY, currentY)
            let maxY = max(startY, currentY)
            
            let beatMin = Double(minX) / Double(pixelsPerBeat)
            let beatMax = Double(maxX) / Double(pixelsPerBeat)
            
            let query = QuadRect(minX: beatMin, maxX: beatMax, minY: Double(minY), maxY: Double(maxY))
            if let results = canvasView.quadTree?.query(range: query) {
                let ids = Set(results.map { $0.id })
                orchestrator.selectClips(ids: ids)
            } else {
                orchestrator.selectClips(ids: [])
            }
            
        case .dragging(let ids, let deltaSamples, let deltaTracks):
            let deltaBeats = Double(deltaSamples) / Double(project.sampleRate * 60.0 / Double(project.bpm))
            
            for id in ids {
                // Find current track
                guard let sourceTrack = project.allVisibleTracks.first(where: { t in
                    t.clips.contains(where: { $0.id == id }) || t.midiClips.contains(where: { $0.id == id })
                }) else { continue }
                
                let sourceIdx = project.allVisibleTracks.firstIndex(where: { $0.id == sourceTrack.id }) ?? 0
                let targetIdx = max(0, min(project.allVisibleTracks.count - 1, sourceIdx + deltaTracks))
                let targetTrack = project.allVisibleTracks[targetIdx]
                
                let oldPos: Double
                if let clip = sourceTrack.clips.first(where: { $0.id == id }) {
                    oldPos = clip.position.beats
                } else if let clip = sourceTrack.midiClips.first(where: { $0.id == id }) {
                    oldPos = clip.position.beats
                } else { continue }
                
                orchestrator.finalizeClipMove(
                    id: id,
                    fromTrackID: sourceTrack.id,
                    toTrackID: targetTrack.id,
                    oldPositionBeats: oldPos,
                    newPositionBeats: oldPos + deltaBeats
                )
            }
            
        case .trimming(let id, let edge, let bounds, let deltaSamples):
            let deltaBeats = Double(deltaSamples) / Double(project.sampleRate * 60.0 / Double(project.bpm))
            
            guard let track = project.allVisibleTracks.first(where: { t in
                t.clips.contains(where: { $0.id == id }) || t.midiClips.contains(where: { $0.id == id })
            }) else { break }
            
            let isMidi = track.midiClips.contains(where: { $0.id == id })
            let oldStart = Double(bounds.startSample) / Double(project.sampleRate * 60.0 / Double(project.bpm))
            let oldDur = Double(bounds.endSample - bounds.startSample) / Double(project.sampleRate * 60.0 / Double(project.bpm))
            let oldTrim = Double(bounds.trimStartOffsetSamples) / Double(project.sampleRate * 60.0 / Double(project.bpm))
            
            var newStart = oldStart
            var newDur = oldDur
            var newTrim = oldTrim
            
            if edge == .left {
                newStart += deltaBeats
                newDur -= deltaBeats
                if !isMidi { newTrim += deltaBeats }
            } else {
                newDur += deltaBeats
            }
            
            orchestrator.finalizeClipResize(
                id: id,
                trackID: track.id,
                isMidi: isMidi,
                oldPositionBeats: oldStart,
                oldDurationBeats: oldDur,
                oldTrimBeats: oldTrim,
                newPositionBeats: newStart,
                newDurationBeats: newDur,
                newTrimBeats: newTrim
            )
            
        default:
            break
        }
        
        canvasView.updateArrangementLayers(fullRedraw: true)
    }
    
    public func interactionDidRequestLoopStartChange(to position: TimePosition) {
        transportController.loopStart = position
        rulerView.loopStart = position
        canvasView.updateArrangementLayers(fullRedraw: false)
    }
    
    public func interactionDidRequestLoopEndChange(to position: TimePosition) {
        transportController.loopEnd = position
        rulerView.loopEnd = position
        canvasView.updateArrangementLayers(fullRedraw: false)
    }
}

// MARK: - Bottom Panel Resizing
extension ArrangementViewController {

    public override func mouseDown(with event: NSEvent) {
        let location = view.convert(event.locationInWindow, from: nil)

        // Hit test for browser divider (right edge of browser panel).
        if isBrowserVisible && abs(location.x - vertDividerLeft.frame.midX) <= 4 {
            isDraggingBrowserDivider = true
            dragStartX = location.x
            initialBrowserWidth = browserWidth
            return
        }
        
        // Hit test for bottom divider
        if !bottomPanel.isHidden && abs(location.y - bottomPanelDivider.frame.midY) <= 4 {
            isDraggingBottomDivider = true
            dragStartY = location.y
            initialPanelHeight = BottomPanelView.defaultHeight
            return
        }
    }

    public override func mouseDragged(with event: NSEvent) {
        if isDraggingBrowserDivider {
            let location = view.convert(event.locationInWindow, from: nil)
            let deltaX = location.x - dragStartX
            let newWidth = initialBrowserWidth + deltaX
            browserWidth = min(DreamTheme.browserMaxWidth, max(DreamTheme.browserMinWidth, newWidth))
            project.viewBrowserWidth = Double(browserWidth)
            view.needsLayout = true
            return
        }

        if isDraggingBottomDivider {
            let location = view.convert(event.locationInWindow, from: nil)
            let deltaY = location.y - dragStartY
            
            // Invert deltaY because we are dragging UP to increase height (decreases Y coordinate in flipped view)
            // Wait, in a flipped view (Y=0 at top), dragging UP means Y decreases.
            // bottomPanel bottom is at view.bounds.height - statusBarH.
            // bottomPanel top is at contentBottom (bottom - height).
            // So if we drag UP, location.y decreases, and height increases.
            
            let newHeight = max(DreamTheme.bottomPanelMinHeight, initialPanelHeight - deltaY)
            BottomPanelView.defaultHeight = min(newHeight, view.bounds.height * 0.8) // Cap at 80% screen
            view.needsLayout = true
        }
    }

    public override func mouseUp(with event: NSEvent) {
        if isDraggingBrowserDivider {
            isDraggingBrowserDivider = false
            project.viewBrowserWidth = Double(browserWidth)
        }
        isDraggingBottomDivider = false
    }

    // Update tracking area for the divider cursor
    public override func updateViewConstraints() {
        super.updateViewConstraints()
        setupDividerTrackingArea()
    }

    private func setupDividerTrackingArea() {
        if let existing = dividerTrackingArea {
            view.removeTrackingArea(existing)
        }
        
        let area = NSTrackingArea(
            rect: .zero,
            options: [.mouseMoved, .activeInKeyWindow, .inVisibleRect],
            owner: self,
            userInfo: nil
        )
        view.addTrackingArea(area)
        dividerTrackingArea = area
    }

    public override func mouseMoved(with event: NSEvent) {
        let location = view.convert(event.locationInWindow, from: nil)
        if isBrowserVisible && abs(location.x - vertDividerLeft.frame.midX) <= 4 {
            NSCursor.resizeLeftRight.set()
        } else if !bottomPanel.isHidden && abs(location.y - bottomPanelDivider.frame.midY) <= 4 {
            NSCursor.resizeUpDown.set()
        } else {
            NSCursor.arrow.set()
        }
    }
}

extension ArrangementViewController: ArrangementRendererDelegate {
    public func rendererDidRequestVisibleTimeRangeUpdate(range: TimeRange) {
        // Redraw logic or state update if needed
    }
}
