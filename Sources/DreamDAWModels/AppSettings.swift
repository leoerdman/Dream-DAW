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

// MARK: - AppSettings

/// Persistent application settings stored in UserDefaults.
public final class AppSettings: ObservableObject {
    
    public static let shared = AppSettings()
    
    private let defaults = UserDefaults.standard
    
    // Keys
    private enum Keys {
        static let language = "dreamdaw.settings.language"
        static let userStoragePath = "dreamdaw.settings.userStoragePath"
        static let samplesPath = "dreamdaw.settings.samplesPath"
        static let audioOutputDeviceUID = "dreamdaw.settings.audioOutputDeviceUID"
        static let waveformStyle = "dreamdaw.settings.waveformStyle"
        static let startupBehavior = "dreamdaw.settings.startupBehavior"
    }
    
    // MARK: - General
    
    /// UI language.
    @Published public var language: AppLanguage {
        didSet {
            defaults.set(language.rawValue, forKey: Keys.language)
        }
    }
    
    /// Waveform aesthetic style.
    @Published public var waveformStyle: WaveformStyle {
        didSet {
            defaults.set(waveformStyle.rawValue, forKey: Keys.waveformStyle)
            NotificationCenter.default.post(name: .waveformStyleDidChange, object: nil)
        }
    }
    
    /// Behavior when application starts.
    @Published public var startupBehavior: StartupBehavior {
        didSet {
            defaults.set(startupBehavior.rawValue, forKey: Keys.startupBehavior)
        }
    }
    
    // MARK: - Storage
    
    /// User-specified storage folder for projects and samples.
    @Published public var userStoragePath: String {
        didSet {
            defaults.set(userStoragePath, forKey: Keys.userStoragePath)
        }
    }
    
    /// User sample library folder path.
    @Published public var samplesPath: String {
        didSet {
            defaults.set(samplesPath, forKey: Keys.samplesPath)
            NotificationCenter.default.post(name: .samplesPathDidChange, object: nil)
        }
    }

    // MARK: - Audio

    /// Selected audio output device UID.
    @Published public var audioOutputDeviceUID: String? {
        didSet {
            defaults.set(audioOutputDeviceUID, forKey: Keys.audioOutputDeviceUID)
        }
    }
    
    // MARK: - Initialization
    
    private init() {
        if let langRaw = defaults.string(forKey: Keys.language),
           let lang = AppLanguage(rawValue: langRaw) {
            self.language = lang
        } else {
            self.language = .english
        }
        
        if let styleRaw = defaults.string(forKey: Keys.waveformStyle),
           let style = WaveformStyle(rawValue: styleRaw) {
            self.waveformStyle = style
        } else {
            self.waveformStyle = .colored
        }
        
        if let path = defaults.string(forKey: Keys.userStoragePath), !path.isEmpty {
            self.userStoragePath = path
        } else {
            // Default to ~/Music/Dream DAW
            let musicDir = FileManager.default.urls(for: .musicDirectory, in: .userDomainMask).first
            self.userStoragePath = musicDir?.appendingPathComponent("Dream DAW").path ?? "~/Music/Dream DAW"
        }
        
        self.samplesPath = defaults.string(forKey: Keys.samplesPath) ?? ""
        self.audioOutputDeviceUID = defaults.string(forKey: Keys.audioOutputDeviceUID)
        
        if let startupRaw = defaults.string(forKey: Keys.startupBehavior),
           let behavior = StartupBehavior(rawValue: startupRaw) {
            self.startupBehavior = behavior
        } else {
            self.startupBehavior = .newProject
        }
    }
}

// MARK: - Notification Names

public extension Notification.Name {
    static let samplesPathDidChange = Notification.Name("dreamdaw.samplesPathDidChange")
    static let waveformStyleDidChange = Notification.Name("dreamdaw.waveformStyleDidChange")
}
