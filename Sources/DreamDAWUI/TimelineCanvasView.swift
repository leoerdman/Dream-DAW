import AppKit
import AVFoundation
import Foundation
import Combine
import DreamDAWModels
import DreamDAWEngine

// MARK: - TimelineCanvasView

/// The main arrangement canvas that renders track lanes, audio clips, MIDI clips,
/// grid lines, and handles mouse interaction for clip selection/creation/movement.
/// Uses Core Graphics for high-performance custom rendering.
public final class TimelineCanvasView: NSView {

    public override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        setup()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        setup()
    }

    private func setup() {
        NSLog("[TimelineCanvasView] setup start")
        self.wantsLayer = true
        self.layer?.backgroundColor = DreamTheme.bgPrimary.cgColor
        
        // Disable implicit animations
        let noActions: [String: CAAction] = [
            "position": NSNull(),
            "bounds": NSNull(),
            "contents": NSNull(),
            "frame": NSNull(),
            "isHidden": NSNull()
        ]
        
        laneContainerLayer.actions = noActions
        gridLayer.actions = noActions
        clipContainerLayer.actions = noActions
        cursorLayer.actions = noActions
        playheadLayer.actions = noActions
        
        self.layer?.addSublayer(laneContainerLayer)
        self.layer?.addSublayer(gridLayer)
        
        // Initial setup for static elements
        laneContainerLayer.zPosition = 0
        gridLayer.zPosition = 1
        metalArrangementLayer.zPosition = 2
        clipContainerLayer.zPosition = 3
        titleContainerLayer.zPosition = 4
        cursorLayer.zPosition = 100
        cursorLayer.backgroundColor = NSColor.white.cgColor
        cursorHandleLayer.zPosition = 101
        cursorHandleLayer.fillColor = NSColor.white.cgColor
        playheadLayer.zPosition = 102
        playheadLayer.backgroundColor = NSColor.systemRed.cgColor
        selectionRectLayer.zPosition = 1000
        
        // Ensure Metal layer is managed by us but attached to viewport later
        metalArrangementLayer.actions = noActions
        metalArrangementLayer.device = metalTimelineRenderer?.device
        metalArrangementLayer.contentsScale = NSScreen.main?.backingScaleFactor ?? 2.0
        metalArrangementLayer.opacity = 0.95
        metalArrangementLayer.isOpaque = false
        self.layer?.addSublayer(metalArrangementLayer)
        
        titleContainerLayer.actions = noActions
        titleContainerLayer.zPosition = 4
        self.layer?.addSublayer(titleContainerLayer)
        
        setupSubscriptions()
        self.layer?.addSublayer(laneContainerLayer)
        self.layer?.addSublayer(gridLayer)
        self.layer?.addSublayer(clipContainerLayer)
        self.layer?.addSublayer(cursorLayer)
        self.layer?.addSublayer(cursorHandleLayer)
        self.layer?.addSublayer(playheadLayer)
        // titleContainerLayer moved to viewport-relative (in updateArrangementLayers)
        self.layer?.addSublayer(selectionRectLayer)
        
        // Ghost Preview Setup
        ghostClipLayer.isHidden = true
        ghostClipLayer.opacity = 0.5
        ghostClipLayer.borderWidth = 1.0
        ghostClipLayer.borderColor = NSColor.white.withAlphaComponent(0.5).cgColor
        ghostClipLayer.cornerRadius = DreamTheme.clipCornerRadius
        self.layer?.addSublayer(ghostClipLayer)
        
        setupCursorAnimation()
        setupDropIndicator()
        NSLog("[TimelineCanvasView] setup complete")
    }

    public override func viewDidMoveToSuperview() {
        super.viewDidMoveToSuperview()
        
        // Listen to scroll events from the parent scroll view to trigger Metal redraws
        if let scrollView = enclosingScrollView {
            scrollView.contentView.postsBoundsChangedNotifications = true
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(viewBoundsChanged),
                name: NSView.boundsDidChangeNotification,
                object: scrollView.contentView
            )
        }
    }

    @objc private func viewBoundsChanged(_ notification: Notification) {
        updateArrangementLayers()
    }

    /// Refresh the UI instantly — redraws all layers and marks the view as dirty.
    public func refreshUI() {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        updateArrangementLayers()
        CATransaction.commit()
        needsDisplay = true
    }

    private func setupDropIndicator() {
        dropIndicatorLayer.backgroundColor = NSColor.systemCyan.cgColor
        dropIndicatorLayer.isHidden = true
        dropIndicatorLayer.zPosition = 2000 // Above clips
        
        // Genius Glow
        dropIndicatorLayer.shadowColor = NSColor.systemCyan.cgColor
        dropIndicatorLayer.shadowOpacity = 0.8
        dropIndicatorLayer.shadowRadius = 4
        dropIndicatorLayer.shadowOffset = .zero
        
        self.layer?.addSublayer(dropIndicatorLayer)

        // Pulsing animation matching header
        let pulse = CABasicAnimation(keyPath: "opacity")
        pulse.fromValue = 0.3
        pulse.toValue = 1.0
        pulse.duration = 0.5
        pulse.autoreverses = true
        pulse.repeatCount = .infinity
        pulse.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        dropIndicatorLayer.add(pulse, forKey: "pulse")
    }

    private func updateInsertionLine() {
        guard let project = project, let index = insertionIndex else {
            dropIndicatorLayer.isHidden = true
            return
        }

        var lineY: CGFloat = 0
        let tracks = project.allVisibleTracks
        for i in 0..<min(index, tracks.count) {
            lineY += tracks[i].height
        }

        CATransaction.begin()
        CATransaction.setDisableActions(true)
        dropIndicatorLayer.frame = CGRect(x: 0, y: lineY - 1, width: bounds.width, height: 2)
        dropIndicatorLayer.isHidden = false
        CATransaction.commit()
    }

    
    deinit {
    }



    // MARK: - Properties

    public var project: Project? {
        didSet {
            setupSubscriptions()
            updateArrangementLayers()
        }
    }

    private var cancellables = Set<AnyCancellable>()

    // MARK: - Absolute Architecture Foundations
    
    /// Sample-accurate viewport (zoom/scroll).
    public var viewportMatrix = ViewportMatrix()
    /// Vertical O(1) layout engine.
    public var layoutEngine = TrackLayoutEngine()
    /// Interaction state machine (phantom UX).
    public var interactionSM = InteractionStateMachine()

    public var pixelsPerBeat: CGFloat = DreamTheme.defaultPixelsPerBeat {
        didSet { 
            if oldValue != pixelsPerBeat {
                rebuildQuadTree() // Rebuild when zoom changes as track layout might shift
                updateArrangementLayers()
            }
        }
    }

    /// Scroll offset — kept for API compatibility but no longer used for drawing.
    /// Drawing uses document coordinates; the NSScrollView handles viewport clipping.
    public var scrollOffset: CGPoint = .zero

    public var playheadPosition: TimePosition = .zero {
        didSet { updateCursorAndPlayheadOnly() }
    }

    public var waveformRenderer: WaveformRenderer?
    public var metalWaveformRenderer: WaveformMetalRenderer? = WaveformMetalRenderer()

    /// Callback when the user clicks to set playhead.
    public var onClickPosition: ((TimePosition) -> Void)?

    /// Callback when a clip is selected.
    public var onClipSelected: ((UUID, UUID) -> Void)?  // (trackID, clipID)
    
    /// Callback when a MIDI clip is double-clicked to open piano roll.
    public var onMidiClipDoubleClicked: ((UUID, UUID) -> Void)?  // (trackID, midiClipID)

    /// Callback when a track is clicked (for detail panel).
    public var onTrackClicked: ((UUID) -> Void)?

    /// Callback when a MIDI clip is Shift+clicked (open piano roll).
    public var onMidiClipShiftClicked: ((UUID, UUID) -> Void)?  // (trackID, midiClipID)

    /// Callback when a browser item (instrument/effect) is dropped on a track.
    /// Parameters: (trackID, nodeType, itemName, fileURL)
    public var onBrowserItemDropped: ((UUID, String, String, URL?) -> Void)?

    /// Callback when zoom level changes (pixelsPerBeat, newScrollX).
    /// Host must update ruler and layout to keep everything in sync.
    public var onZoomChanged: ((CGFloat, CGFloat) -> Void)?

    /// Callback when clips are modified (moved, resized, deleted, or added).
    /// Host should refresh playback if currently running.
    public var onClipsModified: (() -> Void)?

    /// Optional coordinator hook kept for compatibility with controller wiring.
    public var interactionCoordinator: TimelineInteractionCoordinator?

    /// Reference to the application's undo/redo history for recording actions.
    /// Reference to the arrangement orchestrator for complex operations.
    public var orchestrator: ArrangementOrchestrator?


    /// The editing cursor (blue line).
    public var editCursor: EditCursor? {
        didSet {
            updateCursorAndPlayheadOnly()
        }
    }

    /// Layer for the smooth pulsing edit cursor.
    private let cursorLayer = CALayer()
    private let cursorHandleLayer = CAShapeLayer()
    private var isCursorVisible: Bool = true

    /// GPU-accelerated layers for arrangement
    private let gridLayer = GridLayer()
    private let laneContainerLayer = LaneLayer()
    private let clipContainerLayer = CALayer()
    private let playheadLayer = CALayer()
    private let titleContainerLayer = CALayer()
    
    /// Marquee selection visual overlay.
    private let selectionRectLayer: CAShapeLayer = {
        let layer = CAShapeLayer()
        layer.fillColor = NSColor.systemBlue.withAlphaComponent(0.2).cgColor
        layer.strokeColor = NSColor.systemBlue.cgColor
        layer.lineWidth = 1.0
        layer.zPosition = 1000 // Topmost
        return layer
    }()
    
    /// Ghost layer for drag-and-drop preview
    private let ghostClipLayer = CALayer()
    private var ghostAudioClip: AudioClip?

    // Metal Rendering Engine
    private let metalTimelineRenderer = MetalTimelineRenderer()
    private let metalArrangementLayer = CAMetalLayer()

    // Visual drop indicator (cyan line)
    private let dropIndicatorLayer = CALayer()
    public var insertionIndex: Int? {
        didSet {
            updateInsertionLine()
        }
    }


    /// Whether we're dragging the playhead (click on ruler/empty space logic can vary).


    /// Edge hit-test threshold in pixels.
    private let edgeHitZone: CGFloat = 12 // Further increased for better DAW feel
    
    /// Professional bracket cursors for trimming
    private lazy var leftBracketCursor: NSCursor = {
        let size = NSSize(width: 16, height: 16)
        let im = NSImage(size: size, flipped: false) { rect in
            NSColor.white.setStroke()
            let p = NSBezierPath()
            p.lineWidth = 1.2
            p.move(to: NSPoint(x: 10, y: 3))
            p.line(to: NSPoint(x: 6, y: 3))
            p.line(to: NSPoint(x: 6, y: 13))
            p.line(to: NSPoint(x: 10, y: 13))
            p.stroke()
            return true
        }
        return NSCursor(image: im, hotSpot: NSPoint(x: 6, y: 8))
    }()
    
    private lazy var rightBracketCursor: NSCursor = {
        let size = NSSize(width: 16, height: 16)
        let im = NSImage(size: size, flipped: false) { rect in
            NSColor.white.setStroke()
            let p = NSBezierPath()
            p.lineWidth = 1.2
            p.move(to: NSPoint(x: 6, y: 3))
            p.line(to: NSPoint(x: 10, y: 3))
            p.line(to: NSPoint(x: 10, y: 13))
            p.line(to: NSPoint(x: 6, y: 13))
            p.stroke()
            return true
        }
        return NSCursor(image: im, hotSpot: NSPoint(x: 10, y: 8))
    }()

    /// Tracking area for mouseMoved events (cursor changes on hover).
    private var hoverTrackingArea: NSTrackingArea?
    private var hoverLocation: NSPoint?

    // MARK: - Spatial Indexing

    /// Wrapper for clips stored in the QuadTree.
    internal final class ClipWrapper: Identifiable {
        let id: UUID
        let trackID: UUID
        let isMidi: Bool
        let audioClip: AudioClip?
        let midiClip: MidiClip?
        
        init(id: UUID, trackID: UUID, isMidi: Bool, audioClip: AudioClip?, midiClip: MidiClip?) {
            self.id = id
            self.trackID = trackID
            self.isMidi = isMidi
            self.audioClip = audioClip
            self.midiClip = midiClip
        }
    }

    /// QuadTree for fast spatial queries (hit-testing and culling).
    internal var quadTree: QuadTree<ClipWrapper>?

    // MARK: - Reactive Subscriptions

    private func setupSubscriptions() {
        NSLog("[TimelineCanvasView] setupSubscriptions start")
        // Cancel any existing subscriptions
        cancellables.removeAll()

        guard let project = project else { return }

        // 1. Project-level changes (Name, Loop, BPM, etc.)
        project.objectWillChange
            .debounce(for: .milliseconds(10), scheduler: DispatchQueue.main)
            .sink { [weak self] _ in
                self?.rebuildQuadTree()
                self?.updateArrangementLayers()
            }
            .store(in: &cancellables)

        // 2. Track list changes
        project.$tracks
            .debounce(for: .milliseconds(10), scheduler: DispatchQueue.main)
            .sink { [weak self] tracks in
                self?.subscribeToTracks(tracks)
                self?.rebuildQuadTree()
                self?.updateArrangementLayers()
            }
            .store(in: &cancellables)
            
        // 3. Master track changes
        project.masterTrack.objectWillChange
            .debounce(for: .milliseconds(10), scheduler: DispatchQueue.main)
            .sink { [weak self] _ in
                self?.rebuildQuadTree()
                self?.updateArrangementLayers()
            }
            .store(in: &cancellables)
            
        // Initial subscription
        subscribeToTracks(project.allVisibleTracks.filter { $0.trackType != .master })
    }

    private func subscribeToTracks(_ tracks: [Track]) {
        for track in tracks {
            track.objectWillChange
                .debounce(for: .milliseconds(10), scheduler: DispatchQueue.main)
                .sink { [weak self] _ in
                    self?.rebuildQuadTree()
                    self?.updateArrangementLayers()
                }
                .store(in: &cancellables)
        }
    }

    /// Tracks the last change time to prevent rapid-fire rebuilds (e.g. rapid clicking)
    private var lastQuadTreeRebuildTime: Date = Date.distantPast
    private let rebuildCooldown: TimeInterval = 0.05 // 50ms cooldown

    /// Rebuilds the spatial index (QuadTree) from the current project state.
    private func rebuildQuadTree() {
        // PERFORMANCE GUARD: Prevent "Click-Spam-Lag" by debouncing rebuilds
        let now = Date()
        if now.timeIntervalSince(lastQuadTreeRebuildTime) < rebuildCooldown { return }
        lastQuadTreeRebuildTime = now
        
        guard let project = project else {
            quadTree = nil
            return
        }

        // Define the boundary: very large duration (e.g., 100k beats) and all tracks.
        let visibleTracks = project.allVisibleTracks
        let boundary = QuadRect(minX: 0, maxX: 100000, minY: 0, maxY: Double(max(1, visibleTracks.count)))
        let tree = QuadTree<ClipWrapper>(boundary: boundary, capacity: 12)

        for track in visibleTracks {
            guard let trackIndex = visibleTracks.firstIndex(where: { $0.id == track.id }) else { continue }
            let y = Double(trackIndex)

            // Audio Clips
            for clip in track.clips {
                let bounds = QuadRect(
                    minX: clip.position.beats,
                    maxX: clip.position.beats + clip.duration.beats,
                    minY: y,
                    maxY: y + 1.0
                )
                let wrapper = ClipWrapper(id: clip.id, trackID: track.id, isMidi: false, audioClip: clip, midiClip: nil)
                tree.insert(QuadElement(id: clip.id, bounds: bounds, value: wrapper))
            }

            // MIDI Clips
            for clip in track.midiClips {
                let bounds = QuadRect(
                    minX: clip.position.beats,
                    maxX: clip.position.beats + clip.duration.beats,
                    minY: y,
                    maxY: y + 1.0
                )
                let wrapper = ClipWrapper(id: clip.id, trackID: track.id, isMidi: true, audioClip: nil, midiClip: clip)
                tree.insert(QuadElement(id: clip.id, bounds: bounds, value: wrapper))
            }
        }

        self.quadTree = tree
    }


    private func setupCursorAnimation() {
        let pulse = CABasicAnimation(keyPath: "backgroundColor")
        pulse.fromValue = NSColor.white.cgColor
        // Using a soft cyan for "light blue" Ableton look
        pulse.toValue = NSColor.systemCyan.withAlphaComponent(0.6).cgColor
        pulse.duration = 1.0  // Slower, smoother pulse
        pulse.autoreverses = true
        pulse.repeatCount = .infinity
        pulse.timingFunction = CAMediaTimingFunction(name: CAMediaTimingFunctionName.easeInEaseOut)
        cursorLayer.add(pulse, forKey: "pulse")
        
        // Also animate the handle color in sync
        let handlePulse = CABasicAnimation(keyPath: "fillColor")
        handlePulse.fromValue = NSColor.white.cgColor
        handlePulse.toValue = NSColor.systemCyan.withAlphaComponent(0.6).cgColor
        handlePulse.duration = 1.0
        handlePulse.autoreverses = true
        handlePulse.repeatCount = .infinity
        handlePulse.timingFunction = CAMediaTimingFunction(name: CAMediaTimingFunctionName.easeInEaseOut)
        cursorHandleLayer.add(handlePulse, forKey: "pulse")
    }



    private struct DragState {
        let trackID: UUID
        let clipID: UUID
        let isMidi: Bool
        let startMousePosition: NSPoint
        let originalClipBeat: Double
    }

    /// Which edge of a clip is being resized.
    private enum ClipEdge {
        case left
        case right
    }

    private struct ResizeState {
        let trackID: UUID
        let clipID: UUID
        let isMidi: Bool
        let edge: ClipEdge
        let startMouseX: CGFloat
        let originalPosition: Double   // beats
        let originalDuration: Double   // beats
        let originalTrim: Double       // beats (for audio)
    }

    // MARK: - Drawing

    public override var isFlipped: Bool { true }

    public override func draw(_ dirtyRect: NSRect) {
        // All rendering is now layer-backed.
    }

    public override func layout() {
        super.layout()
        updateArrangementLayers()
    }

    public func updateArrangementLayers(fullRedraw: Bool = true, visibleRectOverride: CGRect? = nil, pixelsPerBeatOverride: CGFloat? = nil) {
        // NSLog("[TimelineCanvasView] updateArrangementLayers start (fullRedraw: \(fullRedraw))")
        guard let project = project else { 
            NSLog("[TimelineCanvasView] updateArrangementLayers ABORT: project is nil")
            return 
        }
        
        // Use overrides if provided (for smooth zooming), otherwise use current state
        let currentPPB = pixelsPerBeatOverride ?? pixelsPerBeat
        // Use override rect if provided, otherwise standard visibleRect
        let currentVisibleRect = visibleRectOverride ?? visibleRect
        
        if currentVisibleRect.width <= 0 || currentVisibleRect.height <= 0 {
            NSLog("[TimelineCanvasView] updateArrangementLayers SKIPPED: visibleRect is zero: \(currentVisibleRect)")
        }

        CATransaction.begin()
        // ...
        CATransaction.setDisableActions(true)
        
        if fullRedraw {
            updateGridLayer(project: project)
            updateLaneLayers(project: project)
        }

        let pulseMap = PulseMap(
            bpm: project.bpm,
            sampleRate: project.sampleRate
        )
        
        // SYNC VIEWPORT MATRIX:
        // The ViewportMatrix is the "source of truth" for Metal rendering.
        // It must match the current pixelsPerBeat and visible rect.
        let samplesPerBeat = (60.0 / project.bpm) * project.sampleRate
        viewportMatrix.samplesPerPixel = samplesPerBeat / Double(currentPPB)
        viewportMatrix.visibleStartSample = Double(currentVisibleRect.origin.x) * viewportMatrix.samplesPerPixel
        viewportMatrix.visibleStartY = Double(currentVisibleRect.origin.y)
        viewportMatrix.viewportWidth = Double(currentVisibleRect.width)
        viewportMatrix.viewportHeight = Double(currentVisibleRect.height)
        
        // GPU BATCH RENDERING:
        // Match the Metal layer to the visible viewport.
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        
        metalArrangementLayer.frame = currentVisibleRect
        titleContainerLayer.frame = currentVisibleRect
        
        let scale = self.window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2.0
        metalArrangementLayer.contentsScale = scale
        metalArrangementLayer.drawableSize = CGSize(width: metalArrangementLayer.bounds.width * scale, height: metalArrangementLayer.bounds.height * scale)
        metalArrangementLayer.pixelFormat = .bgra8Unorm
        metalArrangementLayer.isGeometryFlipped = true
        CATransaction.commit()
        
        if let renderer = metalTimelineRenderer {
            if renderer.waveformCache == nil {
                renderer.waveformCache = self.waveformRenderer?.waveformCache
            }

            NSLog("[TimelineCanvasView] calling renderer.render()...")
            renderer.render(
                project: project,
                viewport: viewportMatrix,
                layoutEngine: layoutEngine,
                interactionSM: interactionSM,
                pulseMap: pulseMap,
                in: metalArrangementLayer
            )
            NSLog("[TimelineCanvasView] renderer.render() finished.")
        }
        
        // Cursor and Playhead
        updateCursorLayer(project: project, pixelsPerBeatOverride: currentPPB)
        updatePlayheadLayer(project: project, pixelsPerBeatOverride: currentPPB)
        
        selectionRectLayer.frame = self.bounds // Ensure marquee layer covers whole area
        updateMarqueeLayer(pixelsPerBeatOverride: currentPPB)
        
        // --- CLIP TITLES (Optimized Pass) ---
        updateClipTitles(project: project, visibleRectOverride: currentVisibleRect, pixelsPerBeatOverride: currentPPB)
        
        CATransaction.commit()
    }
    
    private func updateClipTitles(project: Project, visibleRectOverride: CGRect? = nil, pixelsPerBeatOverride: CGFloat? = nil) {
        // Simple but effective: Remove all old titles and add only visible ones.
        // For Enterprise production, we would use a reuse pool, but for 50-100 clips this is fine.
        titleContainerLayer.sublayers?.forEach { $0.removeFromSuperlayer() }
        
        for track in project.allVisibleTracks {
            let trackY = self.yOffsetForTrack(id: track.id, in: project)
            
            // Audio Clips
            let targetVisibleRect = visibleRectOverride ?? visibleRect
            let ppb = pixelsPerBeatOverride ?? pixelsPerBeat
            
            if !track.clips.isEmpty {
                // NSLog("[TimelineCanvasView] Track \(track.name) has \(track.clips.count) audio clips")
            }
            
            for clip in track.clips {
                let clipX = CGFloat(clip.position.beats) * ppb
                let clipWidth = CGFloat(clip.duration.beats) * ppb
                
                // Culling with safety margin
                if clipX + clipWidth < targetVisibleRect.minX || clipX > targetVisibleRect.maxX { continue }
                
                // Viewport-Relative Calculation (Matches Metal)
                let relativeX = clipX - targetVisibleRect.minX
                let relativeRect = CGRect(
                    x: relativeX,
                    y: (trackY + 2) - targetVisibleRect.minY, // Relative Y for viewport-fixed layer
                    width: clipWidth,
                    height: 20
                )
                
                addTitleLayer(name: clip.name, frame: relativeRect, backgroundColor: track.color.nsColor)
            }
            
            // MIDI Clips
            for clip in track.midiClips {
                let clipX = CGFloat(clip.position.beats) * ppb
                let clipWidth = CGFloat(clip.duration.beats) * ppb
                
                if clipX + clipWidth < targetVisibleRect.minX || clipX > targetVisibleRect.maxX { continue }
                
                let relativeX = clipX - targetVisibleRect.minX
                let relativeRect = CGRect(
                    x: relativeX,
                    y: (trackY + 2) - targetVisibleRect.minY,
                    width: clipWidth,
                    height: 20
                )
                
                addTitleLayer(name: clip.name, frame: relativeRect, backgroundColor: track.color.nsColor)
            }
        }
    }
    
    private func addTitleLayer(name: String, frame: CGRect, backgroundColor: NSColor) {
        let textLayer = CATextLayer()
        textLayer.string = name
        textLayer.fontSize = 12 // Slightly larger
        textLayer.font = NSFont.systemFont(ofSize: 12, weight: .semibold)
        
        // DYNAMIC CONTRAST LOGIC (Fixed for Yellow/Light clips)
        // 0.2126*R + 0.7152*G + 0.0722*B
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        backgroundColor.getRed(&r, green: &g, blue: &b, alpha: &a)
        let luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
        
        // Threshold lowered to 0.5 to catch Yellow (0.92) and light colors
        textLayer.foregroundColor = luminance > 0.5 ? NSColor.black.cgColor : NSColor.white.cgColor
        textLayer.backgroundColor = NSColor.clear.cgColor
        textLayer.frame = frame.insetBy(dx: 5, dy: 2)
        textLayer.contentsScale = window?.backingScaleFactor ?? 2.0
        textLayer.alignmentMode = .left
        textLayer.truncationMode = .end
        titleContainerLayer.addSublayer(textLayer)
    }
    
    private func yOffsetForTrack(id: UUID, in project: Project) -> CGFloat {
        var y: CGFloat = 0
        let visibleTracks = project.allVisibleTracks
        for (index, track) in visibleTracks.enumerated() {
            if track.id == id {
                // Same logic as header: pull Master to bottom
                if track.trackType == .master {
                    let totalH = visibleTracks.reduce(0) { $0 + $1.height }
                    if totalH < bounds.height {
                        return bounds.height - track.height
                    }
                }
                return y
            }
            y += track.height
        }
        return 0
    }

    /// Optimized path for frequent playhead/cursor movement.
    /// Does NOT rebuild clips or lanes.
    public func updateCursorAndPlayheadOnly() {
        guard let project = project else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        updateCursorLayer(project: project)
        updatePlayheadLayer(project: project)
        CATransaction.commit()
    }

    private func updateGridLayer(project: Project, pixelsPerBeatOverride: CGFloat? = nil) {
        gridLayer.frame = self.bounds
        gridLayer.pixelsPerBeat = pixelsPerBeatOverride ?? pixelsPerBeat
        gridLayer.timeSignature = project.timeSignature
        gridLayer.setNeedsDisplay()
    }

    private func updateLaneLayers(project: Project) {
        laneContainerLayer.frame = self.bounds
        laneContainerLayer.tracks = project.allVisibleTracks.filter { $0.trackType != .master }
        
        // We might need to pass the alignment info to laneContainerLayer if it draws dividers
        // For now, let's assume it draws based on track order. 
        // If it draws lines between tracks, it needs to know about the gap.
        
        laneContainerLayer.setNeedsDisplay()
    }

    private func updatePlayheadLayer(project: Project?, pixelsPerBeatOverride: CGFloat? = nil) {
        guard let _ = project else { return }
        let ppb = pixelsPerBeatOverride ?? pixelsPerBeat
        let x = CGFloat(playheadPosition.beats) * ppb
        
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        playheadLayer.frame = CGRect(x: x - 0.5, y: 0, width: 1.5, height: bounds.height)
        playheadLayer.isHidden = false
        CATransaction.commit()
    }

    // Pools for layer reuse
    private var audioLayerPool: [UUID: AudioClipLayer] = [:]
    private var midiLayerPool: [UUID: MidiClipLayer] = [:]

    private func updateClipLayers(project: Project) {
        clipContainerLayer.frame = self.bounds
        
        let vr = visibleRect
        let visibleBeatsRange = Double(vr.width) / Double(pixelsPerBeat)
        let minBeat = Double(vr.minX) / Double(pixelsPerBeat)
        let maxBeat = minBeat + visibleBeatsRange
        
        let visibleTracks = project.allVisibleTracks.filter { $0.trackType != .master }
        
        // ENTERPRISE PERFECTION: Expand culling range to prevent clip flickering during fast navigation
        let queryRect = QuadRect(minX: minBeat - 200.0, maxX: maxBeat + 200.0, 
                                 minY: 0, maxY: 100) // maxY 100 is plenty for track indexing
        
        let candidates = quadTree?.query(range: queryRect) ?? []
        var visibleIDs = Set<UUID>()
        
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        
        for element in candidates {
            let wrapper = element.value
            visibleIDs.insert(wrapper.id)
            
            guard let trackIndex = visibleTracks.firstIndex(where: { $0.id == wrapper.trackID }) else { continue }
            let track = visibleTracks[trackIndex]
            
            var trackY: CGFloat = 0
            for i in 0..<trackIndex { trackY += visibleTracks[i].height }
            
            if !wrapper.isMidi, let clip = wrapper.audioClip {
                let layer = audioLayerPool[clip.id] ?? {
                    let newLayer = AudioClipLayer()
                    audioLayerPool[clip.id] = newLayer
                    clipContainerLayer.addSublayer(newLayer)
                    return newLayer
                }()
                
                let clipX = CGFloat(clip.position.beats) * pixelsPerBeat
                let clipWidth = CGFloat(clip.duration.beats) * pixelsPerBeat
                let newFrame = CGRect(x: clipX, y: trackY + 2, width: clipWidth, height: track.height - 4)
                
                // Only update and redraw if something meaningful changed
                let hasMoved = abs(layer.frame.origin.x - clipX) > 0.1 || abs(layer.frame.origin.y - (trackY + 2)) > 0.1
                let hasResized = abs(layer.frame.width - clipWidth) > 0.1 || abs(layer.frame.height - (track.height - 4)) > 0.1
                
                
                if layer.track?.volume != track.volume || abs(layer.pixelsPerBeat - pixelsPerBeat) > 0.01 || hasMoved || hasResized || clip.isSelected != layer.clip?.isSelected {
                    layer.clip = clip
                    layer.track = track
                    layer.pixelsPerBeat = pixelsPerBeat
                    layer.bpm = project.bpm
                    layer.sampleRate = project.sampleRate
                    layer.waveformRenderer = waveformRenderer
                    layer.metalWaveformRenderer = metalWaveformRenderer
                    layer.frame = newFrame
                    layer.setNeedsDisplay()
                }
                
            } else if wrapper.isMidi, let clip = wrapper.midiClip {
                let layer = midiLayerPool[clip.id] ?? {
                    let newLayer = MidiClipLayer()
                    midiLayerPool[clip.id] = newLayer
                    clipContainerLayer.addSublayer(newLayer)
                    return newLayer
                }()
                
                let clipX = CGFloat(clip.position.beats) * pixelsPerBeat
                let clipWidth = CGFloat(clip.duration.beats) * pixelsPerBeat
                let newFrame = CGRect(x: clipX, y: trackY + 2, width: clipWidth, height: track.height - 4)
                
                let hasMoved = abs(layer.frame.origin.x - clipX) > 0.1 || abs(layer.frame.origin.y - (trackY + 2)) > 0.1
                let hasResized = abs(layer.frame.width - clipWidth) > 0.1 || abs(layer.frame.height - (track.height - 4)) > 0.1
                
                if hasMoved || hasResized || clip.isSelected != layer.midiClip?.isSelected {
                    layer.midiClip = clip
                    layer.trackColor = track.color.nsColor
                    layer.frame = newFrame
                    layer.setNeedsDisplay()
                }
            }
        }
        
        // Remove off-screen layers
        audioLayerPool.keys.forEach { id in
            if !visibleIDs.contains(id) {
                audioLayerPool[id]?.removeFromSuperlayer()
                audioLayerPool.removeValue(forKey: id)
            }
        }
        midiLayerPool.keys.forEach { id in
            if !visibleIDs.contains(id) {
                midiLayerPool[id]?.removeFromSuperlayer()
                midiLayerPool.removeValue(forKey: id)
            }
        }
        
        CATransaction.commit()
    }

    public override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        // Animations automatically resume/pause with window visibility in CALayer
    }
    
    private func updateCursorLayer(project: Project, pixelsPerBeatOverride: CGFloat? = nil) {
        guard let cursor = editCursor, !cursor.trackIDs.isEmpty else {
            cursorLayer.isHidden = true
            cursorHandleLayer.isHidden = true
            return
        }
        
        cursorLayer.isHidden = false
        cursorHandleLayer.isHidden = false
        
        // Find track Y range to span all selected tracks
        var minY: CGFloat = .greatestFiniteMagnitude
        var maxY: CGFloat = -.greatestFiniteMagnitude
        var found = false
        
        var yOffset: CGFloat = 0
        let visibleTracks = project.allVisibleTracks
        for track in visibleTracks {
            if cursor.trackIDs.contains(track.id) {
                minY = min(minY, yOffset)
                maxY = max(maxY, yOffset + track.height)
                found = true
            }
            yOffset += track.height
        }
        
        guard found else {
            cursorLayer.isHidden = true
            cursorHandleLayer.isHidden = true
            return
        }
        
        let ppb = pixelsPerBeatOverride ?? pixelsPerBeat
        let x = CGFloat(cursor.position.beats) * ppb
        
        // Update frames (use CATransaction to disable implicit animations for position/bounds)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        cursorLayer.frame = CGRect(x: x - 0.75, y: minY, width: 1.5, height: maxY - minY)
        
        // Triangle Handle (At the top of the spanning range)
        let path = CGMutablePath()
        path.move(to: CGPoint(x: x - 4, y: minY))
        path.addLine(to: CGPoint(x: x + 4, y: minY))
        path.addLine(to: CGPoint(x: x, y: minY + 5))
        path.closeSubpath()
        cursorHandleLayer.path = path
        CATransaction.commit()
    }


    // MARK: - Legacy Drawing Logic (Removed)
    // Note: All rendering is now managed by GridLayer, LaneLayer, AudioClipLayer, and MidiClipLayer subclasses.

    public override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let area = hoverTrackingArea {
            removeTrackingArea(area)
        }
        let area = NSTrackingArea(rect: bounds, options: [.mouseMoved, .mouseEnteredAndExited, .activeAlways], owner: self, userInfo: nil)
        addTrackingArea(area)
        hoverTrackingArea = area
    }

    public override var acceptsFirstResponder: Bool { true }

    public override func mouseMoved(with event: NSEvent) {
        guard let project = project else {
            hoverLocation = nil
            NSCursor.arrow.set()
            return
        }

        let location = convert(event.locationInWindow, from: nil)
        hoverLocation = location
        
        let edgeHitZoneLarge: CGFloat = edgeHitZone + 4 // Even more generous for hover
        
        if let (_, _, edge) = hitTestClipEdge(at: location, project: project) {
            if edge == .left {
                leftBracketCursor.set()
            } else {
                rightBracketCursor.set()
            }
        } else {
            // Empty space: use standard arrow cursor
            NSCursor.arrow.set()
        }
        updateArrangementLayers()
    }

    public override func mouseExited(with event: NSEvent) {
        hoverLocation = nil
        NSCursor.arrow.set()
        updateArrangementLayers()
    }

    public override func keyDown(with event: NSEvent) {
        let modifierFlags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        let isCommand = modifierFlags.contains(.command)
        if isCommand, let chars = event.charactersIgnoringModifiers?.lowercased() {
            switch chars {
            case "x":
                cut(nil)
                return
            case "c":
                copy(nil)
                return
            case "v":
                paste(nil)
                return
            case "d":
                duplicate(nil)
                return
            case "a":
                selectAll(nil)
                return
            default:
                break
            }
        }

        switch event.keyCode {
        case 51, 117:  // Backspace (51), Forward Delete (117)
            deleteSelection()
        case 46: // 'M'
            super.keyDown(with: event)
        default:
            super.keyDown(with: event)
        }
    }

    // MARK: - Edge Hit Testing

    /// Identifies which clip edge (if any) the given point is near.
    /// Returns a tuple of (trackID, clipID, isMidi, edge) or nil.

    // MARK: - Hit Testing (Absolute Architecture)

    internal func hitTestClipBody(at location: NSPoint, project: Project) -> (Track, ClipWrapper)? {
        let beat = Double(location.x) / Double(pixelsPerBeat)
        
        var currentY: CGFloat = 0
        let visibleTracks = project.allVisibleTracks
        for (i, t) in visibleTracks.enumerated() {
            if location.y >= currentY && location.y < currentY + t.height {
                let query = QuadRect(minX: beat - 0.001, maxX: beat + 0.001, minY: Double(i), maxY: Double(i+1))
                if let candidates = quadTree?.query(range: query) {
                    for element in candidates {
                        let wrapper = element.value
                        if wrapper.trackID == t.id {
                            return (t, wrapper)
                        }
                    }
                }
                return nil
            }
            currentY += t.height
        }
        return nil
    }

    internal func hitTestClipEdge(at location: NSPoint, project: Project) -> (Track, ClipWrapper, TrimEdge)? {
        let beat = Double(location.x) / Double(pixelsPerBeat)
        let toleranceBeats = Double(edgeHitZone / pixelsPerBeat)
        
        var currentY: CGFloat = 0
        let visibleTracks = project.allVisibleTracks
        for (i, t) in visibleTracks.enumerated() {
            if location.y >= currentY && location.y < currentY + t.height {
                let query = QuadRect(minX: beat - toleranceBeats, maxX: beat + toleranceBeats, minY: Double(i), maxY: Double(i+1))
                if let candidates = quadTree?.query(range: query) {
                    for element in candidates {
                        let wrapper = element.value
                        if wrapper.trackID == t.id {
                            let start = element.bounds.minX
                            let end = element.bounds.maxX
                            if abs(beat - start) < toleranceBeats {
                                return (t, wrapper, .left)
                            }
                            if abs(beat - end) < toleranceBeats {
                                return (t, wrapper, .right)
                            }
                        }
                    }
                }
                return nil
            }
            currentY += t.height
        }
        return nil
    }


    // MARK: - Selection Helpers

    /// Deselect all clips across all tracks.
    private func deselectAllClips(in project: Project) {
        for track in project.allVisibleTracks {
            for i in track.clips.indices {
                if track.clips[i].isSelected {
                    track.clips[i].isSelected = false
                }
            }
            for i in track.midiClips.indices {
                if track.midiClips[i].isSelected {
                    track.midiClips[i].isSelected = false
                }
            }
        }
    }

    /// Select a specific clip by ID.
    private func selectClip(id: UUID, isMidi: Bool, in project: Project) {
        for track in project.allVisibleTracks {
            if isMidi {
                if let idx = track.midiClips.firstIndex(where: { $0.id == id }) {
                    track.midiClips[idx].isSelected = true
                    // Redraw happens via the caller
                    return
                }
            } else {
                if let idx = track.clips.firstIndex(where: { $0.id == id }) {
                    track.clips[idx].isSelected = true
                    // Redraw happens via the caller
                    return
                }
            }
        }
    }

    // MARK: - Mouse Interaction

    public override func mouseDown(with event: NSEvent) {
        // Make canvas first responder so it receives keyboard events
        window?.makeFirstResponder(self)
        
        guard let project = project else { return }
        interactionCoordinator?.mouseDown(with: event, in: self)
        updateArrangementLayers(fullRedraw: false)
    }
    
    /* REMOVED LEGACY CODE */
    public override func mouseDragged(with event: NSEvent) {
        guard let project = project else { return }
        interactionCoordinator?.mouseDragged(with: event, in: self)
        updateArrangementLayers(fullRedraw: false)
    }
    
    public override func mouseUp(with event: NSEvent) {
        interactionCoordinator?.mouseUp(with: event, in: self)
        updateArrangementLayers(fullRedraw: true)
    }
    
    // MARK: - Marquee Logic
    
    /// Updates the visual marquee layer based on the state machine's state.
    /// This is called during the rendering pass or when the state machine updates.
    private func updateMarqueeLayer(pixelsPerBeatOverride: CGFloat? = nil) {
        if case .marqueeSelecting(let startX, let currentX, let startY, let currentY) = interactionSM.currentState {
            selectionRectLayer.isHidden = false
            let rect = CGRect(
                x: CGFloat(min(startX, currentX)),
                y: min(startY, currentY),
                width: CGFloat(abs(startX - currentX)),
                height: abs(startY - currentY)
            )
            selectionRectLayer.path = CGPath(rect: rect, transform: nil)
        } else {
            selectionRectLayer.isHidden = true
            selectionRectLayer.path = nil
        }
    }
    // [LEGACY LOGIC REMOVED]





    // MARK: - Keyboard Shortcuts

    /// Clipboard for copy/cut/paste operations.
    private struct ClipboardItem {
        enum Kind { case audio(AudioClip), midi(MidiClip) }
        let item: Kind
        let trackID: UUID
    }
    private static var clipboard: [ClipboardItem] = []

    /// Returns the start position of the current selection (earliest clip or marquee start).
    public var selectionPlaybackStart: TimePosition? {
        guard let project = project else { return nil }
        
        // 1. If we have a marquee selection (even a persistent one), use its start beat
        if let rect = selectionRectLayer.path?.boundingBoxOfPath, !selectionRectLayer.isHidden {
            let startBeat = Double(rect.minX) / Double(pixelsPerBeat)
            return TimePosition(beats: startBeat)
        }
        
        // 2. Fallback to earliest selected clip
        var minBeat = Double.greatestFiniteMagnitude
        var found = false
        
        for track in project.allVisibleTracks {
            for clip in track.clips where clip.isSelected {
                minBeat = min(minBeat, clip.position.beats)
                found = true
            }
            for clip in track.midiClips where clip.isSelected {
                minBeat = min(minBeat, clip.position.beats)
                found = true
            }
        }
        
        return found ? TimePosition(beats: minBeat) : nil
    }

    /// Returns true if any clip is currently selected on the canvas.
    public var hasSelection: Bool {
        guard let project = project else { return false }
        return project.allVisibleTracks.contains { $0.clips.contains(where: \.isSelected) || $0.midiClips.contains(where: \.isSelected) }
    }
    
    // MARK: - Editing Operations (Public API for Controller)

    /// Delete all selected clips across all tracks.
    public func deleteSelection() {
        guard let project = project else { return }
        var didDelete = false
        for track in project.allVisibleTracks {
            let audioToRemove = track.clips.filter { $0.isSelected }
            let midiToRemove = track.midiClips.filter { $0.isSelected }

            if !audioToRemove.isEmpty {
                track.clips.removeAll { $0.isSelected }
                didDelete = true
            }
            if !midiToRemove.isEmpty {
                track.midiClips.removeAll { $0.isSelected }
                didDelete = true
            }
        }
        if didDelete {
            refreshUI()
            onClipsModified?()
        }
    }

    /// Split all clips that span the current edit cursor position.
    public func splitClipsAtEditCursor() {
        guard let project = project, let cursor = editCursor else { return }
        let splitBeat = cursor.position.beats
        guard splitBeat > 0 else { return }
        
        // Only split clips on the cursor's track? Or all selected?
        // Ableton: Cmd+E splits selected clips (or all at cursor if none selected?)
        // Let's implement global split at cursor for now (user said "I can insert... into that place")
        // But typically split acts on selection. If specific clips are selected, split them.
        // If nothing selected, maybe split all crossing the line?
        // User requested: "editing operations... happen at this place".

        var didSplit = false

        for track in project.allVisibleTracks {
            // Split clips on the TRACKS where the cursor is.
            guard cursor.trackIDs.contains(track.id) else { continue }
            
            // Split audio clips
            var newAudioClips: [AudioClip] = []
            for (index, clip) in track.clips.enumerated() {
                let clipStart = clip.position.beats
                let clipEnd = clip.endPosition.beats

                // Playhead must be inside the clip (not at edges)
                guard splitBeat > clipStart && splitBeat < clipEnd else { continue }

                let leftDuration = splitBeat - clipStart
                let rightDuration = clipEnd - splitBeat

                // Left part: keep original, trim duration
                track.clips[index].duration = TimePosition(beats: leftDuration)

                // Right part: new clip with adjusted position and trimStartOffset
                let rightClip = AudioClip(
                    name: clip.name,
                    fileURL: clip.fileURL,
                    position: TimePosition(beats: splitBeat),
                    duration: TimePosition(beats: rightDuration),
                    trimStartOffset: TimePosition(beats: clip.trimStartOffset.beats + leftDuration),
                    gain: clip.gain
                )
                newAudioClips.append(rightClip)
                didSplit = true
            }
            track.clips.append(contentsOf: newAudioClips)
            synchronizeClips(on: track)

            // Split MIDI clips
            var newMidiClips: [MidiClip] = []
            for (index, clip) in track.midiClips.enumerated() {
                let clipStart = clip.position.beats
                let clipEnd = clip.endPosition.beats

                guard splitBeat > clipStart && splitBeat < clipEnd else { continue }

                let leftDuration = splitBeat - clipStart
                let rightDuration = clipEnd - splitBeat

                // Partition notes: notes that START before the split go to left,
                // notes that START at or after the split go to right (with adjusted positions)
                let leftNotes = clip.notes.filter { $0.position.beats < leftDuration }
                let rightNotes = clip.notes.compactMap { note -> MidiNote? in
                    guard note.position.beats >= leftDuration else { return nil }
                    var adjusted = note
                    adjusted.position = TimePosition(beats: note.position.beats - leftDuration)
                    return adjusted
                }

                // Left part: keep original, trim duration, keep left notes
                track.midiClips[index].duration = TimePosition(beats: leftDuration)
                track.midiClips[index].notes = leftNotes

                // Right part: new clip
                let rightClip = MidiClip(
                    name: clip.name,
                    position: TimePosition(beats: splitBeat),
                    duration: TimePosition(beats: rightDuration),
                    notes: rightNotes,
                    colorOverride: clip.colorOverride
                )
                newMidiClips.append(rightClip)
                didSplit = true
            }
            track.midiClips.append(contentsOf: newMidiClips)
        }
        if didSplit {
            updateArrangementLayers()
            onClipsModified?()
        }
    }

    /// Copy all selected clips to the clipboard.
    public func copySelection() {
        guard let project = project else { return }
        Self.clipboard.removeAll()

        var selectedCount = 0
        for track in project.allVisibleTracks {
            for clip in track.clips where clip.isSelected {
                Self.clipboard.append(ClipboardItem(item: .audio(clip), trackID: track.id))
                selectedCount += 1
            }
            for clip in track.midiClips where clip.isSelected {
                Self.clipboard.append(ClipboardItem(item: .midi(clip), trackID: track.id))
                selectedCount += 1
            }
        }

        // If no explicit clip selection exists, copy the current marquee time area.
        if selectedCount == 0,
           let box = selectionRectLayer.path?.boundingBoxOfPath,
           !selectionRectLayer.isHidden {
            let minBeat = Double(box.minX) / Double(pixelsPerBeat)
            let maxBeat = Double(box.maxX) / Double(pixelsPerBeat)

            var yOffset: CGFloat = 0
            var minTrackIndex: Int?
            var maxTrackIndex: Int?
            for (index, track) in project.allVisibleTracks.enumerated() {
                let top = yOffset
                let bottom = yOffset + track.height
                if box.minY < bottom && box.maxY > top {
                    minTrackIndex = min(minTrackIndex ?? index, index)
                    maxTrackIndex = max(maxTrackIndex ?? index, index)
                }
                yOffset += track.height
            }

            guard let minIndex = minTrackIndex, let maxIndex = maxTrackIndex else { return }
            let trackRange = minIndex...maxIndex

            for (index, track) in project.allVisibleTracks.enumerated() where trackRange.contains(index) {
                for clip in track.clips where clip.endPosition.beats > minBeat && clip.position.beats < maxBeat {
                    Self.clipboard.append(ClipboardItem(item: .audio(clip), trackID: track.id))
                }
                for clip in track.midiClips where clip.endPosition.beats > minBeat && clip.position.beats < maxBeat {
                    Self.clipboard.append(ClipboardItem(item: .midi(clip), trackID: track.id))
                }
            }
        }
    }

    /// Cut selected clips (or marquee area): copy to clipboard and remove from timeline.
    public func cutSelection() {
        copySelection()
        deleteSelection()
    }

    /// Paste clipboard clips at the current edit cursor position.
    public func pasteClipsAtEditCursor() {
        guard let project = project, let cursor = editCursor else { return }
        guard !Self.clipboard.isEmpty else { return }

        // Find the earliest position among clipboard items
        let earliestBeat: Double = Self.clipboard.reduce(Double.greatestFiniteMagnitude) { result, item in
            switch item.item {
            case .audio(let clip): return min(result, clip.position.beats)
            case .midi(let clip): return min(result, clip.position.beats)
            }
        }

        let offset = cursor.position.beats - earliestBeat

        // Deselect all first
        deselectAllClips(in: project)

        for item in Self.clipboard {
            // Find the target track
            guard let track = project.allVisibleTracks.first(where: { $0.id == item.trackID }) else { continue }

            switch item.item {
            case .audio(let original):
                let pasted = AudioClip(
                    name: original.name,
                    fileURL: original.fileURL,
                    position: TimePosition(beats: original.position.beats + offset),
                    duration: original.duration,
                    trimStartOffset: original.trimStartOffset,
                    gain: original.gain,
                    isSelected: true
                )
                track.clips.append(pasted)

            case .midi(let original):
                let pasted = MidiClip(
                    name: original.name,
                    position: TimePosition(beats: original.position.beats + offset),
                    duration: original.duration,
                    notes: original.notes,
                    isSelected: true,
                    colorOverride: original.colorOverride
                )
                track.midiClips.append(pasted)
            }
        }
        for track in project.allVisibleTracks {
            synchronizeClips(on: track)
        }
        refreshUI()
        onClipsModified?()
    }

    /// Select all clips across all tracks.
    public func selectAllClips() {
        guard let project = project else { return }
        for track in project.allVisibleTracks {
            for i in track.clips.indices { track.clips[i].isSelected = true }
            for i in track.midiClips.indices { track.midiClips[i].isSelected = true }
        }
        updateArrangementLayers()
    }

    /// Duplicate selection — places copies immediately after the originals OR duplicates a marquee range.
    public func duplicateSelection() {
        guard let project = project else { return }
        
        let clipsToDuplicate: [(Track, ClipWrapper)]
        let moveOffset: Double
        
        if case .marqueeSelecting(let startX, let currentX, let startY, let currentY) = interactionSM.currentState {
            // DUPLICATE TIME RANGE (Marquee)
            let ppb = Double(pixelsPerBeat)
            let lowerBeat = Double(min(startX, currentX)) / ppb
            let upperBeat = Double(max(startX, currentX)) / ppb
            
            let query = QuadRect(
                minX: lowerBeat,
                maxX: upperBeat,
                minY: 0,
                maxY: Double(project.allVisibleTracks.count)
            )
            clipsToDuplicate = (quadTree?.query(range: query) ?? []).compactMap { element in
                let wrapper = element.value
                guard let track = project.allVisibleTracks.first(where: { $0.id == wrapper.trackID }) else { return nil }
                return (track, wrapper)
            }
            moveOffset = upperBeat - lowerBeat
            
            // Note: We don't manually move the marquee now, normally DAWs just duplicate and keep selection.
            // If we wanted persistent marquee, we'd update the SM, but usually Command+D on clips is more common.
        } else {
            // DUPLICATE SELECTED CLIPS
            var selected: [(Track, ClipWrapper)] = []
            var minStart = Double.greatestFiniteMagnitude
            var maxEnd: Double = 0
            
            for track in project.allVisibleTracks {
                for clip in track.clips where clip.isSelected {
                    selected.append((track, ClipWrapper(id: clip.id, trackID: track.id, isMidi: false, audioClip: clip, midiClip: nil)))
                    minStart = min(minStart, clip.position.beats)
                    maxEnd = max(maxEnd, clip.endPosition.beats)
                }
                for clip in track.midiClips where clip.isSelected {
                    selected.append((track, ClipWrapper(id: clip.id, trackID: track.id, isMidi: true, audioClip: nil, midiClip: clip)))
                    minStart = min(minStart, clip.position.beats)
                    maxEnd = max(maxEnd, clip.endPosition.beats)
                }
            }
            clipsToDuplicate = selected
            moveOffset = max(0, maxEnd - minStart)
        }
        
        guard !clipsToDuplicate.isEmpty else { return }
        
        deselectAllClips(in: project)
        
        for (track, wrapper) in clipsToDuplicate {
            if let clip = wrapper.audioClip {
                let dupe = AudioClip(
                    name: clip.name,
                    fileURL: clip.fileURL,
                    position: TimePosition(beats: clip.position.beats + moveOffset),
                    duration: clip.duration,
                    trimStartOffset: clip.trimStartOffset,
                    gain: clip.gain,
                    isSelected: true
                )
                track.clips.append(dupe)
            } else if let clip = wrapper.midiClip {
                let dupe = MidiClip(
                    name: clip.name,
                    position: TimePosition(beats: clip.position.beats + moveOffset),
                    duration: clip.duration,
                    notes: clip.notes,
                    isSelected: true,
                    colorOverride: clip.colorOverride
                )
                track.midiClips.append(dupe)
            }
        }
        
        for track in project.allVisibleTracks {
            synchronizeClips(on: track)
        }
        
        project.isDirty = true
        onClipsModified?()
        refreshUI()
    }

    // MARK: - Responder Actions

    @objc public func copy(_ sender: Any?) {
        copySelection()
    }

    @objc public func paste(_ sender: Any?) {
        pasteClipsAtEditCursor()
    }

    @objc public func cut(_ sender: Any?) {
        cutSelection()
    }

    @objc public func duplicate(_ sender: Any?) {
        duplicateSelection()
    }

    @objc public override func selectAll(_ sender: Any?) {
        selectAllClips()
    }

    @objc public func delete(_ sender: Any?) {
        deleteSelection()
    }

    // MARK: - Scroll & Zoom

    public override func scrollWheel(with event: NSEvent) {
        if event.modifierFlags.contains(.command) {
            // Horizontal zoom with Cmd+scroll — centered on the mouse cursor
            let zoomFactor: CGFloat = event.scrollingDeltaY > 0 ? 1.035 : 0.967
            let oldPPB = pixelsPerBeat
            let newPPB = min(DreamTheme.maxPixelsPerBeat, max(DreamTheme.minPixelsPerBeat, oldPPB * zoomFactor))
            guard newPPB != oldPPB else { return }

            // Get mouse position in view coordinates
            let location = convert(event.locationInWindow, from: nil)
            let currentScrollX = enclosingScrollView?.contentView.bounds.origin.x ?? 0
            
            // Anchor beat: The DAW position (in beats) at the mouse cursor
            let mouseBeat = (location.x) / oldPPB
            let mouseScreenX = location.x - currentScrollX

            // Calculate new scroll X to keep the same beat at the same screen position
            let newScrollX = (mouseBeat * newPPB) - mouseScreenX
            
            // JITTER FIX: Render immediately with PREDICTED scroll position and PPB
            // This prevents "oscillation" where Metal renders with new scale but old scroll
            let currentScrollY = self.enclosingScrollView?.contentView.bounds.origin.y ?? 0
            let projectedRect = CGRect(x: newScrollX, y: currentScrollY, width: self.enclosingScrollView?.contentView.bounds.width ?? self.bounds.width, height: self.enclosingScrollView?.contentView.bounds.height ?? self.bounds.height)
            
            // Force granular update with explicit overrides
            updateArrangementLayers(fullRedraw: false, visibleRectOverride: projectedRect, pixelsPerBeatOverride: newPPB)
            
            // Route through host so ruler stays in sync (eventually consistent)
            onZoomChanged?(newPPB, newScrollX)
        } else {
            // Pass to parent for normal scrolling
            super.scrollWheel(with: event)
        }
    }

    // MARK: - Drag & Drop

    public override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        let pb = sender.draggingPasteboard

        // Accept audio file URLs
        if pb.canReadObject(forClasses: [NSURL.self], options: [
            .urlReadingContentsConformToTypes: ["public.audio"]
        ]) {
            return .copy
        }

        // Accept browser items (instruments, effects)
        if pb.string(forType: .browserItem) != nil {
            return .copy
        }

        return []
    }

    public override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        let location = convert(sender.draggingLocation, from: nil)
        let pasteboard = sender.draggingPasteboard
        
        // Find target track and Snap to grid
        var yOffset: CGFloat = 0
        var targetTrack: Track?
        for track in project?.tracks ?? [] {
            if location.y >= yOffset && location.y < yOffset + track.height {
                targetTrack = track
                break
            }
            yOffset += track.height
        }
        
        guard let track = targetTrack, track.trackType == .audio else {
            ghostClipLayer.isHidden = true
            return []
        }
        
        // Calculate beat position
        let beat = max(0, Double(location.x) / Double(pixelsPerBeat))
        let snappedBeat = floor(beat * 4) / 4 // Snap to 16th notes for ghost
        
        // Update Ghost Layer
        ghostClipLayer.isHidden = false
        let ghostWidth: CGFloat = 100 // Default or actual if known
        ghostClipLayer.frame = CGRect(x: CGFloat(snappedBeat) * pixelsPerBeat, y: yOffset, width: ghostWidth, height: track.height)
        ghostClipLayer.backgroundColor = track.color.nsColor.withAlphaComponent(0.3).cgColor
        
        return .copy
    }
    
    public override func draggingExited(_ sender: NSDraggingInfo?) {
        ghostClipLayer.isHidden = true
    }

    public override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        ghostClipLayer.isHidden = true
        guard let project = project else { return false }

        let pasteboard = sender.draggingPasteboard
        let location = convert(sender.draggingLocation, from: nil)

        // Determine target track index from Y position
        var yOffset: CGFloat = 0
        var targetTrackIndex = 0
        for (index, track) in project.allVisibleTracks.enumerated() {
            if location.y >= yOffset && location.y < yOffset + track.height {
                targetTrackIndex = index
                break
            }
            yOffset += track.height
        }
        guard targetTrackIndex < project.allVisibleTracks.count else { return false }
        let track = project.allVisibleTracks[targetTrackIndex]


        // CASE 1: Browser item drop (instruments, effects)
        if let payload = pasteboard.string(forType: .browserItem) {
            let parts = payload.split(separator: ":", maxSplits: 1)
            guard parts.count == 2 else { return false }
            let nodeType = String(parts[0])
            let itemName = String(parts[1])
            onBrowserItemDropped?(track.id, nodeType, itemName, nil)
            self.updateArrangementLayers()
            return true
        }

        // CASE 2: Audio file URL drop
        guard let urls = pasteboard.readObjects(forClasses: [NSURL.self], options: [
            .urlReadingContentsConformToTypes: ["public.audio"]
        ]) as? [URL], let firstURL = urls.first else {
            return false
        }

        // Genius Move: If dropped on a MIDI track, trigger the Auto-Sampler workflow
        if track.trackType == .midi {
            onBrowserItemDropped?(track.id, "audioFile", firstURL.lastPathComponent, firstURL)
            return true
        }

        guard track.trackType == .audio else { return false }

        let beat = max(0, Double(location.x) / Double(pixelsPerBeat))
        var beatPosition = beat
        
        // Track auto-renaming logic (Enterprise Perfection)
        let isDefaultName = track.name.hasPrefix("Audio") || track.name.hasPrefix("Audio Track")
        if track.isEmpty && isDefaultName, let firstURL = urls.first {
            track.name = firstURL.deletingPathExtension().lastPathComponent
        }

        for url in urls {
            // Get actual audio duration using AVFoundation
            let asset = AVURLAsset(url: url)
            let durationSeconds = CMTimeGetSeconds(asset.duration)
            guard !durationSeconds.isNaN && durationSeconds > 0 else { continue }
            
            // Convert seconds to beats based on current BPM
            let bpm = project.bpm
            let clipBeats = (durationSeconds / 60.0) * bpm
            let clipDuration = TimePosition(beats: clipBeats)

            let clip = AudioClip(
                name: url.deletingPathExtension().lastPathComponent,
                fileURL: url,
                position: TimePosition(beats: beatPosition),
                duration: clipDuration,
                sourceDurationSeconds: durationSeconds
            )
            track.clips.append(clip)
            beatPosition += clip.duration.beats
        }
        
        synchronizeClips(on: track)

        self.updateArrangementLayers()
        return true
    }

    private func synchronizeClips(on track: Track) {
        guard let project = project else { return }
        let pm = PulseMap(bpm: project.bpm, sampleRate: project.sampleRate)
        for i in 0..<track.clips.count {
            track.clips[i].synchronize(with: pm)
        }
        for i in 0..<track.midiClips.count {
            track.midiClips[i].synchronize(with: pm)
        }
    }
}

