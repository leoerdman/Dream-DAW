import Foundation
import AVFoundation
import AppKit
import DreamDAWModels
import os.log
import CoreAudioKit

/// Manages instantiation and lifecycle of external VST/AU plugins.
/// Handles GUI request and parameter synchronization.
public final class PluginHost {
    
    public static let shared = PluginHost()
    
    private let logger = Logger(subsystem: "com.dreamdaw", category: "PluginHost")
    
    /// Active instances of external plugins.
    /// Key: Instance ID (likely associated with AudioEffectConfig or InstrumentConfig ID)
    private var instances: [UUID: AVAudioUnit] = [:]
    
    private init() {}
    
    /// Instantiates a plugin from its path/identifier.
    /// This is an asynchronous operation.
    public func instantiate(identifier: String, type: InstrumentType, completion: @escaping (AVAudioUnit?, Error?) -> Void) {
        
        // --- Robust Discovery ---
        // Instead of guessing description, we search for the component by name or bundle ID
        // We look for MusicDevice (Instruments), Effect (FX), and MusicEffect (MIDI-enabled FX)
        let manager = AVAudioUnitComponentManager.shared()
        let allTypes: [OSType] = [kAudioUnitType_MusicDevice, kAudioUnitType_Effect, kAudioUnitType_MusicEffect]
        
        var foundComponent: AVAudioUnitComponent? = nil
        
        for type in allTypes {
            var desc = AudioComponentDescription()
            desc.componentType = type
            let components = manager.components(matching: desc)
            
            if let component = components.first(where: { cp in
                let matchesPath = (cp.componentURL?.path == identifier)
                let nameMatches = (cp.name == identifier)
                
                // Fuzzy match: if it's a VST path, try matching the product name
                let fileName = URL(fileURLWithPath: identifier).deletingPathExtension().lastPathComponent
                let matchesFileName = !fileName.isEmpty && (cp.name.localizedCaseInsensitiveContains(fileName) || fileName.localizedCaseInsensitiveContains(cp.name))
                
                return matchesPath || nameMatches || matchesFileName
            }) {
                foundComponent = component
                self.logger.info("PluginHost: Found component '\(component.name, privacy: .public)' for identifier '\(identifier, privacy: .public)' using type \(type)")
                break
            }
        }
        
        guard let targetComponent = foundComponent else {
            self.logger.error("PluginHost: FAILED to find plugin component for: \(identifier, privacy: .public) across all types.")
            completion(nil, NSError(domain: "PluginHost", code: -1, userInfo: [NSLocalizedDescriptionKey: "Plugin not found: \(identifier)"]))
            return
        }

        AVAudioUnit.instantiate(with: targetComponent.audioComponentDescription, options: []) { unit, error in
            if let error = error {
                self.logger.error("PluginHost: FAILED to instantiate \(identifier, privacy: .public): \(error.localizedDescription)")
                completion(nil, error)
                return
            }
            
            if let unit = unit {
                self.logger.info("PluginHost: SUCCESS instantiated \(identifier, privacy: .public) (Unit Name: \(unit.name, privacy: .public))")
                completion(unit, nil)
            } else {
                self.logger.error("PluginHost: FAILED to instantiate \(identifier, privacy: .public) - No unit and no error returned")
                completion(nil, nil)
            }
        }
    }
    
    /// Requests the native GUI for a plugin.
    public func requestEditor(for unit: AVAudioUnit, completion: @escaping (NSViewController?) -> Void) {
        let name = unit.name
        self.logger.info("PluginHost: Requesting view controller for \(name, privacy: .public)...")
        
        // Ensure we are not on the audio thread if possible, though requestViewController is async
        unit.auAudioUnit.requestViewController { viewController in
            if let vc = viewController {
                self.logger.info("PluginHost: Plugin \(name, privacy: .public) returned view controller successfully. Preferred size: \(vc.preferredContentSize.width)x\(vc.preferredContentSize.height)")
            } else {
                self.logger.warning("PluginHost: Plugin \(name, privacy: .public) returned NO view controller.")
            }
            
            DispatchQueue.main.async {
                completion(viewController)
            }
        }
    }
    
    public func registerInstance(_ id: UUID, unit: AVAudioUnit) {
        instances[id] = unit
    }
    
    public func getInstance(_ id: UUID) -> AVAudioUnit? {
        instances[id]
    }
    
    public func getLatency(for id: UUID) -> Double {
        return instances[id]?.auAudioUnit.latency ?? 0.0
    }

    public func removeInstance(_ id: UUID) {
        instances.removeValue(forKey: id)
    }

    /// Safe accessor for the lock-free MIDI block.
    /// Call this BEFORE starting playback to avoid ObjC runtime locks on the audio thread.
    public func getScheduleMIDIBlock(for id: UUID) -> AUScheduleMIDIEventBlock? {
        guard let instance = instances[id] else { return nil }
        let block: AUScheduleMIDIEventBlock? = instance.auAudioUnit.scheduleMIDIEventBlock
        return block
    }
}
