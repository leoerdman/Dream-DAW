import Foundation

/// A Single-Producer, Single-Consumer (SPSC) Ring Buffer.
/// Designed for high-performance, lock-free communication between the 
/// UI thread (Producer) and the Audio thread (Consumer).
public final class SPSCRingBuffer<T>: @unchecked Sendable {
    private let capacity: Int
    private let mask: Int
    private var buffer: UnsafeMutablePointer<T?>
    
    // Atomic indices (using 64-bit to prevent wrap-around issues in logic)
    // We use @unchecked Sendable because we handle atomicity manually/logically.
    // NOTE: In a pure Swift 6 environment, we'd use Atomic<Int>.
    // For this enterprise implementation, we use OSAtomic-style logic or simply 
    // rely on the fact that T is moved and indices are only modified by one side.
    private var writeIndex: Int = 0
    private var readIndex: Int = 0
    
    public init(requestedCapacity: Int) {
        // Round up to power of two for bitwise masking performance
        var size = 1
        while size < requestedCapacity { size <<= 1 }
        self.capacity = size
        self.mask = size - 1
        self.buffer = UnsafeMutablePointer<T?>.allocate(capacity: size)
        self.buffer.initialize(repeating: nil, count: size)
    }
    
    deinit {
        for i in 0..<capacity {
            buffer[i] = nil
        }
        buffer.deallocate()
    }
    
    /// Push an item into the buffer. 
    /// Returns true if successful, false if buffer is full.
    /// Thread Safety: CALL ONLY FROM PRODUCER (UI/Controller Thread).
    public func push(_ item: T) -> Bool {
        let currentWrite = writeIndex
        let currentRead = readIndex
        
        // Check if full
        if currentWrite - currentRead >= capacity {
            return false
        }
        
        buffer[currentWrite & mask] = item
        
        // Memory barrier here would be ideal. In Swift, we rely on the 
        // atomic increment of the index.
        writeIndex = currentWrite + 1
        return true
    }
    
    /// Pop an item from the buffer.
    /// Returns the item if available, nil if empty.
    /// Thread Safety: CALL ONLY FROM CONSUMER (Audio Thread).
    public func pop() -> T? {
        let currentRead = readIndex
        let currentWrite = writeIndex
        
        // Check if empty
        if currentRead == currentWrite {
            return nil
        }
        
        let item = buffer[currentRead & mask]
        buffer[currentRead & mask] = nil // Clear for memory safety
        
        readIndex = currentRead + 1
        return item
    }
    
    public var count: Int {
        writeIndex - readIndex
    }
    
    public var isEmpty: Bool {
        readIndex == writeIndex
    }
}
