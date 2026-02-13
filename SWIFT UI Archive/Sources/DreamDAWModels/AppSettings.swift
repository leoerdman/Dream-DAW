import Foundation

// MARK: - AppLanguage

/// Supported UI languages.
public enum AppLanguage: String, Codable, CaseIterable, Sendable {
    case english  = "en"
    case russian  = "ru"
    case japanese = "ja"
    case chinese  = "zh"
    case german   = "de"
    case french   = "fr"
    case spanish  = "es"
    
    public var displayName: String {
        switch self {
        case .english:  return "English"
        case .russian:  return "Русский"
        case .japanese: return "日本語"
        case .chinese:  return "中文"
        case .german:   return "Deutsch"
        case .french:   return "Français"
        case .spanish:  return "Español"
        }
    }
}

// MARK: - WaveformStyle

/// Aesthetic style for waveform rendering.
public enum WaveformStyle: String, Codable, CaseIterable, Sendable {
    case colored = "colored"
    case solid   = "solid"
    
    public var displayName: String {
        switch self {
        case .colored: return "Colored"
        case .solid:   return "Classic Black"
        }
    }
}

// MARK: - StartupBehavior

/// Behavior when the application starts.
public enum StartupBehavior: String, Codable, CaseIterable, Sendable {
    case newProject  = "newProject"
    case lastProject = "lastProject"
    
    public var displayName: String {
        switch self {
        case .newProject:  return "New Project"
        case .lastProject: return "Last Opened Project"
        }
    }
}

/// Persistent application settings stored in UserDefaults and a portable JSON file.
public final class AppSettings: ObservableObject, Codable {
    
    public static let shared = AppSettings()
    
    private let defaults = UserDefaults.standard
    private var isInitializing = true
    
    // Keys
    private enum Keys {
        static let language = "dreamdaw.settings.language"
        static let userFolderPath = "dreamdaw.settings.userFolderPath"
        static let samplesPath = "dreamdaw.settings.samplesPath"
        static let audioOutputDeviceUID = "dreamdaw.settings.audioOutputDeviceUID"
        static let waveformStyle = "dreamdaw.settings.waveformStyle"
        static let startupBehavior = "dreamdaw.settings.startupBehavior"
        static let vst2Path = "dreamdaw.settings.vst2Path"
        static let vst3Path = "dreamdaw.settings.vst3Path"
        static let audioBufferSize = "dreamdaw.settings.audioBufferSize"
        static let browserSidebarOrder = "dreamdaw.settings.browserSidebarOrder"
        static let browserPinnedFolders = "dreamdaw.settings.browserPinnedFolders"
        static let browserCategoryPaneWidth = "dreamdaw.settings.browserCategoryPaneWidth"
        static let browserFavorites = "dreamdaw.settings.browserFavorites"
        static let audioSampleRate = "dreamdaw.settings.audioSampleRate"
        static let audioInputDeviceUID = "dreamdaw.settings.audioInputDeviceUID"
        static let driverErrorCompensation = "dreamdaw.settings.driverErrorCompensation"
        static let testToneEnabled = "dreamdaw.settings.testToneEnabled"
        static let testToneVolume = "dreamdaw.settings.testToneVolume"
        static let testToneFrequency = "dreamdaw.settings.testToneFrequency"
        static let cpuUsageSimulator = "dreamdaw.settings.cpuUsageSimulator"
        static let srPitchConversionHighQuality = "dreamdaw.settings.srPitchConversionHighQuality"
    }

    // MARK: - General
    
    @Published public var language: AppLanguage
    @Published public var waveformStyle: WaveformStyle
    @Published public var startupBehavior: StartupBehavior
    
    // MARK: - Storage
    
    /// The primary user folder containing projects, settings, and cache.
    @Published public var userFolderPath: String {
        didSet {
            defaults.set(userFolderPath, forKey: Keys.userFolderPath)
            if !isInitializing {
                // When path changes, we first attempt to LOAD settings from the new location
                // if it already exists (Enterprise robustness: adoption of existing config).
                loadFromDisk()
                
                NotificationCenter.default.post(name: .userFolderPathDidChange, object: nil)
                syncToDisk()
            }
        }
    }
    
