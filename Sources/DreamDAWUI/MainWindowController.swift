import AppKit
import Combine
import DreamDAWModels

// MARK: - MainWindowController

/// Configures and manages the main application window.
/// Sets up the dark appearance, minimum size, and window content.
public final class MainWindowController: NSWindowController, NSWindowDelegate {

    // MARK: - Properties

    private var project: Project
    private var cancellables = Set<AnyCancellable>()

    // MARK: - Initialization

    public init(project: Project) {
        self.project = project
        // ... (window setup)
        super.init(window: nil) // We create a window below
        
        setupWindow()
        
        // Monitor double-click on title bar → zoom
        setupTitleBarDoubleClickHandler()
        
        // Load app icon
        loadAppIcon()
        
        // Observe dirty state
        setupProjectSubscription()
    }
    
    private func setupWindow() {
        let windowRect = NSRect(x: 0, y: 0, width: 1280, height: 800)
        let styleMask: NSWindow.StyleMask = [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView]
        let window = NSWindow(contentRect: windowRect, styleMask: styleMask, backing: .buffered, defer: false)

        window.title = "Dream DAW"
        window.minSize = NSSize(width: 900, height: 600)
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = DreamTheme.bgPrimary
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .visible
        window.isMovableByWindowBackground = false
        window.collectionBehavior = [.fullScreenPrimary]
        window.center()

        self.window = window
        window.delegate = self
        
        let arrangementVC = ArrangementViewController(project: project)
        window.contentViewController = arrangementVC
    }

    /// Swaps the project instance and re-binds observers.
    public func updateProject(_ newProject: Project) {
        self.project = newProject
        
        // Update content view
        if let window = self.window {
            let arrangementVC = ArrangementViewController(project: newProject)
            window.contentViewController = arrangementVC
        }
        
        // Re-bind subscriptions
        setupProjectSubscription()
        updateWindowTitle()
    }
    
    private func setupProjectSubscription() {
        cancellables.removeAll()
        
        // Observe dirty state, name, and file URL changes
        Publishers.CombineLatest3(project.$isDirty, project.$name, project.$fileURL)
            .receive(on: RunLoop.main)
            .sink { [weak self] _, _, _ in
                self?.updateWindowTitle()
            }
            .store(in: &cancellables)
    }

    private func setupTitleBarDoubleClickHandler() {
        NSEvent.addLocalMonitorForEvents(matching: .leftMouseUp) { [weak self] event in
            guard let window = self?.window,
                  event.clickCount == 2 else { return event }
            
            let locationInWindow = event.locationInWindow
            let contentFrame = window.contentLayoutRect
            let titleBarMinY = contentFrame.maxY
            
            if locationInWindow.y >= titleBarMinY {
                window.zoom(nil)
                return nil
            }
            return event
        }
    }
    
    private func updateWindowTitle() {
        // Use the filename (e.g. "Dream V5") if available, otherwise project.name
        let displayName = project.fileURL?.deletingPathExtension().lastPathComponent ?? project.name
        let dirtyIndicator = project.isDirty ? "*" : ""
        window?.title = "Dream DAW – \(displayName)\(dirtyIndicator)"
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    // MARK: - Display

    public func showWindow() {
        window?.makeKeyAndOrderFront(nil)
        // Maximize to fill the visible screen area (menu bar + Dock stay visible)
        window?.zoom(nil)
        window?.makeFirstResponder(window?.contentViewController)
    }

    // MARK: - NSWindowDelegate

    public func window(_ window: NSWindow, shouldPopUpDocumentPathMenu menu: NSMenu) -> Bool {
        false
    }
    
    private func loadAppIcon() {
        // Try multiple search strategies for the icon
        var searchPaths: [String] = []
        
        // 1. SPM resource bundle
        if let bundlePath = Bundle.main.path(forResource: "AppIcon", ofType: "png") {
            searchPaths.append(bundlePath)
        }
        
        // 2. Relative to executable (SPM .build directory structure)
        if let execDir = Bundle.main.executableURL?.deletingLastPathComponent() {
            // Walk up from .build/debug/ to project root
            var dir = execDir
            for _ in 0..<6 {
                let candidate = dir.appendingPathComponent("Sources/DreamDAW/AppIcon.png")
                searchPaths.append(candidate.path)
                dir = dir.deletingLastPathComponent()
            }
        }
        
        // 3. Current working directory
        let cwd = FileManager.default.currentDirectoryPath
        searchPaths.append("\(cwd)/Sources/DreamDAW/AppIcon.png")
        
        for path in searchPaths {
            if let icon = NSImage(contentsOfFile: path) {
                NSApp.applicationIconImage = icon
                return
            }
        }
    }
}