internal class GridLayer: CALayer {
    var pixelsPerBeat: CGFloat = 1.0 { didSet { if oldValue != pixelsPerBeat { setNeedsDisplay() } } }
    var scrollOffset: CGFloat = 0 { didSet { if oldValue != scrollOffset { setNeedsDisplay() } } }
    var timeSignature: TimeSignature = TimeSignature() { didSet { if oldValue != timeSignature { setNeedsDisplay() } } }
    
    override init() {
        super.init()
        self.contentsScale = NSScreen.main?.backingScaleFactor ?? 2.0
        self.actions = ["position": NSNull(), "bounds": NSNull(), "frame": NSNull()]
    }
    
    override init(layer: Any) {
        super.init(layer: layer)
    }
    
    required init?(coder: NSCoder) { fatalError() }
    
    override func draw(in ctx: CGContext) {
        let beatsPerBar = timeSignature.beatsPerBar
        let vr = self.bounds
        
        // If scrollOffset is used (pinned view), we calculate visible beats based on it.
        // If scrollOffset is 0, we use bounds (document view).
        let startX = scrollOffset > 0 ? scrollOffset : vr.origin.x
        let endX = scrollOffset > 0 ? (scrollOffset + vr.width) : vr.maxX
        
        let visibleStartBeat = Double(startX) / Double(pixelsPerBeat)
        let visibleEndBeat = Double(endX) / Double(pixelsPerBeat)

        let startBar = max(0, Int(floor(visibleStartBeat / Double(beatsPerBar))))
        let endBar = Int(ceil(visibleEndBeat / Double(beatsPerBar))) + 1

        for bar in startBar...endBar {
            let barBeat = Double(bar * beatsPerBar)
            let x = CGFloat(barBeat) * pixelsPerBeat - scrollOffset

            ctx.setStrokeColor(DreamTheme.gridLineMajor.cgColor)
            ctx.setLineWidth(1)
            ctx.move(to: CGPoint(x: x, y: 0))
            ctx.addLine(to: CGPoint(x: x, y: bounds.height))
            ctx.strokePath()

            if pixelsPerBeat > 12 {
                for beat in 1..<beatsPerBar {
                    let beatX = x + CGFloat(beat) * pixelsPerBeat
                    ctx.setStrokeColor(DreamTheme.gridLine.cgColor)
                    ctx.setLineWidth(0.5)
                    ctx.move(to: CGPoint(x: beatX, y: 0))
                    ctx.addLine(to: CGPoint(x: beatX, y: bounds.height))
                    ctx.strokePath()
                }
            }

            if pixelsPerBeat > 40 {
                for beat in 0..<beatsPerBar {
                    for sub in 1..<4 {
                        let subX = x + CGFloat(beat) * pixelsPerBeat + CGFloat(sub) * pixelsPerBeat * 0.25
                        ctx.setStrokeColor(DreamTheme.gridLine.withAlphaComponent(0.3).cgColor)
                        ctx.setLineWidth(0.25)
                        ctx.move(to: CGPoint(x: subX, y: 0))
                        ctx.addLine(to: CGPoint(x: subX, y: bounds.height))
                        ctx.strokePath()
                    }
                }
            }
        }
    }
}

