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
        self.layer?.addSublayer(clipContainerLayer)
        self.layer?.addSublayer(cursorLayer)
        self.layer?.addSublayer(cursorHandleLayer)
        self.layer?.addSublayer(playheadLayer)
        self.layer?.addSublayer(selectionRectLayer)
        
        // Ghost Preview Setup
        ghostClipLayer.isHidden = true
        ghostClipLayer.opacity = 0.5
        ghostClipLayer.borderWidth = 1.0
        ghostClipLayer.borderColor = NSColor.white.withAlphaComponent(0.5).cgColor
        ghostClipLayer.cornerRadius = DreamTheme.clipCornerRadius
        self.layer?.addSublayer(ghostClipLayer)
        
        // Initial setup for static elements
        cursorLayer.zPosition = 100
        cursorLayer.backgroundColor = NSColor.white.cgColor
        cursorHandleLayer.zPosition = 101
        cursorHandleLayer.fillColor = NSColor.white.cgColor
        playheadLayer.backgroundColor = NSColor.systemRed.cgColor
        
        setupCursorAnimation()
        setupDropIndicator()
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

    private func finalizeMarqueeSelection(rect: CGRect) {
        guard let project = project else { return }
        
        // Small threshold for "single click" vs "drag selection"
        if rect.width < 2 && rect.height < 2 {
            // It's effectively a click.
            //mouseDown already set the editCursor and playhead.
            return
        }
        
        // Convert screen rect to project coordinates (Beats + Tracks)
        let minBeat = Double(rect.minX) / Double(pixelsPerBeat)
        let maxBeat = Double(rect.maxX) / Double(pixelsPerBeat)
        
        // Determine tracks covered
        var tracksInRange: [Int] = []
        var yOffset: CGFloat = 0
        let visibleTracks = project.allVisibleTracks.filter { $0.trackType != .master }
        for (index, track) in visibleTracks.enumerated() {
            let trackRect = CGRect(x: 0, y: yOffset, width: bounds.width, height: track.height)
            if rect.intersects(trackRect) {
                tracksInRange.append(index)
            }
            yOffset += track.height
        }
        
        if tracksInRange.isEmpty { return }
        
        let minY = Double(tracksInRange.min()!)
        let maxY = Double(tracksInRange.max()! + 1)
        
        // Query QuadTree
        let queryRange = QuadRect(minX: minBeat, maxX: maxBeat, minY: minY, maxY: maxY)
        let elements = quadTree?.query(range: queryRange) ?? []
        
        // Apply Selection
        if !NSEvent.modifierFlags.contains(.shift) {
            deselectAllClips(in: project)
        }
        
        for element in elements {
            let wrapper = element.value
            selectClip(id: wrapper.id, isMidi: wrapper.isMidi, in: project)
            onClipSelected?(wrapper.trackID, wrapper.id)
        }
        
        updateArrangementLayers()
    }

    // MARK: - Properties

    public var project: Project? {
        didSet {
            setupSubscriptions()
            updateArrangementLayers()
        }
    }

    private var cancellables = Set<AnyCancellable>()

    public var pixelsPerBeat: CGFloat = DreamTheme.defaultPixelsPerBeat {
        didSet { 
            rebuildQuadTree() // Rebuild when zoom changes as track layout might shift
            updateArrangementLayers()
        }
    }

    /// Scroll offset — kept for API compatibility but no longer used for drawing.
    /// Drawing uses document coordinates; the NSScrollView handles viewport clipping.
    public var scrollOffset: CGPoint = .zero

    public var playheadPosition: TimePosition = .zero {
        didSet { updatePlayheadLayer(project: project) }
    }

    public var waveformRenderer: WaveformRenderer?

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
    /// Parameters: (trackID, nodeType, itemName)
    public var onBrowserItemDropped: ((UUID, String, String) -> Void)?

    /// Callback when zoom level changes (pixelsPerBeat, newScrollX).
    /// Host must update ruler and layout to keep everything in sync.
    public var onZoomChanged: ((CGFloat, CGFloat) -> Void)?

    /// Callback when clips are modified (moved, resized, deleted, or added).
    /// Host should refresh playback if currently running.
    public var onClipsModified: (() -> Void)?

    /// Reference to the application's undo/redo history for recording actions.
    /// Reference to the arrangement orchestrator for complex operations.
    public var orchestrator: ArrangementOrchestrator?

    /// Currently dragged clip info for move operations.
    private var dragState: DragState?

    /// Currently resizing clip info.
    private var resizeState: ResizeState?

    /// Marquee selection state.
    private struct MarqueeState {
        let startLocation: CGPoint
        var currentRect: CGRect = .zero
        var trackIndices: [Int] = []
        var timeRange: ClosedRange<Double>?
    }
    private var marqueeState: MarqueeState?

    /// The editing cursor (blue line).
    public var editCursor: EditCursor? {
        didSet {
            updateArrangementLayers()
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
    private struct ClipWrapper: Identifiable {
        let id: UUID
        let trackID: UUID
        let isMidi: Bool
        let audioClip: AudioClip?
        let midiClip: MidiClip?
    }

    /// QuadTree for fast spatial queries (hit-testing and culling).
    private var quadTree: QuadTree<ClipWrapper>?

    // MARK: - Reactive Subscriptions

    private func setupSubscriptions() {
        // Cancel any existing subscriptions
        cancellables.removeAll()

        guard let project = project else { return }

        // 1. Project-level changes (Name, Loop, BPM, etc.)
        project.objectWillChange
            .sink { [weak self] _ in
                self?.rebuildQuadTree()
                self?.updateArrangementLayers()
            }
            .store(in: &cancellables)

        // 2. Track list changes
        // When the array reference changes, re-subscribe to individual tracks
        project.$tracks
            .sink { [weak self] tracks in
                self?.subscribeToTracks(tracks)
                self?.rebuildQuadTree()
                self?.updateArrangementLayers()
            }
            .store(in: &cancellables)
            
        // 3. Master track changes
        project.masterTrack.objectWillChange
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
            // Observe each track for volume, pan, mute, solo changes
            track.objectWillChange
                .sink { [weak self] _ in
                    self?.rebuildQuadTree() // In case tracks moved/resized
                    self?.updateArrangementLayers()
                }
                .store(in: &cancellables)
        }
    }

    /// Rebuilds the spatial index (QuadTree) from the current project state.
    private func rebuildQuadTree() {
        guard let project = project else {
            quadTree = nil
            return
        }

        // Define the boundary: very large duration (e.g., 10k beats) and all tracks.
        let visibleTracks = project.allVisibleTracks
        let boundary = QuadRect(minX: 0, maxX: 10000, minY: 0, maxY: Double(max(1, visibleTracks.count)))
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

    public func updateArrangementLayers() {
        guard let project = project else { return }
        
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        
        updateGridLayer(project: project)
        updateLaneLayers(project: project)
        updateClipLayers(project: project)
        updateCursorLayer(project: project)
        updatePlayheadLayer(project: project)
        
        selectionRectLayer.frame = self.bounds // Ensure marquee layer covers whole area
        updateMarqueeLayer(project: project)
        
        CATransaction.commit()
    }

    private func updateGridLayer(project: Project) {
        gridLayer.frame = self.bounds
        gridLayer.pixelsPerBeat = pixelsPerBeat
        gridLayer.timeSignature = project.timeSignature
        gridLayer.setNeedsDisplay()
    }

    private func updateLaneLayers(project: Project) {
        laneContainerLayer.frame = self.bounds
        laneContainerLayer.tracks = project.allVisibleTracks.filter { $0.trackType != .master }
        laneContainerLayer.setNeedsDisplay()
    }

    private func updatePlayheadLayer(project: Project?) {
        guard let _ = project else { return }
        let x = CGFloat(playheadPosition.beats) * pixelsPerBeat
        
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
        let queryRect = QuadRect(minX: minBeat - 4.0, maxX: maxBeat + 4.0, 
                                 minY: 0, maxY: Double(visibleTracks.count))
        
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
                
                // Only update and redraw if something changed
                if layer.frame != newFrame || layer.clip?.position != clip.position || layer.clip?.duration != clip.duration || layer.clip?.isSelected != clip.isSelected {
                    layer.clip = clip
                    layer.track = track
                    layer.pixelsPerBeat = pixelsPerBeat
                    layer.bpm = project.bpm
                    layer.sampleRate = project.sampleRate
                    layer.waveformRenderer = waveformRenderer
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
                
                if layer.frame != newFrame || layer.midiClip?.position != clip.position || layer.midiClip?.duration != clip.duration || layer.midiClip?.isSelected != clip.isSelected {
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
    
    private func updateCursorLayer(project: Project) {
        guard let cursor = editCursor else {
            cursorLayer.isHidden = true
            cursorHandleLayer.isHidden = true
            return
        }
        
        cursorLayer.isHidden = false
        cursorHandleLayer.isHidden = false
        
        // Find track Y position
        var yOffset: CGFloat = 0
        var trackHeight: CGFloat = 0
        var found = false
        
        let visibleTracks = project.allVisibleTracks
        for track in visibleTracks {
            if track.id == cursor.trackID {
                trackHeight = track.height
                found = true
                break
            }
            yOffset += track.height
        }
        
        guard found else {
            cursorLayer.isHidden = true
            cursorHandleLayer.isHidden = true
            return
        }
        
        let x = CGFloat(cursor.position.beats) * pixelsPerBeat
        
        // Update frames (use CATransaction to disable implicit animations for position/bounds)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        cursorLayer.frame = CGRect(x: x - 0.75, y: yOffset, width: 1.5, height: trackHeight)
        
        // Triangle Handle
        let path = CGMutablePath()
        path.move(to: CGPoint(x: x - 4, y: yOffset))
        path.addLine(to: CGPoint(x: x + 4, y: yOffset))
        path.addLine(to: CGPoint(x: x, y: yOffset + 5))
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
        
        if let edgeHit = hitTestClipEdge(at: location, project: project, zone: edgeHitZoneLarge) {
            if edgeHit.edge == .left {
                leftBracketCursor.set()
            } else {
                rightBracketCursor.set()
            }
        } else {
            // Check if on a clip body
            if let _ = hitTestClipBody(at: location, project: project) {
                NSCursor.arrow.set()
            } else {
                // Empty space: crosshair for marquee
                NSCursor.crosshair.set()
            }
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
        let isShift = modifierFlags.contains(.shift)

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
    private struct EdgeHit {
        let trackID: UUID
        let clipID: UUID
        let isMidi: Bool
        let edge: ClipEdge
        let clipPosition: Double
        let clipDuration: Double
        let clipTrim: Double  // beats
    }

    private func hitTestClipEdge(at location: NSPoint, project: Project, zone: CGFloat? = nil) -> EdgeHit? {
        let currentZone = zone ?? edgeHitZone
        let beat = Double(location.x) / Double(pixelsPerBeat)
        let queryWindowBeats = Double(currentZone * 2) / Double(pixelsPerBeat)
        
        // Find track under mouse to narrow spatial search
        var currentY: CGFloat = 0
        var trackIndexUnderMouse: Int?
        var trackUnderMouse: Track?
        
        let visibleTracks = project.allVisibleTracks
        for (i, t) in visibleTracks.enumerated() {
            if location.y >= currentY && location.y < currentY + t.height {
                trackIndexUnderMouse = i
                trackUnderMouse = t
                break
            }
            currentY += t.height
        }
        
        guard let trackIndex = trackIndexUnderMouse, let track = trackUnderMouse else { return nil }
        
        // Query QuadTree around the click
        let queryRect = QuadRect(
            minX: beat - queryWindowBeats,
            maxX: beat + queryWindowBeats,
            minY: Double(trackIndex),
            maxY: Double(trackIndex + 1)
        )
        
        let candidates = quadTree?.query(range: queryRect) ?? []
        for element in candidates {
            let wrapper = element.value
            guard wrapper.trackID == track.id else { continue }
            
            let clipPos: Double
            let clipDur: Double
            let clipTrim: Double
            
            if let ac = wrapper.audioClip {
                clipPos = ac.position.beats
                clipDur = ac.duration.beats
                clipTrim = ac.trimStartOffset.beats
            } else if let mc = wrapper.midiClip {
                clipPos = mc.position.beats
                clipDur = mc.duration.beats
                clipTrim = 0
            } else { continue }
            
            let clipX = CGFloat(clipPos) * pixelsPerBeat
            let clipWidth = CGFloat(clipDur) * pixelsPerBeat
            
            // X-only check for edge proximity within the track row
            if abs(location.x - clipX) <= currentZone {
                return EdgeHit(trackID: track.id, clipID: wrapper.id, isMidi: wrapper.isMidi,
                               edge: .left, clipPosition: clipPos, clipDuration: clipDur, clipTrim: clipTrim)
            }
            if abs(location.x - (clipX + clipWidth)) <= currentZone {
                return EdgeHit(trackID: track.id, clipID: wrapper.id, isMidi: wrapper.isMidi,
                               edge: .right, clipPosition: clipPos, clipDuration: clipDur, clipTrim: clipTrim)
            }
        }
        
        return nil
    }
    
    private func hitTestClipBody(at location: NSPoint, project: Project) -> (Track, ClipWrapper)? {
        let beat = Double(location.x) / Double(pixelsPerBeat)
        
        var currentY: CGFloat = 0
        for (i, t) in project.allVisibleTracks.enumerated() {
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

    // MARK: - Selection Helpers

    /// Deselect all clips across all tracks.
    private func deselectAllClips(in project: Project) {
        for track in project.allVisibleTracks {
            for i in track.clips.indices { track.clips[i].isSelected = false }
            for i in track.midiClips.indices { track.midiClips[i].isSelected = false }
        }
    }

    /// Select a specific clip by ID.
    private func selectClip(id: UUID, isMidi: Bool, in project: Project) {
        for track in project.allVisibleTracks {
            if isMidi {
                if let idx = track.midiClips.firstIndex(where: { $0.id == id }) {
                    track.midiClips[idx].isSelected = true
                    updateArrangementLayers()
                    return
                }
            } else {
                if let idx = track.clips.firstIndex(where: { $0.id == id }) {
                    track.clips[idx].isSelected = true
                    updateArrangementLayers()
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

        let location = convert(event.locationInWindow, from: nil)
        let rawBeat = Double(location.x) / Double(pixelsPerBeat)
        
        // Use snapping for placement
        let snapInterval: Double = pixelsPerBeat > 40 ? 0.25 : 1.0
        let clickBeat = (rawBeat / snapInterval).rounded() * snapInterval
        
        // Find track under mouse
        var yOffset: CGFloat = 0
        var clickedTrackID: UUID?
        for track in project.allVisibleTracks {
            if location.y >= yOffset && location.y < yOffset + track.height {
                clickedTrackID = track.id
                break
            }
            yOffset += track.height
        }
        // Set initial Edit Cursor (on clicked track) - but we might clear it if we hit a header
        var initialEditCursor: EditCursor? = nil
        if let trackID = clickedTrackID {
            initialEditCursor = EditCursor(trackID: trackID, position: TimePosition(beats: max(0, clickBeat)))
            onTrackClicked?(trackID)
        }

        // Double-click
        if event.clickCount == 2 {
            handleDoubleClick(at: location, beat: clickBeat, project: project)
            return
        }

        // 1. Edge resize hit test (Highest Priority)
        let edgeHitZoneLarge: CGFloat = edgeHitZone + 4
        if let edgeHit = hitTestClipEdge(at: location, project: project, zone: edgeHitZoneLarge) {
            resizeState = ResizeState(
                trackID: edgeHit.trackID,
                clipID: edgeHit.clipID,
                isMidi: edgeHit.isMidi,
                edge: edgeHit.edge,
                startMouseX: location.x,
                originalPosition: edgeHit.clipPosition,
                originalDuration: edgeHit.clipDuration,
                originalTrim: edgeHit.clipTrim
            )
            // Visual feedback: Use custom bracket cursors
            if edgeHit.edge == .left { leftBracketCursor.set() } else { rightBracketCursor.set() }
            
            // DUAL-ACTION: Set playhead even when hitting an edge for resizing
            editCursor = initialEditCursor
            
            if !event.modifierFlags.contains(.shift) {
                deselectAllClips(in: project)
            }
            selectClip(id: edgeHit.clipID, isMidi: edgeHit.isMidi, in: project)
            updateArrangementLayers()
            return
        }

        // 2. Clip Body Interaction (Movement / Selection)
        if let (track, wrapper) = hitTestClipBody(at: location, project: project) {
            let isSelected = wrapper.audioClip?.isSelected ?? wrapper.midiClip?.isSelected ?? false
            
            // Re-calculate clip rect for header check
            let clipPos = wrapper.audioClip?.position.beats ?? wrapper.midiClip?.position.beats ?? 0
            let clipDur = wrapper.audioClip?.duration.beats ?? wrapper.midiClip?.duration.beats ?? 0
            let clipX = CGFloat(clipPos) * pixelsPerBeat
            let clipWidth = CGFloat(clipDur) * pixelsPerBeat
            
            var targetY: CGFloat = 0
            for t in project.allVisibleTracks {
                if t.id == track.id { break }
                targetY += t.height
            }
            
            let titleRect = CGRect(x: clipX, y: targetY, width: clipWidth, height: DreamTheme.clipTitleHeight)
            
            if titleRect.contains(location) {
                // Header Click: Movement / Multi-selection
                marqueeState = nil
                CATransaction.begin()
                CATransaction.setDisableActions(true)
                selectionRectLayer.isHidden = true
                selectionRectLayer.path = nil
                CATransaction.commit()

                editCursor = nil // CRITICAL: Clear cursor if we hit a header
                NSCursor.arrow.set()
                
                if !isSelected {
                    if !event.modifierFlags.contains(.shift) {
                        deselectAllClips(in: project)
                    }
                    selectClip(id: wrapper.id, isMidi: wrapper.isMidi, in: project)
                }
                
                dragState = DragState(
                    trackID: track.id,
                    clipID: wrapper.id,
                    isMidi: wrapper.isMidi,
                    startMousePosition: location,
                    originalClipBeat: clipPos
                )
            } else {
                // Body Click: Set Edit Cursor for playback point
                marqueeState = nil
                selectionRectLayer.isHidden = true
                
                editCursor = initialEditCursor // Apply the cursor if we hit the body
                NSCursor.arrow.set()
                
                if !isSelected {
                    if !event.modifierFlags.contains(.shift) {
                        deselectAllClips(in: project)
                    }
                    selectClip(id: wrapper.id, isMidi: wrapper.isMidi, in: project)
                }
            }
            
            updateArrangementLayers()
            onClipSelected?(track.id, wrapper.id)
            return
        }

        // 3. Marquee Selection / Empty Space Click (Lowest Priority)
        
        // PREVENT accidental marquee: If the mouse just clicked on ANY track that has clips,
        // and we are within 50px of any clip, maybe we shouldn't start a marquee immediately?
        // Actually, DAWs allow marquee in "true" empty space.
        // Let's just ensure Step 1 and 2 are robust.
        
        if !event.modifierFlags.contains(.shift) {
            deselectAllClips(in: project)
        }
        
        // Clear previous selection graphic (Mode 3)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        selectionRectLayer.isHidden = true
        selectionRectLayer.path = nil
        CATransaction.commit()
        
        // Mode 3: Start fresh Marquee only on truly empty space
        marqueeState = MarqueeState(startLocation: location)
        
        // Mode 1: Update Edit Cursor to the clicked location
        let snappedPos = TimePosition(beats: max(0, clickBeat))
        editCursor = EditCursor(trackID: clickedTrackID ?? project.allVisibleTracks.first?.id ?? UUID(), position: snappedPos)
        
        onTrackClicked?(clickedTrackID ?? project.allVisibleTracks.first?.id ?? UUID())
        updateArrangementLayers()
        // redraw
    }
    
    private func updateMarqueeLayer(project: Project) {
        guard let state = marqueeState, let timeRange = state.timeRange, !state.trackIndices.isEmpty else {
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            selectionRectLayer.isHidden = true
            CATransaction.commit()
            return
        }
        
        let startX = CGFloat(timeRange.lowerBound) * pixelsPerBeat
        let endX = CGFloat(timeRange.upperBound) * pixelsPerBeat
        let width = endX - startX
        
        // Hide if width is negligible to avoid "two lines" on simple click
        if abs(width) < 1.0 {
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            selectionRectLayer.isHidden = true
            CATransaction.commit()
            return
        }
        
        var minY: CGFloat = 0
        var maxY: CGFloat = 0
        var yOffset: CGFloat = 0
        var foundIndices = false
        
        let visibleTracks = project.allVisibleTracks
        for (idx, track) in visibleTracks.enumerated() {
            if state.trackIndices.contains(idx) {
                if !foundIndices {
                    minY = yOffset
                    foundIndices = true
                }
                maxY = yOffset + track.height
            }
            yOffset += track.height
        }
        
        if !foundIndices {
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            selectionRectLayer.isHidden = true
            CATransaction.commit()
            return
        }
        
        let rect = CGRect(x: startX, y: minY, width: width, height: maxY - minY)
        
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        selectionRectLayer.path = CGPath(rect: rect, transform: nil)
        selectionRectLayer.isHidden = false
        CATransaction.commit()
    }

    /// Handle double-click: create MIDI clip on empty space of MIDI track,
    /// or open existing MIDI clip for editing.
    private func handleDoubleClick(at location: NSPoint, beat: Double, project: Project) {
        var yOffset: CGFloat = 0
        
        for track in project.allVisibleTracks {
            let laneRect = CGRect(x: 0, y: yOffset, width: bounds.width, height: track.height)
            
            if laneRect.contains(location) {
                // Check if we double-clicked on an existing MIDI clip
                for midiClip in track.midiClips {
                    let clipX = CGFloat(midiClip.position.beats) * pixelsPerBeat
                    let clipWidth = CGFloat(midiClip.duration.beats) * pixelsPerBeat
                    let clipRect = CGRect(x: clipX, y: yOffset + 2, width: clipWidth, height: track.height - 4)
                    
                    if clipRect.contains(location) {
                        // Open piano roll for this clip - ALWAYS, even on header double-click
                        onMidiClipDoubleClicked?(track.id, midiClip.id)
                        return
                    }
                }
                
                // Double-click on empty space of a MIDI track — create new MIDI clip
                if track.trackType == .midi {
                    let beatsPerBar = project.timeSignature.beatsPerBar
                    // Snap to bar boundary
                    let barIndex = Int(floor(beat / Double(beatsPerBar)))
                    let snappedBeat = Double(barIndex * beatsPerBar)
                    
                    // Check no overlap with existing clips
                    let newClipEnd = snappedBeat + Double(beatsPerBar)
                    let hasOverlap = track.midiClips.contains { clip in
                        clip.position.beats < newClipEnd && clip.endPosition.beats > snappedBeat
                    }
                    
                    if !hasOverlap {
                        let newClip = MidiClip(
                            name: "MIDI \(track.midiClips.count + 1)",
                            position: TimePosition(beats: snappedBeat),
                            duration: TimePosition(beats: Double(beatsPerBar))  // 1 bar
                        )
                        track.midiClips.append(newClip)
                        // Record undo action for the clip creation
                        let action = AddMidiClipAction(trackID: track.id, clip: newClip)
                        if let project = self.project {
                orchestrator?.actionHistory.record(action, on: project)
            }
                        updateArrangementLayers()
                    }
                }
                return
            }
            yOffset += track.height
        }
    }

    public override func mouseDragged(with event: NSEvent) {
        let location = convert(event.locationInWindow, from: nil)
        guard let project = project else { return }

        // ──── Handle Marquee Selection ────
        if let state = marqueeState {
            let dragDist = hypot(location.x - state.startLocation.x, location.y - state.startLocation.y)
            if dragDist > 5 {
                editCursor = nil // Hide cursor on marquee drag
            } else {
                // If it's a very small drag, don't show marquee yet to keep it clean
                selectionRectLayer.isHidden = true
                return
            }

            let snapInterval: Double = pixelsPerBeat > 40 ? 0.25 : 1.0
            
            let startBeat = Double(state.startLocation.x) / Double(pixelsPerBeat)
            let currBeat = Double(location.x) / Double(pixelsPerBeat)
            
            let snappedStartBeat = (startBeat / snapInterval).rounded() * snapInterval
            let snappedCurrBeat = (currBeat / snapInterval).rounded() * snapInterval
            
            let minX = min(snappedStartBeat, snappedCurrBeat) * Double(pixelsPerBeat)
            let maxX = max(snappedStartBeat, snappedCurrBeat) * Double(pixelsPerBeat)
            
            // Vertical Snapping to Track Boundaries
            var yOffset: CGFloat = 0
            var snappedMinY: CGFloat = 0
            var snappedMaxY: CGFloat = 0
            var foundStart = false
            
            let dragMinY = min(state.startLocation.y, location.y)
            let dragMaxY = max(state.startLocation.y, location.y)
            
            var trackIndicesInRange: [Int] = []
            
            for (idx, track) in project.allVisibleTracks.enumerated() {
                let trackTop = yOffset
                let trackBottom = yOffset + track.height
                
                if dragMinY < trackBottom && dragMaxY > trackTop {
                    if !foundStart {
                        snappedMinY = trackTop
                        foundStart = true
                    }
                    snappedMaxY = trackBottom
                    trackIndicesInRange.append(idx)
                }
                
                yOffset += track.height
            }
            
            // If dragging below all tracks, maxY is capped at last track bottom
            if !foundStart { snappedMinY = yOffset } // Fallback
            if snappedMaxY < snappedMinY { snappedMaxY = snappedMinY }

            let rect = CGRect(
                x: minX,
                y: snappedMinY,
                width: maxX - minX,
                height: snappedMaxY - snappedMinY
            )
            
            marqueeState?.currentRect = rect
            marqueeState?.timeRange = min(snappedStartBeat, snappedCurrBeat)...max(snappedStartBeat, snappedCurrBeat)
            marqueeState?.trackIndices = trackIndicesInRange
            
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            selectionRectLayer.isHidden = (rect.width == 0 && rect.height == 0) // Only show if area exists
            selectionRectLayer.path = CGPath(rect: rect, transform: nil)
            CATransaction.commit()
            return
        }

        // ──── Resize drag mode ────
        if let resize = resizeState { // Corrected from user's `= resizeState`
            let deltaX = location.x - resize.startMouseX
            let deltaBeat = Double(deltaX) / Double(pixelsPerBeat)
            let minDuration: Double = 1.0  // Minimum 1 beat

            for track in project.allVisibleTracks where track.id == resize.trackID {
                switch resize.edge {
                case .left:
                    // Dragging left edge: move start, keep end fixed
                    let originalEnd = resize.originalPosition + resize.originalDuration
                    let newStart = max(0, round(resize.originalPosition + deltaBeat))
                    let newDuration = originalEnd - newStart
                    guard newDuration >= minDuration else { break }

                    if resize.isMidi {
                        if let idx = track.midiClips.firstIndex(where: { $0.id == resize.clipID }) {
                            track.midiClips[idx].position = TimePosition(beats: newStart)
                            track.midiClips[idx].duration = TimePosition(beats: newDuration)
                        }
                    } else {
                        if let idx = track.clips.firstIndex(where: { $0.id == resize.clipID }) {
                            // Professional DAW Trimming (Left Edge):
                            // 1. Audio samples must remain pinned to their timeline time.
                            // 2. Cannot reveal samples before the file start (trimStartOffset >= 0).
                            
                            let deltaBeat = round(deltaBeat) // Snap trim to bars
                            let newStart = max(0, resize.originalPosition + deltaBeat)
                            let positionDelta = newStart - resize.originalPosition
                            
                            // Constraint: We can only pull LEFT (decreasing trim) if we HAVE trim available.
                            // Constraint: We can only pull RIGHT (increasing trim) as long as we don't exceed duration.
                            let newTrim = max(0, resize.originalTrim + positionDelta)
                            
                            // If we hit the file start limit (newTrim = 0), we must clamp newStart
                            let actualPositionDelta = newTrim - resize.originalTrim
                            let clampedNewStart = resize.originalPosition + actualPositionDelta
                            let newDuration = (resize.originalPosition + resize.originalDuration) - clampedNewStart
                            
                            guard newDuration >= minDuration else { break }
                            
                            track.clips[idx].position = TimePosition(beats: clampedNewStart)
                            track.clips[idx].duration = TimePosition(beats: newDuration)
                            track.clips[idx].trimStartOffset = TimePosition(beats: newTrim)
                        }
                    }

                case .right:
                    // Dragging right edge: keep start fixed, change duration
                    let newDuration = round(resize.originalDuration + deltaBeat)
                    guard newDuration >= minDuration else { break }

                    if resize.isMidi {
                        if let idx = track.midiClips.firstIndex(where: { $0.id == resize.clipID }) {
                            track.midiClips[idx].duration = TimePosition(beats: newDuration)
                        }
                    } else {
                        if let idx = track.clips.firstIndex(where: { $0.id == resize.clipID }) {
                            // Professional DAW Trimming (Right Edge):
                            // Cannot extend beyond the original audio file's duration.
                            let bpm = project.bpm
                            let sourceDurationBeats = (track.clips[idx].sourceDurationSeconds / 60.0) * bpm
                            let maxDuration = sourceDurationBeats - track.clips[idx].trimStartOffset.beats
                            
                            let requestedDuration = round(resize.originalDuration + deltaBeat)
                            let clampedDuration = max(minDuration, min(maxDuration, requestedDuration))
                            
                            track.clips[idx].duration = TimePosition(beats: clampedDuration)
                        }
                    }
                }
            }
            updateArrangementLayers()
            return
        }

        // ──── Clip move drag mode ────
        guard let drag = dragState else { return }

        let deltaX = location.x - drag.startMousePosition.x
        let deltaBeat = Double(deltaX) / Double(pixelsPerBeat)
        let unroundedBeat = drag.originalClipBeat + deltaBeat
        let snappedBeat = max(0, round(unroundedBeat))

        // Find target track under mouse
        var currentY: CGFloat = 0
        var targetTrackID: UUID?
        for track in project.allVisibleTracks {
            if location.y >= currentY && location.y < currentY + track.height {
                targetTrackID = track.id
                break
            }
            currentY += track.height
        }

        if let targetID = targetTrackID {
            // Check if track changed
            if targetID != drag.trackID {
                // Update track in project (Enterprise Move)
                orchestrator?.changeClipTrack(clipID: drag.clipID, fromTrackID: drag.trackID, toTrackID: targetID, isMidi: drag.isMidi)
                dragState = DragState(
                    trackID: targetID,
                    clipID: drag.clipID,
                    isMidi: drag.isMidi,
                    startMousePosition: drag.startMousePosition,
                    originalClipBeat: drag.originalClipBeat
                )
            }

            // Update position on the current track (snapped)
            for track in project.allVisibleTracks where track.id == targetID {
                if drag.isMidi {
                    if let idx = track.midiClips.firstIndex(where: { $0.id == drag.clipID }) {
                        track.midiClips[idx].position = TimePosition(beats: snappedBeat)
                    }
                } else {
                    if let idx = track.clips.firstIndex(where: { $0.id == drag.clipID }) {
                        track.clips[idx].position = TimePosition(beats: snappedBeat)
                    }
                }
            }
            
            rebuildQuadTree()
            updateArrangementLayers()
        }
    }

    public override func mouseUp(with event: NSEvent) {
        // ──── Finalize Marquee ────
        if let state = marqueeState {
            let dragDist = hypot(event.locationInWindow.x - convert(state.startLocation, to: nil).x, 
                                 event.locationInWindow.y - convert(state.startLocation, to: nil).y)
            
            if dragDist < 3 {
                // It was just a click, not a drag. Clear marquee so we only see the cursor.
                marqueeState = nil
                selectionRectLayer.isHidden = true
            } else {
                // Valid marquee drag. Playhead/Cursor is typically hidden during/after marquee selection
                // unless the user clicks again.
                editCursor = nil
            }
            refreshUI()
            return
        }

        // ──── Finalize Resize ────
        if let resize = resizeState, let project = project {
            let track = project.allVisibleTracks.first(where: { $0.id == resize.trackID })
            let clip = resize.isMidi ? 
                track?.midiClips.first(where: { $0.id == resize.clipID }) as Any? :
                track?.clips.first(where: { $0.id == resize.clipID }) as Any?

            if let midi = clip as? MidiClip {
                orchestrator?.finalizeClipResize(
                    id: resize.clipID,
                    trackID: resize.trackID,
                    isMidi: true,
                    oldPositionBeats: resize.originalPosition,
                    oldDurationBeats: resize.originalDuration,
                    oldTrimBeats: 0,
                    newPositionBeats: midi.position.beats,
                    newDurationBeats: midi.duration.beats,
                    newTrimBeats: 0
                )
            } else if let audio = clip as? AudioClip {
                orchestrator?.finalizeClipResize(
                    id: resize.clipID,
                    trackID: resize.trackID,
                    isMidi: false,
                    oldPositionBeats: resize.originalPosition,
                    oldDurationBeats: resize.originalDuration,
                    oldTrimBeats: resize.originalTrim,
                    newPositionBeats: audio.position.beats,
                    newDurationBeats: audio.duration.beats,
                    newTrimBeats: audio.trimStartOffset.beats
                )
            }

            NSCursor.arrow.set()
            resizeState = nil
            refreshUI()
            onClipsModified?()
            return
        }

        // ──── Clip move drag end ────
        if let drag = dragState, let project = project {
            let track = project.allVisibleTracks.first(where: { $0.id == drag.trackID })
            let clip = drag.isMidi ? 
                track?.midiClips.first(where: { $0.id == drag.clipID }) as Any? :
                track?.clips.first(where: { $0.id == drag.clipID }) as Any?

            if let midi = clip as? MidiClip {
                orchestrator?.finalizeClipMove(
                    id: drag.clipID,
                    fromTrackID: drag.trackID,
                    toTrackID: drag.trackID,
                    oldPositionBeats: drag.originalClipBeat,
                    newPositionBeats: midi.position.beats
                )
            } else if let audio = clip as? AudioClip {
                orchestrator?.finalizeClipMove(
                    id: drag.clipID,
                    fromTrackID: drag.trackID,
                    toTrackID: drag.trackID,
                    oldPositionBeats: drag.originalClipBeat,
                    newPositionBeats: audio.position.beats
                )
            }

            NSCursor.arrow.set()
            dragState = nil
            refreshUI()
            onClipsModified?()
            return
        }
    }

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
            // Only affect the track with the cursor? Or all tracks?
            // User said "strip on selected track". Implicitly focused editing.
            // Let's restrict split to the cursor track if no specific selection exists?
            // Actually, safe bet: Split ALL tracks at this time? No, that's destructive.
            // Split clips on the TRACK where the cursor is.
            guard track.id == cursor.trackID else { continue }
            
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
        for track in project.allVisibleTracks {
            for clip in track.clips where clip.isSelected {
                Self.clipboard.append(ClipboardItem(item: .audio(clip), trackID: track.id))
            }
            for clip in track.midiClips where clip.isSelected {
                Self.clipboard.append(ClipboardItem(item: .midi(clip), trackID: track.id))
            }
        }
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
        refreshUI()
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

    /// Duplicate selected clips — places copies immediately after the originals.
    public func duplicateSelection() {
        guard let project = project else { return }
        // Cmd+D usually duplicates AFTER original.
        // User said "I can insert and duplicate into that place".
        // Maybe check if cursor is set?
        // Standard D: Duplicate selection.
        // Paste always goes to cursor.
        // Let's stick to standard duplication (end of clip) unless cursor is explicitly used for "Duplicate Time"?
        // But user said "duplicate into that place". Maybe they mean Copy+Paste?
        // I'll leave Duplicate as standard (append) for now, as it's safer.
        // Wait, Ableton Duplicate (Cmd+D) puts it after.
        // Paste (Cmd+V) puts it at cursor.
        // User's request concerning Duplicate might be simpler: "I can duplicate...".
        // I will implement standard behavior for Duplicate.

        for track in project.allVisibleTracks {
            var newAudio: [AudioClip] = []
            var newMidi: [MidiClip] = []

            for clip in track.clips where clip.isSelected {
                let dupe = AudioClip(
                    name: clip.name,
                    fileURL: clip.fileURL,
                    position: TimePosition(beats: clip.endPosition.beats),
                    duration: clip.duration,
                    trimStartOffset: clip.trimStartOffset,
                    gain: clip.gain,
                    isSelected: true
                )
                newAudio.append(dupe)
            }
            for clip in track.midiClips where clip.isSelected {
                let dupe = MidiClip(
                    name: clip.name,
                    position: TimePosition(beats: clip.endPosition.beats),
                    duration: clip.duration,
                    notes: clip.notes,
                    isSelected: true,
                    colorOverride: clip.colorOverride
                )
                newMidi.append(dupe)
            }

            // Deselect originals
            for i in track.clips.indices { track.clips[i].isSelected = false }
            for i in track.midiClips.indices { track.midiClips[i].isSelected = false }

            track.clips.append(contentsOf: newAudio)
            track.midiClips.append(contentsOf: newMidi)
        }
        refreshUI()
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

            // Route through host so ruler stays in sync
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
            onBrowserItemDropped?(track.id, nodeType, itemName)
            self.updateArrangementLayers()
            return true
        }

        // CASE 2: Audio file URL drop
        guard let urls = pasteboard.readObjects(forClasses: [NSURL.self], options: [
            .urlReadingContentsConformToTypes: ["public.audio"]
        ]) as? [URL] else {
            return false
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

        self.updateArrangementLayers()
        return true
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
        for (index, track) in tracks.enumerated() {
            let laneRect = CGRect(x: 0, y: yOffset, width: bounds.width, height: track.height)
            let bgColor = index % 2 == 0 ? DreamTheme.bgSecondary : DreamTheme.bgTertiary
            ctx.setFillColor(bgColor.cgColor)
            ctx.fill(laneRect)

            ctx.setStrokeColor(DreamTheme.divider.cgColor)
            ctx.setLineWidth(0.5)
            ctx.move(to: CGPoint(x: 0, y: yOffset + track.height - 0.5))
            ctx.addLine(to: CGPoint(x: bounds.width, y: yOffset + track.height - 0.5))
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

    // Waveform cache for 120Hz ProMotion performance
    private var cachedWaveform: CGImage?
    private var cachedSize: CGSize = .zero
    private var cachedClipID: UUID?
    private var cachedPPB: CGFloat = 0

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
        let attrs: [NSAttributedString.Key: Any] = [
            .font: DreamTheme.fontSmall,
            .foregroundColor: DreamTheme.textPrimary
        ]
        let attrString = NSAttributedString(string: clipName, attributes: attrs)
        let textRect = CGRect(x: 4, y: 2, width: rect.width - 8, height: DreamTheme.clipTitleHeight)
        
        // AppKit drawing in layer context
        NSGraphicsContext.saveGraphicsState()
        let nctx = NSGraphicsContext(cgContext: ctx, flipped: true)
        NSGraphicsContext.current = nctx
        attrString.draw(in: textRect)
        NSGraphicsContext.restoreGraphicsState()

        // Waveform - use cached image if possible
        if let renderer = waveformRenderer {
            let needsNewRender = cachedWaveform == nil || cachedSize != rect.size || cachedClipID != clip.id || cachedPPB != pixelsPerBeat
            
            if needsNewRender {
                // Try to render a fresh, high-quality waveform
                let scale = self.contentsScale
                let imgSize = CGSize(width: rect.width * scale, height: rect.height * scale)
                
                if imgSize.width > 0 && imgSize.height > 0 {
                    let colorSpace = CGColorSpaceCreateDeviceRGB()
                    if let bitmapCtx = CGContext(data: nil, width: Int(imgSize.width), height: Int(imgSize.height), bitsPerComponent: 8, bytesPerRow: 0, space: colorSpace, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) {
                        bitmapCtx.scaleBy(x: scale, y: scale)
                        
                        // drawWaveform returns true if it drew from data, false if it drew a placeholder
                        let didDrawData = renderer.drawWaveform(
                            in: bitmapCtx,
                            clip: clip,
                            rect: CGRect(origin: .zero, size: rect.size),
                            color: trackColor,
                            pixelsPerBeat: pixelsPerBeat,
                            bpm: bpm,
                            sampleRate: sampleRate
                        )
                        
                        if didDrawData {
                            // Successfully rendered a new waveform from data - update cache
                            cachedWaveform = bitmapCtx.makeImage()
                            cachedSize = rect.size
                            cachedClipID = clip.id
                            cachedPPB = pixelsPerBeat
                        }
                    }
                }
            }
            
            // Draw whatever we have in cache (even if it's from a previous size/zoom)
            // ctx.draw scales it to the rect automatically, providing a "blurred" transition during zoom.
            if let img = cachedWaveform {
                ctx.draw(img, in: rect)
            }
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
        let attrs: [NSAttributedString.Key: Any] = [
            .font: DreamTheme.fontSmall,
            .foregroundColor: DreamTheme.textPrimary
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
