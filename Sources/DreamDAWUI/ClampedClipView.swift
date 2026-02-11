import AppKit

// MARK: - ClampedClipView

/// A custom NSClipView that hard-clamps its bounds origin to the valid
/// document range, preventing any over-scroll (rubber-band bounce) that
/// can occur with trackpad momentum scrolling—even when elasticity is `.none`.
public final class ClampedClipView: NSClipView {

    public override func constrainBoundsRect(_ proposedBounds: NSRect) -> NSRect {
        var constrained = super.constrainBoundsRect(proposedBounds)

        guard let documentView = documentView else { return constrained }

        let docFrame = documentView.frame

        // Clamp X: can't scroll before 0 or past end of document
        let maxX = max(0, docFrame.width - constrained.width)
        constrained.origin.x = min(max(0, constrained.origin.x), maxX)

        // Clamp Y: can't scroll before 0 or past end of document
        let maxY = max(0, docFrame.height - constrained.height)
        constrained.origin.y = min(max(0, constrained.origin.y), maxY)

        return constrained
    }
}
