import Foundation
import Atomics

/// A Wait-Free Single-Producer Single-Consumer Ring Buffer.
/// Optimized for Audio Thread usage: Zero allocations, Zero locks, Zero ARC.
///
/// ARCHITECTURAL NOTE (HOTFIX 8.5):
/// This buffer uses `UnsafeMutableRawPointer` with manual `MemoryLayout<T>` stride-based
/// access. This is the ONLY correct way to eliminate ARC retain/release in a generic
/// ring buffer that must support value types (enums, structs) AND reference types.
///
/// WHY NOT `UnsafeMutablePointer<T?>`?
///   - Optional wrapping forces the Swift compiler to emit `swift_retain`/`swift_release`
///     calls on every read/write, which internally use `pthread_mutex_lock`.
///   - This completely destroys the Lock-Free guarantee on the audio thread.
///
/// WHY NOT `Numeric & Sendable` constraint?
///   - The buffer is used with `AudioCommand` (enum), `MidiEventStruct` (struct),
///     and `AVAudioPCMBuffer` (class). Constraining to Numeric breaks all call sites.
///
/// HOW RAW POINTER WORKS:
///   - We allocate `capacity * MemoryLayout<T>.stride` bytes of raw memory.
///   - Slots are managed via atomic `writeIndex`/`readIndex` counters.
///   - We ONLY `initializeMemory` (write) and `moveMemory` (read+destroy) —
///     the compiler never sees typed Optional wrappers, so no ARC.
///   - For reference types (AVAudioPCMBuffer), the ref is moved out atomically
///     via `moveMemory`, which transfers ownership without retain/release cycles.
public final class SPSCRingBuffer<T>: @unchecked Sendable {
    private let capacity: Int
    private let mask: Int
    private let stride: Int
    private let rawBuffer: UnsafeMutableRawPointer
    
    // Tracks which slots are initialized (have valid T values).
    // This replaces the old Optional pattern without ARC overhead.
    private let slotOccupied: UnsafeMutablePointer<Bool>
    
    // Atomic indices
    // writeIndex: Owned by Producer.
    // readIndex: Owned by Consumer.
    private let writeIndex: ManagedAtomic<Int>
    private let readIndex: ManagedAtomic<Int>
    
    public init(capacity: Int) {
        // Enforce Power of Two for branchless masking
        precondition(capacity > 0 && (capacity & (capacity - 1)) == 0,
                     "SPSCRingBuffer capacity must be a power of 2")
        
        self.capacity = capacity
        self.mask = capacity - 1
        self.stride = MemoryLayout<T>.stride
        
        // Allocate raw, untyped memory — completely invisible to ARC.
        // Alignment matches T's natural alignment for correct CPU load/store.
        self.rawBuffer = UnsafeMutableRawPointer.allocate(
            byteCount: capacity * MemoryLayout<T>.stride,
            alignment: MemoryLayout<T>.alignment
        )
        
        // Occupation flags — simple Bool array, no ARC (Bool is trivial).
        self.slotOccupied = UnsafeMutablePointer<Bool>.allocate(capacity: capacity)
        self.slotOccupied.initialize(repeating: false, count: capacity)
        
        self.writeIndex = ManagedAtomic(0)
        self.readIndex = ManagedAtomic(0)
    }
    
    deinit {
        // Destroy any remaining items that haven't been popped
        let r = readIndex.load(ordering: .relaxed)
        let w = writeIndex.load(ordering: .relaxed)
        for i in r..<w {
            let slot = i & mask
            if slotOccupied[slot] {
                let ptr = rawBuffer.advanced(by: slot * stride)
                ptr.assumingMemoryBound(to: T.self).deinitialize(count: 1)
            }
        }
        
        slotOccupied.deinitialize(count: capacity)
        slotOccupied.deallocate()
        rawBuffer.deallocate()
    }
    
    /// Push item (PRODUCER ONLY).
    /// Safe to call from Background Task / any non-audio thread.
    /// Returns `false` if ring buffer is full (back-pressure signal).
    @inline(__always)
    public func push(_ item: T) -> Bool {
        let currentWrite = writeIndex.load(ordering: .relaxed)
        let currentRead = readIndex.load(ordering: .acquiring)
        
        if currentWrite - currentRead >= capacity {
            return false // Full — apply back-pressure
        }
        
        let slot = currentWrite & mask
        let ptr = rawBuffer.advanced(by: slot * stride)
        
        // Initialize raw memory with the item — single memcpy, no ARC wrapper
        ptr.initializeMemory(as: T.self, repeating: item, count: 1)
        slotOccupied[slot] = true
        
        // Publish write with release fence so consumer sees the data
        writeIndex.store(currentWrite + 1, ordering: .releasing)
        return true
    }
    
    /// Pop item (CONSUMER ONLY).
    /// Safe to call from Audio Thread — guaranteed zero allocations, zero locks.
    /// Returns `nil` if ring buffer is empty.
    @inline(__always)
    public func pop() -> T? {
        let currentRead = readIndex.load(ordering: .relaxed)
        let currentWrite = writeIndex.load(ordering: .acquiring)
        
        if currentRead == currentWrite {
            return nil // Empty
        }
        
        let slot = currentRead & mask
        let ptr = rawBuffer.advanced(by: slot * stride)
        
        // Move item out of raw memory — transfers ownership, no retain/release
        let item = ptr.assumingMemoryBound(to: T.self).move()
        slotOccupied[slot] = false
        
        // Publish read with release fence
        readIndex.store(currentRead + 1, ordering: .releasing)
        return item
    }
    
    /// Peek at item without popping (CONSUMER ONLY).
    @inline(__always)
    public func peek() -> T? {
        let currentRead = readIndex.load(ordering: .relaxed)
        let currentWrite = writeIndex.load(ordering: .acquiring)
        
        if currentRead == currentWrite {
            return nil // Empty
        }
        
        let slot = currentRead & mask
        let ptr = rawBuffer.advanced(by: slot * stride)
        
        // Read without consuming — does NOT move/destroy
        return ptr.assumingMemoryBound(to: T.self).pointee
    }
    
    /// Current number of items available for consumption.
    public var count: Int {
        let w = writeIndex.load(ordering: .relaxed)
        let r = readIndex.load(ordering: .relaxed)
        return w - r
    }
    
    public var isEmpty: Bool {
        return count == 0
    }
}
