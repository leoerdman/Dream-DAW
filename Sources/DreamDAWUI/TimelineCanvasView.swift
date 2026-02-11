import AppKit
import AVFoundation
import Foundation
import DreamDAWModels
import DreamDAWEngine

// MARK: - TimelineCanvasView

/// The main arrangement canvas that renders track lanes, audio clips, MIDI clips,
/// grid lines, and handles mouse interaction for clip selection/creation/movement.
/// Uses Core Graphics for high-performance custom rendering.
public final class TimelineCanvasView: NSView {

    // MARK: - Properties

    public var project: Project? {
        didSet { needsDisplay = true }
    }

    public var pixelsPerBeat: CGFloat = DreamTheme.defaultPixelsPerBeat {
        didSet { needsDisplay = true }
    }

    public var scrollOffset: CGPoint = .zero {
        didSet { needsDisplay = true }
    }

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

    /// Currently dragged clip info for move operations.
    private var dragState: DragState?

    /// Whether we're dragging the playhead (click on empty space).
    private var isDraggingPlayhead: Bool = false

    private struct DragState {
        let trackID: UUID
        let clipID: UUID
        let isMidi: Bool
        let startMousePosition: NSPoint
        let originalClipBeat: Double
    }

    // MARK: - Drawing

    public override var isFlipped: Bool { true }

    public override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext,
              let project = project else { return }

        // Background
        ctx.setFillColor(DreamTheme.bgPrimary.cgColor)
        ctx.fill(bounds)

