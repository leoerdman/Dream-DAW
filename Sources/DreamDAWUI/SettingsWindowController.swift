import SwiftUI
import DreamDAWModels
import CoreAudio

// MARK: - SettingsTab

/// Available settings tabs.
enum SettingsTab: String, CaseIterable, Identifiable {
    case general  = "general"
    case audio    = "audio"
    case storage  = "storage"
    
    var id: String { rawValue }
    
    var label: String {
        switch self {
        case .general: return "General"
        case .audio:   return "Audio"
        case .storage: return "Folders"
        }
    }
    
    var icon: String {
        switch self {
        case .general: return "gearshape"
        case .audio:   return "speaker.wave.3"
        case .storage: return "folder"
        }
    }
}

// MARK: - SettingsView

/// Main settings view with sidebar navigation.
public struct SettingsView: View {
    
    @StateObject private var settings = AppSettings.shared
    @State private var selectedTab: SettingsTab = .general
    
    public init() {}
    
    public var body: some View {
        NavigationSplitView {
            // Sidebar
            List(SettingsTab.allCases, selection: $selectedTab) { tab in
                Label(tab.label, systemImage: tab.icon)
                    .tag(tab)
            }
            .listStyle(.sidebar)
            .navigationSplitViewColumnWidth(min: 180, ideal: 200, max: 220)
        } detail: {
            // Detail panel
            switch selectedTab {
            case .general:
                GeneralSettingsView(settings: settings)
            case .audio:
                AudioSettingsView(settings: settings)
            case .storage:
                StorageSettingsView(settings: settings)
            }
        }
        .frame(width: 650, height: 450)
    }
}

// MARK: - GeneralSettingsView

struct GeneralSettingsView: View {
    @ObservedObject var settings: AppSettings
    
