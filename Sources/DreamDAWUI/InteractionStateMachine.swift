import Foundation
import DreamDAWModels

// MARK: - Interaction Types

/// Cached original clip bounds used during trimming to compute deltas.
public struct ClipBounds: Sendable {
    public let clipID: UUID
    public let startSample: Int64
    public let endSample: Int64
    public let trimStartOffsetSamples: Int64

    public init(clipID: UUID, startSample: Int64, endSample: Int64, trimStartOffsetSamples: Int64 = 0) {
        self.clipID = clipID
        self.startSample = startSample
        self.endSample = endSample
        self.trimStartOffsetSamples = trimStartOffsetSamples
    }
}

// MARK: - Interaction State

/// Finite State Machine for mouse interactions on the arrangement timeline.
///
/// **The Phantom Pattern**: While the user drags clips or adjusts trim edges,
/// the Project Model is NEVER mutated. Instead, we track pure mathematical deltas
/// (`phantomDeltaSamples`, `deltaTrackIndex`) that describe the ghost offset.
///
/// The Metal renderer draws the "phantom" clips at their offset position with
/// reduced opacity. The actual model mutation + UndoManager push happens
/// **strictly on mouseUp** via `commitInteraction()`.
///
/// This guarantees:
/// 1. Zero audio glitches during drag (engine reads the unchanged model)
/// 2. Clean, single-step Undo history (one entry per completed action)
/// 3. Instant cancellation via Escape key
public enum InteractionState: Sendable {
    /// No interaction in progress.
    case idle

    // PHASE 9.9: Gesture Disambiguation
    /// Mouse is down but hasn't moved past the threshold yet.
    /// If mouseUp fires while still pending, it's a click (not a drag).
    /// If mouse travels > 4px, transitions to `.dragging`.
    case pendingDrag(
        clipIDs: Set<UUID>,
        anchorPixelX: Float,
        anchorPixelY: Float
    )

    /// User is drawing a selection rectangle (marquee/lasso select).
    case marqueeSelecting(
        startPixelX: Float,
        currentPixelX: Float,
        startPixelY: CGFloat,
        currentPixelY: CGFloat
    )

    /// User is dragging one or more selected clips.
    /// The model is NOT mutated — only the phantom offset changes.
    case dragging(
        clipIDs: Set<UUID>,
        phantomDeltaSamples: Int64,
        deltaTrackIndex: Int
    )

    /// User is trimming a clip's left or right edge.
    /// The model is NOT mutated — only the phantom trim boundary changes.
    case trimming(
        clipID: UUID,
        edge: TrimEdge,
        originalBounds: ClipBounds,
        deltaSamples: Int64
    )
    
    // PHASE 9.8: New Interaction States
    
    /// User is splitting a clip at a specific sample frame position.
    /// Renders a vertical cut line at the split point.
    case splitting(
        clipID: UUID,
        splitSampleFrame: Int64
    )
    
    /// User is slicing across multiple tracks at a time position.
    /// Renders a vertical cut line spanning the affected track range.
    case slicing(
        sampleFrame: Int64,
        trackIndexRange: ClosedRange<Int>
    )
    
    /// User is stretching/warping a clip from one edge.
    /// `rate` = new_duration / original_duration (1.0 = no change).
    case stretching(
        clipID: UUID,
        edge: TrimEdge,
        originalBounds: ClipBounds,
        rate: Double
    )
}

// MARK: - Phantom Overlay Data

/// Lightweight data structure passed to the Metal renderer to draw ghost clips.
/// Allocated on the stack — no heap allocation during drag.
public struct PhantomOverlay: Sendable {
    public let clipIDs: Set<UUID>
    public let deltaSamples: Int64
    public let deltaTrackIndex: Int
    public let isActive: Bool

    public static let inactive = PhantomOverlay(clipIDs: [], deltaSamples: 0, deltaTrackIndex: 0, isActive: false)
}