    /// User sample library folder path.
    @Published public var samplesPath: String {
        didSet {
            defaults.set(samplesPath, forKey: Keys.samplesPath)
            if !isInitializing {
                NotificationCenter.default.post(name: .samplesPathDidChange, object: nil)
                syncToDisk()
            }
        }
    }

    /// VST2 plugins folder path.
    @Published public var vst2Path: String {
        didSet {
            defaults.set(vst2Path, forKey: Keys.vst2Path)
            if !isInitializing {
                NotificationCenter.default.post(name: .vstPathsDidChange, object: nil)
                syncToDisk()
            }
        }
    }

    /// VST3 plugins folder path.
    @Published public var vst3Path: String {
        didSet {
            defaults.set(vst3Path, forKey: Keys.vst3Path)
            if !isInitializing {
                NotificationCenter.default.post(name: .vstPathsDidChange, object: nil)
                syncToDisk()
            }
        }
    }

    /// The primary user folder as a URL.
    public var userFolderPathURL: URL {
        URL(fileURLWithPath: userFolderPath)
    }

    /// URL for the "User Info" folder where settings.json is stored.
    public var userInfoURL: URL {
        userFolderPathURL.appendingPathComponent("User Info")
    }

    /// URL for the "User Cache" folder.
    public var userCacheURL: URL {
        URL(fileURLWithPath: userFolderPath).appendingPathComponent("User Cache")
    }

    /// Path to the settings.json file.
    private var settingsFileURL: URL {
        userInfoURL.appendingPathComponent("settings.json")
    }

    // MARK: - Audio

    @Published public var audioOutputDeviceUID: String? {
        didSet {
            defaults.set(audioOutputDeviceUID, forKey: Keys.audioOutputDeviceUID)
            if !isInitializing {
                syncToDisk()
            }
        }
    }

    @Published public var audioBufferSize: Int {
        didSet {
            defaults.set(audioBufferSize, forKey: Keys.audioBufferSize)
            if !isInitializing {
                syncToDisk()
            }
        }
    }

    @Published public var audioSampleRate: Double {
        didSet {
            defaults.set(audioSampleRate, forKey: Keys.audioSampleRate)
            if !isInitializing {
                syncToDisk()
            }
        }
    }

    @Published public var audioInputDeviceUID: String? {
        didSet {
            defaults.set(audioInputDeviceUID, forKey: Keys.audioInputDeviceUID)
            if !isInitializing {
                syncToDisk()
            }
        }
    }

    @Published public var driverErrorCompensation: Double {
        didSet {
            defaults.set(driverErrorCompensation, forKey: Keys.driverErrorCompensation)
            if !isInitializing {
                syncToDisk()
            }
        }
    }

    @Published public var testToneEnabled: Bool {
        didSet {
            defaults.set(testToneEnabled, forKey: Keys.testToneEnabled)
            if !isInitializing {
                syncToDisk()
            }
        }
    }

    @Published public var testToneVolume: Double {
        didSet {
            defaults.set(testToneVolume, forKey: Keys.testToneVolume)
            if !isInitializing {
                syncToDisk()
            }
        }
    }

    @Published public var testToneFrequency: Double {
        didSet {
            defaults.set(testToneFrequency, forKey: Keys.testToneFrequency)
            if !isInitializing {
                syncToDisk()
            }
        }
    }

    @Published public var cpuUsageSimulator: Int {
        didSet {
            defaults.set(cpuUsageSimulator, forKey: Keys.cpuUsageSimulator)
            if !isInitializing {
                syncToDisk()
            }
        }
    }

    @Published public var srPitchConversionHighQuality: Bool {
        didSet {
            defaults.set(srPitchConversionHighQuality, forKey: Keys.srPitchConversionHighQuality)
            if !isInitializing {
                syncToDisk()
            }
        }
    }

    // MARK: - Browser

    @Published public var browserSidebarOrder: [String] {
        didSet {
            defaults.set(browserSidebarOrder, forKey: Keys.browserSidebarOrder)
            if !isInitializing {
                syncToDisk()
            }
        }
    }

