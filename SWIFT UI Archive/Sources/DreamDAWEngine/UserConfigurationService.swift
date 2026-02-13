import Foundation
import DreamDAWModels
import os.log

/// Manages the physical directory structure for Dream DAW user data.
/// Ensures "User Info" and "User Cache" exist and handles migrations if paths change.
public final class UserConfigurationService {
    
    public static let shared = UserConfigurationService()
    
    private let logger = Logger(subsystem: "com.dreamdaw", category: "UserConfigurationService")
    private let fm = FileManager.default
    
    private init() {
        setupObservers()
    }
    
    // MARK: - Lifecycle
    
    /// Ensures the current user folder structure is healthy.
    public func validateStructure() {
        let settings = AppSettings.shared
        createFolderIfMissing(at: settings.userInfoURL, label: "User Info")
        createFolderIfMissing(at: settings.userCacheURL, label: "User Cache")
        
        // Initial sync of settings to ensure the file exists in the folder
        settings.syncToDisk()
        
        logger.info("User structure validated at: \(settings.userFolderPath)")
    }
    
    private func setupObservers() {
        NotificationCenter.default.addObserver(
            forName: .userFolderPathDidChange,
            object: nil,
            queue: nil // Process on the posting thread
        ) { [weak self] _ in
            self?.handlePathChange()
        }
    }
    
    private func handlePathChange() {
        logger.info("User folder path changed. Initializing new structure...")
        validateStructure()
    }
    
    // MARK: - Helpers
    
    private func createFolderIfMissing(at url: URL, label: String) {
        var isDir: ObjCBool = false
        if fm.fileExists(atPath: url.path, isDirectory: &isDir) {
            if isDir.boolValue {
                return // Already exists
            } else {
                // Unexpected file at this location
                try? fm.removeItem(at: url)
            }
        }
        
        do {
            try fm.createDirectory(at: url, withIntermediateDirectories: true)
            logger.info("Created \(label) folder at: \(url.path)")
        } catch {
            logger.error("Failed to create \(label) folder: \(error.localizedDescription)")
        }
    }
}
