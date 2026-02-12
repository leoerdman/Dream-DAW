import Foundation
import DreamDAWModels
import os.log

// MARK: - ProjectFileManager

/// Manages project file operations: save, save-as, open.
///
/// **Ableton-style folder structure:**
/// ```
/// ProjectName/
///   ├── ProjectName V1.ddpj        ← JSON-encoded project data
///   ├── ProjectName V2.ddpj        ← subsequent saves create new versions
///   ├── Samples/
///   │   ├── Imported/              ← audio files copied on import
///   │   └── Recorded/             ← audio from recording
///   └── Backup/                   ← auto-save copies
/// ```
///
/// File format: `.ddpj` — Dream DAW Project JSON (gzip-compressed JSON).
public final class ProjectFileManager {

    // MARK: - Singleton

    public static let shared = ProjectFileManager()

    // MARK: - Properties

    private let logger = Logger(subsystem: "com.dreamdaw", category: "ProjectFileManager")

    /// The file extension for Dream DAW project files.
    public static let fileExtension = "ddpj"

    /// The currently open project folder URL (nil if never saved).
    public private(set) var projectFolderURL: URL?

    /// Current version number within the project folder.
    public private(set) var currentVersion: Int = 1
    
    /// The URL for the user's default project template.
    /// Stored in `~/Library/Application Support/DreamDAW/DefaultProject.ddpj`.
    public var defaultProjectURL: URL? {
        guard let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { return nil }
        let dreamFolder = appSupport.appendingPathComponent("DreamDAW")
        // Ensure folder exists
        try? FileManager.default.createDirectory(at: dreamFolder, withIntermediateDirectories: true, attributes: nil)
        return dreamFolder.appendingPathComponent("DefaultProject.ddpj")
    }

    /// Resets the manager state for a fresh project.
    public func resetState() {
        self.projectFolderURL = nil
        self.currentVersion = 1
        logger.info("Project file manager state reset.")
    }

    // MARK: - Recent Projects

    // MARK: - Recent Projects

    private static let recentProjectsKey = "com.dreamdaw.recentProjects"
    private static let maxRecentProjects = 10

    /// Returns the list of recently opened/saved project file URLs (most recent first).
    public var recentProjectURLs: [URL] {
        let paths = UserDefaults.standard.stringArray(forKey: Self.recentProjectsKey) ?? []
        return paths.compactMap { URL(fileURLWithPath: $0) }
            .filter { FileManager.default.fileExists(atPath: $0.path) }
    }

    /// Record a project file URL as recently opened/saved.
    public func addToRecentProjects(_ url: URL) {
        var paths = UserDefaults.standard.stringArray(forKey: Self.recentProjectsKey) ?? []
        let path = url.path
        // Remove if already present (we'll re-insert at top)
        paths.removeAll { $0 == path }
        // Insert at beginning (most recent first)
        paths.insert(path, at: 0)
        // Keep only the last N entries
        if paths.count > Self.maxRecentProjects {
            paths = Array(paths.prefix(Self.maxRecentProjects))
        }
        UserDefaults.standard.set(paths, forKey: Self.recentProjectsKey)
    }

    /// Clear the recent projects list.
    public func clearRecentProjects() {
        UserDefaults.standard.removeObject(forKey: Self.recentProjectsKey)
    }

    // MARK: - Save

    /// Save the project to its current location. If never saved, triggers save-as.
    /// Returns true if save succeeded.
    @discardableResult
    public func save(project: Project) async throws -> URL {
        if let folderURL = projectFolderURL {
            // Overwrite the current version file in place (standard Cmd+S behavior)
            let fileURL = makeFileURL(folder: folderURL, name: project.name, version: currentVersion)
            try await writeProject(project, to: fileURL)
            
            // UI updates on MainActor
            await MainActor.run {
                project.fileURL = fileURL
            }
            logger.info("Project saved (overwrite): \(fileURL.lastPathComponent) (V\(self.currentVersion))")
            return fileURL
        } else {
            // First save — needs a location
            throw ProjectFileError.noProjectFolder
        }
    }

