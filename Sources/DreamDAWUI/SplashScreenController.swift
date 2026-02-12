import AppKit

public final class SplashScreenController: NSWindowController {
    
    private let splashView = SplashScreenView()
    
    public init() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 400, height: 400),
            styleMask: [.borderless, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        
        window.backgroundColor = DreamTheme.bgPrimary
        window.isOpaque = true
        window.hasShadow = true
        window.level = .floating
        
        // Mathematical centering (not visual center which is slightly higher)
        if let screen = NSScreen.main {
            let screenFrame = screen.frame
            let windowFrame = window.frame
            let x = (screenFrame.width - windowFrame.width) / 2 + screenFrame.minX
            let y = (screenFrame.height - windowFrame.height) / 2 + screenFrame.minY
            window.setFrameOrigin(NSPoint(x: x, y: y))
        }
        
        super.init(window: window)
        
        window.contentView = splashView
        
        // Add a subtle professional border
        window.contentView?.wantsLayer = true
        window.contentView?.layer?.borderColor = NSColor.white.withAlphaComponent(0.1).cgColor
        window.contentView?.layer?.borderWidth = 1.0
    }
    
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }
    
    public override func showWindow(_ sender: Any?) {
        window?.alphaValue = 0
        super.showWindow(sender)
        
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.5
            window?.animator().alphaValue = 1.0
        }
    }
    
    public func updateStatus(_ status: String) {
        splashView.updateStatus(status)
    }
    
    public func dismiss(completion: @escaping () -> Void) {
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.5
            window?.animator().alphaValue = 0
        }, completionHandler: {
            self.close()
            completion()
        })
    }
}
