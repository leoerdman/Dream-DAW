import AppKit
import SwiftUI
import Foundation
import DreamDAWModels
import DreamDAWEngine
import os.log
import Combine

/// Main view controller for the arrangement view.
/// Refactored to SOLID architecture using Coordinator/Delegate pattern.
public final class ArrangementViewController: NSViewController {

    // MARK: - Coordinators
    private var interactionCoordinator: TimelineInteractionCoordinator!
    private var rendererCoordinator: ArrangementRendererCoordinator!

    // MARK: - Core Dependencies
    public var project: Project
    public let sharedEngine: SharedEngine
    public let actionHistory = ActionHistory()
    public var orchestrator: ArrangementOrchestrator
    public let audioLevelMeter: AudioLevelMeter
    
    // Engine components
    public let transportController: TransportController
    public let trackMixer: TrackMixer
    public let playbackScheduler: PlaybackScheduler
    
    // State
    private var pixelsPerBeat: CGFloat = DreamTheme.defaultPixelsPerBeat
    private var selectedClipID: UUID?
    private var isBrowserVisible = true
    private var cancellables = Set<AnyCancellable>()
    private let logger = Logger(subsystem: "com.dreamdaw", category: "ArrangementVC")

    // UI Components (Managed by Auto Layout)
    private let rulerView = TimelineRulerView()
    private let trackHeaders = TrackHeadersContainerView()
    private let canvasView = TimelineCanvasView()
    private let canvasScrollView = NSScrollView()
    private let headerScrollView = DragForwardingScrollView()
    private let browserSidebar = BrowserSidebarView()
    private let bottomPanel = BottomPanelView()
    private let masterLaneView = MasterLaneView()
    private let rootStackView = NSStackView()
    private let centerSplitView = NSSplitView()
    private let loadingOverlay = LoadingOverlayView()

    // MARK: - Initialization

