import AppKit

public final class SplashScreenController: NSWindowController {
    
    private let splashView = SplashScreenView()
    
    public init() {
        let size: CGFloat = 450
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: size, height: size),
            styleMask: [.borderless, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        
        window.backgroundColor = DreamTheme.bgPrimary
        window.isOpaque = true
        window.hasShadow = true
        window.level = .floating
        
        // FOOLPROOF MATHEMATICAL CENTERING
        if let screen = NSScreen.main {
            let screenFrame = screen.frame
            let x = (screenFrame.width - size) / 2 + screenFrame.minX
            let y = (screenFrame.height - size) / 2 + screenFrame.minY
            window.setFrameOrigin(NSPoint(x: x, y: y))
        }
        
        super.init(window: window)
        
        window.contentView = splashView
        
        // Add a premium professional border
        window.contentView?.wantsLayer = true
        window.contentView?.layer?.borderColor = NSColor.white.withAlphaComponent(0.15).cgColor
        window.contentView?.layer?.borderWidth = 1.0
        window.contentView?.layer?.cornerRadius = 0 // Keep it perfectly square per user request
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