    @Published public var browserPinnedFolders: [String] {
        didSet {
            defaults.set(browserPinnedFolders, forKey: Keys.browserPinnedFolders)
            if !isInitializing {
                syncToDisk()
            }
        }
    }

    @Published public var browserCategoryPaneWidth: Double? {
        didSet {
            defaults.set(browserCategoryPaneWidth, forKey: Keys.browserCategoryPaneWidth)
            if !isInitializing {
                syncToDisk()
            }
        }
    }

    @Published public var browserFavorites: [String] {
        didSet {
            defaults.set(browserFavorites, forKey: Keys.browserFavorites)
            if !isInitializing {
                syncToDisk()
            }
        }
    }
    
    // MARK: - Codable (Manual implementation for @Published)
    
    enum CodingKeys: String, CodingKey {
        case language, waveformStyle, startupBehavior, userFolderPath, samplesPath, vst2Path, vst3Path, audioOutputDeviceUID, audioBufferSize, audioSampleRate
        case audioInputDeviceUID, driverErrorCompensation, testToneEnabled, testToneVolume, testToneFrequency, cpuUsageSimulator, srPitchConversionHighQuality
        case browserSidebarOrder, browserPinnedFolders, browserCategoryPaneWidth, browserFavorites
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        language = try container.decode(AppLanguage.self, forKey: .language)
        waveformStyle = try container.decode(WaveformStyle.self, forKey: .waveformStyle)
        startupBehavior = try container.decode(StartupBehavior.self, forKey: .startupBehavior)
        userFolderPath = try container.decode(String.self, forKey: .userFolderPath)
        samplesPath = try container.decode(String.self, forKey: .samplesPath)
        vst2Path = try container.decode(String.self, forKey: .vst2Path)
        vst3Path = try container.decode(String.self, forKey: .vst3Path)
        audioOutputDeviceUID = try container.decodeIfPresent(String.self, forKey: .audioOutputDeviceUID)
        audioBufferSize = try container.decodeIfPresent(Int.self, forKey: .audioBufferSize) ?? 512
        audioSampleRate = try container.decodeIfPresent(Double.self, forKey: .audioSampleRate) ?? 48000.0
        audioInputDeviceUID = try container.decodeIfPresent(String.self, forKey: .audioInputDeviceUID)
        driverErrorCompensation = try container.decodeIfPresent(Double.self, forKey: .driverErrorCompensation) ?? 0.0
        testToneEnabled = try container.decodeIfPresent(Bool.self, forKey: .testToneEnabled) ?? false
        testToneVolume = try container.decodeIfPresent(Double.self, forKey: .testToneVolume) ?? -36.0
        testToneFrequency = try container.decodeIfPresent(Double.self, forKey: .testToneFrequency) ?? 440.0
        cpuUsageSimulator = try container.decodeIfPresent(Int.self, forKey: .cpuUsageSimulator) ?? 0
        srPitchConversionHighQuality = try container.decodeIfPresent(Bool.self, forKey: .srPitchConversionHighQuality) ?? true
        browserSidebarOrder = try container.decodeIfPresent([String].self, forKey: .browserSidebarOrder) ?? []
        browserPinnedFolders = try container.decodeIfPresent([String].self, forKey: .browserPinnedFolders) ?? []
        browserCategoryPaneWidth = try container.decodeIfPresent(Double.self, forKey: .browserCategoryPaneWidth)
        browserFavorites = try container.decodeIfPresent([String].self, forKey: .browserFavorites) ?? []
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(language, forKey: .language)
        try container.encode(waveformStyle, forKey: .waveformStyle)
        try container.encode(startupBehavior, forKey: .startupBehavior)
        try container.encode(userFolderPath, forKey: .userFolderPath)
        try container.encode(samplesPath, forKey: .samplesPath)
        try container.encode(vst2Path, forKey: .vst2Path)
        try container.encode(vst3Path, forKey: .vst3Path)
        try container.encode(audioOutputDeviceUID, forKey: .audioOutputDeviceUID)
        try container.encode(audioBufferSize, forKey: .audioBufferSize)
        try container.encode(audioSampleRate, forKey: .audioSampleRate)
        try container.encode(audioInputDeviceUID, forKey: .audioInputDeviceUID)
        try container.encode(driverErrorCompensation, forKey: .driverErrorCompensation)
        try container.encode(testToneEnabled, forKey: .testToneEnabled)
        try container.encode(testToneVolume, forKey: .testToneVolume)
        try container.encode(testToneFrequency, forKey: .testToneFrequency)
        try container.encode(cpuUsageSimulator, forKey: .cpuUsageSimulator)
        try container.encode(srPitchConversionHighQuality, forKey: .srPitchConversionHighQuality)
        try container.encode(browserSidebarOrder, forKey: .browserSidebarOrder)
        try container.encode(browserPinnedFolders, forKey: .browserPinnedFolders)
        try container.encodeIfPresent(browserCategoryPaneWidth, forKey: .browserCategoryPaneWidth)
        try container.encode(browserFavorites, forKey: .browserFavorites)
    }

