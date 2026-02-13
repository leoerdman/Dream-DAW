import SwiftUI
import DreamDAWModels
import DreamDAWEngine
import CoreAudio

// MARK: - SettingsTab

/// Available settings tabs.
enum SettingsTab: String, CaseIterable, Identifiable {
    case general  = "general"
    case appearance = "appearance"
    case audio    = "audio"
    case storage  = "storage"
    case about    = "about"
    
    var id: String { rawValue }
    
    var label: String {
        switch self {
        case .general: return "General"
        case .appearance: return "Appearance"
        case .audio:   return "Audio"
        case .storage: return "Folders"
        case .about:   return "About"
        }
    }
    
    var icon: String {
        switch self {
        case .general: return "gearshape"
        case .appearance: return "paintbrush"
        case .audio:   return "speaker.wave.3"
        case .storage: return "folder"
        case .about:   return "info.circle"
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
        HStack(spacing: 0) {
            // Sidebar
            List(SettingsTab.allCases, selection: $selectedTab) { tab in
                Label(tab.label, systemImage: tab.icon)
                    .tag(tab)
            }
            .listStyle(.sidebar)
            .frame(width: 180)
            
            // Detail panel
            Group {
                switch selectedTab {
                case .general:
                    GeneralSettingsView(settings: settings)
                case .appearance:
                    AppearanceSettingsView(settings: settings)
                case .audio:
                    AudioSettingsView(settings: settings)
                case .storage:
                    StorageSettingsView(settings: settings)
                case .about:
                    AboutSettingsView()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color(NSColor.windowBackgroundColor))
        }
        .frame(width: 650, height: 450)
        .toolbar(.hidden, for: .windowToolbar) // Radically hide the window toolbar to ensure sidebar toggle and separators are gone
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
            
            Section {
                Picker("Application Startup", selection: $settings.startupBehavior) {
                    ForEach(StartupBehavior.allCases, id: \.self) { behavior in
                        Text(behavior.displayName).tag(behavior)
                    }
                }
                .pickerStyle(.radioGroup)
            } header: {
                Text("Startup")
            } footer: {
                Text("Choose what happens when you open Dream DAW.")
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
    }
}

// MARK: - AboutSettingsView

struct AboutSettingsView: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                // Header
                HStack(spacing: 16) {
                    Image(nsImage: NSImage(named: "AppIcon") ?? NSImage())
                        .resizable()
                        .frame(width: 64, height: 64)
                        .cornerRadius(12)
                    
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Dream DAW")
                            .font(.title).bold()
                        Text(AppVersion.fullVersionString)
                            .font(.subheadline)
                            .foregroundColor(.secondary)
                    }
                }
                .padding(.bottom, 10)
                
                Divider()
                
                Text("Version History")
                    .font(.headline)
                
                ForEach(AppVersion.history, id: \.version) { entry in
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text(entry.version)
                                .font(.system(size: 13, weight: .bold, design: .monospaced))
                                .foregroundColor(DreamTheme.accentSwiftUI)
                            Spacer()
                            Text(entry.date)
                                .font(.caption)
                                .foregroundColor(.secondary)
                        }
                        
                        VStack(alignment: .leading, spacing: 2) {
                            ForEach(entry.changes, id: \.self) { change in
                                HStack(alignment: .top, spacing: 6) {
                                    Text("•").foregroundColor(DreamTheme.accentSwiftUI)
                                    Text(change)
                                        .font(.system(size: 11))
                                }
                            }
                        }
                    }
                    .padding(.vertical, 4)
                    
                    if entry.version != AppVersion.history.last?.version {
                        Divider().opacity(0.3)
                    }
                }
                
                Spacer(minLength: 20)
                
                Text("© 2026 Dream DAW Team. All rights reserved.")
                    .font(.caption2)
                    .foregroundColor(.secondary)
                    .frame(maxWidth: .infinity, alignment: .center)
            }
            .padding(24)
        }
    }
}

// SwiftUI Color Extension for DreamTheme
extension DreamTheme {
    static var accentSwiftUI: Color {
        Color(nsColor: DreamTheme.accent)
    }
}

// MARK: - AppearanceSettingsView

struct AppearanceSettingsView: View {
    @ObservedObject var settings: AppSettings
    
