import AppKit
import DreamDAWModels

// MARK: - MainWindowController

/// Configures and manages the main application window.
/// Sets up the dark appearance, minimum size, and window content.
public final class MainWindowController: NSWindowController, NSWindowDelegate {

    // MARK: - Properties

    private let project: Project

    // MARK: - Initialization

    public init(project: Project) {
        self.project = project

        let windowRect = NSRect(x: 0, y: 0, width: 1280, height: 800)
        let styleMask: NSWindow.StyleMask = [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView]
        let window = NSWindow(contentRect: windowRect, styleMask: styleMask, backing: .buffered, defer: false)

        window.title = "Dream DAW — \(project.name)"
        window.minSize = NSSize(width: 900, height: 600)
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = DreamTheme.bgPrimary
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .visible
        window.isMovableByWindowBackground = false
        window.collectionBehavior = [.fullScreenPrimary]
        window.center()

        super.init(window: window)

        // Set delegate
        window.delegate = self

        // Set up content
        let arrangementVC = ArrangementViewController(project: project)
        window.contentViewController = arrangementVC
        
        // Monitor double-click on title bar → zoom (maximize with Dock/menu bar visible)
        // NOT fullscreen — fullscreen is only via the green button.
        NSEvent.addLocalMonitorForEvents(matching: .leftMouseUp) { [weak window] event in
            guard let window = window,
                  event.clickCount == 2 else { return event }
            
            // Check if click is in the title bar area (above content view)
            let locationInWindow = event.locationInWindow
            let contentFrame = window.contentLayoutRect
            let titleBarMinY = contentFrame.maxY
            
            if locationInWindow.y >= titleBarMinY {
                window.zoom(nil)
                return nil // consume the event
            }
            return event
        }
        
        // Load app icon
        loadAppIcon()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    // MARK: - Display

    public func showWindow() {
        window?.makeKeyAndOrderFront(nil)
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

