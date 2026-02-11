import SwiftUI
import DreamDAWModels

// MARK: - SettingsTab

/// Available settings tabs.
enum SettingsTab: String, CaseIterable, Identifiable {
    case general  = "general"
    case storage  = "storage"
    
    var id: String { rawValue }
    
    var label: String {
        switch self {
        case .general: return "General"
        case .storage: return "Folders"
        }
    }
    
    var icon: String {
        switch self {
        case .general: return "gearshape"
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
            case .storage:
                StorageSettingsView(settings: settings)
            }
        }
        .frame(width: 650, height: 400)
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
            contentRect: NSRect(x: 0, y: 0, width: 650, height: 400),
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