    public init(project: Project, sharedEngine: SharedEngine) {
        self.project = project
        self.sharedEngine = sharedEngine
        self.orchestrator = ArrangementOrchestrator(project: project, actionHistory: actionHistory)
        
        self.audioLevelMeter = AudioLevelMeter()
        self.transportController = TransportController()
        self.trackMixer = TrackMixer(audioEngine: sharedEngine.audioEngine, audioLevelMeter: self.audioLevelMeter)
        self.playbackScheduler = PlaybackScheduler(audioEngine: sharedEngine.audioEngine, trackMixer: self.trackMixer)
        
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    // MARK: - View Lifecycle

    public override func loadView() {
        self.view = NSView()
        self.view.wantsLayer = true
        self.view.layer?.backgroundColor = DreamTheme.bgPrimary.cgColor
    }

    public override func viewDidLoad() {
        super.viewDidLoad()
        
        // 1. UI Assembly (Auto Layout)
        setupHierarchy()
        setupConstraints()
        
        // 2. Dependency Injection
        self.interactionCoordinator = TimelineInteractionCoordinator()
        self.interactionCoordinator.delegate = self

        self.rendererCoordinator = ArrangementRendererCoordinator(metalCanvas: self.canvasView)
        self.rendererCoordinator.delegate = self
        
        // 3. System Config
        setupAudioEngine()
        configureProject()
        installGlobalKeyMonitor()
    }

    // MARK: - UI Configuration (Auto Layout)

    private func setupHierarchy() {
        rootStackView.orientation = .vertical
        rootStackView.spacing = 0
        rootStackView.distribution = .fill
        rootStackView.alignment = .centerX
        rootStackView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(rootStackView)
        
        // Center Split View (Browser | Headers | Canvas)
        centerSplitView.isVertical = true
        centerSplitView.dividerStyle = .thin
        centerSplitView.translatesAutoresizingMaskIntoConstraints = false
        
        // Timeline Container (Ruler + Canvas)
        let timelineContainer = NSStackView()
        timelineContainer.orientation = .vertical
        timelineContainer.spacing = 0
        timelineContainer.distribution = .fill
        timelineContainer.alignment = .leading
        timelineContainer.translatesAutoresizingMaskIntoConstraints = false
        
        rulerView.translatesAutoresizingMaskIntoConstraints = false
        canvasScrollView.translatesAutoresizingMaskIntoConstraints = false
        canvasScrollView.documentView = canvasView
        canvasScrollView.hasHorizontalScroller = true
        canvasScrollView.hasVerticalScroller = true
        
        timelineContainer.addArrangedSubview(rulerView)
        timelineContainer.addArrangedSubview(canvasScrollView)
        
        // Scroll synchronization (Headers <-> Canvas)
        headerScrollView.documentView = trackHeaders
        headerScrollView.hasVerticalScroller = false
        headerScrollView.translatesAutoresizingMaskIntoConstraints = false
        
        centerSplitView.addArrangedSubview(browserSidebar)
        centerSplitView.addArrangedSubview(headerScrollView)
        centerSplitView.addArrangedSubview(timelineContainer)
        
        rootStackView.addArrangedSubview(centerSplitView)
        rootStackView.addArrangedSubview(bottomPanel)
        
        // Loading Overlay
        loadingOverlay.translatesAutoresizingMaskIntoConstraints = false
        loadingOverlay.isHidden = true
        view.addSubview(loadingOverlay)
    }

    private func setupConstraints() {
        NSLayoutConstraint.activate([
            rootStackView.topAnchor.constraint(equalTo: view.topAnchor),
            rootStackView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            rootStackView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            rootStackView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            
            rulerView.heightAnchor.constraint(equalToConstant: 40),
            rulerView.widthAnchor.constraint(equalTo: canvasScrollView.widthAnchor),
            
            loadingOverlay.topAnchor.constraint(equalTo: view.topAnchor),
            loadingOverlay.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            loadingOverlay.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            loadingOverlay.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            
            browserSidebar.widthAnchor.constraint(greaterThanOrEqualToConstant: 200),
            headerScrollView.widthAnchor.constraint(equalToConstant: 250)
        ])
    }

    // MARK: - Public API (Required by main.swift)

    public func setZoom(_ ppb: CGFloat) {
        self.pixelsPerBeat = min(DreamTheme.maxPixelsPerBeat, max(DreamTheme.minPixelsPerBeat, ppb))
        canvasView.pixelsPerBeat = pixelsPerBeat
        rulerView.pixelsPerBeat = pixelsPerBeat
        masterLaneView.pixelsPerBeat = pixelsPerBeat
        project.viewZoomScale = Double(pixelsPerBeat)
    }

    @objc public func reloadTracks() {
        trackHeaders.configure(tracks: project.tracks)
        canvasView.updateArrangementLayers()
        rendererCoordinator.rebuildSpatialIndex(with: project)
    }

    @objc public func undo(_ sender: Any?) { actionHistory.undo(on: project); reloadTracks() }
    @objc public func redo(_ sender: Any?) { actionHistory.redo(on: project); reloadTracks() }
    @objc public func duplicate(_ sender: Any?) { 
        if let clipID = selectedClipID { orchestrator.duplicateClip(id: clipID); reloadTracks() }
    }
    @objc public func split(_ sender: Any?) {
        if let clipID = selectedClipID { orchestrator.splitClip(id: clipID, at: transportController.playheadPosition); reloadTracks() }
    }

    // MARK: - Core Logic

    private func setupAudioEngine() {
        trackMixer.configureTracks(project.tracks, masterTrack: project.masterTrack)
    }

    private func configureProject() {
        transportController.bpm = project.bpm
        transportController.timeSignature = project.timeSignature
        canvasView.project = project
        reloadTracks()
    }

    private func installGlobalKeyMonitor() {
        NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self = self else { return event }
            if event.keyCode == 49 { // Space
                self.transportController.togglePlayPause()
                return nil
            }
            return event
        }
    }
    
    public func showLoadingOverlay(message: String) { loadingOverlay.show(message: message) }
    public func hideLoadingOverlay() { loadingOverlay.hide() }
}

// MARK: - TimelineInteractionDelegate
extension ArrangementViewController: TimelineInteractionDelegate {
    public func interactionDidRequestClipMove(clipID: UUID, newPosition: TimePosition) {
        orchestrator.moveClip(id: clipID, to: newPosition)
    }

    public func interactionDidSelectClips(clipIDs: Set<UUID>) {
        project.selectedClipIDs = clipIDs
        if let firstID = clipIDs.first { self.selectedClipID = firstID }
        canvasView.needsDisplay = true
    }

    public func interactionDidRequestContextMenu(for clipID: UUID, at point: CGPoint) {}
}

// MARK: - ArrangementRendererDelegate
extension ArrangementViewController: ArrangementRendererDelegate {
    public func rendererDidRequestVisibleTimeRangeUpdate(range: TimeRange) {}
}