    var body: some View {
        Form {
            Section {
                Picker("Interface Language", selection: $settings.language) {
                    ForEach(AppLanguage.allCases, id: \.self) { lang in
                        Text(lang.displayName).tag(lang)
                    }
                }
                .pickerStyle(.menu)
            } header: {
                Text("Language")
            } footer: {
                Text("Changes will be applied after restart.")
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .navigationTitle("General")
    }
}

// MARK: - AudioSettingsView

struct AudioSettingsView: View {
    @ObservedObject var settings: AppSettings
    @State private var outputDevices: [(name: String, uid: String)] = []
    @State private var selectedDeviceUID: String = ""
    @State private var currentSampleRate: Double = 44100.0
    @State private var currentBufferSize: Int = 512
    
    var body: some View {
        Form {
            Section {
                HStack {
                    Text("Driver Type")
                    Spacer()
                    Text("CoreAudio")
                        .foregroundStyle(.secondary)
                }
                
                Picker("Audio Output Device", selection: $selectedDeviceUID) {
                    ForEach(outputDevices, id: \.uid) { device in
                        Text(device.name).tag(device.uid)
                    }
                }
                .pickerStyle(.menu)
                .onChange(of: selectedDeviceUID) { _, newUID in
                    settings.audioOutputDeviceUID = newUID
                }
            } header: {
                Text("Audio Device")
            }
            
            Section {
                HStack {
                    Text("Sample Rate")
                    Spacer()
                    Text("\(Int(currentSampleRate)) Hz")
                        .foregroundStyle(.secondary)
                }
                
                HStack {
                    Text("Buffer Size")
                    Spacer()
                    Text("\(currentBufferSize) Samples")
                        .foregroundStyle(.secondary)
                }
                
                HStack {
                    Text("Input Latency")
                    Spacer()
                    let inputMs = Double(currentBufferSize) / currentSampleRate * 1000.0
                    Text(String(format: "%.1f ms", inputMs))
                        .foregroundStyle(.secondary)
                }
                
                HStack {
                    Text("Output Latency")
                    Spacer()
                    let outputMs = Double(currentBufferSize) / currentSampleRate * 1000.0
                    Text(String(format: "%.1f ms", outputMs))
                        .foregroundStyle(.secondary)
                }
            } header: {
                Text("Latency")
            }
        }
        .formStyle(.grouped)
        .navigationTitle("Audio")
        .onAppear {
            loadAudioDevices()
        }
    }
    
    private func loadAudioDevices() {
        outputDevices = AudioDeviceEnumerator.listOutputDevices()
        
        // Select currently saved or default device
        if let savedUID = settings.audioOutputDeviceUID,
           outputDevices.contains(where: { $0.uid == savedUID }) {
            selectedDeviceUID = savedUID
        } else if let defaultUID = AudioDeviceEnumerator.defaultOutputDeviceUID() {
            selectedDeviceUID = defaultUID
        }
        
        // Load current sample rate
        currentSampleRate = AudioDeviceEnumerator.sampleRateForDevice(uid: selectedDeviceUID) ?? 44100.0
        currentBufferSize = AudioDeviceEnumerator.bufferSizeForDevice(uid: selectedDeviceUID) ?? 512
    }
}

// MARK: - AudioDeviceEnumerator

/// Enumerates CoreAudio output devices on macOS.
enum AudioDeviceEnumerator {
    
    /// List all available output audio devices.
    static func listOutputDevices() -> [(name: String, uid: String)] {
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
    static func defaultOutputDeviceUID() -> String? {
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
    static func sampleRateForDevice(uid: String) -> Double? {
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
    static func bufferSizeForDevice(uid: String) -> Int? {
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
    
    private static func deviceIDForUID(_ uid: String) -> AudioDeviceID? {
        // Iterate all devices and match UID — avoids unsafe AudioValueTranslation pointers
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

// MARK: - StorageSettingsView

struct StorageSettingsView: View {
    @ObservedObject var settings: AppSettings
    
    var body: some View {
        Form {
            Section {
                HStack {
                    TextField("Storage Path", text: $settings.userStoragePath)
                        .textFieldStyle(.roundedBorder)
                    
                    Button("Browse...") {
                        selectFolder(for: \.userStoragePath)
                    }
                }
            } header: {
                Text("User Storage")
            } footer: {
                Text("Projects will be stored in this folder.")
                    .foregroundStyle(.secondary)
            }
            
            Section {
                HStack {
                    TextField("Samples Folder", text: $settings.samplesPath)
                        .textFieldStyle(.roundedBorder)
                    
                    Button("Browse...") {
                        selectFolder(for: \.samplesPath)
                    }
                }
                
                if !settings.samplesPath.isEmpty {
                    let fileCount = countAudioFiles(in: settings.samplesPath)
                    HStack {
                        Image(systemName: "waveform")
                            .foregroundColor(.secondary)
                        Text("\(fileCount) audio files found")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            } header: {
                Text("Samples Library")
            } footer: {
                Text("Audio samples from this folder will appear in the Browser sidebar for drag & drop.")
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .navigationTitle("Folders")
    }
    
    private func selectFolder(for keyPath: ReferenceWritableKeyPath<AppSettings, String>) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Select Folder"
        
        if panel.runModal() == .OK, let url = panel.url {
            settings[keyPath: keyPath] = url.path
        }
    }
    
    private func countAudioFiles(in path: String) -> Int {
        let url = URL(fileURLWithPath: path)
        let audioExtensions = ["wav", "aiff", "aif", "mp3", "m4a", "flac", "ogg", "caf"]
        guard let enumerator = FileManager.default.enumerator(
            at: url,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles]
        ) else { return 0 }
        
        var count = 0
        for case let fileURL as URL in enumerator {
            if audioExtensions.contains(fileURL.pathExtension.lowercased()) {
                count += 1
            }
        }
        return count
    }
}

// MARK: - SettingsWindowController

/// Manages the Settings window (Cmd+,).
public final class SettingsWindowController: NSWindowController {
    
    private static var shared: SettingsWindowController?
    
    public static func showSettings() {
        if let existing = shared, let window = existing.window, window.isVisible {
            window.makeKeyAndOrderFront(nil)
            return
        }
        
        let settingsView = SettingsView()
        let hostingView = NSHostingView(rootView: settingsView)
        
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 650, height: 450),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Dream DAW Settings"
        window.contentView = hostingView
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = .windowBackgroundColor
        window.center()
        window.isReleasedWhenClosed = false
        
        let controller = SettingsWindowController(window: window)
        shared = controller
        
        window.makeKeyAndOrderFront(nil)
    }
    
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }
    
    override init(window: NSWindow?) {
        super.init(window: window)
    }
}
