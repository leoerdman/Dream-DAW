import AppKit
import Foundation
import DreamDAWModels

/// Translates ruler/canvas pointer input into high-level timeline actions.
@MainActor
public final class TimelineInteractionCoordinator: NSObject {

    public weak var delegate: TimelineInteractionDelegate?

    private enum RulerDragTarget {
        case none
        case loopStart
        case loopEnd
    }

    private var rulerDragTarget: RulerDragTarget = .none
    
    // MARK: - Canvas Interaction (Managed via InteractionStateMachine)

    public func mouseDown(with event: NSEvent, in view: TimelineCanvasView) {
        guard let project = view.project else { return }
        let location = view.convert(event.locationInWindow, from: nil)
        
        // 1. Identify track and timing
        let beat = Double(location.x) / Double(view.pixelsPerBeat)
        let sampleFrame = Int64(beat * (project.sampleRate * 60.0 / Double(project.bpm))) // Simplified for now, should ideally use PulseMap
        
        var trackIndex: Int = 0
        var currentY: CGFloat = 0
        let visibleTracks = project.allVisibleTracks
        for (i, t) in visibleTracks.enumerated() {
            if location.y >= currentY && location.y < currentY + t.height {
                trackIndex = i
                break
            }
            currentY += t.height
        }
        
        // 2. Hit Testing
        if let (track, wrapper, edge) = view.hitTestClipEdge(at: location, project: project) {
            // TRIM START
            let clip = wrapper.isMidi ? (wrapper.midiClip as Any) : (wrapper.audioClip as Any)
            let start = wrapper.isMidi ? wrapper.midiClip!.position.beats : wrapper.audioClip!.position.beats
            let dur = wrapper.isMidi ? wrapper.midiClip!.duration.beats : wrapper.audioClip!.duration.beats
            let trim = wrapper.isMidi ? 0.0 : wrapper.audioClip!.trimStartOffset.beats
            
            let bounds = ClipBounds(
                clipID: wrapper.id,
                startSample: Int64(start * (project.sampleRate * 60.0 / Double(project.bpm))),
                endSample: Int64((start + dur) * (project.sampleRate * 60.0 / Double(project.bpm))),
                trimStartOffsetSamples: Int64(trim * (project.sampleRate * 60.0 / Double(project.bpm)))
            )
            
            view.interactionSM.beginTrim(clipID: wrapper.id, edge: edge, originalBounds: bounds, anchorSample: sampleFrame)
            return
        }
        
        if let (track, wrapper) = view.hitTestClipBody(at: location, project: project) {
            // DRAG START
            // If clip is not selected, select it (and deselect others unless shift)
            let isShift = event.modifierFlags.contains(.shift)
            delegate?.interactionDidUpdateSelection(clipIDs: [wrapper.id], isShift: isShift)
            
            view.interactionSM.beginPendingDrag(
                clipIDs: project.selectedClipIDs,
                anchorSample: sampleFrame,
                anchorTrackIndex: trackIndex,
                anchorPixelX: Float(location.x),
                anchorPixelY: Float(location.y)
            )
            return
        }
        
        // 3. Empty Space: Seek or Marquee
        if event.clickCount == 2 {
            // Future: Double click to insert clip?
        } else {
            // Seek and start Marquee
            delegate?.interactionDidRequestSeek(to: TimePosition(beats: beat), on: nil)
            view.interactionSM.beginMarquee(startPixelX: Float(location.x), startPixelY: location.y)
        }
    }

    public func mouseDragged(with event: NSEvent, in view: TimelineCanvasView) {
        guard let project = view.project else { return }
        let location = view.convert(event.locationInWindow, from: nil)
        
        let beat = Double(location.x) / Double(view.pixelsPerBeat)
        let sampleFrame = Int64(beat * (project.sampleRate * 60.0 / Double(project.bpm)))
        
        var trackIndex: Int = 0
        var currentY: CGFloat = 0
        let visibleTracks = project.allVisibleTracks
        for (i, t) in visibleTracks.enumerated() {
            if location.y >= currentY && location.y < currentY + t.height {
                trackIndex = i
                break
            }
            currentY += t.height
        }
        
        view.interactionSM.handleMouseDragged(
            currentSample: sampleFrame,
            currentTrackIndex: trackIndex,
            currentPixelX: Float(location.x),
            currentPixelY: Float(location.y),
            viewport: view.viewportMatrix
        )
    }

    public func mouseUp(with event: NSEvent, in view: NSView) {
        if let canvasView = view as? TimelineCanvasView {
            let finalState = canvasView.interactionSM.commitInteraction()
            delegate?.interactionDidCommitClipsModification(finalState: finalState)
        } else {
            // For Ruler or other views, we just finalize without a state-machine commit
            delegate?.interactionDidCommitClipsModification(finalState: .idle)
        }
        
        rulerDragTarget = .none
    }

    // MARK: - Ruler Interaction

    public func mouseDownRuler(
        with event: NSEvent,
        at location: CGPoint,
        pixelsPerBeat: CGFloat,
        loopStart: Double,
        loopEnd: Double
    ) {
        let beat = max(0, Double(location.x / pixelsPerBeat))
        let snapBeat = beat.rounded()
        let startX = CGFloat(loopStart) * pixelsPerBeat
        let endX = CGFloat(loopEnd) * pixelsPerBeat

        if abs(location.x - startX) <= 8 {
            rulerDragTarget = .loopStart
            return
        }
        if abs(location.x - endX) <= 8 {
            rulerDragTarget = .loopEnd
            return
        }

        rulerDragTarget = .none
        delegate?.interactionDidRequestSeek(to: TimePosition(beats: snapBeat), on: nil)
    }

    public func mouseDraggedRuler(
        with event: NSEvent,
        at location: CGPoint,
        pixelsPerBeat: CGFloat,
        loopStart: Double,
        loopEnd: Double
    ) {
        let beat = max(0, Double(location.x / pixelsPerBeat)).rounded()

        switch rulerDragTarget {
        case .loopStart:
            let clamped = min(beat, loopEnd - 1.0)
            delegate?.interactionDidRequestLoopStartChange(to: TimePosition(beats: max(0, clamped)))
        case .loopEnd:
            let clamped = max(beat, loopStart + 1.0)
            delegate?.interactionDidRequestLoopEndChange(to: TimePosition(beats: clamped))
        case .none:
            delegate?.interactionDidRequestSeek(to: TimePosition(beats: beat), on: nil)
        }
    }
}
