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

    // MARK: - Properties

    public var project: Project? {
        didSet {
            setupSubscriptions()
            needsDisplay = true
        }
    }

    private var cancellables = Set<AnyCancellable>()

    public var pixelsPerBeat: CGFloat = DreamTheme.defaultPixelsPerBeat {
        didSet { 
            needsDisplay = true 
            rebuildQuadTree() // Rebuild when zoom changes as track layout might shift
        }
    }

    /// Scroll offset — kept for API compatibility but no longer used for drawing.
    /// Drawing uses document coordinates; the NSScrollView handles viewport clipping.
    public var scrollOffset: CGPoint = .zero

    public var playheadPosition: TimePosition = .zero {
        didSet { needsDisplay = true }
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

    /// The editing cursor (blue line).
    public var editCursor: EditCursor? {
        didSet {
            // Reset animation phase on move
            needsDisplay = true
        }
    }

    /// Layer for the smooth pulsing edit cursor.
    private let cursorLayer = CALayer()
    private let cursorHandleLayer = CAShapeLayer()
    private var isCursorVisible: Bool = true


    /// Whether we're dragging the playhead (click on ruler/empty space logic can vary).


    /// Edge hit-test threshold in pixels.
    private let edgeHitZone: CGFloat = 6

    /// Tracking area for mouseMoved events (cursor changes on hover).
    private var hoverTrackingArea: NSTrackingArea?

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
                self?.needsDisplay = true
            }
            .store(in: &cancellables)

        // 2. Track list changes
        // When the array reference changes, re-subscribe to individual tracks
        project.$tracks
            .sink { [weak self] tracks in
                self?.subscribeToTracks(tracks)
                self?.rebuildQuadTree()
                self?.needsDisplay = true
            }
            .store(in: &cancellables)
            
        // Initial subscription
        subscribeToTracks(project.tracks)
    }

    private func subscribeToTracks(_ tracks: [Track]) {
        for track in tracks {
            // Observe each track for volume, pan, mute, solo changes
            track.objectWillChange
                .sink { [weak self] _ in
                    self?.rebuildQuadTree() // In case tracks moved/resized
                    self?.needsDisplay = true
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
        let boundary = QuadRect(minX: 0, maxX: 10000, minY: 0, maxY: Double(max(1, project.tracks.count)))
        let tree = QuadTree<ClipWrapper>(boundary: boundary, capacity: 12)

        for track in project.tracks {
            guard let trackIndex = project.tracks.firstIndex(where: { $0.id == track.id }) else { continue }
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

    // MARK: - Initialization

    public override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        setupUI()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        setupUI()
    }

    private func setupUI() {
        wantsLayer = true
        layer?.backgroundColor = DreamTheme.bgPrimary.cgColor
        
        // Setup Cursor Layers
        cursorLayer.zPosition = 100
        cursorLayer.backgroundColor = NSColor.white.cgColor
        layer?.addSublayer(cursorLayer)
        
        cursorHandleLayer.zPosition = 101
        cursorHandleLayer.fillColor = NSColor.white.cgColor
        layer?.addSublayer(cursorHandleLayer)
        
        setupCursorAnimation()
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
        guard let ctx = NSGraphicsContext.current?.cgContext,
              let project = project else { return }

        // Background
        ctx.setFillColor(DreamTheme.bgPrimary.cgColor)
        ctx.fill(bounds)

        // Track lane backgrounds first (opaque fills)
        drawTrackLanes(ctx: ctx, project: project)
        // Grid lines ON TOP of lanes so they are visible
        drawGridLines(ctx: ctx, project: project)
        // Clips on top of grid
        drawClips(ctx: ctx, project: project)
        drawMidiClips(ctx: ctx, project: project)
        drawMidiClips(ctx: ctx, project: project)
        updateCursorLayer(project: project)
        drawPlayhead(ctx: ctx)
        drawPlayhead(ctx: ctx)
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
        
        for track in project.tracks {
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


    // MARK: - Grid Lines

    private func drawGridLines(ctx: CGContext, project: Project) {
        let beatsPerBar = project.timeSignature.beatsPerBar
        // Use visibleRect (document coordinates) for culling
        let vr = visibleRect
        let visibleStartBeat = Double(vr.origin.x) / Double(pixelsPerBeat)
        let visibleEndBeat = Double(vr.maxX) / Double(pixelsPerBeat)

        let startBar = max(0, Int(floor(visibleStartBeat / Double(beatsPerBar))))
        let endBar = Int(ceil(visibleEndBeat / Double(beatsPerBar))) + 1

        // Draw bar lines
        for bar in startBar...endBar {
            let barBeat = Double(bar * beatsPerBar)
            let x = CGFloat(barBeat) * pixelsPerBeat

            // Major bar line
            ctx.setStrokeColor(DreamTheme.gridLineMajor.cgColor)
            ctx.setLineWidth(1)
            ctx.move(to: CGPoint(x: x, y: 0))
            ctx.addLine(to: CGPoint(x: x, y: bounds.height))
            ctx.strokePath()

            // Beat lines within bar
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

            // Subdivision lines at high zoom
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

    // MARK: - Track Lanes

    private func drawTrackLanes(ctx: CGContext, project: Project) {
        var yOffset: CGFloat = 0

        for (index, track) in project.tracks.enumerated() {
            let laneRect = CGRect(x: 0, y: yOffset, width: bounds.width, height: track.height)

            // Alternating backgrounds
            let bgColor = index % 2 == 0 ? DreamTheme.bgSecondary : DreamTheme.bgTertiary
            ctx.setFillColor(bgColor.cgColor)
            ctx.fill(laneRect)

            // Lane bottom divider
            ctx.setStrokeColor(DreamTheme.divider.cgColor)
            ctx.setLineWidth(0.5)
            ctx.move(to: CGPoint(x: 0, y: yOffset + track.height - 0.5))
            ctx.addLine(to: CGPoint(x: bounds.width, y: yOffset + track.height - 0.5))
            ctx.strokePath()

            // Muted track overlay
            if track.isMuted {
                ctx.setFillColor(NSColor.black.withAlphaComponent(0.3).cgColor)
                ctx.fill(laneRect)
            }

            yOffset += track.height
        }
    }

    // MARK: - Audio Clips

    private func drawClips(ctx: CGContext, project: Project) {
        // Query visible region
        let visibleBeatsRange = Double(visibleRect.width) / Double(pixelsPerBeat)
        let minBeat = Double(visibleRect.minX) / Double(pixelsPerBeat)
        let maxBeat = minBeat + visibleBeatsRange
        
        let queryRect = QuadRect(minX: minBeat - 1.0, maxX: maxBeat + 1.0, 
                                 minY: 0, maxY: Double(project.tracks.count))
        
        let candidates = quadTree?.query(range: queryRect) ?? []
        
        for element in candidates {
            let wrapper = element.value
            guard !wrapper.isMidi, let clip = wrapper.audioClip else { continue }
            
            guard let trackIndex = project.tracks.firstIndex(where: { $0.id == wrapper.trackID }) else { continue }
            let track = project.tracks[trackIndex]
            
            // Calculate yOffset for this track
            var trackY: CGFloat = 0
            for i in 0..<trackIndex { trackY += project.tracks[i].height }
            
            let clipX = CGFloat(clip.position.beats) * pixelsPerBeat
            let clipWidth = CGFloat(clip.duration.beats) * pixelsPerBeat
            let clipRect = CGRect(x: clipX, y: trackY + 2, width: clipWidth, height: track.height - 4)

            drawSingleClip(ctx: ctx, clip: clip, rect: clipRect, track: track, project: project)
        }
    }

    private func drawSingleClip(ctx: CGContext, clip: AudioClip, rect: CGRect, track: Track, project: Project) {
        let trackColor = track.color.nsColor

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
        let titleRect = CGRect(x: rect.origin.x, y: rect.origin.y, width: rect.width, height: DreamTheme.clipTitleHeight)
        ctx.setFillColor(trackColor.withAlphaComponent(0.6).cgColor)
        ctx.fill(titleRect)

        // Clip name text
        let clipName = clip.name
        let attrs: [NSAttributedString.Key: Any] = [
            .font: DreamTheme.fontSmall,
            .foregroundColor: DreamTheme.textPrimary
        ]
        let attrString = NSAttributedString(string: clipName, attributes: attrs)
        let textRect = CGRect(x: rect.origin.x + 4, y: rect.origin.y + 2, width: rect.width - 8, height: DreamTheme.clipTitleHeight)
        attrString.draw(in: textRect)

        // Waveform
        if let renderer = waveformRenderer {
            renderer.drawWaveform(
                in: ctx,
                clip: clip,
                rect: rect,
                color: trackColor,
                pixelsPerBeat: pixelsPerBeat,
                bpm: project.bpm,
                sampleRate: project.sampleRate
            )
        }

        ctx.restoreGState()

        // Clip border
        ctx.setStrokeColor(trackColor.withAlphaComponent(0.5).cgColor)
        ctx.setLineWidth(0.5)
        ctx.addPath(clipPath)
        ctx.strokePath()

        // Selection border — subtle white glow (drawn LAST so it's on top)
        if clip.isSelected {
            ctx.setStrokeColor(NSColor.white.withAlphaComponent(0.55).cgColor)
            ctx.setLineWidth(1.0)
            ctx.addPath(clipPath)
            ctx.strokePath()
        }

        // Edge resize bracket indicators (drawn when mouse is near edge)
        drawResizeBrackets(ctx: ctx, rect: rect)
    }

    // MARK: - MIDI Clips

    private func drawMidiClips(ctx: CGContext, project: Project) {
        // Query visible region
        let visibleBeatsRange = Double(visibleRect.width) / Double(pixelsPerBeat)
        let minBeat = Double(visibleRect.minX) / Double(pixelsPerBeat)
        let maxBeat = minBeat + visibleBeatsRange
        
        let queryRect = QuadRect(minX: minBeat - 1.0, maxX: maxBeat + 1.0, 
                                 minY: 0, maxY: Double(project.tracks.count))
        
        let candidates = quadTree?.query(range: queryRect) ?? []
        
        for element in candidates {
            let wrapper = element.value
            guard wrapper.isMidi, let clip = wrapper.midiClip else { continue }
            
            guard let trackIndex = project.tracks.firstIndex(where: { $0.id == wrapper.trackID }) else { continue }
            let track = project.tracks[trackIndex]
            
            // Calculate yOffset for this track
            var trackY: CGFloat = 0
            for i in 0..<trackIndex { trackY += project.tracks[i].height }
            
            let clipX = CGFloat(clip.position.beats) * pixelsPerBeat
            let clipWidth = CGFloat(clip.duration.beats) * pixelsPerBeat
            let clipRect = CGRect(x: clipX, y: trackY + 2, width: clipWidth, height: track.height - 4)

            drawSingleMidiClip(ctx: ctx, midiClip: clip, rect: clipRect, track: track)
        }
    }

    private func drawSingleMidiClip(ctx: CGContext, midiClip: MidiClip, rect: CGRect, track: Track) {
        let trackColor = (midiClip.colorOverride ?? track.color).nsColor

        ctx.saveGState()

        // Clip body (rounded rect)
        let clipPath = CGPath(roundedRect: rect, cornerWidth: DreamTheme.clipCornerRadius, cornerHeight: DreamTheme.clipCornerRadius, transform: nil)
        ctx.addPath(clipPath)
        ctx.clip()

        // Background fill — slightly different shade for MIDI
        ctx.setFillColor(trackColor.withAlphaComponent(0.25).cgColor)
        ctx.fill(rect)

        // Title bar
        let titleRect = CGRect(x: rect.origin.x, y: rect.origin.y, width: rect.width, height: DreamTheme.clipTitleHeight)
        ctx.setFillColor(trackColor.withAlphaComponent(0.55).cgColor)
        ctx.fill(titleRect)

        // Clip name with MIDI icon
        let clipName = "♪ \(midiClip.name)"
        let attrs: [NSAttributedString.Key: Any] = [
            .font: DreamTheme.fontSmall,
            .foregroundColor: DreamTheme.textPrimary
        ]
        let attrString = NSAttributedString(string: clipName, attributes: attrs)
        let textRect = CGRect(x: rect.origin.x + 4, y: rect.origin.y + 2, width: rect.width - 8, height: DreamTheme.clipTitleHeight)
        attrString.draw(in: textRect)

        // Draw mini note bars (piano roll preview)
        let noteAreaRect = CGRect(
            x: rect.origin.x,
            y: rect.origin.y + DreamTheme.clipTitleHeight,
            width: rect.width,
            height: rect.height - DreamTheme.clipTitleHeight
        )

        if !midiClip.notes.isEmpty {
            // Find pitch range
            let minPitch = midiClip.notes.map(\.pitch).min() ?? 60
            let maxPitch = midiClip.notes.map(\.pitch).max() ?? 72
            let pitchRange = max(1, maxPitch - minPitch)

            for note in midiClip.notes {
                let noteX = noteAreaRect.origin.x + CGFloat(note.position.beats / midiClip.duration.beats) * noteAreaRect.width
                let noteW = max(2, CGFloat(note.duration.beats / midiClip.duration.beats) * noteAreaRect.width)
                let normalizedPitch = CGFloat(note.pitch - minPitch) / CGFloat(pitchRange)
                let noteY = noteAreaRect.maxY - normalizedPitch * (noteAreaRect.height - 4) - 4
                let noteH: CGFloat = max(2, min(6, noteAreaRect.height / CGFloat(pitchRange + 2)))

                let noteRect = CGRect(x: noteX + 1, y: noteY, width: noteW - 1, height: noteH)
                let noteColor = trackColor.withAlphaComponent(0.85)
                ctx.setFillColor(noteColor.cgColor)
                let notePath = CGPath(roundedRect: noteRect, cornerWidth: 1, cornerHeight: 1, transform: nil)
                ctx.addPath(notePath)
                ctx.fillPath()
            }
        } else {
            // Empty clip — draw subtle pattern
            let emptyText = "Double-click to edit"
            let emptyAttrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 9, weight: .light),
                .foregroundColor: DreamTheme.textMuted.withAlphaComponent(0.5)
            ]
            let emptyStr = NSAttributedString(string: emptyText, attributes: emptyAttrs)
            let emptyRect = CGRect(
                x: noteAreaRect.origin.x + 4,
                y: noteAreaRect.origin.y + (noteAreaRect.height - 12) / 2,
                width: noteAreaRect.width - 8,
                height: 14
            )
            emptyStr.draw(in: emptyRect)
        }

        ctx.restoreGState()

        // Clip border
        ctx.setStrokeColor(trackColor.withAlphaComponent(0.6).cgColor)
        ctx.setLineWidth(0.5)
        ctx.addPath(clipPath)
        ctx.strokePath()

        // Selection border — subtle white glow (drawn LAST so it's on top)
        if midiClip.isSelected {
            ctx.setStrokeColor(NSColor.white.withAlphaComponent(0.55).cgColor)
            ctx.setLineWidth(1.0)
            ctx.addPath(clipPath)
            ctx.strokePath()
        }

        // Edge resize bracket indicators
        drawResizeBrackets(ctx: ctx, rect: rect)
    }

    // MARK: - Playhead

    private func drawPlayhead(ctx: CGContext) {
        let playheadX = CGFloat(playheadPosition.beats) * pixelsPerBeat
        let vr = visibleRect
        guard playheadX >= vr.origin.x - 1 && playheadX <= vr.maxX + 1 else { return }

        ctx.setStrokeColor(DreamTheme.playhead.cgColor)
        ctx.setLineWidth(DreamTheme.playheadWidth)
        ctx.move(to: CGPoint(x: playheadX, y: 0))
        ctx.addLine(to: CGPoint(x: playheadX, y: bounds.height))
        ctx.strokePath()
    }

    // MARK: - Resize Bracket Drawing

    /// Hover position for bracket indicator rendering (in view coordinates).
    private var hoverLocation: NSPoint?

    /// Draw bracket indicators `[` or `]` when the mouse is near clip edges.
    private func drawResizeBrackets(ctx: CGContext, rect: CGRect) {
        guard let hover = hoverLocation else { return }

        let bracketH: CGFloat = min(rect.height * 0.5, 20)
        let bracketW: CGFloat = 3
        let bracketInset: CGFloat = 2
        let yMid = rect.midY

        // Left edge bracket `[`
        let leftEdge = rect.minX
        if abs(hover.x - leftEdge) <= edgeHitZone && hover.y >= rect.minY && hover.y <= rect.maxY {
            ctx.setStrokeColor(NSColor.white.withAlphaComponent(0.8).cgColor)
            ctx.setLineWidth(1.5)

            let bx = leftEdge + bracketInset
            let by = yMid - bracketH / 2
            // Draw [ shape
            ctx.move(to: CGPoint(x: bx + bracketW, y: by))
            ctx.addLine(to: CGPoint(x: bx, y: by))
            ctx.addLine(to: CGPoint(x: bx, y: by + bracketH))
            ctx.addLine(to: CGPoint(x: bx + bracketW, y: by + bracketH))
            ctx.strokePath()
        }

        // Right edge bracket `]`
        let rightEdge = rect.maxX
        if abs(hover.x - rightEdge) <= edgeHitZone && hover.y >= rect.minY && hover.y <= rect.maxY {
            ctx.setStrokeColor(NSColor.white.withAlphaComponent(0.8).cgColor)
            ctx.setLineWidth(1.5)

            let bx = rightEdge - bracketInset
            let by = yMid - bracketH / 2
            // Draw ] shape
            ctx.move(to: CGPoint(x: bx - bracketW, y: by))
            ctx.addLine(to: CGPoint(x: bx, y: by))
            ctx.addLine(to: CGPoint(x: bx, y: by + bracketH))
            ctx.addLine(to: CGPoint(x: bx - bracketW, y: by + bracketH))
            ctx.strokePath()
        }
    }

    // MARK: - Tracking Area (hover detection)

    public override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let existing = hoverTrackingArea {
            removeTrackingArea(existing)
        }
        let area = NSTrackingArea(
            rect: bounds,
            options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow],
            owner: self,
            userInfo: nil
        )
        addTrackingArea(area)
        hoverTrackingArea = area
    }

    public override func mouseMoved(with event: NSEvent) {
        guard let project = project else {
            hoverLocation = nil
            NSCursor.arrow.set()
            return
        }

        let location = convert(event.locationInWindow, from: nil)
        hoverLocation = location

        // Check if cursor is near any clip edge for resize cursor
        if let edge = hitTestClipEdge(at: location, project: project) {
            NSCursor.resizeLeftRight.set()
            needsDisplay = true  // Redraw bracket indicator
            _ = edge  // Used implicitly via cursor set
        } else {
            NSCursor.arrow.set()
            needsDisplay = true  // Clear bracket indicator
        }
    }

    public override func mouseExited(with event: NSEvent) {
        hoverLocation = nil
        NSCursor.arrow.set()
        needsDisplay = true
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

    private func hitTestClipEdge(at location: NSPoint, project: Project) -> EdgeHit? {
        let beat = Double(location.x) / Double(pixelsPerBeat)
        let queryWindowBeats = Double(edgeHitZone * 2) / Double(pixelsPerBeat)
        
        // Find track under mouse to narrow spatial search
        var currentY: CGFloat = 0
        var trackIndexUnderMouse: Int?
        var trackUnderMouse: Track?
        
        for (i, t) in project.tracks.enumerated() {
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
        let trackY = currentY // Start of the track row
        
        for element in candidates {
            let wrapper = element.value
            guard wrapper.trackID == track.id else { continue }
            
            let clipPos: Double
            let clipDur: Double
            
            if let ac = wrapper.audioClip {
                clipPos = ac.position.beats
                clipDur = ac.duration.beats
            } else if let mc = wrapper.midiClip {
                clipPos = mc.position.beats
                clipDur = mc.duration.beats
            } else { continue }
            
            let clipX = CGFloat(clipPos) * pixelsPerBeat
            let clipWidth = CGFloat(clipDur) * pixelsPerBeat
            let clipRect = CGRect(x: clipX, y: trackY + 2, width: clipWidth, height: track.height - 4)
            
            let clipTrim = (wrapper.audioClip?.trimStartOffset.beats) ?? 0

            if abs(location.x - clipRect.minX) <= edgeHitZone {
                return EdgeHit(trackID: track.id, clipID: wrapper.id, isMidi: wrapper.isMidi,
                               edge: .left, clipPosition: clipPos, clipDuration: clipDur, clipTrim: clipTrim)
            }
            if abs(location.x - clipRect.maxX) <= edgeHitZone {
                return EdgeHit(trackID: track.id, clipID: wrapper.id, isMidi: wrapper.isMidi,
                               edge: .right, clipPosition: clipPos, clipDuration: clipDur, clipTrim: clipTrim)
            }
        }
        
        return nil
    }

    // MARK: - Selection Helpers

    /// Deselect all clips across all tracks.
    private func deselectAllClips(in project: Project) {
        for track in project.tracks {
            for i in track.clips.indices { track.clips[i].isSelected = false }
            for i in track.midiClips.indices { track.midiClips[i].isSelected = false }
        }
    }

    /// Select a specific clip by ID.
    private func selectClip(id: UUID, isMidi: Bool, in project: Project) {
        for track in project.tracks {
            if isMidi {
                if let idx = track.midiClips.firstIndex(where: { $0.id == id }) {
                    track.midiClips[idx].isSelected = true
                    return
                }
            } else {
                if let idx = track.clips.firstIndex(where: { $0.id == id }) {
                    track.clips[idx].isSelected = true
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
        let clickBeat = Double(location.x) / Double(pixelsPerBeat)
        
        // Find track under mouse
        var yOffset: CGFloat = 0
        var clickedTrackID: UUID?
        for track in project.tracks {
            if location.y >= yOffset && location.y < yOffset + track.height {
                clickedTrackID = track.id
                break
            }
            yOffset += track.height
        }

        // Snap to grid logic
        // If pixelsPerBeat > 40 -> snap to 1/4 beat
        // If pixelsPerBeat > 12 -> snap to 1 beat
        // Else snap to 1 beat (default)
        let snapInterval: Double = pixelsPerBeat > 40 ? 0.25 : 1.0
        let snappedBeat = (clickBeat / snapInterval).rounded() * snapInterval

        // Set Edit Cursor (on clicked track) & specific track selection
        if let trackID = clickedTrackID {
            editCursor = EditCursor(trackID: trackID, position: TimePosition(beats: max(0, snappedBeat)))
            onTrackClicked?(trackID)
        }

        // Double-click: create MIDI clip on MIDI tracks, or open existing clip
        if event.clickCount == 2 {
            handleDoubleClick(at: location, beat: clickBeat, project: project)
            return
        }

        // ──── Priority 1: Edge resize ────
        // If click is near a clip edge, start resize mode
        if let edgeHit = hitTestClipEdge(at: location, project: project) {
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
            NSCursor.resizeLeftRight.set()
            // Also select the clip being resized
            deselectAllClips(in: project)
            selectClip(id: edgeHit.clipID, isMidi: edgeHit.isMidi, in: project)
            needsDisplay = true
            return
        }

        // ──── Priority 2: Clip body click (select + drag) ────
        if let trackIndex = project.tracks.firstIndex(where: { $0.id == clickedTrackID }) {
            let track = project.tracks[trackIndex]
            let queryRect = QuadRect(minX: clickBeat - 0.001, maxX: clickBeat + 0.001, 
                                     minY: Double(trackIndex), maxY: Double(trackIndex + 1))
            
            let candidates = quadTree?.query(range: queryRect) ?? []
            // Calculate yOffset for this track
            var targetY: CGFloat = 0
            for i in 0..<trackIndex { targetY += project.tracks[i].height }
            
            for element in candidates {
                let wrapper = element.value
                guard wrapper.trackID == track.id else { continue }
                
                let clipPos: Double
                let clipDur: Double
                if let ac = wrapper.audioClip {
                    clipPos = ac.position.beats
                    clipDur = ac.duration.beats
                } else if let mc = wrapper.midiClip {
                    clipPos = mc.position.beats
                    clipDur = mc.duration.beats
                } else { continue }
                
                let clipX = CGFloat(clipPos) * pixelsPerBeat
                let clipWidth = CGFloat(clipDur) * pixelsPerBeat
                let clipRect = CGRect(x: clipX, y: targetY + 2, width: clipWidth, height: track.height - 4)
                
                if clipRect.contains(location) {
                    let isSelected: Bool
                    if let ac = wrapper.audioClip { isSelected = ac.isSelected }
                    else if let mc = wrapper.midiClip { isSelected = mc.isSelected }
                    else { isSelected = false }
                    
                    if !isSelected {
                        if !event.modifierFlags.contains(.shift) {
                            deselectAllClips(in: project)
                        }
                        selectClip(id: wrapper.id, isMidi: wrapper.isMidi, in: project)
                    }
                    
                    needsDisplay = true
                    onClipSelected?(track.id, wrapper.id)

                    dragState = DragState(
                        trackID: track.id,
                        clipID: wrapper.id,
                        isMidi: wrapper.isMidi,
                        startMousePosition: location,
                        originalClipBeat: clipPos
                    )
                    return
                }
            }
        }

        // ──── Priority 3: Empty space click ────
        // Deselect all
        deselectAllClips(in: project)
        needsDisplay = true
    }
    
    /// Handle double-click: create MIDI clip on empty space of MIDI track,
    /// or open existing MIDI clip for editing.
    private func handleDoubleClick(at location: NSPoint, beat: Double, project: Project) {
        var yOffset: CGFloat = 0
        
        for track in project.tracks {
            let laneRect = CGRect(x: 0, y: yOffset, width: bounds.width, height: track.height)
            
            if laneRect.contains(location) {
                // Check if we double-clicked on an existing MIDI clip
                for midiClip in track.midiClips {
                    let clipX = CGFloat(midiClip.position.beats) * pixelsPerBeat
                    let clipWidth = CGFloat(midiClip.duration.beats) * pixelsPerBeat
                    let clipRect = CGRect(x: clipX, y: yOffset + 2, width: clipWidth, height: track.height - 4)
                    
                    if clipRect.contains(location) {
                        // Open piano roll for this clip
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
                        orchestrator.history.record(action)
                        needsDisplay = true
                    }
                }
                return
            }
            yOffset += track.height
        }
    }

    public override func mouseDragged(with event: NSEvent) {
        let location = convert(event.locationInWindow, from: nil)


        // ──── Resize drag mode ────
        if let resize = resizeState, let project = project {
            let deltaX = location.x - resize.startMouseX
            let deltaBeat = Double(deltaX) / Double(pixelsPerBeat)
            let minDuration: Double = 1.0  // Minimum 1 beat

            for track in project.tracks where track.id == resize.trackID {
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
                            // Adjust trimStartOffset for audio clips (reveals earlier audio)
                            let positionDelta = newStart - resize.originalPosition
                            let newTrim = max(0, track.clips[idx].trimStartOffset.beats + positionDelta)
                            track.clips[idx].position = TimePosition(beats: newStart)
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
                            track.clips[idx].duration = TimePosition(beats: newDuration)
                        }
                    }
                }
            }
            needsDisplay = true
            return
        }

        // ──── Clip move drag mode ────
        guard let dragState = dragState, let project = project else { return }

        let deltaX = location.x - dragState.startMousePosition.x
        let deltaBeat = Double(deltaX) / Double(pixelsPerBeat)
        let newBeat = max(0, dragState.originalClipBeat + deltaBeat)

        // Snap to grid (nearest beat)
        let snappedBeat = round(newBeat)

        // Find and update the clip
        for track in project.tracks where track.id == dragState.trackID {
            if dragState.isMidi {
                if let idx = track.midiClips.firstIndex(where: { $0.id == dragState.clipID }) {
                    track.midiClips[idx].position = TimePosition(beats: snappedBeat)
                    needsDisplay = true
                }
            } else {
                if let idx = track.clips.firstIndex(where: { $0.id == dragState.clipID }) {
                    track.clips[idx].position = TimePosition(beats: snappedBeat)
                    needsDisplay = true
                }
            }
        }
    }

    public override func mouseUp(with event: NSEvent) {
        // ──── Resize end ────
        if let resize = resizeState, let project = project {
            let track = project.tracks.first(where: { $0.id == resize.trackID })
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
            needsDisplay = true
            onClipsModified?()
            return
        }

        // ──── Clip move drag end ────
        if let drag = dragState, let project = project {
            let track = project.tracks.first(where: { $0.id == drag.trackID })
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
            needsDisplay = true
            onClipsModified?()
            return
        }
    }

    // MARK: - Keyboard Shortcuts

    public override var acceptsFirstResponder: Bool { true }

    /// Clipboard for copy/cut/paste operations.
    private struct ClipboardItem {
        enum Kind { case audio(AudioClip), midi(MidiClip) }
        let item: Kind
        let trackID: UUID
    }
    private static var clipboard: [ClipboardItem] = []



    /// Handle non-modifier keys (Delete, Backspace).
    public override func keyDown(with event: NSEvent) {
        switch event.keyCode {
        case 51, 117:  // Backspace (51), Forward Delete (117)
            deleteSelection()
        default:
            super.keyDown(with: event)
        }
    }

    /// Returns true if any clip is currently selected on the canvas.
    public var hasSelection: Bool {
        guard let project = project else { return false }
        return project.tracks.contains { $0.clips.contains(where: \.isSelected) || $0.midiClips.contains(where: \.isSelected) }
    }
    
    // MARK: - Editing Operations (Public API for Controller)

    /// Delete all selected clips across all tracks.
    public func deleteSelection() {
        guard let project = project else { return }
        var didDelete = false
        for track in project.tracks {
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
            needsDisplay = true
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

        for track in project.tracks {
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
            needsDisplay = true
            onClipsModified?()
        }
    }

    /// Copy all selected clips to the clipboard.
    public func copySelection() {
        guard let project = project else { return }
        Self.clipboard.removeAll()
        for track in project.tracks {
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
            guard let track = project.tracks.first(where: { $0.id == item.trackID }) else { continue }

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
        needsDisplay = true
    }

    /// Select all clips across all tracks.
    public func selectAllClips() {
        guard let project = project else { return }
        for track in project.tracks {
            for i in track.clips.indices { track.clips[i].isSelected = true }
            for i in track.midiClips.indices { track.midiClips[i].isSelected = true }
        }
        needsDisplay = true
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

        for track in project.tracks {
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
        needsDisplay = true
    }

    // MARK: - Scroll & Zoom

    public override func scrollWheel(with event: NSEvent) {
        if event.modifierFlags.contains(.command) {
            // Zoom horizontally with Cmd+scroll — centered on the playhead
            let zoomFactor: CGFloat = event.scrollingDeltaY > 0 ? 1.035 : 0.967
            let oldPPB = pixelsPerBeat
            let newPPB = min(DreamTheme.maxPixelsPerBeat, max(DreamTheme.minPixelsPerBeat, oldPPB * zoomFactor))
            guard newPPB != oldPPB else { return }

            // Center zoom on the playhead position
            let playheadBeat = CGFloat(playheadPosition.beats)
            let currentScrollX = enclosingScrollView?.contentView.bounds.origin.x ?? 0
            let playheadScreenX = playheadBeat * oldPPB - currentScrollX

            // Calculate new scroll X to keep playhead at the same screen position
            let newScrollX = playheadBeat * newPPB - playheadScreenX

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

    public override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        guard let project = project else { return false }

        let pasteboard = sender.draggingPasteboard
        let location = convert(sender.draggingLocation, from: nil)

        // Determine target track index from Y position
        var yOffset: CGFloat = 0
        var targetTrackIndex = 0
        for (index, track) in project.tracks.enumerated() {
            if location.y >= yOffset && location.y < yOffset + track.height {
                targetTrackIndex = index
                break
            }
            yOffset += track.height
        }
        guard targetTrackIndex < project.tracks.count else { return false }
        let track = project.tracks[targetTrackIndex]

        // CASE 1: Browser item drop (instruments, effects)
        if let payload = pasteboard.string(forType: .browserItem) {
            let parts = payload.split(separator: ":", maxSplits: 1)
            guard parts.count == 2 else { return false }
            let nodeType = String(parts[0])
            let itemName = String(parts[1])
            onBrowserItemDropped?(track.id, nodeType, itemName)
            needsDisplay = true
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
        for url in urls {
            // Compute real clip duration from audio file
            let clipDuration: TimePosition
            if let audioFile = try? AVAudioFile(forReading: url) {
                let fileDurationSeconds = Double(audioFile.length) / audioFile.processingFormat.sampleRate
                let fileDurationBeats = fileDurationSeconds * (project.bpm / 60.0)
                clipDuration = TimePosition(beats: fileDurationBeats)
            } else {
                // Fallback: 4 bars
                clipDuration = TimePosition(bars: 4, beatsPerBar: project.timeSignature.beatsPerBar)
            }

            let clip = AudioClip(
                name: url.deletingPathExtension().lastPathComponent,
                fileURL: url,
                position: TimePosition(beats: beatPosition),
                duration: clipDuration
            )
            track.clips.append(clip)
            beatPosition += clip.duration.beats
        }

        needsDisplay = true
        return true
    }
}
