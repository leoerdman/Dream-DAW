import AppKit
import SwiftUI
import Foundation
import DreamDAWModels
import DreamDAWEngine

// MARK: - ArrangementViewController

/// Main view controller for the arrangement view.
/// Hosts the ruler, track headers, timeline canvas, and transport bar.
/// Manages synchronized scrolling and zoom state.
public final class ArrangementViewController: NSViewController {

    // MARK: - Properties

    public let project: Project
    public let audioEngine: AudioEngine
    public let transportController: TransportController
    public let trackMixer: TrackMixer
    public let playbackScheduler: PlaybackScheduler
    public let waveformCache: WaveformCache

    // UI Components
    private let rulerView = TimelineRulerView()
    private let trackHeaders = TrackHeadersContainerView()
    private let canvasView = TimelineCanvasView()
    private let canvasScrollView = NSScrollView()
    private let headerScrollView = NSScrollView()
    private var transportHostingView: NSHostingView<TransportBarView>?
    private let cornerView = NSView()
    private let vertDivider = NSView()

    // State
    private var pixelsPerBeat: CGFloat = DreamTheme.defaultPixelsPerBeat

    // MARK: - Initialization

    public init(project: Project) {
        self.project = project
        self.audioEngine = AudioEngine()
        self.transportController = TransportController()
        self.waveformCache = WaveformCache()
        self.trackMixer = TrackMixer(audioEngine: audioEngine)
        self.playbackScheduler = PlaybackScheduler(audioEngine: audioEngine, trackMixer: trackMixer)

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
        view = NSView()
        view.wantsLayer = true
        view.layer?.backgroundColor = DreamTheme.bgPrimary.cgColor
    }

    public override func viewDidLoad() {
        super.viewDidLoad()
        setupUI()
        setupAudioEngine()
        setupBindings()
        configureProject()
    }

    public override func viewDidLayout() {
        super.viewDidLayout()
        layoutSubviews()
    }

    // MARK: - Setup

    private func setupUI() {
        // Corner label (top-left, above ruler and to the left of headers)
        cornerView.wantsLayer = true
        cornerView.layer?.backgroundColor = DreamTheme.bgHeader.cgColor
        view.addSubview(cornerView)

        // Ruler view setup
        rulerView.wantsLayer = true
        view.addSubview(rulerView)

        // Track headers scroll view
        headerScrollView.wantsLayer = true
        headerScrollView.drawsBackground = false
        headerScrollView.hasVerticalScroller = false
        headerScrollView.hasHorizontalScroller = false
        headerScrollView.documentView = trackHeaders
        view.addSubview(headerScrollView)

        // Canvas scroll view
        canvasScrollView.wantsLayer = true
        canvasScrollView.drawsBackground = false
        canvasScrollView.hasVerticalScroller = true
        canvasScrollView.hasHorizontalScroller = true
        canvasScrollView.autohidesScrollers = false
        canvasScrollView.documentView = canvasView
        canvasScrollView.scrollerStyle = .overlay
        view.addSubview(canvasScrollView)

        // Register for drag and drop
        canvasView.registerForDraggedTypes([.fileURL])

        // Transport bar (SwiftUI)
        let transportView = TransportBarView(
            transportController: transportController,
            project: project
        )
        let hostingView = NSHostingView(rootView: transportView)
        hostingView.wantsLayer = true
        view.addSubview(hostingView)
        self.transportHostingView = hostingView

        // Divider between headers and canvas
        vertDivider.wantsLayer = true
        vertDivider.layer?.backgroundColor = DreamTheme.divider.cgColor
        view.addSubview(vertDivider)
    }