/// Trim phantom data for the Metal renderer.
public struct TrimPhantom: Sendable {
    public let clipID: UUID
    public let edge: TrimEdge
    public let deltaSamples: Int64
    public let isActive: Bool

    public static let inactive = TrimPhantom(clipID: UUID(), edge: .left, deltaSamples: 0, isActive: false)
}

// PHASE 9.8: Split phantom for the vertical cut line.
public struct SplitPhantom: Sendable {
    public let clipID: UUID?
    public let sampleFrame: Int64
    public let trackIndexRange: ClosedRange<Int>?
    public let isActive: Bool
    
    public static let inactive = SplitPhantom(clipID: nil, sampleFrame: 0, trackIndexRange: nil, isActive: false)
}

/// Stretch phantom data for Metal renderer (time-stretch preview).
public struct StretchPhantom: Sendable {
    public let clipID: UUID
    public let edge: TrimEdge
    public let rate: Double
    public let isActive: Bool
    
    public static let inactive = StretchPhantom(clipID: UUID(), edge: .left, rate: 1.0, isActive: false)
}

// MARK: - InteractionStateMachine

/// The central controller for all mouse interactions on the arrangement canvas.
///
/// Usage:
/// ```swift
/// // mouseDown:
/// stateMachine.beginDrag(clipIDs: selected, anchorSample: clickSample)
///
/// // mouseDragged (called 120x/sec):
/// stateMachine.handleMouseDragged(mousePixelX: x, viewport: viewport)
///
/// // mouseUp:
/// let action = stateMachine.commitInteraction()
/// project.apply(action) // Single atomic mutation + Undo
/// ```
@MainActor
public final class InteractionStateMachine {

    // MARK: - State

    /// The current interaction state.
    public private(set) var currentState: InteractionState = .idle

    /// The sample frame at which the drag/trim started (anchor point).
    private var anchorSample: Int64 = 0

    /// The track index at which the drag started.
    private var anchorTrackIndex: Int = 0

    /// Snap-to-grid callback. Returns the nearest grid-aligned sample frame.
    /// Set this from the arrangement controller to enable beat snapping.
    public var snapToGrid: ((Int64) -> Int64)?

    // MARK: - Constants
    
    // PHASE 9.9: Gesture disambiguation threshold in points.
    // Mouse must travel this far from mouseDown before a drag begins.
    // This prevents accidental drags when the user intended a click.
    private static let dragThresholdPoints: Float = 4.0

    // MARK: - Initialization

    public init() {}

    // MARK: - Begin Interactions

    /// PHASE 9.9: Begins a potential drag — doesn't commit to dragging yet.
    /// If the mouse travels > 4px, transitions to `.dragging`.
    /// If mouseUp fires while still pending, it's treated as a click.
    public func beginPendingDrag(clipIDs: Set<UUID>, anchorSample: Int64, anchorTrackIndex: Int, anchorPixelX: Float, anchorPixelY: Float) {
        self.anchorSample = anchorSample
        self.anchorTrackIndex = anchorTrackIndex
        currentState = .pendingDrag(clipIDs: clipIDs, anchorPixelX: anchorPixelX, anchorPixelY: anchorPixelY)
    }

    /// Begins a clip drag interaction (bypasses threshold — use when certain user wants to drag).
    public func beginDrag(clipIDs: Set<UUID>, anchorSample: Int64, anchorTrackIndex: Int) {
        self.anchorSample = anchorSample
        self.anchorTrackIndex = anchorTrackIndex
        currentState = .dragging(clipIDs: clipIDs, phantomDeltaSamples: 0, deltaTrackIndex: 0)
    }

    /// Begins a marquee selection interaction.
    public func beginMarquee(startPixelX: Float, startPixelY: CGFloat) {
        currentState = .marqueeSelecting(
            startPixelX: startPixelX,
            currentPixelX: startPixelX,
            startPixelY: startPixelY,
            currentPixelY: startPixelY
        )
    }

