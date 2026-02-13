import Foundation
import CoreAudio

/// Enumerates CoreAudio output devices on macOS.
public enum AudioDeviceEnumerator {
    
    /// List all available input audio devices.
    public static func listInputDevices() -> [(name: String, uid: String)] {
        var propertyAddress = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        
        var dataSize: UInt32 = 0
        var status = AudioObjectGetPropertyDataSize(
            AudioObjectID(kAudioObjectSystemObject),
            &propertyAddress,
            0, nil,
            &dataSize
        )
        guard status == noErr else { return [] }
        
        let deviceCount = Int(dataSize) / MemoryLayout<AudioDeviceID>.size
        var deviceIDs = [AudioDeviceID](repeating: 0, count: deviceCount)
        
        status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &propertyAddress,
            0, nil,
            &dataSize,
            &deviceIDs
        )
        guard status == noErr else { return [] }
        
        var devices: [(name: String, uid: String)] = []
        
        for deviceID in deviceIDs {
            // Check if device has input channels
            var inputAddress = AudioObjectPropertyAddress(
                mSelector: kAudioDevicePropertyStreamConfiguration,
                mScope: kAudioObjectPropertyScopeInput,
                mElement: kAudioObjectPropertyElementMain
            )
            
            var inputSize: UInt32 = 0
            status = AudioObjectGetPropertyDataSize(deviceID, &inputAddress, 0, nil, &inputSize)
            guard status == noErr, inputSize > 0 else { continue }
            
            let bufferListPtr = UnsafeMutablePointer<AudioBufferList>.allocate(capacity: 1)
            defer { bufferListPtr.deallocate() }
            
            status = AudioObjectGetPropertyData(deviceID, &inputAddress, 0, nil, &inputSize, bufferListPtr)
            guard status == noErr else { continue }
            
            let bufferList = UnsafePointer(bufferListPtr).pointee
            let inputChannels = bufferList.mBuffers.mNumberChannels
            guard inputChannels > 0 else { continue }
            
            // Get device name
            var nameAddress = AudioObjectPropertyAddress(
                mSelector: kAudioDevicePropertyDeviceNameCFString,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain
            )
            
            var nameRef: CFString = "" as CFString
            var nameSize = UInt32(MemoryLayout<CFString>.size)
            status = AudioObjectGetPropertyData(deviceID, &nameAddress, 0, nil, &nameSize, &nameRef)
            let name = status == noErr ? nameRef as String : "Unknown Device"
            
            // Get device UID
            var uidAddress = AudioObjectPropertyAddress(
                mSelector: kAudioDevicePropertyDeviceUID,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain
            )
            
            var uidRef: CFString = "" as CFString
            var uidSize = UInt32(MemoryLayout<CFString>.size)
            status = AudioObjectGetPropertyData(deviceID, &uidAddress, 0, nil, &uidSize, &uidRef)
            let uid = status == noErr ? uidRef as String : ""
            
            if !uid.isEmpty {
                // Get input channel count
                var inChannelCount: UInt32 = 0
                let audioBuffers = UnsafeMutableAudioBufferListPointer(bufferListPtr)
                for buf in audioBuffers {
                    inChannelCount += buf.mNumberChannels
                }
                
                // Also get output channel count for the same device to show "N In, M Out"
                var outputAddress = AudioObjectPropertyAddress(
                    mSelector: kAudioDevicePropertyStreamConfiguration,
                    mScope: kAudioObjectPropertyScopeOutput,
                    mElement: kAudioObjectPropertyElementMain
                )
                var outChannelCount: UInt32 = 0
                var outputSize: UInt32 = 0
                status = AudioObjectGetPropertyDataSize(deviceID, &outputAddress, 0, nil, &outputSize)
                if status == noErr && outputSize > 0 {
                    let outBufferListPtr = UnsafeMutablePointer<AudioBufferList>.allocate(capacity: 1)
                    defer { outBufferListPtr.deallocate() }
                    status = AudioObjectGetPropertyData(deviceID, &outputAddress, 0, nil, &outputSize, outBufferListPtr)
                    if status == noErr {
                        let outAudioBuffers = UnsafeMutableAudioBufferListPointer(outBufferListPtr)
                        for buf in outAudioBuffers {
                            outChannelCount += buf.mNumberChannels
                        }
                    }
                }

                devices.append((
                    name: "\(name) (\(inChannelCount) In, \(outChannelCount) Out)",
                    uid: uid
                ))
            }
        }
        