    // MARK: - Persistence
    
    private init() {
        // 1. Determine User Folder (Bootstrapping)
        let defaultPath: String
        let musicDir = FileManager.default.urls(for: .musicDirectory, in: .userDomainMask).first
        defaultPath = musicDir?.appendingPathComponent("Dream DAW").path ?? "~/Music/Dream DAW"
        
        let initialPath = defaults.string(forKey: Keys.userFolderPath) ?? defaultPath
        self.userFolderPath = initialPath

        // 2. Default Values
        self.language = .english
        self.waveformStyle = .colored
        self.startupBehavior = .newProject
        self.samplesPath = ""
        self.vst2Path = "/Library/Audio/Plug-Ins/VST"
        self.vst3Path = "/Library/Audio/Plug-Ins/VST3"
        self.audioOutputDeviceUID = nil
        self.audioBufferSize = 512
        self.audioSampleRate = 48000.0
        self.audioInputDeviceUID = nil
        self.driverErrorCompensation = 0.0
        self.testToneEnabled = false
        self.testToneVolume = -36.0
        self.testToneFrequency = 440.0
        self.cpuUsageSimulator = 0
        self.srPitchConversionHighQuality = true
        self.browserSidebarOrder = []
        self.browserPinnedFolders = []
        self.browserCategoryPaneWidth = nil
        self.browserFavorites = []

        // 3. Load from JSON if available (Centralized Source of Truth)
        loadFromDisk()

        // 4. Fallback to UserDefaults (Backward Compatibility / Legacy migration)
        if let langRaw = defaults.string(forKey: Keys.language), let lang = AppLanguage(rawValue: langRaw) {
            self.language = lang
        }
        if let styleRaw = defaults.string(forKey: Keys.waveformStyle), let style = WaveformStyle(rawValue: styleRaw) {
            self.waveformStyle = style
        }
        if let samples = defaults.string(forKey: Keys.samplesPath) {
            self.samplesPath = samples
        }
        if let device = defaults.string(forKey: Keys.audioOutputDeviceUID) {
            self.audioOutputDeviceUID = device
        }
        if let vst2 = defaults.string(forKey: Keys.vst2Path) {
            self.vst2Path = vst2
        }
        if let vst3 = defaults.string(forKey: Keys.vst3Path) {
            self.vst3Path = vst3
        }
        if let startupRaw = defaults.string(forKey: Keys.startupBehavior), let behavior = StartupBehavior(rawValue: startupRaw) {
            self.startupBehavior = behavior
        }
        if let savedOrder = defaults.stringArray(forKey: Keys.browserSidebarOrder) {
            self.browserSidebarOrder = savedOrder
        }
        if let savedFolders = defaults.stringArray(forKey: Keys.browserPinnedFolders) {
            self.browserPinnedFolders = savedFolders
        }
        if defaults.object(forKey: Keys.browserCategoryPaneWidth) != nil {
            self.browserCategoryPaneWidth = defaults.double(forKey: Keys.browserCategoryPaneWidth)
        }
        if let savedFavorites = defaults.stringArray(forKey: Keys.browserFavorites) {
            self.browserFavorites = savedFavorites
        }
        
        let savedBufferSize = defaults.integer(forKey: Keys.audioBufferSize)
        if savedBufferSize > 0 {
            self.audioBufferSize = savedBufferSize
        }

        let savedSampleRate = defaults.double(forKey: Keys.audioSampleRate)
        if savedSampleRate > 0 {
            self.audioSampleRate = savedSampleRate
        }
        
        if let input = defaults.string(forKey: Keys.audioInputDeviceUID) {
            self.audioInputDeviceUID = input
        }
        
        if defaults.object(forKey: Keys.driverErrorCompensation) != nil {
            self.driverErrorCompensation = defaults.double(forKey: Keys.driverErrorCompensation)
        }
        
        self.testToneEnabled = defaults.bool(forKey: Keys.testToneEnabled)
        
        if defaults.object(forKey: Keys.testToneVolume) != nil {
            self.testToneVolume = defaults.double(forKey: Keys.testToneVolume)
        }
        
        if defaults.object(forKey: Keys.testToneFrequency) != nil {
            self.testToneFrequency = defaults.double(forKey: Keys.testToneFrequency)
        }
        
        self.cpuUsageSimulator = defaults.integer(forKey: Keys.cpuUsageSimulator)
        
        if defaults.object(forKey: Keys.srPitchConversionHighQuality) != nil {
            self.srPitchConversionHighQuality = defaults.bool(forKey: Keys.srPitchConversionHighQuality)
        } else {
            self.srPitchConversionHighQuality = true
        }

        self.isInitializing = false
    }