        drawGridLines(ctx: ctx, project: project)
        drawTrackLanes(ctx: ctx, project: project)
        drawClips(ctx: ctx, project: project)
        drawMidiClips(ctx: ctx, project: project)
        drawPlayhead(ctx: ctx)
    }

    // MARK: - Grid Lines

    private func drawGridLines(ctx: CGContext, project: Project) {
        let beatsPerBar = project.timeSignature.beatsPerBar
        let visibleStartBeat = Double(scrollOffset.x) / Double(pixelsPerBeat)
        let visibleEndBeat = visibleStartBeat + Double(bounds.width) / Double(pixelsPerBeat)

        let startBar = max(0, Int(floor(visibleStartBeat / Double(beatsPerBar))))
        let endBar = Int(ceil(visibleEndBeat / Double(beatsPerBar))) + 1

        // Draw bar lines
        for bar in startBar...endBar {
            let barBeat = Double(bar * beatsPerBar)
            let x = CGFloat(barBeat) * pixelsPerBeat - scrollOffset.x

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
        var yOffset: CGFloat = -scrollOffset.y

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
        var yOffset: CGFloat = -scrollOffset.y

        for track in project.tracks {
            for clip in track.clips {
                let clipX = CGFloat(clip.position.beats) * pixelsPerBeat - scrollOffset.x
                let clipWidth = CGFloat(clip.duration.beats) * pixelsPerBeat
                let clipRect = CGRect(x: clipX, y: yOffset + 2, width: clipWidth, height: track.height - 4)

                // Only draw if visible
                guard clipRect.intersects(bounds) else { continue }

                drawSingleClip(ctx: ctx, clip: clip, rect: clipRect, track: track, project: project)
            }
            yOffset += track.height
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

        // Selection border
        if clip.isSelected {
            ctx.setStrokeColor(DreamTheme.selectionBorder.cgColor)
            ctx.setLineWidth(2)
            ctx.addPath(clipPath)
            ctx.strokePath()
        }

        // Clip border
        ctx.setStrokeColor(trackColor.withAlphaComponent(0.5).cgColor)
        ctx.setLineWidth(0.5)
        ctx.addPath(clipPath)
        ctx.strokePath()
    }

    // MARK: - MIDI Clips

    private func drawMidiClips(ctx: CGContext, project: Project) {
        var yOffset: CGFloat = -scrollOffset.y

        for track in project.tracks {
            for midiClip in track.midiClips {
                let clipX = CGFloat(midiClip.position.beats) * pixelsPerBeat - scrollOffset.x
                let clipWidth = CGFloat(midiClip.duration.beats) * pixelsPerBeat
                let clipRect = CGRect(x: clipX, y: yOffset + 2, width: clipWidth, height: track.height - 4)

                guard clipRect.intersects(bounds) else { continue }

                drawSingleMidiClip(ctx: ctx, midiClip: midiClip, rect: clipRect, track: track)
            }
            yOffset += track.height
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

        // Selection border
        if midiClip.isSelected {
            ctx.setStrokeColor(DreamTheme.selectionBorder.cgColor)
            ctx.setLineWidth(2)
            ctx.addPath(clipPath)
            ctx.strokePath()
        }

        // Clip border
        ctx.setStrokeColor(trackColor.withAlphaComponent(0.6).cgColor)
        ctx.setLineWidth(0.5)
        ctx.addPath(clipPath)
        ctx.strokePath()
    }

    // MARK: - Playhead

    private func drawPlayhead(ctx: CGContext) {
        let playheadX = CGFloat(playheadPosition.beats) * pixelsPerBeat - scrollOffset.x

        guard playheadX >= -1 && playheadX <= bounds.width + 1 else { return }

        ctx.setStrokeColor(DreamTheme.playhead.cgColor)
        ctx.setLineWidth(DreamTheme.playheadWidth)
        ctx.move(to: CGPoint(x: playheadX, y: 0))
        ctx.addLine(to: CGPoint(x: playheadX, y: bounds.height))
        ctx.strokePath()
    }

    // MARK: - Mouse Interaction

    public override func mouseDown(with event: NSEvent) {
        guard let project = project else { return }

        let location = convert(event.locationInWindow, from: nil)
        let beat = Double(location.x + scrollOffset.x) / Double(pixelsPerBeat)
        
        // Double-click: create MIDI clip on MIDI tracks, or open existing clip
        if event.clickCount == 2 {
            handleDoubleClick(at: location, beat: beat, project: project)
            return
        }

        // Check if we clicked on a clip (audio or MIDI)
        var yOffset: CGFloat = -scrollOffset.y
        for track in project.tracks {
            // Check audio clips
            for clip in track.clips {
                let clipX = CGFloat(clip.position.beats) * pixelsPerBeat - scrollOffset.x
                let clipWidth = CGFloat(clip.duration.beats) * pixelsPerBeat
                let clipRect = CGRect(x: clipX, y: yOffset + 2, width: clipWidth, height: track.height - 4)

                if clipRect.contains(location) {
                    dragState = DragState(
                        trackID: track.id,
                        clipID: clip.id,
                        isMidi: false,
                        startMousePosition: location,
                        originalClipBeat: clip.position.beats
                    )
                    onClipSelected?(track.id, clip.id)
                    return
                }
            }
            
            // Check MIDI clips
            for midiClip in track.midiClips {
                let clipX = CGFloat(midiClip.position.beats) * pixelsPerBeat - scrollOffset.x
                let clipWidth = CGFloat(midiClip.duration.beats) * pixelsPerBeat
                let clipRect = CGRect(x: clipX, y: yOffset + 2, width: clipWidth, height: track.height - 4)

                if clipRect.contains(location) {
                    // Shift+click on MIDI clip → open piano roll
                    if event.modifierFlags.contains(.shift) {
                        onMidiClipShiftClicked?(track.id, midiClip.id)
                        return
                    }
                    dragState = DragState(
                        trackID: track.id,
                        clipID: midiClip.id,
                        isMidi: true,
                        startMousePosition: location,
                        originalClipBeat: midiClip.position.beats
                    )
                    return
                }
            }
            
            yOffset += track.height
        }

        // No clip clicked — start playhead drag + show track detail
        let snappedBeat = max(0, beat)
        isDraggingPlayhead = true
        onClickPosition?(TimePosition(beats: snappedBeat))

        // If click landed in a track lane, show its detail panel
        var trackYOffset: CGFloat = -scrollOffset.y
        for track in project.tracks {
            let laneRect = CGRect(x: 0, y: trackYOffset, width: bounds.width, height: track.height)
            if laneRect.contains(location) {
                onTrackClicked?(track.id)
                break
            }
            trackYOffset += track.height
        }
    }
    
    /// Handle double-click: create MIDI clip on empty space of MIDI track,
    /// or open existing MIDI clip for editing.
    private func handleDoubleClick(at location: NSPoint, beat: Double, project: Project) {
        var yOffset: CGFloat = -scrollOffset.y
        
        for track in project.tracks {
            let laneRect = CGRect(x: 0, y: yOffset, width: bounds.width, height: track.height)
            
            if laneRect.contains(location) {
                // Check if we double-clicked on an existing MIDI clip
                for midiClip in track.midiClips {
                    let clipX = CGFloat(midiClip.position.beats) * pixelsPerBeat - scrollOffset.x
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

        // Playhead drag mode — continuously move playhead with mouse
        if isDraggingPlayhead {
            let beat = max(0, Double(location.x + scrollOffset.x) / Double(pixelsPerBeat))
            onClickPosition?(TimePosition(beats: beat))
            return
        }

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
        isDraggingPlayhead = false
        dragState = nil
    }

    // MARK: - Scroll & Zoom

    public override func scrollWheel(with event: NSEvent) {
        if event.modifierFlags.contains(.option) {
            // Zoom horizontally with Option+scroll
            let zoomFactor: CGFloat = event.scrollingDeltaY > 0 ? 1.15 : 0.87
            let newPPB = min(DreamTheme.maxPixelsPerBeat, max(DreamTheme.minPixelsPerBeat, pixelsPerBeat * zoomFactor))
            pixelsPerBeat = newPPB
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
        var yOffset: CGFloat = -scrollOffset.y
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

        let beat = max(0, Double(location.x + scrollOffset.x) / Double(pixelsPerBeat))
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