    var body: some View {
        Form {
            Section {
                Picker("Waveform Style", selection: $settings.waveformStyle) {
                    ForEach(WaveformStyle.allCases, id: \.self) { style in
                        Text(style.displayName).tag(style)
                    }
                }
                .pickerStyle(.radioGroup)
            } header: {
                Text("Waveforms")
            } footer: {
                Text("Classic Black style provides a high-contrast, professional look.")
            }
        }
        .formStyle(.grouped)
    }
}

// MARK: - AudioSettingsView

struct AudioSettingsView: View {
    @ObservedObject var settings: AppSettings
    @State private var inputDevices: [(name: String, uid: String)] = []
    @State private var outputDevices: [(name: String, uid: String)] = []
    @State private var selectedInputUID: String = ""
    @State private var selectedOutputUID: String = ""
    @State private var currentSampleRate: Double = 48000.0
    @State private var currentBufferSize: Int = 512
    
    var body: some View {
        Form {
            Section {
                HStack {
                    Text("Driver Type")
                    Spacer()
                    Picker("", selection: .constant("CoreAudio")) {
                        Text("CoreAudio").tag("CoreAudio")
                    }
                    .labelsHidden()
                    .frame(width: 150)
                }
                
                Picker("Audio Input Device", selection: $selectedInputUID) {
                    Text("No Device").tag("")
                    ForEach(inputDevices, id: \.uid) { device in
                        Text(device.name).tag(device.uid)
                    }
                }
                .onChange(of: selectedInputUID) { newUID in
                    settings.audioInputDeviceUID = newUID.isEmpty ? nil : newUID
                }
                
                Picker("Audio Output Device", selection: $selectedOutputUID) {
                    ForEach(outputDevices, id: \.uid) { device in
                        Text(device.name).tag(device.uid)
                    }
                }
                .onChange(of: selectedOutputUID) { newUID in
                    settings.audioOutputDeviceUID = newUID
                }
                
                HStack {
                    Text("Channel Configuration")
                    Spacer()
                    HStack(spacing: 8) {
                        Button("Input Config") {}
                            .buttonStyle(.bordered)
                        Button("Output Config") {}
                            .buttonStyle(.bordered)
                    }
                }
            } header: {
                Text("Audio Device")
            }
            
            Section {
                HStack {
                    Text("In/Out Sample Rate")
                    Spacer()
                    Picker("", selection: $settings.audioSampleRate) {
                        ForEach([44100.0, 48000.0, 88200.0, 96000.0], id: \.self) { rate in
                            Text("\(Int(rate))").tag(rate)
                        }
                    }
                    .pickerStyle(.menu)
                    .labelsHidden()
                    .frame(width: 100)
                    .onChange(of: settings.audioSampleRate) { newRate in
                        AudioDeviceEnumerator.setSampleRateForDevice(uid: selectedOutputUID, rate: newRate)
                        currentSampleRate = newRate
                    }
                }
                
                HStack {
                    Text("Default SR & Pitch Conversion")
                    Spacer()
                    Toggle(isOn: $settings.srPitchConversionHighQuality) {
                        Text(settings.srPitchConversionHighQuality ? "High Quality" : "Normal")
                    }
                    .toggleStyle(.button)
                    .tint(Color(nsColor: NSColor(red: 1.0, green: 0.6, blue: 0.2, alpha: 1.0)))
                }
            } header: {
                Text("Sample Rate")
            }
            
            Section {
                HStack {
                    Text("Buffer Size")
                    Spacer()
                    Picker("", selection: $settings.audioBufferSize) {
                        ForEach([64, 128, 256, 512, 1024, 2048], id: \.self) { size in
                            Text("\(size) Samples").tag(size)
                        }
                    }
                    .pickerStyle(.menu)
                    .labelsHidden()
                    .frame(width: 120)
                    .onChange(of: settings.audioBufferSize) { newSize in
                        AudioDeviceEnumerator.setBufferSizeForDevice(uid: selectedOutputUID, size: UInt32(newSize))
                        currentBufferSize = newSize
                    }
                }
                
                let inputMs = Double(currentBufferSize) / currentSampleRate * 1000.0
                let outputMs = Double(currentBufferSize) / currentSampleRate * 1000.0
                let compensation = settings.driverErrorCompensation
                let overall = inputMs + outputMs + compensation
                
                HStack {
                    Text("Input Latency")
                    Spacer()
                    Text(String(format: "%.1f ms", inputMs))
                        .foregroundStyle(.secondary)
                }
                
                HStack {
                    Text("Output Latency")
                    Spacer()
                    Text(String(format: "%.1f ms", outputMs))
                        .foregroundStyle(.secondary)
                }
                
                HStack {
                    Text("Driver Error Compensation")
                    Spacer()
                    HStack(spacing: 0) {
                        TextField("", value: $settings.driverErrorCompensation, format: .number)
                            .textFieldStyle(.plain)
                            .multilineTextAlignment(.center)
                            .frame(width: 60)
                            .background(Color(white: 0.2))
                        Text("ms")
                            .font(.caption)
                            .padding(.horizontal, 4)
                            .background(Color(nsColor: NSColor(red: 1.0, green: 0.6, blue: 0.2, alpha: 1.0)))
                            .foregroundColor(.black)
                    }
                    .cornerRadius(2)
                }
                
                HStack {
                    Text("Overall Latency")
                    Spacer()
                    Text(String(format: "%.1f ms", overall))
                        .foregroundStyle(.secondary)
                }
            } header: {
                Text("Latency")
            }
            
            Section {
                HStack {
                    Text("Test Tone")
                    Spacer()
                    Toggle(isOn: $settings.testToneEnabled) {
                        Text(settings.testToneEnabled ? "On" : "Off")
                    }
                    .toggleStyle(.button)
                    .tint(settings.testToneEnabled ? .cyan : .gray)
                }
                
                HStack {
                    Text("Tone Volume")
                    Spacer()
                    HStack(spacing: 0) {
                        TextField("", value: $settings.testToneVolume, format: .number)
                            .textFieldStyle(.plain)
                            .multilineTextAlignment(.center)
                            .frame(width: 60)
                            .background(Color(white: 0.2))
                        Text("dB")
                            .font(.caption)
                            .padding(.horizontal, 4)
                            .background(Color.cyan.opacity(0.8))
                            .foregroundColor(.black)
                    }
                    .cornerRadius(2)
                }
                
                HStack {
                    Text("Tone Frequency")
                    Spacer()
                    HStack(spacing: 0) {
                        TextField("", value: $settings.testToneFrequency, format: .number)
                            .textFieldStyle(.plain)
                            .multilineTextAlignment(.center)
                            .frame(width: 60)
                            .background(Color(white: 0.2))
                        Text("Hz")
                            .font(.caption)
                            .padding(.horizontal, 4)
                            .background(Color.cyan.opacity(0.8))
                            .foregroundColor(.black)
                    }
                    .cornerRadius(2)
                }
                
                HStack {
                    Text("CPU Usage Simulator")
                    Spacer()
                    HStack(spacing: 0) {
                        TextField("", value: $settings.cpuUsageSimulator, format: .number)
                            .textFieldStyle(.plain)
                            .multilineTextAlignment(.center)
                            .frame(width: 60)
                            .background(Color(white: 0.2))
                        Text("%")
                            .font(.caption)
                            .padding(.horizontal, 4)
                            .background(Color.cyan.opacity(0.8))
                            .foregroundColor(.black)
                    }
                    .cornerRadius(2)
                }
            } header: {
                Text("Test")
            }
        }
        .formStyle(.grouped)
        .onAppear {
            loadAudioDevices()
        }
    }
    
