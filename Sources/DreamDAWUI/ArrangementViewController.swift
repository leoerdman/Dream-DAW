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
    private var keyEventMonitor: Any?
    private var meterUpdateTimer: Timer?
    private var pendingHorizontalScrollX: CGFloat?

    // MARK: - Initialization

    public init(project: Project, sharedEngine: SharedEngine) {
        self.project = project
        self.sharedEngine = sharedEngine
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
        self.waveformRenderer = WaveformRenderer(waveformCache: sharedEngine.waveformCache)
        canvasView.waveformRenderer = self.waveformRenderer
        canvasView.project = project
        rulerView.timeSignature = project.timeSignature
        
        // Synchronize pixelsPerBeat
        rulerView.pixelsPerBeat = pixelsPerBeat
        canvasView.pixelsPerBeat = pixelsPerBeat
        
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
        let bounds = view.bounds
        let titleBarH: CGFloat = 28
        let controlBarH = DreamTheme.controlBarHeight
        let statusBarH = DreamTheme.statusBarHeight
        let rulerH = DreamTheme.rulerHeight
        let browserW = isBrowserVisible ? DreamTheme.browserWidth : 0
        let bottomPanelH = bottomPanel.isHidden ? 0 : bottomPanel.panelHeight
        let masterLaneH = project.masterTrack.height
        
        let headerW = DreamTheme.trackHeaderWidth + CGFloat(project.maxTrackDepth * 8)
        
        transportHostingView?.frame = CGRect(x: 0, y: titleBarH, width: bounds.width, height: controlBarH)
        statusBarHostingView?.frame = CGRect(x: 0, y: bounds.height - statusBarH, width: bounds.width, height: statusBarH)
        
        let contentTop = titleBarH + controlBarH
        let contentBottom = bounds.height - statusBarH - bottomPanelH
        let contentHeight = contentBottom - contentTop
        
        browserSidebar.frame = CGRect(x: 0, y: contentTop, width: browserW, height: contentHeight)
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
        let totalTrackH = visibleTracks.reduce(0) { $0 + $1.height }
        let totalWidth = CGFloat(project.totalDuration.beats) * pixelsPerBeat
        
        canvasView.frame = NSRect(x: 0, y: 0, width: max(totalWidth, mainWidth), height: max(totalTrackH, scrollAreaH))
        trackHeaders.frame = NSRect(x: 0, y: 0, width: headerW, height: max(totalTrackH, scrollAreaH))
        
        trackHeaders.configure(tracks: visibleTracks, viewportHeight: scrollAreaH)
        masterHeaderView?.configure(maxDepth: project.maxTrackDepth, depth: 0, isLastInGroup: true)
        masterHeaderView?.isSelected = (project.selectedTrackID == project.masterTrack.id)
        masterLaneView.isSelected = (project.selectedTrackID == project.masterTrack.id)
        masterLaneView.pixelsPerBeat = pixelsPerBeat
        masterLaneView.timeSignature = project.timeSignature
        masterLaneView.scrollOffset = canvasScrollView.contentView.bounds.origin.x

        // Keep horizontal anchor stable during zoom/layout.
        let requestedX = pendingHorizontalScrollX ?? CGFloat(project.viewScrollPosition ?? Double(canvasScrollView.contentView.bounds.origin.x))
        let maxScrollX = max(0, canvasView.frame.width - canvasScrollView.contentView.bounds.width)
        let clampedX = min(max(0, requestedX), maxScrollX)
        let currentY = canvasScrollView.contentView.bounds.origin.y
        let maxScrollY = max(0, canvasView.frame.height - canvasScrollView.contentView.bounds.height)
        let clampedY = min(max(0, currentY), maxScrollY)
        canvasScrollView.contentView.scroll(to: NSPoint(x: clampedX, y: clampedY))
        canvasScrollView.reflectScrolledClipView(canvasScrollView.contentView)
        headerScrollView.contentView.scroll(to: NSPoint(x: 0, y: clampedY))
        headerScrollView.reflectScrolledClipView(headerScrollView.contentView)
        masterLaneView.scrollOffset = clampedX
        pendingHorizontalScrollX = nil
        
        // Force refresh after frame assignment
        canvasView.updateArrangementLayers(fullRedraw: true)
        log("performManualLayout finished. CanvasView frame: \(canvasView.frame)")
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

    private func handleTrackSelection(_ trackID: UUID, isShift: Bool) {
        project.selectedTrackID = trackID
        trackHeaders.updateSelection(selectedID: trackID)
        masterHeaderView?.isSelected = (trackID == project.masterTrack.id)
        masterLaneView.isSelected = (trackID == project.masterTrack.id)
        
        if let track = project.allVisibleTracks.first(where: { $0.id == trackID }) {
            bottomPanel.mode = .detail(track)
            bottomPanel.isHidden = false
            view.needsLayout = true
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
        if let savedZoom = project.viewZoomScale {
            setZoom(CGFloat(savedZoom))
        }
        if let savedScroll = project.viewScrollPosition {
            pendingHorizontalScrollX = CGFloat(savedScroll)
        }
        reloadTracks()
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
                    bottomPanel.mode = .pianoRoll(track, clip)
                } else if let first = track.midiClips.first {
                    bottomPanel.mode = .pianoRoll(track, first)
                }
            } else if track.trackType == .audio {
                let clipID = project.primarySelectedClipID ?? track.clips.first?.id
                if let cid = clipID, let clip = track.clips.first(where: { $0.id == cid }) {
                    bottomPanel.mode = .audioClip(track, clip)
                } else if let first = track.clips.first {
                    bottomPanel.mode = .audioClip(track, first)
                }
            }
        case .pianoRoll, .audioClip:
            // Switch to Devices
            bottomPanel.mode = .detail(track)
        default:
            break
        }
    }
}

extension ArrangementViewController: TimelineInteractionDelegate {
    public func interactionDidRequestClipMove(clipID: UUID, newPosition: TimePosition) {
        // TODO: Handle clip move in project state
    }
    
    public func interactionDidClickTimeline(at position: TimePosition, on trackID: UUID) {
        // Update edit cursor when timeline is clicked
        project.editCursorPosition = position
    }
    
    public func interactionDidSelectClips(clipIDs: Set<UUID>) {
        project.selectedClipIDs = clipIDs
        if let first = clipIDs.first {
            project.primarySelectedClipID = first
        } else {
            project.primarySelectedClipID = nil
        }
    }
    
    public func interactionDidRequestContextMenu(for clipID: UUID, at point: CGPoint) {
        // TODO: Show context menu for clip
    }
}

extension ArrangementViewController: ArrangementRendererDelegate {
    public func rendererDidRequestVisibleTimeRangeUpdate(range: TimeRange) {
        // Redraw logic or state update if needed
    }
}
