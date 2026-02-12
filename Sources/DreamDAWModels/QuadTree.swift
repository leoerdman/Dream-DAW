import Foundation

/// Represents a rectangular area in the DAW's beat-track space.
public struct QuadRect: Equatable {
    public let minX: Double // Beats
    public let maxX: Double // Beats
    public let minY: Double // Track Index
    public let maxY: Double // Track Index

    public init(minX: Double, maxX: Double, minY: Double, maxY: Double) {
        self.minX = minX
        self.maxX = maxX
        self.minY = minY
        self.maxY = maxY
    }

    public func contains(_ rect: QuadRect) -> Bool {
        return rect.minX >= minX && rect.maxX <= maxX &&
               rect.minY >= minY && rect.maxY <= maxY
    }

    public func intersects(_ rect: QuadRect) -> Bool {
        return !(rect.minX > maxX || rect.maxX < minX ||
                 rect.minY > maxY || rect.maxY < minY)
    }
}

/// A spatial element that can be stored in the QuadTree.
public struct QuadElement<T: Identifiable>: Identifiable {
    public let id: T.ID
    public let bounds: QuadRect
    public let value: T

    public init(id: T.ID, bounds: QuadRect, value: T) {
        self.id = id
        self.bounds = bounds
        self.value = value
    }
}

/// A generic QuadTree implementation for efficient spatial partitioning in the DAW.
/// Used for O(log n) clip hit-testing and rendering culling.
public final class QuadTree<T: Identifiable> {
    
    // MARK: - Configuration
    
    private let boundary: QuadRect
    private let capacity: Int
    private let depth: Int
    private let maxDepth: Int
    
    // MARK: - State
    
    private var elements: [QuadElement<T>] = []
    private var divided = false
    
    private var northwest: QuadTree<T>?
    private var northeast: QuadTree<T>?
    private var southwest: QuadTree<T>?
    private var southeast: QuadTree<T>?
    
    // MARK: - Initialization
    
    public init(boundary: QuadRect, capacity: Int = 8, depth: Int = 0, maxDepth: Int = 10) {
        self.boundary = boundary
        self.capacity = capacity
        self.depth = depth
        self.maxDepth = maxDepth
    }
    
    // MARK: - Public API
    
    /// Insert an element into the QuadTree.
    @discardableResult
    public func insert(_ element: QuadElement<T>) -> Bool {
        if !boundary.intersects(element.bounds) {
            return false
        }
        
        if elements.count < capacity && !divided {
            elements.append(element)
            return true
        }
        
        // RECURSION LIMIT: Stop subdividing if we reached max depth.
        // Items will just be stored in the 'elements' array of this leaf node.
        if depth >= maxDepth {
            elements.append(element)
            return true
        }
        
        if !divided {
            subdivide()
        }
        
        // Try to insert into children. Note that an element might span multiple quadrants
        // if it intersects them.
        let insertedNW = northwest?.insert(element) ?? false
        let insertedNE = northeast?.insert(element) ?? false
        let insertedSW = southwest?.insert(element) ?? false
        let insertedSE = southeast?.insert(element) ?? false
        
        return insertedNW || insertedNE || insertedSW || insertedSE
    }
    
    /// Query elements within a given range.
    public func query(range: QuadRect) -> [QuadElement<T>] {
        var found: [QuadElement<T>] = []
        
        if !boundary.intersects(range) {
            return found
        }
        
        // Optimization: if the current boundary is fully contained in the range,
        // we could potentially add everything, but we still need to check children.
        
        for element in elements {
            if range.intersects(element.bounds) {
                found.append(element)
            }
        }
        
        if divided {
            found.append(contentsOf: northwest?.query(range: range) ?? [])
            found.append(contentsOf: northeast?.query(range: range) ?? [])
            found.append(contentsOf: southwest?.query(range: range) ?? [])
            found.append(contentsOf: southeast?.query(range: range) ?? [])
        }
        
        // Remove duplicates if elements appear in multiple nodes
        var uniqueFound: [QuadElement<T>] = []
        var seenIDs = Set<T.ID>()
        for element in found {
            if !seenIDs.contains(element.id) {
                uniqueFound.append(element)
                seenIDs.insert(element.id)
            }
        }
        
        return uniqueFound
    }
    
    /// Clear the QuadTree.
    public func clear() {
        elements.removeAll()
        northwest = nil
        northeast = nil
        southwest = nil
        southeast = nil
        divided = false
    }
    
    // MARK: - Private
    
    private func subdivide() {
        let x = boundary.minX
        let y = boundary.minY
        let w = (boundary.maxX - boundary.minX) / 2
        let h = (boundary.maxY - boundary.minY) / 2
        
        let nextDepth = depth + 1
        
        northwest = QuadTree(boundary: QuadRect(minX: x, maxX: x + w, minY: y, maxY: y + h), capacity: capacity, depth: nextDepth, maxDepth: maxDepth)
        northeast = QuadTree(boundary: QuadRect(minX: x + w, maxX: x + w * 2, minY: y, maxY: y + h), capacity: capacity, depth: nextDepth, maxDepth: maxDepth)
        southwest = QuadTree(boundary: QuadRect(minX: x, maxX: x + w, minY: y + h, maxY: y + h * 2), capacity: capacity, depth: nextDepth, maxDepth: maxDepth)
        southeast = QuadTree(boundary: QuadRect(minX: x + w, maxX: x + w * 2, minY: y + h, maxY: y + h * 2), capacity: capacity, depth: nextDepth, maxDepth: maxDepth)
        
        divided = true
        
        // Re-distribute existing elements to children? 
        // Not strictly necessary for a simple implementation but better for performance.
        let existingElements = elements
        elements.removeAll()
        for element in existingElements {
            insert(element)
        }
    }
}