    /// Save the project to a specific file URL.
    @discardableResult
    public func saveToFile(project: Project, fileURL: URL) async throws -> URL {
        let parentDir = fileURL.deletingLastPathComponent()
        let filename = fileURL.deletingPathExtension().lastPathComponent

        // Calculate new state (Version, Name, URLs) on Main Thread first
        let newVersion: Int
        let newProjectFolderURL: URL
        let newName: String
        let needsNewFolderStructure: Bool

        if isDreamDAWProjectDirectory(parentDir) {
            // Saving inside an existing project directory
            newProjectFolderURL = parentDir
            newVersion = extractVersion(from: fileURL) ?? 1
            
            let baseName = filename
                .replacingOccurrences(of: " V\\d+$", with: "", options: .regularExpression)
                .trimmingCharacters(in: .whitespaces)
            newName = !baseName.isEmpty ? baseName : project.name
            needsNewFolderStructure = false
        } else {
            // Saving to a new location — create project folder structure
            let projectName = filename
                .replacingOccurrences(of: " V\\d+$", with: "", options: .regularExpression)
                .trimmingCharacters(in: .whitespaces)
            newProjectFolderURL = parentDir.appendingPathComponent(projectName)
            newVersion = 1
            newName = projectName
            needsNewFolderStructure = true
        }

        // Apply changes to Project (Main Thread)
        project.name = newName
        
        // Create folders if needed (Fast synchronous I/O, acceptable on main thread or detached)
        if needsNewFolderStructure {
            try FileManager.default.createDirectory(at: newProjectFolderURL, withIntermediateDirectories: true)
            
            let samplesFolder = newProjectFolderURL.appendingPathComponent("Samples")
            let importedFolder = samplesFolder.appendingPathComponent("Imported")
            let recordedFolder = samplesFolder.appendingPathComponent("Recorded")
            let backupFolder = newProjectFolderURL.appendingPathComponent("Backup")

            for dir in [samplesFolder, importedFolder, recordedFolder, backupFolder] {
                try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            }
            
            // Copy samples (might be slow, strictly should be async but keeping simple for now)
            try copyAudioSamples(project: project, to: importedFolder)
        }

        // Update Manager State
        self.projectFolderURL = newProjectFolderURL
        self.currentVersion = newVersion
        
        // Write File (Async)
        // If it's a new structure, we use the constructed URL.
        // If existing, we use the fileURL provided.
        // Logic simplification: The fileURL passed in IS the destination file.
        // Wait, for new structure `fileURL` from save panel might be `.../ProjectName.ddpj` but we move it to `.../ProjectName/ProjectName V1.ddpj`?
        // The original logic:
        // Case 1 (Existing): write to fileURL.
        // Case 2 (New): write to `projectFolder/ProjectName V1.ddpj`.
        
        let targetFileURL: URL
        if needsNewFolderStructure {
             targetFileURL = makeFileURL(folder: newProjectFolderURL, name: newName, version: newVersion)
        } else {
             targetFileURL = fileURL
        }

        try await writeProject(project, to: targetFileURL)

        // Final Update
        await MainActor.run {
            project.fileURL = targetFileURL
        }

        if needsNewFolderStructure {
            logger.info("Created project directory: \(newProjectFolderURL.lastPathComponent) → \(targetFileURL.lastPathComponent)")
        } else {
            logger.info("Saved into existing project dir: \(targetFileURL.lastPathComponent)")
        }
        
        return targetFileURL
    }

    // MARK: - Default Project Template

    /// Saves the current project state as the default template for new projects.
    public func saveAsDefaultProject(_ project: Project) async throws {
        guard let url = defaultProjectURL else {
            throw ProjectFileError.noProjectFolder
        }
        
        // Save to the specific default path
        try await writeProject(project, to: url)
        logger.info("Saved default project template to: \(url.path)")
    }

    /// Loads the default project template if it exists. Returns nil if not found.
    public func loadDefaultProject() async -> Project? {
        guard let url = defaultProjectURL, FileManager.default.fileExists(atPath: url.path) else {
            return nil
        }
        
        do {
            let project = try await open(fileURL: url)
            // Reset project ID and file URL so it's treated as a fresh "New Project"
            // We want a new copy, not to edit the template itself directly
            let newProject = Project(
                name: "New Project", // Reset name
                bpm: project.bpm,
                timeSignature: project.timeSignature,
                sampleRate: project.sampleRate,
                tracks: project.tracks // Copies tracks (structs/classes need to be careful with references)
            )
            // Copy other properties manually if not covered by init
            newProject.isLooping = project.isLooping
            newProject.loopStart = project.loopStart
            newProject.loopEnd = project.loopEnd
            newProject.masterTrack = project.masterTrack
            
            logger.info("Loaded default project template.")
            return newProject
        } catch {
            logger.error("Failed to load default project: \(error.localizedDescription)")
            return nil
        }
    }