    private func loadFromDisk() {
        let url = settingsFileURL
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        
        do {
            let data = try Data(contentsOf: url)
            let decoded = try JSONDecoder().decode(AppSettings.self, from: data)
            
            // Sync values
            self.language = decoded.language
            self.waveformStyle = decoded.waveformStyle
            self.startupBehavior = decoded.startupBehavior
            self.samplesPath = decoded.samplesPath
            self.vst2Path = decoded.vst2Path
            self.vst3Path = decoded.vst3Path
            self.audioOutputDeviceUID = decoded.audioOutputDeviceUID
            self.audioBufferSize = decoded.audioBufferSize
            self.audioSampleRate = decoded.audioSampleRate
            self.audioInputDeviceUID = decoded.audioInputDeviceUID
            self.driverErrorCompensation = decoded.driverErrorCompensation
            self.testToneEnabled = decoded.testToneEnabled
            self.testToneVolume = decoded.testToneVolume
            self.testToneFrequency = decoded.testToneFrequency
            self.cpuUsageSimulator = decoded.cpuUsageSimulator
            self.srPitchConversionHighQuality = decoded.srPitchConversionHighQuality
            self.browserSidebarOrder = decoded.browserSidebarOrder
            self.browserPinnedFolders = decoded.browserPinnedFolders
            self.browserCategoryPaneWidth = decoded.browserCategoryPaneWidth
            self.browserFavorites = decoded.browserFavorites
            // userFolderPath is ignored from JSON as the JSON location defines itself
        } catch {
            print("AppSettings: Failed to load from JSON: \(error)")
        }
    }

    public func syncToDisk() {
        // Ensure directory exists (will be reinforced by UserConfigurationService)
        do {
            try FileManager.default.createDirectory(at: userInfoURL, withIntermediateDirectories: true)
            let data = try JSONEncoder().encode(self)
            try data.write(to: settingsFileURL, options: .atomic)
        } catch {
            print("AppSettings: Failed to sync to disk: \(error)")
        }
    }
}

// MARK: - Notification Names

public extension Notification.Name {
    static let samplesPathDidChange = Notification.Name("dreamdaw.samplesPathDidChange")
    static let waveformStyleDidChange = Notification.Name("dreamdaw.waveformStyleDidChange")
    static let userFolderPathDidChange = Notification.Name("dreamdaw.userFolderPathDidChange")
    static let vstPathsDidChange = Notification.Name("dreamdaw.vstPathsDidChange")
}
