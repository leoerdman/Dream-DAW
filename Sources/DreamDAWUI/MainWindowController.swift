import AppKit
import Combine
import DreamDAWModels
import DreamDAWEngine

// MARK: - MainWindowController

/// Configures and manages the main application window.
/// Sets up the dark appearance, minimum size, and window content.
public final class MainWindowController: NSWindowController, NSWindowDelegate {

    // MARK: - Properties

    private var project: Project
    public let sharedEngine: SharedEngine
    private var cancellables = Set<AnyCancellable>()
    private let windowFrameDefaultsKey = "DreamDAW.MainWindow.Frame.v1"
    private let windowZoomedDefaultsKey = "DreamDAW.MainWindow.Zoomed.v1"

    // MARK: - Initialization

    public init(project: Project, sharedEngine: SharedEngine) {
        NSLog("[MainWindowController] init start")
        self.project = project
        self.sharedEngine = sharedEngine
        super.init(window: nil)
        
        NSLog("[MainWindowController] calling setupWindow()...")
        setupWindow()
        NSLog("[MainWindowController] setupWindow() finished.")
        
        setupTitleBarDoubleClickHandler()
        NSLog("[MainWindowController] title bar handler set.")
        
        loadAppIcon()
        NSLog("[MainWindowController] app icon loaded.")
        
        setupProjectSubscription()
        NSLog("[MainWindowController] project subscription set.")
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
        window.setFrameAutosaveName("DreamDAWMainWindowFrame")
        if !restoreWindowGeometry(window) {
            window.center()
        }

        self.window = window
        window.delegate = self
        
        NSLog("[MainWindowController] Setting contentViewController (ArrangementViewController)...")
        let arrangementVC = ArrangementViewController(project: project, sharedEngine: sharedEngine)
        window.contentViewController = arrangementVC
        NSLog("[MainWindowController] contentViewController set.")
    }

    /// Swaps the project instance and re-binds observers.
    public func updateProject(_ newProject: Project) {
        self.project = newProject
        
        // Update content view
        if let window = self.window {
            let arrangementVC = ArrangementViewController(project: newProject, sharedEngine: sharedEngine)
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
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let window = self.window else { return }
            let shouldZoom = UserDefaults.standard.bool(forKey: self.windowZoomedDefaultsKey)
            if shouldZoom && !window.isZoomed {
                window.zoom(nil)
            }
            window.makeFirstResponder(window.contentViewController?.view)
        }
    }

    // MARK: - NSWindowDelegate

    public func window(_ window: NSWindow, shouldPopUpDocumentPathMenu menu: NSMenu) -> Bool {
        false
    }

    public func windowDidResize(_ notification: Notification) {
        guard let window = notification.object as? NSWindow else { return }
        persistWindowGeometry(window)
    }

    public func windowDidMove(_ notification: Notification) {
        guard let window = notification.object as? NSWindow else { return }
        persistWindowGeometry(window)
    }

    public func windowDidEndLiveResize(_ notification: Notification) {
        guard let window = notification.object as? NSWindow else { return }
        persistWindowGeometry(window)
    }

    public func windowWillClose(_ notification: Notification) {
        guard let window = notification.object as? NSWindow else { return }
        persistWindowGeometry(window)
    }

    private func persistWindowGeometry(_ window: NSWindow) {
        UserDefaults.standard.set(window.frameDescriptor, forKey: windowFrameDefaultsKey)
        UserDefaults.standard.set(window.isZoomed, forKey: windowZoomedDefaultsKey)
    }

    private func restoreWindowGeometry(_ window: NSWindow) -> Bool {
        if window.setFrameUsingName("DreamDAWMainWindowFrame", force: true) {
            return true
        }
        guard let frameString = UserDefaults.standard.string(forKey: windowFrameDefaultsKey) else {
            return false
        }
        window.setFrame(from: frameString)
        return true
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