    private func loadAudioDevices() {
        inputDevices = AudioDeviceEnumerator.listInputDevices()
        outputDevices = AudioDeviceEnumerator.listOutputDevices()
        
        // Select currently saved or default device
        if let savedUID = settings.audioOutputDeviceUID,
           outputDevices.contains(where: { $0.uid == savedUID }) {
            selectedOutputUID = savedUID
        } else if let defaultUID = AudioDeviceEnumerator.defaultOutputDeviceUID() {
            selectedOutputUID = defaultUID
        }
        
        if let savedInputUID = settings.audioInputDeviceUID,
           inputDevices.contains(where: { $0.uid == savedInputUID }) {
            selectedInputUID = savedInputUID
        }
        
        // Load current sample rate
        currentSampleRate = AudioDeviceEnumerator.sampleRateForDevice(uid: selectedOutputUID) ?? 48000.0
        
        if !selectedOutputUID.isEmpty {
            AudioDeviceEnumerator.setSampleRateForDevice(uid: selectedOutputUID, rate: settings.audioSampleRate)
            AudioDeviceEnumerator.setBufferSizeForDevice(uid: selectedOutputUID, size: UInt32(settings.audioBufferSize))
        }
        
        currentBufferSize = AudioDeviceEnumerator.bufferSizeForDevice(uid: selectedOutputUID) ?? 512
    }
}

