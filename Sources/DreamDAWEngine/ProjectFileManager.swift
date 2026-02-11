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

    // MARK: - Save

    /// Save the project to its current location. If never saved, triggers save-as.
    /// Returns true if save succeeded.
    @discardableResult
    public func save(project: Project) throws -> URL {
        if let folderURL = projectFolderURL {
            // Increment version and save
            currentVersion += 1
            let fileURL = makeFileURL(folder: folderURL, name: project.name, version: currentVersion)
            try writeProject(project, to: fileURL)
            project.fileURL = fileURL
            logger.info("Project saved: \(fileURL.lastPathComponent) (V\(self.currentVersion))")
            return fileURL
        } else {
            // First save — needs a location
            throw ProjectFileError.noProjectFolder
        }
    }

    /// Save the project to a specific file URL.
    ///
    /// **Directory detection logic:**
    /// - If the file's parent directory is already a Dream DAW project directory
    ///   (contains .ddpj files or the standard Samples/ folder), the file is saved
    ///   directly there — no subdirectory is created.
    /// - If the parent directory is NOT a project directory, a new project folder
    ///   is created (named after the project) with the standard Ableton-style
    ///   structure, and the file is saved inside it.
    @discardableResult
    public func saveToFile(project: Project, fileURL: URL) throws -> URL {
        let parentDir = fileURL.deletingLastPathComponent()
        let filename = fileURL.deletingPathExtension().lastPathComponent

        if isDreamDAWProjectDirectory(parentDir) {
            // ━━━ Saving inside an existing project directory ━━━
            // Just write the file directly — no new folders needed
            projectFolderURL = parentDir
            currentVersion = extractVersion(from: fileURL) ?? 1

            // Update the project name from the chosen filename (strip version suffix)
            let baseName = filename
                .replacingOccurrences(of: " V\\d+$", with: "", options: .regularExpression)
                .trimmingCharacters(in: .whitespaces)
            if !baseName.isEmpty {
                project.name = baseName
            }

            try writeProject(project, to: fileURL)
            project.fileURL = fileURL

            logger.info("Saved into existing project dir: \(fileURL.lastPathComponent)")
            return fileURL
        } else {
            // ━━━ Saving to a new location — create project folder structure ━━━
            let projectName = filename
                .replacingOccurrences(of: " V\\d+$", with: "", options: .regularExpression)
                .trimmingCharacters(in: .whitespaces)
            let projectFolder = parentDir.appendingPathComponent(projectName)

            try FileManager.default.createDirectory(at: projectFolder, withIntermediateDirectories: true)

            // Create standard sub-directories
            let samplesFolder = projectFolder.appendingPathComponent("Samples")
            let importedFolder = samplesFolder.appendingPathComponent("Imported")
            let recordedFolder = samplesFolder.appendingPathComponent("Recorded")
            let backupFolder = projectFolder.appendingPathComponent("Backup")

            for dir in [samplesFolder, importedFolder, recordedFolder, backupFolder] {
                try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            }

            // Copy audio samples into the project folder
            try copyAudioSamples(project: project, to: importedFolder)

            // Save the project file inside the new folder
            currentVersion = 1
            projectFolderURL = projectFolder

            // Update the project name from the chosen filename
            project.name = projectName

            let destURL = makeFileURL(folder: projectFolder, name: projectName, version: currentVersion)
            try writeProject(project, to: destURL)
            project.fileURL = destURL

            logger.info("Created project directory: \(projectFolder.lastPathComponent) → \(destURL.lastPathComponent)")
            return destURL
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
    public func open(fileURL: URL) throws -> Project {
        let data = try Data(contentsOf: fileURL)

        // Try gzip decompression first, fall back to raw JSON
        let jsonData: Data
        if data.isGzipped {
            jsonData = try data.gunzipped()
        } else {
            jsonData = data
        }

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let project = try decoder.decode(Project.self, from: jsonData)
        project.fileURL = fileURL

        // Set the project folder context
        projectFolderURL = fileURL.deletingLastPathComponent()

        // Determine current version from filename
        currentVersion = extractVersion(from: fileURL) ?? 1

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
    public func createBackup(project: Project) {
        guard let folderURL = projectFolderURL else { return }

        let backupFolder = folderURL.appendingPathComponent("Backup")
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd_HH-mm-ss"
        let timestamp = formatter.string(from: Date())
        let backupFile = backupFolder.appendingPathComponent("\(project.name)_backup_\(timestamp).\(Self.fileExtension)")

        do {
            try FileManager.default.createDirectory(at: backupFolder, withIntermediateDirectories: true)
            try writeProject(project, to: backupFile)
            logger.info("Backup created: \(backupFile.lastPathComponent)")
        } catch {
            logger.error("Backup failed: \(error.localizedDescription)")
        }
    }

    // MARK: - Private Helpers

    private func makeFileURL(folder: URL, name: String, version: Int) -> URL {
        folder.appendingPathComponent("\(name) V\(version).\(Self.fileExtension)")
    }

    private func writeProject(_ project: Project, to url: URL) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        let jsonData = try encoder.encode(project)

        // Gzip compress for smaller file size
        let compressedData = try jsonData.gzipped()
        try compressedData.write(to: url, options: .atomic)
    }

    private func copyAudioSamples(project: Project, to importedFolder: URL) throws {
        let fm = FileManager.default

        for track in project.tracks {
            for clip in track.clips {
                let sourceURL = clip.fileURL
                guard fm.fileExists(atPath: sourceURL.path) else { continue }

                let destURL = importedFolder.appendingPathComponent(sourceURL.lastPathComponent)

                // Skip if already exists (same file)
                if fm.fileExists(atPath: destURL.path) { continue }

                try fm.copyItem(at: sourceURL, to: destURL)

                // Update the clip's fileURL to the project-relative path
                // (we keep absolute for now; relative paths would need an additional mapping)
                logger.info("Copied sample: \(sourceURL.lastPathComponent)")
            }
        }
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

    public var errorDescription: String? {
        switch self {
        case .noProjectFolder:
            return "Project has not been saved yet. Use Save As to choose a location."
        case .fileNotFound(let url):
            return "Project file not found: \(url.lastPathComponent)"
        case .invalidFormat:
            return "Invalid project file format."
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
