import AppKit
import SwiftUI
import Foundation
import DreamDAWModels
import DreamDAWEngine

// MARK: - ArrangementViewController

/// Main view controller for the arrangement view — Ableton Live 11 layout.
/// Layout: [ControlBar TOP] → [BrowserSidebar LEFT | Ruler+Canvas CENTER | TrackHeaders RIGHT] → [StatusBar BOTTOM]
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

    // State
    private var pixelsPerBeat: CGFloat = DreamTheme.defaultPixelsPerBeat
    private var isBrowserVisible: Bool = true

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
        // ===== TOP: Control Bar (Transport) =====
        let transportView = TransportBarView(
            transportController: transportController,
            project: project
        )
        let hostingView = NSHostingView(rootView: transportView)
        hostingView.wantsLayer = true
        view.addSubview(hostingView)
        self.transportHostingView = hostingView

        // ===== LEFT: Browser Sidebar =====
        browserSidebar.wantsLayer = true
        view.addSubview(browserSidebar)

        // ===== CENTER-TOP: Left corner (browser header area) =====
        cornerViewLeft.wantsLayer = true
        cornerViewLeft.layer?.backgroundColor = DreamTheme.bgHeader.cgColor
        view.addSubview(cornerViewLeft)

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
        canvasScrollView.documentView = canvasView
        canvasScrollView.scrollerStyle = .overlay
        view.addSubview(canvasScrollView)

        // Register for drag and drop
        canvasView.registerForDraggedTypes([.fileURL])

        // ===== RIGHT: Track Headers Scroll View =====
        headerScrollView.wantsLayer = true
        headerScrollView.drawsBackground = false
        headerScrollView.hasVerticalScroller = false
        headerScrollView.hasHorizontalScroller = false
        headerScrollView.documentView = trackHeaders
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
        view.addSubview(bottomPanel)

        // Horizontal divider above bottom panel
        bottomPanelDivider.wantsLayer = true
        bottomPanelDivider.layer?.backgroundColor = DreamTheme.divider.cgColor
        view.addSubview(bottomPanelDivider)
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

        // Control bar (TOP, full width)
        transportHostingView?.frame = CGRect(
            x: 0, y: 0,
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
        let contentTop = controlBarH
        let contentHeight = bounds.height - controlBarH - statusBarH - bottomPanelH

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

        // Canvas scroll view (center)
        let canvasTop = contentTop + rulerH
        let canvasAreaHeight = contentHeight - rulerH
        canvasScrollView.frame = CGRect(
            x: canvasStartX,
            y: canvasTop,
            width: canvasWidth,
            height: canvasAreaHeight
        )

        // Canvas document size
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

        // Track headers scroll view (RIGHT)
        headerScrollView.frame = CGRect(
            x: canvasEndX + 1,
            y: canvasTop,
            width: headerW,
            height: canvasAreaHeight
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
    }

    // MARK: - Audio Engine
    
    private func setupAudioEngine() {
        do {
            try audioEngine.start()
        } catch {
            print("[DreamDAW] Audio engine failed to start: \(error)")
        }

        trackMixer.configureTracks(project.tracks)

        // Apply master track volume/pan to the engine master mixer
        trackMixer.applyMasterSettings(project.masterTrack)

        // Connect waveform renderer callback → canvas redraw
        let renderer = WaveformRenderer(waveformCache: waveformCache)
        renderer.onWaveformReady = { [weak self] in
            self?.canvasView.needsDisplay = true
        }
        canvasView.waveformRenderer = renderer
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

        // Transport position updates → canvas and ruler
        transportController.onPlayheadUpdate = { [weak self] position in
            self?.canvasView.playheadPosition = position
            self?.rulerView.playheadPosition = position
        }

        // Ruler click → set playhead
        rulerView.onClickPosition = { [weak self] position in
            self?.transportController.seek(to: position)
        }

        // Track changes → mixer
        trackHeaders.onTrackChanged = { [weak self] track in
            guard let self = self else { return }
            if track.trackType == .master {
                self.trackMixer.applyMasterSettings(track)
            } else {
                self.trackMixer.applyTrackSettings(track)
            }
            self.canvasView.needsDisplay = true
        }

        // Right-click context menu: Add Audio / MIDI Track
        trackHeaders.onAddTrack = { [weak self] isAudio in
            guard let self = self else { return }
            self.project.addTrack(type: isAudio ? .audio : .midi)
            self.reloadTracks()
        }

        // Transport state → PlaybackScheduler
        // Play → stop browser preview + schedule all clips; Pause/Stop → stop all players
        transportController.onStateChange = { [weak self] state in
            guard let self = self else { return }
            switch state {
            case .playing:
                self.browserSidebar.stopPreview()
                self.playbackScheduler.schedulePlayback(
                    project: self.project,
                    from: self.transportController.playheadPosition
                )
            case .paused, .stopped:
                self.playbackScheduler.stopAll()
            }
        }

        // Canvas → bottom panel: click track → show detail
        canvasView.onTrackClicked = { [weak self] trackID in
            guard let self = self,
                  let track = self.project.tracks.first(where: { $0.id == trackID }) else { return }
            self.bottomPanel.showDetail(for: track)
            self.layoutSubviews()
        }

        // Canvas → bottom panel: Shift+click MIDI clip → open piano roll
        canvasView.onMidiClipShiftClicked = { [weak self] trackID, clipID in
            guard let self = self,
                  let track = self.project.tracks.first(where: { $0.id == trackID }),
                  let clip = track.midiClips.first(where: { $0.id == clipID }) else { return }
            self.bottomPanel.showPianoRoll(track: track, clip: clip)
            self.layoutSubviews()
        }

        // Bottom panel → project: note changes from piano roll
        bottomPanel.onNotesChanged = { [weak self] track, updatedClip in
            guard let self = self,
                  let trackIndex = self.project.tracks.firstIndex(where: { $0.id == track.id }),
                  let clipIndex = self.project.tracks[trackIndex].midiClips.firstIndex(where: { $0.id == updatedClip.id })
            else { return }
            self.project.tracks[trackIndex].midiClips[clipIndex] = updatedClip
            self.canvasView.needsDisplay = true
        }
    }

    @objc private func canvasScrolled(_ notification: Notification) {
        let clipBounds = canvasScrollView.contentView.bounds

        // Sync track headers vertical position
        trackHeaders.setVerticalOffset(clipBounds.origin.y)

        // Sync ruler horizontal position
        rulerView.scrollOffset = clipBounds.origin.x

        // Pass scroll offset to canvas for drawing
        canvasView.scrollOffset = CGPoint(x: clipBounds.origin.x, y: clipBounds.origin.y)
    }

    // MARK: - Configure

    private func configureProject() {
        canvasView.project = project
        canvasView.pixelsPerBeat = pixelsPerBeat

        rulerView.pixelsPerBeat = pixelsPerBeat
        rulerView.bpm = project.bpm
        rulerView.timeSignature = project.timeSignature

        trackHeaders.configure(tracks: project.tracks, masterTrack: project.masterTrack)
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
        trackHeaders.configure(tracks: project.tracks, masterTrack: project.masterTrack)
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
        case 49: // Space
            transportController.togglePlayPause()
        case 36: // Return — stop and go to beginning
            transportController.stop()
        case 24 where flags.contains(.command): // Cmd+=  zoom in
            setZoom(pixelsPerBeat * 1.3)
        case 27 where flags.contains(.command): // Cmd+-  zoom out
            setZoom(pixelsPerBeat / 1.3)
        case 11 where flags.contains(.command) && flags.contains(.option): // Cmd+Opt+B toggle browser
            toggleBrowser()
        default:
            super.keyDown(with: event)
        }
    }

    public override var acceptsFirstResponder: Bool { true }
}
