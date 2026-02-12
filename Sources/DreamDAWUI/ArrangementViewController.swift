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
    
    // Combine
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

    // MARK: - Initialization

    public init(project: Project, sharedEngine: SharedEngine) {
        self.project = project
        self.sharedEngine = sharedEngine
        self.orchestrator = ArrangementOrchestrator(project: project, actionHistory: actionHistory)
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
        self.interactionCoordinator.delegate = self // Controller becomes the delegate

        self.rendererCoordinator = ArrangementRendererCoordinator(metalCanvas: self.canvasView)
        self.rendererCoordinator.delegate = self
        
        // 3. System Config
        setupAudioEngine()
        configureProject()
        installGlobalKeyMonitor()
    }

    // MARK: - UI Configuration (Auto Layout Only)

    private func setupHierarchy() {
        // Build the nested structure: [Transport] -> [SplitView (Browser|Timeline|Headers)] -> [BottomPanel] -> [Status]
        rootStackView.orientation = .vertical
        rootStackView.spacing = 0
        rootStackView.alignment = .centerX
        rootStackView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(rootStackView)
        
        // Center Split View
        centerSplitView.isVertical = true
        centerSplitView.dividerStyle = .thin
        
        // Canvas Container (Ruler + Canvas)
        let timelineContainer = NSView()
        // ... build internal hierarchy for timeline ...
        
        centerSplitView.addArrangedSubview(browserSidebar)
        centerSplitView.addArrangedSubview(timelineContainer)
        centerSplitView.addArrangedSubview(trackHeaders)
        
        rootStackView.addArrangedSubview(centerSplitView)
        rootStackView.addArrangedSubview(bottomPanel)
    }

    private func setupConstraints() {
        NSLayoutConstraint.activate([
            rootStackView.topAnchor.constraint(equalTo: view.topAnchor),
            rootStackView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            rootStackView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            rootStackView.trailingAnchor.constraint(equalTo: view.trailingAnchor)
        ])
    }

    // MARK: - Core Logic (Delegated)

    private func setupAudioEngine() {
        // Engine startup and mixer config
    }

    private func configureProject() {
        // Sync project state with views
    }

    private func installGlobalKeyMonitor() {
        // Intercept Space, Return, Esc
    }
}

// MARK: - TimelineInteractionDelegate
extension ArrangementViewController: TimelineInteractionDelegate {
    public func interactionDidRequestClipMove(clipID: UUID, newPosition: TimePosition) {
        // Apply move action via Orchestrator
        orchestrator.moveClip(id: clipID, to: newPosition)
    }

    public func interactionDidSelectClips(clipIDs: Set<UUID>) {
        project.selectedClipIDs = clipIDs
        canvasView.needsDisplay = true
    }

    public func interactionDidRequestContextMenu(for clipID: UUID, at point: CGPoint) {
        // Show context menu logic
    }
}

// MARK: - ArrangementRendererDelegate
extension ArrangementViewController: ArrangementRendererDelegate {
    public func rendererDidRequestVisibleTimeRangeUpdate(range: TimeRange) {
        // Sync ruler and transport
    }
}