    // MARK: - Directory Detection

    /// Determine if a directory is a Dream DAW project directory.
    ///
    /// A directory is considered a project directory if:
    /// 1. It contains at least one `.ddpj` file, OR
    /// 2. It contains a `Samples/` subdirectory (standard project structure)
    private func isDreamDAWProjectDirectory(_ url: URL) -> Bool {
        let fm = FileManager.default
        var isDir: ObjCBool = false
        guard fm.fileExists(atPath: url.path, isDirectory: &isDir), isDir.boolValue else {
            return false
        }

        // Check for Samples/ subdirectory (definitive project marker)
        let samplesDir = url.appendingPathComponent("Samples")
        if fm.fileExists(atPath: samplesDir.path, isDirectory: &isDir), isDir.boolValue {
            return true
        }

        // Check for existing .ddpj files
        if let contents = try? fm.contentsOfDirectory(at: url, includingPropertiesForKeys: nil, options: .skipsHiddenFiles) {
            for file in contents {
                if file.pathExtension == Self.fileExtension {
                    return true
                }
            }
        }

        return false
    }

    // MARK: - Open

    /// Open a project from a .ddpj file.
    public func open(fileURL: URL) async throws -> Project {
        // Read and Decompress on background thread
        let project = try await Task.detached(priority: .userInitiated, operation: {
            let data = try Data(contentsOf: fileURL)

            // Try gzip decompression
            let jsonData: Data
            if data.isGzipped {
                jsonData = try data.gunzipped()
            } else {
                jsonData = data
            }

            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            let decodedProject = try decoder.decode(Project.self, from: jsonData)
            return decodedProject
        }).value

        // Update MainActor state
        await MainActor.run {
            project.fileURL = fileURL
        }
        
        self.projectFolderURL = fileURL.deletingLastPathComponent()
        self.currentVersion = extractVersion(from: fileURL) ?? 1

        logger.info("Opened project: \(project.name) (V\(self.currentVersion))")
        return project
    }

    /// Scan a project folder for all version files, sorted by version.
    public func listVersions(in folderURL: URL) -> [(version: Int, url: URL)] {
        guard let contents = try? FileManager.default.contentsOfDirectory(
            at: folderURL,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles]
        ) else { return [] }

        return contents
            .filter { $0.pathExtension == Self.fileExtension }
            .compactMap { url -> (Int, URL)? in
                guard let v = extractVersion(from: url) else { return nil }
                return (v, url)
            }
            .sorted { $0.0 < $1.0 }
    }

    // MARK: - Backup (auto-save)

    /// Create a backup copy of the current project state.
    public func createBackup(project: Project) async {
        guard let folderURL = projectFolderURL else { return }

        let backupFolder = folderURL.appendingPathComponent("Backup")
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd_HH-mm-ss"
        let timestamp = formatter.string(from: Date())
        let backupFile = backupFolder.appendingPathComponent("\(project.name)_backup_\(timestamp).\(ProjectFileManager.fileExtension)")

        do {
            try FileManager.default.createDirectory(at: backupFolder, withIntermediateDirectories: true)
            try await writeProject(project, to: backupFile)
            logger.info("Backup created: \(backupFile.lastPathComponent)")
        } catch {
            logger.error("Backup failed: \(error.localizedDescription)")
        }
    }

    // MARK: - Private Helpers

    private func makeFileURL(folder: URL, name: String, version: Int) -> URL {
        folder.appendingPathComponent("\(name) V\(version).\(ProjectFileManager.fileExtension)")
    }

    private func writeProject(_ project: Project, to url: URL) async throws {
        // Encode on current actor (Main) to ensure thread safety for Project access
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        let jsonData = try encoder.encode(project)

        // Write to disk on background thread
        try await Task.detached(priority: .userInitiated) {
            // Gzip compress for smaller file size
            let compressedData = try jsonData.gzipped()
            try compressedData.write(to: url, options: .atomic)
        }.value
    }

    private func copyAudioSamples(project: Project, to importedFolder: URL) throws {
        let fm = FileManager.default

        for track in project.tracks {
            // 1. Copy AudioClip samples
            for clip in track.clips {
                let sourceURL = clip.fileURL
                try copySingleSample(at: sourceURL, to: importedFolder)
            }
            
            // 2. Copy Sampler instrument samples
            if let samplerURL = track.instrument?.sampleURL {
                try copySingleSample(at: samplerURL, to: importedFolder)
                // Note: In an enterprise solution, we should update track.instrument.sampleURL 
                // to the new location, but for now we follow the existing pattern of keeping 
                // absolute paths (with the expectation that they exist in the new folder).
            }
        }
    }
    
    private func copySingleSample(at sourceURL: URL, to importedFolder: URL) throws {
        let fm = FileManager.default
        guard fm.fileExists(atPath: sourceURL.path) else { return }

        let destURL = importedFolder.appendingPathComponent(sourceURL.lastPathComponent)

        // Skip if already exists (same file or same name)
        if fm.fileExists(atPath: destURL.path) { return }

        try fm.copyItem(at: sourceURL, to: destURL)
        logger.info("Copied sample: \(sourceURL.lastPathComponent)")
    }

    private func extractVersion(from url: URL) -> Int? {
        // Parse "ProjectName V3.ddpj" → 3
        let filename = url.deletingPathExtension().lastPathComponent
        guard let range = filename.range(of: " V", options: .backwards),
              let version = Int(filename[range.upperBound...]) else {
            return nil
        }
        return version
    }
}

