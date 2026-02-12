import Foundation
import DreamDAWModels
import os.log

/// Metadata for a discovered external plugin.
public struct PluginInfo: Codable, Identifiable, Sendable {
    public var id: String { path }
    public let name: String
    public let path: String
    public let type: AudioEffectType // .vst2 or .vst3
}

/// Manages discovery and scanning of VST2/VST3 plugins.
public final class PluginManager: ObservableObject {
    
    public static let shared = PluginManager()
    
    private let logger = Logger(subsystem: "com.dreamdaw", category: "PluginManager")
    
    @Published public private(set) var availablePlugins: [PluginInfo] = []
    
    private var observer: Any?
    
    private init() {
        loadCache() // Load cached plugins first for instant UI
        
        // Watch for path changes in settings
        observer = NotificationCenter.default.addObserver(
            forName: .vstPathsDidChange,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.scanAll(forceRescan: true)
        }
        
        // Initial scan in background if cache is empty or on startup
        DispatchQueue.global(qos: .background).asyncAfter(deadline: .now() + 1.0) {
            self.scanAll(forceRescan: false)
        }
    }
    
    deinit {
        if let obs = observer {
            NotificationCenter.default.removeObserver(obs)
        }
    }
    
    /// Scans both VST2 and VST3 directories configured in AppSettings.
    /// - Parameter forceRescan: If true, ignores the cache and performs a full disk scan.
    public func scanAll(forceRescan: Bool = false) {
        if !forceRescan && !availablePlugins.isEmpty {
            logger.info("Using cached plugins (\(self.availablePlugins.count)).")
            return
        }

        logger.info("Starting background plugin scan...")
        
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }
            
            var found: [PluginInfo] = []
            
            let vst2Path = AppSettings.shared.vst2Path
            let vst3Path = AppSettings.shared.vst3Path
            
            if !vst2Path.isEmpty {
                found.append(contentsOf: self.scanDirectory(path: vst2Path, type: .vst2, extension: "vst"))
            }
            
            if !vst3Path.isEmpty {
                found.append(contentsOf: self.scanDirectory(path: vst3Path, type: .vst3, extension: "vst3"))
            }
            
            let sorted = found.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
            
            DispatchQueue.main.async {
                self.availablePlugins = sorted
                self.saveCache(sorted)
                self.logger.info("Plugin scan complete. Found \(self.availablePlugins.count) plugins.")
            }
        }
    }
    
    // MARK: - Caching
    
    private var cacheURL: URL {
        let plugInsFolder = AppSettings.shared.userFolderPathURL.appendingPathComponent("Plug-Ins")
        if !FileManager.default.fileExists(atPath: plugInsFolder.path) {
            try? FileManager.default.createDirectory(at: plugInsFolder, withIntermediateDirectories: true)
        }
        return plugInsFolder.appendingPathComponent("PluginsCache.json")
    }
    
    private func loadCache() {
        guard FileManager.default.fileExists(atPath: cacheURL.path) else { return }
        do {
            let data = try Data(contentsOf: cacheURL)
            let cached = try JSONDecoder().decode([PluginInfo].self, from: data)
            self.availablePlugins = cached
            logger.info("Loaded \(cached.count) plugins from cache.")
        } catch {
            logger.error("Failed to load plugin cache: \(error.localizedDescription)")
        }
    }
    
    private func saveCache(_ plugins: [PluginInfo]) {
        do {
            let data = try JSONEncoder().encode(plugins)
            try data.write(to: cacheURL, options: .atomic)
        } catch {
            logger.error("Failed to save plugin cache: \(error.localizedDescription)")
        }
    }
    
    
    private func scanDirectory(path: String, type: AudioEffectType, extension ext: String) -> [PluginInfo] {
        let url = URL(fileURLWithPath: path)
        let fm = FileManager.default
        
        guard fm.fileExists(atPath: path) else {
            logger.warning("Plugin directory does not exist: \(path)")
            return []
        }
        
        var plugins: [PluginInfo] = []
        
        // Recurse to find bundles with the specified extension
        let enumerator = fm.enumerator(at: url, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles])
        
        while let fileURL = enumerator?.nextObject() as? URL {
            if fileURL.pathExtension.lowercased() == ext.lowercased() {
                // Found a plugin bundle
                let name = fileURL.deletingPathExtension().lastPathComponent
                plugins.append(PluginInfo(name: name, path: fileURL.path, type: type))
                
                // Don't descend into the bundle itself
                enumerator?.skipDescendants()
            }
        }
        
        return plugins
    }
}
