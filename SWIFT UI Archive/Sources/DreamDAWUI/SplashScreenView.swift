import AppKit
import DreamDAWModels

public final class SplashScreenView: NSView {
    
    private let logoImageView = NSImageView()
    private let titleLabel = NSTextField(labelWithString: "DREAM DAW")
    private let versionLabel = NSTextField(labelWithString: AppVersion.current)
    private let statusLabel = NSTextField(labelWithString: "Initializing Audio Engine...")
    
    public override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        setupUI()
    }
    
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }
    
    private let gradientLayer = CAGradientLayer()
    
    private func setupUI() {
        wantsLayer = true
        
        // Premium Gradient Background
        gradientLayer.colors = [
            DreamTheme.bgPrimary.cgColor,
            NSColor(red: 0.12, green: 0.12, blue: 0.12, alpha: 1.0).cgColor
        ]
        gradientLayer.locations = [0.0, 1.0]
        layer?.addSublayer(gradientLayer)
        
        // Logo
        if let icon = loadAppIcon() {
            logoImageView.image = icon
        } else {
            // Fallback if truly lost
            logoImageView.image = NSImage(size: NSSize(width: 180, height: 180))
            logoImageView.layer?.backgroundColor = NSColor.black.cgColor
        }

        logoImageView.imageScaling = .scaleProportionallyUpOrDown
        logoImageView.wantsLayer = true
        logoImageView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(logoImageView)
        
        // CIRCULAR MASK: Foolproof way to fix "white stripes" at corners
        let mask = CAShapeLayer()
        logoImageView.layer?.mask = mask
        
        // Add a professional outer glow
        logoImageView.layer?.shadowColor = DreamTheme.accent.cgColor
        logoImageView.layer?.shadowOpacity = 0.3
        logoImageView.layer?.shadowOffset = .zero
        logoImageView.layer?.shadowRadius = 20
        
        // Title
        titleLabel.font = .systemFont(ofSize: 32, weight: .bold)
        titleLabel.textColor = .white
        titleLabel.alignment = .center
        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        addSubview(titleLabel)
        
        // Version
        versionLabel.font = .monospacedSystemFont(ofSize: 14, weight: .semibold)
        versionLabel.textColor = DreamTheme.accent
        versionLabel.alignment = .center
        versionLabel.translatesAutoresizingMaskIntoConstraints = false
        addSubview(versionLabel)
        
        // Status
        statusLabel.font = .systemFont(ofSize: 12, weight: .medium)
        statusLabel.textColor = DreamTheme.textSecondary
        statusLabel.alignment = .center
        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        addSubview(statusLabel)
        
        NSLayoutConstraint.activate([
            logoImageView.centerXAnchor.constraint(equalTo: centerXAnchor),
            logoImageView.centerYAnchor.constraint(equalTo: centerYAnchor, constant: -40), // Slightly up to leave room for title
            logoImageView.widthAnchor.constraint(equalToConstant: 180),
            logoImageView.heightAnchor.constraint(equalToConstant: 180),
            
            titleLabel.topAnchor.constraint(equalTo: logoImageView.bottomAnchor, constant: 20),
            titleLabel.centerXAnchor.constraint(equalTo: centerXAnchor),
            
            versionLabel.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 4),
            versionLabel.centerXAnchor.constraint(equalTo: centerXAnchor),
            
            statusLabel.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -25),
            statusLabel.centerXAnchor.constraint(equalTo: centerXAnchor)
        ])
    }
    
    public override func layout() {
        super.layout()
        gradientLayer.frame = bounds
        
        // FOOLPROOF CIRCULAR MASK
        if let mask = logoImageView.layer?.mask as? CAShapeLayer {
            mask.path = CGPath(ellipseIn: logoImageView.bounds, transform: nil)
        }
    }
    
    public func updateStatus(_ status: String) {
        DispatchQueue.main.async {
            self.statusLabel.stringValue = status
        }
    }
    
    private func loadAppIcon() -> NSImage? {
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
                return icon
            }
        }
        return NSImage(named: "AppIcon")
    }
}