internal class LaneLayer: CALayer {
    var tracks: [Track] = []
    
    override init() {
        super.init()
        self.contentsScale = NSScreen.main?.backingScaleFactor ?? 2.0
        self.actions = ["position": NSNull(), "bounds": NSNull(), "frame": NSNull()]
    }
    
    override init(layer: Any) {
        super.init(layer: layer)
    }
    
    required init?(coder: NSCoder) { fatalError() }
    
    override func draw(in ctx: CGContext) {
        var yOffset: CGFloat = 0
        let visibleTracks = tracks
        for (index, track) in visibleTracks.enumerated() {
            var drawY = yOffset
            if track.trackType == .master {
                let currentBottom = yOffset + track.height
                if currentBottom < bounds.height {
                    drawY = bounds.height - track.height
                }
            }
            
            let laneRect = CGRect(x: 0, y: drawY, width: bounds.width, height: track.height)
            let bgColor = index % 2 == 0 ? DreamTheme.bgSecondary : DreamTheme.bgTertiary
            ctx.setFillColor(bgColor.cgColor)
            ctx.fill(laneRect)

            ctx.setStrokeColor(DreamTheme.divider.cgColor)
            ctx.setLineWidth(0.5)
            ctx.move(to: CGPoint(x: 0, y: drawY + track.height - 0.5))
            ctx.addLine(to: CGPoint(x: bounds.width, y: drawY + track.height - 0.5))
            ctx.strokePath()

            if track.isMuted {
                ctx.setFillColor(NSColor.black.withAlphaComponent(0.3).cgColor)
                ctx.fill(laneRect)
            }
            yOffset += track.height
        }
    }
}