    /// Begins a trim interaction.
    public func beginTrim(clipID: UUID, edge: TrimEdge, originalBounds: ClipBounds, anchorSample: Int64) {
        self.anchorSample = anchorSample
        currentState = .trimming(clipID: clipID, edge: edge, originalBounds: originalBounds, deltaSamples: 0)
    }
    
    // PHASE 9.8: New interaction starters
    
    /// Begins a split interaction (vertical cut line follows mouse).
    public func beginSplit(clipID: UUID, sampleFrame: Int64) {
        currentState = .splitting(clipID: clipID, splitSampleFrame: sampleFrame)
    }
    
    /// Begins a slice across multiple tracks.
    public func beginSlice(sampleFrame: Int64, trackIndexRange: ClosedRange<Int>) {
        currentState = .slicing(sampleFrame: sampleFrame, trackIndexRange: trackIndexRange)
    }
    
    /// Begins a time-stretch/warp interaction.
    public func beginStretch(clipID: UUID, edge: TrimEdge, originalBounds: ClipBounds, anchorSample: Int64) {
        self.anchorSample = anchorSample
        currentState = .stretching(clipID: clipID, edge: edge, originalBounds: originalBounds, rate: 1.0)
    }

    // MARK: - Mouse Dragged (called 120x/sec)

    /// Updates the phantom state based on mouse movement.
    /// This is the hot path — must be fast (no allocations, no model mutations).
    public func handleMouseDragged(
        currentSample: Int64,
        currentTrackIndex: Int,
        currentPixelX: Float = 0,
        currentPixelY: Float = 0,
        viewport: ViewportMatrix
    ) {
        let rawDeltaSamples = currentSample - anchorSample
        let rawDeltaTracks = currentTrackIndex - anchorTrackIndex

        switch currentState {
        // PHASE 9.9: Gesture Disambiguation
        case .pendingDrag(let ids, let anchorPx, let anchorPy):
            let dx = currentPixelX - anchorPx
            let dy = currentPixelY - anchorPy
            let distance = (dx * dx + dy * dy).squareRoot()
            
            if distance >= Self.dragThresholdPoints {
                // Crossed threshold — commit to drag
                let snappedDelta = snapToGrid?(rawDeltaSamples) ?? rawDeltaSamples
                currentState = .dragging(
                    clipIDs: ids,
                    phantomDeltaSamples: snappedDelta,
                    deltaTrackIndex: rawDeltaTracks
                )
            }
            // Below threshold: stay in pendingDrag (no phantom rendered)
            
        case .dragging(let ids, _, _):
            // Optional: snap the delta to grid
            let snappedDelta = snapToGrid?(rawDeltaSamples) ?? rawDeltaSamples
            currentState = .dragging(
                clipIDs: ids,
                phantomDeltaSamples: snappedDelta,
                deltaTrackIndex: rawDeltaTracks
            )

        case .trimming(let id, let edge, let bounds, _):
            // Clamp to prevent clip inversion (zero-width)
            let clampedDelta: Int64
            switch edge {
            case .left:
                // Can't trim left past the right edge
                let maxDelta = bounds.endSample - bounds.startSample - 1
                clampedDelta = min(rawDeltaSamples, maxDelta)
            case .right:
                // Can't trim right past the left edge
                let minDelta = bounds.startSample - bounds.endSample + 1
                clampedDelta = max(rawDeltaSamples, minDelta)
            }

            let snappedDelta = snapToGrid?(clampedDelta) ?? clampedDelta
            currentState = .trimming(clipID: id, edge: edge, originalBounds: bounds, deltaSamples: snappedDelta)

        case .marqueeSelecting(let startX, _, let startY, _):
            let currentPixelXFromSample = viewport.pixelX(for: currentSample)
            currentState = .marqueeSelecting(
                startPixelX: startX,
                currentPixelX: currentPixelXFromSample,
                startPixelY: startY,
                currentPixelY: CGFloat(currentTrackIndex)
            )
        
        // PHASE 9.8: New state handlers
        case .splitting(let clipID, _):
            currentState = .splitting(clipID: clipID, splitSampleFrame: currentSample)
        
        case .slicing(_, let trackRange):
            currentState = .slicing(sampleFrame: currentSample, trackIndexRange: trackRange)
            
        case .stretching(let clipID, let edge, let bounds, _):
            // Calculate stretch rate from mouse delta
            let originalLength = bounds.endSample - bounds.startSample
            guard originalLength > 0 else { break }
            
            let stretchedLength: Int64
            switch edge {
            case .right:
                stretchedLength = max(1, originalLength + rawDeltaSamples)
            case .left:
                stretchedLength = max(1, originalLength - rawDeltaSamples)
            }
            let rate = Double(stretchedLength) / Double(originalLength)
            currentState = .stretching(clipID: clipID, edge: edge, originalBounds: bounds, rate: rate)

        case .idle:
            break
        }
    }

