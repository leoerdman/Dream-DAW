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

        // Set delegate for double-click fullscreen
        window.delegate = self

        // Set up content
        let arrangementVC = ArrangementViewController(project: project)
        window.contentViewController = arrangementVC
        
        // Monitor double-click on title bar to toggle fullscreen
        // This works regardless of macOS system preference
        NSEvent.addLocalMonitorForEvents(matching: .leftMouseUp) { [weak window] event in
            guard let window = window,
                  event.clickCount == 2 else { return event }
            
            // Check if click is in the title bar area (above content view)
            let locationInWindow = event.locationInWindow
            let contentFrame = window.contentLayoutRect
            let titleBarMinY = contentFrame.maxY
            
            if locationInWindow.y >= titleBarMinY {
                window.toggleFullScreen(nil)
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

    /// Double-click on title bar toggles fullscreen.
    public func window(_ window: NSWindow, shouldPopUpDocumentPathMenu menu: NSMenu) -> Bool {
        false
    }

    /// This enables double-click on title bar to zoom/fullscreen
    /// macOS uses the system preference for this by default, but we ensure
    /// the zoom behavior is fullscreen toggle.
    public func windowShouldZoom(_ window: NSWindow, toFrame newFrame: NSRect) -> Bool {
        window.toggleFullScreen(nil)
        return false // We handle it ourselves via fullscreen
    }
    
    // MARK: - App Icon
    
    private func loadAppIcon() {
        // Load the app icon from the bundled resources
        let iconPath = Bundle.main.executableURL?
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/DreamDAW/AppIcon.png")
        
        // Try multiple paths for the icon
        let paths = [
            iconPath?.path,
            Bundle.main.path(forResource: "AppIcon", ofType: "png"),
        ].compactMap { $0 }
        
        for path in paths {
            if let icon = NSImage(contentsOfFile: path) {
                NSApp.applicationIconImage = icon
                return
            }
        }
    }
}
