import AppKit
import DreamDAWModels
import DreamDAWUI
import DreamDAWEngine

// MARK: - AppDelegate

/// Application delegate for Dream DAW.
/// Manages the application lifecycle and main window.
final class AppDelegate: NSObject, NSApplicationDelegate {

    // MARK: - Properties

    private var mainWindowController: MainWindowController?
    private var project: Project!

    // MARK: - Application Lifecycle

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Create default project
        project = Project.createDefault()

        // Create and show main window
        mainWindowController = MainWindowController(project: project)
        mainWindowController?.showWindow()

        // Set up application menu
        setupMainMenu()

        // Ensure app is in foreground
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationWillTerminate(_ notification: Notification) {
        // Cleanup: stop audio engine
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool {
        true
    }

    // MARK: - Menu

    private func setupMainMenu() {
        let mainMenu = NSMenu()

        // App Menu
        let appMenuItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Dream DAW", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "Settings...", action: #selector(openSettings), keyEquivalent: ",")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "Quit Dream DAW", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appMenuItem.submenu = appMenu
        mainMenu.addItem(appMenuItem)

        // File Menu
        let fileMenuItem = NSMenuItem()
        let fileMenu = NSMenu(title: "File")
        fileMenu.addItem(withTitle: "New Project", action: #selector(newProject), keyEquivalent: "n")
        fileMenu.addItem(NSMenuItem.separator())
        fileMenu.addItem(withTitle: "Open...", action: #selector(openProject), keyEquivalent: "o")
        fileMenu.addItem(NSMenuItem.separator())
        fileMenu.addItem(withTitle: "Save", action: #selector(saveProject), keyEquivalent: "s")
        fileMenu.addItem(withTitle: "Save As...", action: #selector(saveProjectAs), keyEquivalent: "S")
        fileMenuItem.submenu = fileMenu
        mainMenu.addItem(fileMenuItem)

        // Edit Menu
        let editMenuItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Undo", action: #selector(ArrangementViewController.undo(_:)), keyEquivalent: "z")
        editMenu.addItem(withTitle: "Redo", action: #selector(ArrangementViewController.redo(_:)), keyEquivalent: "Z")
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Delete", action: #selector(NSText.delete(_:)), keyEquivalent: "\u{8}")
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editMenuItem.submenu = editMenu
        mainMenu.addItem(editMenuItem)

        // View Menu
        let viewMenuItem = NSMenuItem()
        let viewMenu = NSMenu(title: "View")
        viewMenu.addItem(withTitle: "Zoom In", action: #selector(zoomIn), keyEquivalent: "=")
        viewMenu.addItem(withTitle: "Zoom Out", action: #selector(zoomOut), keyEquivalent: "-")
        viewMenu.addItem(withTitle: "Zoom to Fit", action: #selector(zoomToFit), keyEquivalent: "0")
        viewMenuItem.submenu = viewMenu
        mainMenu.addItem(viewMenuItem)

        // Transport Menu
        let transportMenuItem = NSMenuItem()
        let transportMenu = NSMenu(title: "Transport")
        transportMenu.addItem(withTitle: "Play/Pause", action: #selector(togglePlay), keyEquivalent: " ")
        transportMenu.addItem(withTitle: "Stop", action: #selector(stopTransport), keyEquivalent: "\r")
        transportMenuItem.submenu = transportMenu
        mainMenu.addItem(transportMenuItem)

        // Track Menu
        let trackMenuItem = NSMenuItem()
        let trackMenu = NSMenu(title: "Track")
        trackMenu.addItem(withTitle: "Add MIDI Track", action: #selector(addMidiTrack), keyEquivalent: "t")
        let addAudioItem = NSMenuItem(title: "Add Audio Track", action: #selector(addAudioTrack), keyEquivalent: "t")
        addAudioItem.keyEquivalentModifierMask = [.command, .shift]
        trackMenu.addItem(addAudioItem)
        trackMenuItem.submenu = trackMenu
        mainMenu.addItem(trackMenuItem)

        // Window Menu
        let windowMenuItem = NSMenuItem()
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowMenuItem.submenu = windowMenu
        mainMenu.addItem(windowMenuItem)

        NSApplication.shared.mainMenu = mainMenu
        NSApplication.shared.windowsMenu = windowMenu
    }

    // MARK: - Actions

    @objc private func newProject() {
        project = Project.createDefault()
        // Reuse existing window — replace content, preserve window frame
        if let window = mainWindowController?.window {
            let savedFrame = window.frame
            let arrangementVC = ArrangementViewController(project: project)
            window.contentViewController = arrangementVC
            window.title = "Dream DAW — \(project.name)"
            window.setFrame(savedFrame, display: true)
        } else {
            mainWindowController = MainWindowController(project: project)
            mainWindowController?.showWindow()
        }
    }

    @objc private func openProject() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.init(filenameExtension: ProjectFileManager.fileExtension) ?? .data]
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.message = "Select a Dream DAW project file (.ddpj)"
        panel.appearance = NSAppearance(named: .darkAqua)

        panel.begin { [weak self] response in
            guard response == .OK, let url = panel.url else { return }
            self?.loadProject(from: url)
        }
    }

    @objc private func saveProject() {
        let fm = ProjectFileManager.shared
        if fm.projectFolderURL != nil {
            do {
                _ = try fm.save(project: project)
                mainWindowController?.window?.title = "Dream DAW — \(project.name) V\(fm.currentVersion)"
            } catch {
                saveProjectAs()
            }
        } else {
            saveProjectAs()
        }
    }

    @objc private func saveProjectAs() {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = "\(project.name) V1"
        panel.allowedContentTypes = [.init(filenameExtension: ProjectFileManager.fileExtension) ?? .data]
        panel.canCreateDirectories = true
        panel.title = "Save Project"
        panel.prompt = "Save"
        panel.message = "Choose where to save \"\(project.name)\". If saved outside a project folder, a new folder will be created automatically."
        panel.appearance = NSAppearance(named: .darkAqua)
        panel.directoryURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Documents")

        // Use runModal() for a full-size standalone Finder window
        let response = panel.runModal()
        guard response == .OK, let fileURL = panel.url else { return }

        do {
            _ = try ProjectFileManager.shared.saveToFile(project: self.project, fileURL: fileURL)
            let fm = ProjectFileManager.shared
            self.mainWindowController?.window?.title = "Dream DAW — \(self.project.name) V\(fm.currentVersion)"
        } catch {
            let alert = NSAlert(error: error)
            alert.runModal()
        }
    }

    @objc private func zoomIn() {
        if let vc = mainWindowController?.window?.contentViewController as? ArrangementViewController {
            vc.setZoom(DreamTheme.defaultPixelsPerBeat * 1.5)
        }
    }

    @objc private func zoomOut() {
        if let vc = mainWindowController?.window?.contentViewController as? ArrangementViewController {
            vc.setZoom(DreamTheme.defaultPixelsPerBeat * 0.67)
        }
    }

    @objc private func zoomToFit() {
        if let vc = mainWindowController?.window?.contentViewController as? ArrangementViewController {
            vc.setZoom(DreamTheme.defaultPixelsPerBeat)
        }
    }

    @objc private func togglePlay() {
        // Handled by ArrangementViewController keyboard shortcut
    }

    @objc private func stopTransport() {
        // Handled by ArrangementViewController keyboard shortcut
    }

    @objc private func openSettings() {
        SettingsWindowController.showSettings()
    }

    @objc private func addMidiTrack() {
        project.addTrack(type: .midi)
        refreshArrangement()
    }

    @objc private func addAudioTrack() {
        project.addTrack(type: .audio)
        refreshArrangement()
    }

    private func refreshArrangement() {
        if let vc = mainWindowController?.window?.contentViewController as? ArrangementViewController {
            vc.reloadTracks()
        }
    }

    // MARK: - Persistence

    private func loadProject(from url: URL) {
        do {
            let loadedProject = try ProjectFileManager.shared.open(fileURL: url)
            project = loadedProject
            let fm = ProjectFileManager.shared
            // Reuse existing window — replace content, preserve window frame
            if let window = mainWindowController?.window {
                let savedFrame = window.frame
                let arrangementVC = ArrangementViewController(project: project)
                window.contentViewController = arrangementVC
                window.title = "Dream DAW — \(project.name) V\(fm.currentVersion)"
                window.setFrame(savedFrame, display: true)
            } else {
                mainWindowController = MainWindowController(project: project)
                mainWindowController?.showWindow()
            }
        } catch {
            let alert = NSAlert(error: error)
            alert.runModal()
        }
    }
}

// MARK: - App Entry Point

let app = NSApplication.shared

// CRITICAL: Without this, a CLI-launched app has no Dock icon and windows stay hidden.
app.setActivationPolicy(.regular)

let delegate = AppDelegate()
app.delegate = delegate

// Activate and bring to front
app.activate(ignoringOtherApps: true)

app.run()
