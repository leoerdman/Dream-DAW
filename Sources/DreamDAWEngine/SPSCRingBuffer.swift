import Foundation
import Atomics

/// A Wait-Free Single-Producer Single-Consumer Ring Buffer.
/// Optimized for Audio Thread usage: Zero allocations, Zero locks, Raw Pointers.
public final class SPSCRingBuffer<T>: @unchecked Sendable {
    private let capacity: Int
    private let mask: Int
    private let buffer: UnsafeMutablePointer<T?>
    
    // Atomic indices
    // writeIndex: Owned by Producer.
    // readIndex: Owned by Consumer.
    private let writeIndex: ManagedAtomic<Int>
    private let readIndex: ManagedAtomic<Int>
    
    public init(capacity: Int) {
        // Enforce Power of Two
        precondition(capacity > 0 && (capacity & (capacity - 1)) == 0, "SPSCRingBuffer capacity must be a power of 2")
        
        self.capacity = capacity
        self.mask = capacity - 1
        
        // Allocate raw memory
        self.buffer = UnsafeMutablePointer<T?>.allocate(capacity: capacity)
        self.buffer.initialize(repeating: nil, count: capacity)
        
        self.writeIndex = ManagedAtomic(0)
        self.readIndex = ManagedAtomic(0)
    }
    
    deinit {
        // Cleanup
        buffer.deinitialize(count: capacity)
        buffer.deallocate()
    }
    
    /// Push item (PRODUCER ONLY).
    /// Safe to call from Background Task.
    public func push(_ item: T) -> Bool {
        let currentWrite = writeIndex.load(ordering: .relaxed)
        let currentRead = readIndex.load(ordering: .acquiring)
        
        if currentWrite - currentRead >= capacity {
            return false // Full
        }
        
        // Write data
        buffer[currentWrite & mask] = item
        
        // Publish write
        writeIndex.store(currentWrite + 1, ordering: .releasing)
        return true
    }
    
    /// Pop item (CONSUMER ONLY).
    /// Safe to call from Audio Thread.
    public func pop() -> T? {
        let currentRead = readIndex.load(ordering: .relaxed)
        let currentWrite = writeIndex.load(ordering: .acquiring)
        
        if currentRead == currentWrite {
            return nil // Empty
        }
        
        // Read data
        let item = buffer[currentRead & mask]
        buffer[currentRead & mask] = nil // Reset slot
        
        // Publish read
        readIndex.store(currentRead + 1, ordering: .releasing)
        return item
    }
    
    /// Peek at item without popping (CONSUMER ONLY).
    public func peek() -> T? {
        let currentRead = readIndex.load(ordering: .relaxed)
        let currentWrite = writeIndex.load(ordering: .acquiring)
        
        if currentRead == currentWrite {
            return nil // Empty
        }
        
        return buffer[currentRead & mask]
    }
    
    public var count: Int {
        let w = writeIndex.load(ordering: .relaxed)
        let r = readIndex.load(ordering: .relaxed)
        return w - r
    }
    
    public var isEmpty: Bool {
        return count == 0
    }
}