        return devices
    }

    /// List all available output audio devices.
    public static func listOutputDevices() -> [(name: String, uid: String)] {
        var propertyAddress = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        
        var dataSize: UInt32 = 0
        var status = AudioObjectGetPropertyDataSize(
            AudioObjectID(kAudioObjectSystemObject),
            &propertyAddress,
            0, nil,
            &dataSize
        )
        guard status == noErr else { return [] }
        
        let deviceCount = Int(dataSize) / MemoryLayout<AudioDeviceID>.size
        var deviceIDs = [AudioDeviceID](repeating: 0, count: deviceCount)
        
        status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &propertyAddress,
            0, nil,
            &dataSize,
            &deviceIDs
        )
        guard status == noErr else { return [] }
        
        var devices: [(name: String, uid: String)] = []
        
        for deviceID in deviceIDs {
            // Check if device has output channels
            var outputAddress = AudioObjectPropertyAddress(
                mSelector: kAudioDevicePropertyStreamConfiguration,
                mScope: kAudioDevicePropertyScopeOutput,
                mElement: kAudioObjectPropertyElementMain
            )
            
            var outputSize: UInt32 = 0
            status = AudioObjectGetPropertyDataSize(deviceID, &outputAddress, 0, nil, &outputSize)
            guard status == noErr, outputSize > 0 else { continue }
            
            let bufferListPtr = UnsafeMutablePointer<AudioBufferList>.allocate(capacity: 1)
            defer { bufferListPtr.deallocate() }
            
            status = AudioObjectGetPropertyData(deviceID, &outputAddress, 0, nil, &outputSize, bufferListPtr)
            guard status == noErr else { continue }
            
            let bufferList = UnsafePointer(bufferListPtr).pointee
            let outputChannels = bufferList.mBuffers.mNumberChannels
            guard outputChannels > 0 else { continue }
            
            // Get device name
            var nameAddress = AudioObjectPropertyAddress(
                mSelector: kAudioDevicePropertyDeviceNameCFString,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain
            )
            
            var nameRef: CFString = "" as CFString
            var nameSize = UInt32(MemoryLayout<CFString>.size)
            status = AudioObjectGetPropertyData(deviceID, &nameAddress, 0, nil, &nameSize, &nameRef)
            let name = status == noErr ? nameRef as String : "Unknown Device"
            
            // Get device UID
            var uidAddress = AudioObjectPropertyAddress(
                mSelector: kAudioDevicePropertyDeviceUID,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain
            )
            
            var uidRef: CFString = "" as CFString
            var uidSize = UInt32(MemoryLayout<CFString>.size)
            status = AudioObjectGetPropertyData(deviceID, &uidAddress, 0, nil, &uidSize, &uidRef)
            let uid = status == noErr ? uidRef as String : ""
            
            if !uid.isEmpty {
                // Get output channel count for display
                var outChannelCount: UInt32 = 0
                let audioBuffers = UnsafeMutableAudioBufferListPointer(bufferListPtr)
                for buf in audioBuffers {
                    outChannelCount += buf.mNumberChannels
                }
                
                devices.append((
                    name: "\(name) (\(outChannelCount) Out)",
                    uid: uid
                ))
            }
        }
        
        return devices
    }
    
    /// Get the UID of the default output device.
    public static func defaultOutputDeviceUID() -> String? {
        var propertyAddress = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        
        var deviceID: AudioDeviceID = 0
        var dataSize = UInt32(MemoryLayout<AudioDeviceID>.size)
        
        let status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &propertyAddress,
            0, nil,
            &dataSize,
            &deviceID
        )
        guard status == noErr else { return nil }
        
        var uidAddress = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDeviceUID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        
        var uidRef: CFString = "" as CFString
        var uidSize = UInt32(MemoryLayout<CFString>.size)
        
        let uidStatus = AudioObjectGetPropertyData(deviceID, &uidAddress, 0, nil, &uidSize, &uidRef)
        return uidStatus == noErr ? uidRef as String : nil
    }
    
    /// Get the sample rate for a device by UID.
    public static func sampleRateForDevice(uid: String) -> Double? {
        guard let deviceID = deviceIDForUID(uid) else { return nil }
        
        var propertyAddress = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyNominalSampleRate,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        
        var sampleRate: Float64 = 0
        var dataSize = UInt32(MemoryLayout<Float64>.size)
        
        let status = AudioObjectGetPropertyData(deviceID, &propertyAddress, 0, nil, &dataSize, &sampleRate)
        return status == noErr ? sampleRate : nil
    }
    
    /// Get the buffer size for a device by UID.
    public static func bufferSizeForDevice(uid: String) -> Int? {
        guard let deviceID = deviceIDForUID(uid) else { return nil }
        
        var propertyAddress = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyBufferFrameSize,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        
        var bufferSize: UInt32 = 0
        var dataSize = UInt32(MemoryLayout<UInt32>.size)
        
        let status = AudioObjectGetPropertyData(deviceID, &propertyAddress, 0, nil, &dataSize, &bufferSize)
        return status == noErr ? Int(bufferSize) : nil
    }
    
    /// Set the buffer size for a device by UID.
    public static func setBufferSizeForDevice(uid: String, size: UInt32) {
        guard let deviceID = deviceIDForUID(uid) else { return }
        
        var propertyAddress = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyBufferFrameSize,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        
        var bufferSize = size
        let dataSize = UInt32(MemoryLayout<UInt32>.size)
        
        let status = AudioObjectSetPropertyData(deviceID, &propertyAddress, 0, nil, dataSize, &bufferSize)
        if status != noErr {
            print("AudioDeviceEnumerator: Failed to set buffer size for device \(uid): \(status)")
        }
    }

    /// Set the sample rate for a device by UID.
    public static func setSampleRateForDevice(uid: String, rate: Double) {
        guard let deviceID = deviceIDForUID(uid) else { return }

        var propertyAddress = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyNominalSampleRate,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )

        var sampleRate = Float64(rate)
        let dataSize = UInt32(MemoryLayout<Float64>.size)

        let status = AudioObjectSetPropertyData(deviceID, &propertyAddress, 0, nil, dataSize, &sampleRate)
        if status != noErr {
            print("AudioDeviceEnumerator: Failed to set sample rate for device \(uid): \(status)")
        }
    }
    
    private static func deviceIDForUID(_ uid: String) -> AudioDeviceID? {
        var propertyAddress = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        
        var dataSize: UInt32 = 0
        var status = AudioObjectGetPropertyDataSize(
            AudioObjectID(kAudioObjectSystemObject),
            &propertyAddress,
            0, nil,
            &dataSize
        )
        guard status == noErr else { return nil }
        
        let deviceCount = Int(dataSize) / MemoryLayout<AudioDeviceID>.size
        var deviceIDs = [AudioDeviceID](repeating: 0, count: deviceCount)
        
        status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &propertyAddress,
            0, nil,
            &dataSize,
            &deviceIDs
        )
        guard status == noErr else { return nil }
        
        for deviceID in deviceIDs {
            var uidAddress = AudioObjectPropertyAddress(
                mSelector: kAudioDevicePropertyDeviceUID,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain
            )
            
            var uidRef: CFString = "" as CFString
            var uidSize = UInt32(MemoryLayout<CFString>.size)
            let uidStatus = AudioObjectGetPropertyData(deviceID, &uidAddress, 0, nil, &uidSize, &uidRef)
            
            if uidStatus == noErr, (uidRef as String) == uid {
                return deviceID
            }
        }
        
        return nil
    }
}
