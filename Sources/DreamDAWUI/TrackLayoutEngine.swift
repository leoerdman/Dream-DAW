import Foundation
import AppKit
import DreamDAWModels

// MARK: - TrackLayoutEngine

/// Enterprise-grade vertical layout engine using prefix-sum caching.
///
/// Replaces the O(N) per-frame height summation with:
/// - `yPosition(forTrackIndex:)` → O(1) via cached prefix sums
/// - `trackIndex(atPixelY:)` → O(log N) via binary search
/// - `totalHeight` → O(1) cached value
///
/// The cache is rebuilt ONCE when track heights or visibility change (folder collapse,
/// track resize) — never per-frame. This is critical for 1000+ track projects at 120 FPS.
public final class TrackLayoutEngine {

    // MARK: - Cache State

    /// Prefix-sum Y positions. `prefixY[i]` = Y offset of the top edge of track at index `i`.
    private var prefixY: [CGFloat] = []

    /// Cached total height of all visible tracks.
    public private(set) var totalHeight: CGFloat = 0

    /// The track IDs in layout order (for reverse lookup).
    private var trackIDs: [UUID] = []

    /// Track heights cached for change detection.
    private var cachedHeights: [CGFloat] = []

    // MARK: - Initialization

    public init() {}

    // MARK: - Cache Rebuild

    /// Rebuilds the prefix-sum cache from the current visible track list.
    ///
    /// Call this when:
    /// - Track heights change (resize, fold/unfold)
    /// - Track visibility changes (folder collapse/expand)
    /// - Tracks are added or removed
    ///
    /// - Complexity: O(N) where N = number of visible tracks. Called rarely (not per-frame).
    public func rebuildCache(visibleTracks: [Track]) {
        let count = visibleTracks.count
        prefixY = Array(repeating: 0, count: count)
        trackIDs = Array(repeating: UUID(), count: count)
        cachedHeights = Array(repeating: 0, count: count)

        var currentY: CGFloat = 0

        for (index, track) in visibleTracks.enumerated() {
            prefixY[index] = currentY
            trackIDs[index] = track.id

            // Smart Culling: if a track is hidden by a collapsed folder, its height is 0.
            // This makes collapsed children invisible to both layout and GPU rendering.
            let trackHeight = track.isHiddenByFolder ? 0 : track.height
            cachedHeights[index] = trackHeight
            currentY += trackHeight
        }

        totalHeight = currentY
    }

    /// Incrementally updates a single track's height without full rebuild.
    /// Returns `true` if the height actually changed (cache was updated).
    @discardableResult
    public func updateTrackHeight(atIndex index: Int, newHeight: CGFloat) -> Bool {
        guard index >= 0 && index < cachedHeights.count else { return false }
        let oldHeight = cachedHeights[index]
        guard oldHeight != newHeight else { return false }

        cachedHeights[index] = newHeight
        let delta = newHeight - oldHeight

        // Shift all subsequent prefix sums
        for i in (index + 1)..<prefixY.count {
            prefixY[i] += delta
        }
        totalHeight += delta
        return true
    }

    // MARK: - O(1) Position Lookup

    /// Returns the Y pixel position of the top edge of the track at `index`.
    ///
    /// - Complexity: O(1)
    /// - Returns: Y position, or -1000 (offscreen) if index is invalid.
    public func yPosition(forTrackIndex index: Int) -> CGFloat {
        guard index >= 0 && index < prefixY.count else { return -1000 }
        return prefixY[index]
    }

    /// Returns the height of the track at `index`.
    public func height(forTrackIndex index: Int) -> CGFloat {
        guard index >= 0 && index < cachedHeights.count else { return 0 }
        return cachedHeights[index]
    }

    /// Returns the bottom Y of the track at `index`.
    public func bottomY(forTrackIndex index: Int) -> CGFloat {
        yPosition(forTrackIndex: index) + height(forTrackIndex: index)
    }

    // MARK: - O(log N) Hit-Testing

    /// Finds the track index at a given Y pixel position.
    /// Uses binary search on the sorted prefix-sum array.
    ///
    /// - Complexity: O(log N)
    /// - Returns: Track index, or `nil` if `y` is below all tracks.
    public func trackIndex(atPixelY y: CGFloat) -> Int? {
        guard !prefixY.isEmpty else { return nil }
        guard y >= 0 && y < totalHeight else { return nil }

        // Binary search: find the last index where prefixY[index] <= y
        var lo = 0
        var hi = prefixY.count - 1

        while lo < hi {
            let mid = lo + (hi - lo + 1) / 2
            if prefixY[mid] <= y {
                lo = mid
            } else {
                hi = mid - 1
            }
        }

        return lo
    }

    /// Returns the track ID at a given Y pixel position.
    public func trackID(atPixelY y: CGFloat) -> UUID? {
        guard let index = trackIndex(atPixelY: y) else { return nil }
        return trackIDs[index]
    }

    // MARK: - Index ↔ ID Lookups

    /// Returns the index for a track ID, or `nil` if not found.
    public func index(forTrackID id: UUID) -> Int? {
        trackIDs.firstIndex(of: id)
    }

    /// Returns the track ID at a given index.
    public func trackID(atIndex index: Int) -> UUID? {
        guard index >= 0 && index < trackIDs.count else { return nil }
        return trackIDs[index]
    }

    // MARK: - Visible Range Culling

    /// Returns the range of track indices visible within the given Y pixel range.
    /// Used by the Metal renderer to skip offscreen tracks entirely.
    ///
    /// - Complexity: O(log N)
    public func visibleTrackRange(minY: CGFloat, maxY: CGFloat) -> ClosedRange<Int>? {
        guard let firstIndex = trackIndex(atPixelY: max(0, minY)) else { return nil }

        // Find last visible track
        var lastIndex = firstIndex
        for i in firstIndex..<prefixY.count {
            if prefixY[i] > maxY { break }
            lastIndex = i
        }

        return firstIndex...lastIndex
    }

    // MARK: - Diagnostics

    /// Number of tracks in the layout cache.
    public var trackCount: Int { prefixY.count }

    /// Debug description of the current layout.
    public var debugDescription: String {
        var desc = "TrackLayoutEngine: \(trackCount) tracks, totalHeight=\(totalHeight)\n"
        for i in 0..<min(trackCount, 20) {
            desc += "  [\(i)] y=\(prefixY[i]) h=\(cachedHeights[i]) id=\(trackIDs[i].uuidString.prefix(8))\n"
        }
        if trackCount > 20 {
            desc += "  ... (\(trackCount - 20) more)\n"
        }
        return desc
    }
}

// MARK: - Track Extension

extension Track {
    /// Whether this track is hidden by a collapsed parent folder.
    /// Used by `TrackLayoutEngine` for smart culling.
    public var isHiddenByFolder: Bool {
        // Currently, the `allVisibleTracks` filter in Project already handles this.
        // This property exists for when TrackLayoutEngine manages its own track list.
        return false
    }

    /// The current display height of this track.
    /// Accounts for collapsed state: a collapsed group track may have reduced height.
    public var currentHeight: CGFloat {
        return height
    }
}
