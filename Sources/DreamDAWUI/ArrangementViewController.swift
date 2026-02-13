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
    private let canvasScrollView = NSScrollView()
    private let headerScrollView = DragForwardingScrollView()
    private let browserSidebar = BrowserSidebarView()
    private let bottomPanel = BottomPanelView()
    
    private let vertDividerLeft = NSView()
    private let vertDividerRight = NSView()
    private let bottomPanelDivider = NSView()
    private let masterLaneView = MasterLaneView()
    private let masterSeparator = NSView()
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
        masterLaneView.timeSignature = project.timeSignature
        
        // Synchronize pixelsPerBeat
        rulerView.pixelsPerBeat = pixelsPerBeat
        canvasView.pixelsPerBeat = pixelsPerBeat
        masterLaneView.pixelsPerBeat = pixelsPerBeat
        
        setupAudioEngine()
        setupBindings()
        configureProject()
        installGlobalKeyMonitor()
        
        log("viewDidLoad finished. Project assigned. PPB: \(pixelsPerBeat)")
    }

    public override func viewDidLayout() {
        super.viewDidLayout()
        performManualLayout()
    }

    deinit {
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
        
        // Master Lane
        masterSeparator.wantsLayer = true
        masterSeparator.layer?.backgroundColor = DreamTheme.divider.cgColor
        view.addSubview(masterSeparator)
        
        masterLaneView.wantsLayer = true
        masterLaneView.layer?.backgroundColor = DreamTheme.bgSecondary.cgColor
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
        
        let masterH: CGFloat = project.masterTrack.height
        let masterSepH: CGFloat = 2
        let masterRegionH = masterH + masterSepH
        
        let canvasTop = contentTop + rulerH
        let canvasAreaH = contentHeight - rulerH - masterRegionH
        
        canvasScrollView.frame = CGRect(x: mainStartX, y: canvasTop, width: mainWidth, height: canvasAreaH)
        headerScrollView.frame = CGRect(x: mainEndX + 1, y: canvasTop, width: headerW, height: canvasAreaH)
        vertDividerRight.frame = CGRect(x: mainEndX, y: contentTop, width: 1, height: contentHeight)
        
        masterSeparator.frame = CGRect(x: mainStartX, y: contentBottom - masterRegionH, width: bounds.width - mainStartX, height: masterSepH)
        masterLaneView.frame = CGRect(x: mainStartX, y: contentBottom - masterH, width: mainWidth, height: masterH)
        
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
        
        canvasView.frame = NSRect(x: 0, y: 0, width: max(totalWidth, mainWidth), height: max(totalTrackH, canvasAreaH))
        trackHeaders.frame = NSRect(x: 0, y: 0, width: headerW, height: max(totalTrackH, canvasAreaH))
        
        // Force refresh after frame assignment
        canvasView.updateArrangementLayers(fullRedraw: true)
        log("performManualLayout finished. CanvasView frame: \(canvasView.frame)")
    }

    // MARK: - Public API

    @objc public func reloadTracks() {
        trackHeaders.configure(tracks: project.tracks)
        canvasView.updateArrangementLayers()
        rendererCoordinator.rebuildSpatialIndex(with: project)
        view.needsLayout = true
    }

    public func setZoom(_ ppb: CGFloat) {
        self.pixelsPerBeat = min(DreamTheme.maxPixelsPerBeat, max(DreamTheme.minPixelsPerBeat, ppb))
        canvasView.pixelsPerBeat = pixelsPerBeat
        rulerView.pixelsPerBeat = pixelsPerBeat
        masterLaneView.pixelsPerBeat = pixelsPerBeat
        project.viewZoomScale = Double(pixelsPerBeat)
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

    @objc public func duplicate(_ sender: Any?) { /* No-op for now */ }
    @objc public func split(_ sender: Any?) { /* No-op for now */ }

    private func setupAudioEngine() {
        sharedEngine.trackMixer.configureTracks(project.tracks, masterTrack: project.masterTrack)
    }

    private func setupBindings() {
        // Vertical Scroll Sync
        NotificationCenter.default.addObserver(
            forName: NSView.boundsDidChangeNotification,
            object: canvasScrollView.contentView,
            queue: .main
        ) { [weak self] _ in
            guard let self = self else { return }
            let canvasY = self.canvasScrollView.contentView.bounds.origin.y
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
        
        // Selection Logic
        trackHeaders.onHeaderClicked = { [weak self] trackID, isShift in
            self?.handleTrackSelection(trackID, isShift: isShift)
        }
    }

    private func handleTrackSelection(_ trackID: UUID, isShift: Bool) {
        project.selectedTrackID = trackID
        trackHeaders.updateSelection(selectedID: trackID)
        
        if let track = project.allVisibleTracks.first(where: { $0.id == trackID }) {
            bottomPanel.mode = .detail(track)
            bottomPanel.isHidden = false
            view.needsLayout = true
        }
    }

    private func configureProject() {
        if let savedZoom = project.viewZoomScale {
            setZoom(CGFloat(savedZoom))
        }
        reloadTracks()
    }

    private func installGlobalKeyMonitor() {
        keyEventMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self = self else { return event }
            if event.keyCode == 49 { // Space
                self.transportController.togglePlayPause()
                return nil
            }
            return event
        }
    }
}

extension ArrangementViewController: TimelineInteractionDelegate {
    public func interactionDidRequestClipMove(clipID: UUID, newPosition: TimePosition) {
        // TODO: Handle clip move in project state
    }
    
    public func interactionDidSelectClips(clipIDs: Set<UUID>) {
        // TODO: Update selection in project state
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