// MARK: - Specialized Clip Layers

internal class AudioClipLayer: CALayer {
    var clip: AudioClip? {
        didSet {
            setNeedsDisplay()
        }
    }
    var track: Track?
    var pixelsPerBeat: CGFloat = 1.0
    var bpm: Double = 120.0
    var sampleRate: Double = 44100.0
    var waveformRenderer: WaveformRenderer?
    var metalWaveformRenderer: WaveformMetalRenderer?

    // GPU Layer for waveforms
    private let metalWaveformLayer = CAMetalLayer()

    // Waveform cache for 120Hz ProMotion performance
    private var cachedWaveform: CGImage?
    private var cachedSize: CGSize = .zero
    private var cachedClipID: UUID?
    private var cachedPPB: CGFloat = 0

    override init() {
        super.init()
        self.contentsScale = NSScreen.main?.backingScaleFactor ?? 2.0
        self.contentsGravity = .resize
        self.actions = ["position": NSNull(), "bounds": NSNull(), "frame": NSNull()]
        
        // Setup Metal Layer
        metalWaveformLayer.contentsScale = self.contentsScale
        metalWaveformLayer.opacity = 0.8
        metalWaveformLayer.isOpaque = false
        metalWaveformLayer.actions = self.actions
        self.addSublayer(metalWaveformLayer)
    }