    /// Simplified mouseDragged for marquee (pixel-based, no sample conversion needed).
    public func updateMarquee(currentPixelX: Float, currentPixelY: CGFloat) {
        if case .marqueeSelecting(let startX, _, let startY, _) = currentState {
            currentState = .marqueeSelecting(
                startPixelX: startX,
                currentPixelX: currentPixelX,
                startPixelY: startY,
                currentPixelY: currentPixelY
            )
        }
    }

    // MARK: - Commit (mouseUp)

    /// Commits the current interaction and returns the action to apply to the model.
    /// This is the ONLY point where model mutation should occur.
    /// Returns the final state for the caller to apply, then resets to `.idle`.
    @discardableResult
    public func commitInteraction() -> InteractionState {
        let finalState = currentState
        currentState = .idle
        return finalState
    }

    // MARK: - Cancel (Escape key)

    /// Cancels the current interaction without committing.
    /// The phantom disappears and the model remains unchanged.
    public func cancelInteraction() {
        currentState = .idle
    }

    // MARK: - Query Helpers

    /// Whether an interaction is currently in progress.
    public var isInteracting: Bool {
        switch currentState {
        case .idle, .pendingDrag:
            return false
        default:
            return true
        }
    }
    
    /// Whether the state machine is waiting for gesture disambiguation.
    public var isPendingDrag: Bool {
        if case .pendingDrag = currentState { return true }
        return false
    }

    /// Returns phantom overlay data for the Metal renderer.
    public var phantomOverlay: PhantomOverlay {
        if case .dragging(let ids, let delta, let deltaTrack) = currentState {
            return PhantomOverlay(clipIDs: ids, deltaSamples: delta, deltaTrackIndex: deltaTrack, isActive: true)
        }
        return .inactive
    }

    /// Returns trim phantom data for the Metal renderer.
    public var trimPhantom: TrimPhantom {
        if case .trimming(let id, let edge, _, let delta) = currentState {
            return TrimPhantom(clipID: id, edge: edge, deltaSamples: delta, isActive: true)
        }
        return .inactive
    }
    
    /// PHASE 9.8: Returns split/slice phantom for the Metal renderer.
    public var splitPhantom: SplitPhantom {
        switch currentState {
        case .splitting(let clipID, let sf):
            return SplitPhantom(clipID: clipID, sampleFrame: sf, trackIndexRange: nil, isActive: true)
        case .slicing(let sf, let range):
            return SplitPhantom(clipID: nil, sampleFrame: sf, trackIndexRange: range, isActive: true)
        default:
            return .inactive
        }
    }
    
    /// PHASE 9.8: Returns stretch phantom for the Metal renderer.
    public var stretchPhantom: StretchPhantom {
        if case .stretching(let id, let edge, _, let rate) = currentState {
            return StretchPhantom(clipID: id, edge: edge, rate: rate, isActive: true)
        }
        return .inactive
    }
}
