import Foundation
import AVFoundation
import AppKit
import DreamDAWModels
import os.log
import CoreAudioKit

/// Manages instantiation and lifecycle of external VST/AU plugins.
/// Handles GUI request and parameter synchronization.
public final class PluginHost {
    public enum Usage {
        case instrument
        case effect
    }
    
    public static let shared = PluginHost()
    
    private let logger = Logger(subsystem: "com.dreamdaw", category: "PluginHost")
    
    /// Active instances of external plugins.
    /// Key: Instance ID (likely associated with AudioEffectConfig or InstrumentConfig ID)
    private var instances: [UUID: AVAudioUnit] = [:]
    
    private init() {}
    
    /// Backward-compatible wrapper.
    public func instantiate(identifier: String, type: InstrumentType, completion: @escaping (AVAudioUnit?, Error?) -> Void) {
        let usage: Usage = (type == .vst2 || type == .vst3) ? .instrument : .effect
        instantiate(identifier: identifier, usage: usage, completion: completion)
    }

    /// Instantiates a plugin from path/name via AU component manager.
    /// This host path is AU-based (VST bundles are matched to their AU counterparts by name).
    public func instantiate(identifier: String, usage: Usage, completion: @escaping (AVAudioUnit?, Error?) -> Void) {
        guard let targetComponent = findBestComponent(for: identifier, usage: usage) else {
            self.logger.error("PluginHost: FAILED to find plugin component for: \(identifier, privacy: .public)")
            completion(nil, NSError(domain: "PluginHost", code: -1, userInfo: [NSLocalizedDescriptionKey: "Plugin not found: \(identifier)"]))
            return
        }

        AVAudioUnit.instantiate(with: targetComponent.audioComponentDescription, options: [.loadOutOfProcess]) { unit, error in
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

    private func findBestComponent(for identifier: String, usage: Usage) -> AVAudioUnitComponent? {
        let manager = AVAudioUnitComponentManager.shared()
        let allTypes: [OSType] = [kAudioUnitType_MusicDevice, kAudioUnitType_MusicEffect, kAudioUnitType_Effect]

        var best: (component: AVAudioUnitComponent, score: Int)?
        for componentType in allTypes {
            var desc = AudioComponentDescription()
            desc.componentType = componentType
            let components = manager.components(matching: desc)
            for component in components {
                let score = componentMatchScore(component, identifier: identifier, usage: usage)
                guard score > 0 else { continue }
                if best == nil || score > best!.score {
                    best = (component, score)
                }
            }
        }

        if let winner = best {
            self.logger.info("PluginHost: Matched '\(identifier, privacy: .public)' -> '\(winner.component.name, privacy: .public)' score=\(winner.score)")
            return winner.component
        }
        return nil
    }

    private func componentMatchScore(_ component: AVAudioUnitComponent, identifier: String, usage: Usage) -> Int {
        let identifierURL = URL(fileURLWithPath: identifier)
        let identifierPath = identifierURL.standardizedFileURL.path
        let identifierBase = identifierURL.deletingPathExtension().lastPathComponent
        let normalizedIdentifier = normalizedToken(identifierBase.isEmpty ? identifier : identifierBase)
        let normalizedName = normalizedToken(component.name)
        let normalizedManufacturer = normalizedToken(component.manufacturerName)
        let normalizedType = normalizedToken(component.typeName)
        let componentPath = component.componentURL?.standardizedFileURL.path
        let componentType = component.audioComponentDescription.componentType

        var score = 0

        // Usage-based priority: instrument-like vs effect-like components.
        switch usage {
        case .instrument:
            if componentType == kAudioUnitType_MusicDevice { score += 120 }
            if componentType == kAudioUnitType_MusicEffect { score += 60 }
        case .effect:
            if componentType == kAudioUnitType_Effect { score += 120 }
            if componentType == kAudioUnitType_MusicEffect { score += 80 }
        }

        if identifierPath == componentPath { score += 400 }
        if component.name == identifier { score += 260 }
        if normalizedIdentifier == normalizedName { score += 220 }

        if !normalizedIdentifier.isEmpty {
            if normalizedName.contains(normalizedIdentifier) || normalizedIdentifier.contains(normalizedName) {
                score += 140
            }
            if normalizedManufacturer.contains(normalizedIdentifier) || normalizedType.contains(normalizedIdentifier) {
                score += 60
            }
        }

        // If identifier points to a plugin bundle, match by bundle ID where possible.
        if let requestedBundleID = Bundle(url: identifierURL)?.bundleIdentifier,
           let componentBundleURL = component.componentURL,
           let componentBundleID = Bundle(url: componentBundleURL)?.bundleIdentifier,
           requestedBundleID == componentBundleID {
            score += 300
        }

        return score
    }

    private func normalizedToken(_ input: String) -> String {
        let folded = input.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: .current)
        let filtered = folded.unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) }
        return String(String.UnicodeScalarView(filtered)).lowercased()
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