    override init(layer: Any) {
        super.init(layer: layer)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func draw(in ctx: CGContext) {
        guard let clip = clip, let track = track else { return }
        let trackColor = track.color.nsColor
        let rect = self.bounds

        ctx.saveGState()

        // Clip body (rounded rect)
        let clipPath = CGPath(roundedRect: rect, cornerWidth: DreamTheme.clipCornerRadius, cornerHeight: DreamTheme.clipCornerRadius, transform: nil)
        ctx.addPath(clipPath)
        ctx.clip()

        // Background fill
        let bodyColor = trackColor.withAlphaComponent(0.3)
        ctx.setFillColor(bodyColor.cgColor)
        ctx.fill(rect)

        // Title bar
        let titleRect = CGRect(x: 0, y: 0, width: rect.width, height: DreamTheme.clipTitleHeight)
        ctx.setFillColor(trackColor.withAlphaComponent(0.6).cgColor)
        ctx.fill(titleRect)

        // Clip name text
        let clipName = clip.name
        
        // Dynamic Contrast
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        track.color.nsColor.getRed(&r, green: &g, blue: &b, alpha: &a)
        let luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
        let textColor = luminance > 0.5 ? NSColor.black : NSColor.white
        
        let attrs: [NSAttributedString.Key: Any] = [
            .font: DreamTheme.fontSmall,
            .foregroundColor: textColor
        ]
        let attrString = NSAttributedString(string: clipName, attributes: attrs)
        let textRect = CGRect(x: 4, y: 2, width: rect.width - 8, height: DreamTheme.clipTitleHeight)
        
        // AppKit drawing in layer context
        NSGraphicsContext.saveGraphicsState()
        let nctx = NSGraphicsContext(cgContext: ctx, flipped: true)
        NSGraphicsContext.current = nctx
        attrString.draw(in: textRect)
        NSGraphicsContext.restoreGraphicsState()

        // Waveform - use Metal if available, else fallback to CG
        if let renderer = metalWaveformRenderer, let waveCache = waveformRenderer?.waveformCache {
            let waveformHeight = rect.height - DreamTheme.clipTitleHeight
            metalWaveformLayer.frame = CGRect(x: 0, y: DreamTheme.clipTitleHeight, width: rect.width, height: waveformHeight)
            
            // Try to get cached multi-band data
            if let data = waveCache.getCachedMultiBandWaveform(for: clip.fileURL, samplesPerPixel: Int(sampleRate / Double(pixelsPerBeat))) {
                renderer.render(clip: clip, data: data, in: metalWaveformLayer, color: trackColor, verticalScale: track.volume)
            } else {
                // Fallback to legcy renderer draw while data is loading
                waveformRenderer?.drawWaveform(in: ctx, clip: clip, rect: rect, color: trackColor, pixelsPerBeat: pixelsPerBeat, bpm: bpm, sampleRate: sampleRate, verticalScale: track.volume)
            }
        } else if let renderer = waveformRenderer {
            // Legacy Core Graphics path
            renderer.drawWaveform(in: ctx, clip: clip, rect: rect, color: trackColor, pixelsPerBeat: pixelsPerBeat, bpm: bpm, sampleRate: sampleRate, verticalScale: track.volume)
        }

        ctx.restoreGState()

        // Clip border
        ctx.setStrokeColor(trackColor.withAlphaComponent(0.5).cgColor)
        ctx.setLineWidth(0.5)
        ctx.addPath(clipPath)
        ctx.strokePath()

        // Selection border
        if clip.isSelected {
            ctx.setStrokeColor(NSColor.white.withAlphaComponent(0.55).cgColor)
            ctx.setLineWidth(1.5)
            ctx.addPath(clipPath)
            ctx.strokePath()
        }
    }
}

internal class MidiClipLayer: CALayer {
    var midiClip: MidiClip?
    var trackColor: NSColor = .systemBlue