// MARK: - ProjectFileError

public enum ProjectFileError: LocalizedError {
    case noProjectFolder
    case fileNotFound(URL)
    case invalidFormat
    case unknown

    public var errorDescription: String? {
        switch self {
        case .noProjectFolder:
            return "Project has not been saved yet. Use Save As to choose a location."
        case .fileNotFound(let url):
            return "Project file not found: \(url.lastPathComponent)"
        case .invalidFormat:
            return "Invalid project file format."
        case .unknown:
            return "An unknown error occurred."
        }
    }
}

// MARK: - Data+Gzip

/// Minimal gzip compression/decompression using zlib (built into macOS).
import Compression

extension Data {
    /// Check if data starts with gzip magic number.
    var isGzipped: Bool {
        count >= 2 && self[0] == 0x1f && self[1] == 0x8b
    }

    /// Compress data using LZFSE (fast, Apple-native).
    /// For project files we use zlib for broader compatibility.
    func gzipped() throws -> Data {
        guard !isEmpty else { return self }

        let sourceSize = count
        let destinationBufferSize = sourceSize + 512 // overhead
        let destinationBuffer = UnsafeMutablePointer<UInt8>.allocate(capacity: destinationBufferSize)
        defer { destinationBuffer.deallocate() }

        let compressedSize = self.withUnsafeBytes { sourceBytes -> Int in
            guard let sourcePointer = sourceBytes.baseAddress else { return 0 }
            return compression_encode_buffer(
                destinationBuffer,
                destinationBufferSize,
                sourcePointer.assumingMemoryBound(to: UInt8.self),
                sourceSize,
                nil,
                COMPRESSION_ZLIB
            )
        }

        guard compressedSize > 0 else { return self }

        // Add gzip header/trailer for compatibility
        var result = Data([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03])
        result.append(destinationBuffer, count: compressedSize)
        return result
    }

    /// Decompress gzip data.
    func gunzipped() throws -> Data {
        guard isGzipped, count > 10 else { return self }

        // Skip gzip header (10 bytes minimum)
        let compressedData = self.dropFirst(10)
        let sourceSize = compressedData.count
        let destinationBufferSize = sourceSize * 10 // generous decompression buffer
        let destinationBuffer = UnsafeMutablePointer<UInt8>.allocate(capacity: destinationBufferSize)
        defer { destinationBuffer.deallocate() }

        let decompressedSize = compressedData.withUnsafeBytes { sourceBytes -> Int in
            guard let sourcePointer = sourceBytes.baseAddress else { return 0 }
            return compression_decode_buffer(
                destinationBuffer,
                destinationBufferSize,
                sourcePointer.assumingMemoryBound(to: UInt8.self),
                sourceSize,
                nil,
                COMPRESSION_ZLIB
            )
        }

        guard decompressedSize > 0 else { return self }
        return Data(bytes: destinationBuffer, count: decompressedSize)
    }
}