// [AudioDeviceEnumerator MOVED TO DreamDAWEngine]

// MARK: - StorageSettingsView

struct StorageSettingsView: View {
    @ObservedObject var settings: AppSettings
    
    var body: some View {
        Form {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        TextField("User Folder", text: $settings.userFolderPath)
                            .textFieldStyle(.roundedBorder)
                        
                        Button("Browse...") {
                            selectFolder(for: \.userFolderPath)
                        }
                    }
                    
                    Text("This is the main folder for your projects, settings, and cache.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                
                // Subfolder Status
                VStack(alignment: .leading, spacing: 4) {
                    FolderStatusRow(name: "User Info", path: settings.userInfoURL.path)
                    FolderStatusRow(name: "User Cache", path: settings.userCacheURL.path)
                }
                .padding(.top, 4)
                
            } header: {
                Text("Main User Directory")
            } footer: {
                Text("Changing this folder will migrate your settings and cache to the new location.")
                    .foregroundStyle(.secondary)
            }
            
            Section {
                HStack {
                    TextField("Samples Library", text: $settings.samplesPath)
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
                        Text("\(fileCount) audio files indexed")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            } header: {
                Text("Samples Library")
            } footer: {
                Text("Samples from this folder appear in the sidebar for quick drag & drop.")
                    .foregroundStyle(.secondary)
            }
            
            Section {
                // VST2
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        TextField("VST2 Folders", text: $settings.vst2Path)
                            .textFieldStyle(.roundedBorder)
                        
                        Button("Browse...") {
                            selectFolder(for: \.vst2Path)
                        }
                    }
                }
                
                // VST3
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        TextField("VST3 Folders", text: $settings.vst3Path)
                            .textFieldStyle(.roundedBorder)
                        
                        Button("Browse...") {
                            selectFolder(for: \.vst3Path)
                        }
                    }
                }
            } header: {
                Text("Plug-In Sources")
            } footer: {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Dream DAW will scan these folders for VST2 (.vst) and VST3 (.vst3) plugins.")
                    
                    Button {
                        PluginManager.shared.scanAll(forceRescan: true)
                    } label: {
                        Label("Rescan Plugins", systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(.bordered)
                }
                .foregroundStyle(.secondary)
            }
            
            Section {
                Button("Reveal User Folder in Finder") {
                    NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: settings.userFolderPath)
                }
                .frame(maxWidth: .infinity, alignment: .center)
            }
        }
        .formStyle(.grouped)
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
        let audioExtensions = ["wav", "aiff", "aif", "mp3", "m4a", "flac"]
        guard let enumerator = FileManager.default.enumerator(
            at: url,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles, .skipsPackageDescendants]
        ) else { return 0 }
        
        var count = 0
        for case let fileURL as URL in enumerator {
            if audioExtensions.contains(fileURL.pathExtension.lowercased()) {
                count += 1
                if count > 1000 { return 1000 } // Cap for UI performance
            }
        }
        return count
    }
}

private struct FolderStatusRow: View {
    let name: String
    let path: String
    
    var body: some View {
        HStack {
            Image(systemName: "folder.fill")
                .foregroundColor(.accentColor)
                .font(.caption)
            Text(name)
                .font(.caption)
            Spacer()
            Text(FileManager.default.fileExists(atPath: path) ? "Active" : "Pending")
                .font(.caption2)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(FileManager.default.fileExists(atPath: path) ? Color.green.opacity(0.2) : Color.orange.opacity(0.2))
                .foregroundColor(FileManager.default.fileExists(atPath: path) ? .green : .orange)
                .cornerRadius(4)
        }
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