    override init() {
        super.init()
        self.contentsScale = NSScreen.main?.backingScaleFactor ?? 2.0
        self.actions = ["position": NSNull(), "bounds": NSNull(), "frame": NSNull()]
    }

    override init(layer: Any) {
        super.init(layer: layer)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func draw(in ctx: CGContext) {
        guard let clip = midiClip else { return }
        let rect = self.bounds
        let color = clip.colorOverride?.nsColor ?? trackColor

        ctx.saveGState()

        // Clip body (rounded rect)
        let clipPath = CGPath(roundedRect: rect, cornerWidth: DreamTheme.clipCornerRadius, cornerHeight: DreamTheme.clipCornerRadius, transform: nil)
        ctx.addPath(clipPath)
        ctx.clip()

        // Background fill
        ctx.setFillColor(color.withAlphaComponent(0.25).cgColor)
        ctx.fill(rect)

        // Title bar
        let titleRect = CGRect(x: 0, y: 0, width: rect.width, height: DreamTheme.clipTitleHeight)
        ctx.setFillColor(color.withAlphaComponent(0.55).cgColor)
        ctx.fill(titleRect)

        // Clip name
        let clipName = "♪ \(clip.name)"
        
        // Dynamic Contrast
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        color.getRed(&r, green: &g, blue: &b, alpha: &a)
        let luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
        let textColor = luminance > 0.5 ? NSColor.black : NSColor.white

        let attrs: [NSAttributedString.Key: Any] = [
            .font: DreamTheme.fontSmall,
            .foregroundColor: textColor
        ]
        let attrString = NSAttributedString(string: clipName, attributes: attrs)
        let textRect = CGRect(x: 4, y: 2, width: rect.width - 8, height: DreamTheme.clipTitleHeight)
        
        NSGraphicsContext.saveGraphicsState()
        let nctx = NSGraphicsContext(cgContext: ctx, flipped: true)
        NSGraphicsContext.current = nctx
        attrString.draw(in: textRect)
        NSGraphicsContext.restoreGraphicsState()

        // Piano roll preview
        let noteAreaRect = CGRect(x: 0, y: DreamTheme.clipTitleHeight, width: rect.width, height: rect.height - DreamTheme.clipTitleHeight)
        drawMidiNotes(ctx: ctx, in: noteAreaRect, clip: clip, color: color)

        ctx.restoreGState()

        // Clip border
        ctx.setStrokeColor(color.withAlphaComponent(0.5).cgColor)
        ctx.setLineWidth(0.5)
        ctx.addPath(clipPath)
        ctx.strokePath()

        if clip.isSelected {
            ctx.setStrokeColor(NSColor.white.withAlphaComponent(0.55).cgColor)
            ctx.setLineWidth(1.5)
            ctx.addPath(clipPath)
            ctx.strokePath()
        }
    }

    private func drawMidiNotes(ctx: CGContext, in rect: CGRect, clip: MidiClip, color: NSColor) {
        // Implementation from TimelineCanvasView...
        let notes = clip.notes
        guard !notes.isEmpty else { return }

        let minPitch = notes.map { $0.pitch }.min() ?? 36
        let maxPitch = notes.map { $0.pitch }.max() ?? 84
        let pitchRange = max(12, maxPitch - minPitch + 4)
        let basePitch = minPitch - 2

        ctx.setFillColor(color.withAlphaComponent(0.7).cgColor)

        for note in notes {
            let noteX = CGFloat(note.position.beats) * (rect.width / CGFloat(clip.duration.beats))
            let noteW = CGFloat(note.duration.beats) * (rect.width / CGFloat(clip.duration.beats))
            let normalizedPitch = CGFloat(note.pitch - basePitch) / CGFloat(pitchRange)
            let noteH: CGFloat = 2.0
            let noteY = rect.origin.y + rect.height - (normalizedPitch * rect.height) - noteH

            ctx.fill(CGRect(x: noteX, y: noteY, width: noteW, height: noteH))
        }
    }
}