    private func layoutSubviews() {
        let bounds = view.bounds
        let headerWidth = DreamTheme.trackHeaderWidth
        let rulerHeight = DreamTheme.rulerHeight
        let transportHeight = DreamTheme.transportBarHeight

        // Corner (top-left)
        cornerView.frame = CGRect(x: 0, y: 0, width: headerWidth, height: rulerHeight)

        // Ruler (top, right of corner)
        rulerView.frame = CGRect(
            x: headerWidth,
            y: 0,
            width: bounds.width - headerWidth,
            height: rulerHeight
        )

        // Track headers (left, below ruler, above transport)
        let headersHeight = bounds.height - rulerHeight - transportHeight
        headerScrollView.frame = CGRect(
            x: 0,
            y: rulerHeight,
            width: headerWidth,
            height: headersHeight
        )

        // Canvas (center, below ruler, above transport)
        let canvasWidth = bounds.width - headerWidth
        canvasScrollView.frame = CGRect(
            x: headerWidth,
            y: rulerHeight,
            width: canvasWidth,
            height: headersHeight
        )

        // Canvas document size
        let totalTrackHeight = project.tracks.reduce(CGFloat(0)) { $0 + $1.height }
        let totalWidth = CGFloat(project.totalDuration.beats) * pixelsPerBeat
        canvasView.frame = NSRect(x: 0, y: 0, width: max(totalWidth, canvasWidth), height: max(totalTrackHeight, headersHeight))

        // Track headers document size
        trackHeaders.frame.size.width = headerWidth

        // Vertical divider
        vertDivider.frame = CGRect(x: headerWidth - 1, y: 0, width: 1, height: bounds.height - transportHeight)

        // Transport bar (bottom)
        transportHostingView?.frame = CGRect(
            x: 0,
            y: bounds.height - transportHeight,
            width: bounds.width,
            height: transportHeight
        )
    }

    private func setupAudioEngine() {
        do {
            try audioEngine.start()
        } catch {
            print("Failed to start audio engine: \(error)")
        }

        trackMixer.configureTracks(project.tracks)
    }

    private func setupBindings() {
        // Ruler interaction
        rulerView.onClickPosition = { [weak self] position in
            self?.transportController.seek(to: position)
        }

        // Canvas interaction
        canvasView.onClickPosition = { [weak self] position in
            self?.transportController.seek(to: position)
        }

        // Track header changes
        trackHeaders.onTrackChanged = { [weak self] track in
            guard let self = self else { return }
            self.trackMixer.applyTrackSettings(track)
            self.trackMixer.applySoloLogic(self.project.tracks)
            self.canvasView.needsDisplay = true
        }

        // Playhead updates from transport
        transportController.onPlayheadUpdate = { [weak self] position in
            guard let self = self else { return }
            self.rulerView.playheadPosition = position
            self.canvasView.playheadPosition = position
        }

        // Transport state changes
        transportController.onStateChange = { [weak self] state in
            guard let self = self else { return }
            switch state {
            case .playing:
                self.playbackScheduler.schedulePlayback(
                    project: self.project,
                    from: self.transportController.playheadPosition
                )
            case .stopped, .paused:
                self.playbackScheduler.stopAll()
            }
        }

        // Scroll synchronization
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(canvasScrolled),
            name: NSView.boundsDidChangeNotification,
            object: canvasScrollView.contentView
        )
        canvasScrollView.contentView.postsBoundsChangedNotifications = true
    }

    @objc private func canvasScrolled() {
        let scrollOrigin = canvasScrollView.contentView.bounds.origin

        // Sync ruler horizontal scroll
        rulerView.scrollOffset = scrollOrigin.x
        canvasView.scrollOffset = scrollOrigin

        // Sync track headers vertical scroll
        trackHeaders.setVerticalOffset(scrollOrigin.y)
    }

    private func configureProject() {
        let renderer = WaveformRenderer(waveformCache: waveformCache)
        canvasView.waveformRenderer = renderer
        canvasView.project = project
        canvasView.pixelsPerBeat = pixelsPerBeat

        rulerView.pixelsPerBeat = pixelsPerBeat
        rulerView.bpm = project.bpm
        rulerView.timeSignature = project.timeSignature

        trackHeaders.configure(tracks: project.tracks)
    }

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
        trackMixer.configureTracks(project.tracks)
        canvasView.project = project
        canvasView.needsDisplay = true
        layoutSubviews()
    }

    /// Handle keyboard shortcuts at the arrangement level.
    public override func keyDown(with event: NSEvent) {
        switch event.keyCode {
        case 49: // Space
            transportController.togglePlayPause()
        case 36: // Return — stop and go to beginning
            transportController.stop()
        case 24 where event.modifierFlags.contains(.command): // Cmd+=  zoom in
            setZoom(pixelsPerBeat * 1.3)
        case 27 where event.modifierFlags.contains(.command): // Cmd+-  zoom out
            setZoom(pixelsPerBeat / 1.3)
        default:
            super.keyDown(with: event)
        }
    }

    public override var acceptsFirstResponder: Bool { true }
}

