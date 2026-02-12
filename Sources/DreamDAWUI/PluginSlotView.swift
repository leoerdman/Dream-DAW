import AppKit
import Foundation

/// A standardized container for DAW plugins (Shell).
/// Provides a dark header with a power toggle and plugin name.
/// Ensures the header does not overlap the plugin content.
public final class PluginSlotView: NSView {

    // MARK: - Properties
    
    private let headerView = NSView()
    private let bodyContainer = NSView()
    
    private let titleLabel = NSTextField(labelWithString: "")
    private let powerButton = NSButton()
    
    /// Optional stack for plugin-specific header controls (e.g. Sampler tabs)
    public let extraHeaderStack = NSStackView()
    
    public var onToggle: ((Bool) -> Void)?
    
    public var isEnabled: Bool = true {
        didSet { updatePowerState() }
    }
    
    private let headerHeight: CGFloat = 18

    // MARK: - Initialization
    
    public init(title: String, frame: CGRect) {
        super.init(frame: frame)
        setupUI(title: title)
    }
    
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }
    
    // MARK: - Setup
    
    private func setupUI(title: String) {
        wantsLayer = true
        layer?.backgroundColor = NSColor(white: 0.12, alpha: 1.0).cgColor
        layer?.cornerRadius = 4
        layer?.borderWidth = 1
        layer?.borderColor = NSColor(white: 0.22, alpha: 1.0).cgColor
        
        // --- Header ---
        headerView.wantsLayer = true
        headerView.layer?.backgroundColor = NSColor(white: 0.18, alpha: 1.0).cgColor
        headerView.layer?.cornerRadius = 4
        headerView.layer?.maskedCorners = [.layerMinXMinYCorner, .layerMaxXMinYCorner]
        addSubview(headerView)
        
        // Power Toggle
        powerButton.title = ""
        powerButton.bezelStyle = .inline
        powerButton.setButtonType(.pushOnPushOff)
        powerButton.isBordered = false
        powerButton.wantsLayer = true
        powerButton.layer?.cornerRadius = 5
        powerButton.target = self
        powerButton.action = #selector(powerToggled)
        headerView.addSubview(powerButton)
        
        // Title
        titleLabel.stringValue = title
        titleLabel.font = NSFont.systemFont(ofSize: 9, weight: .bold)
        titleLabel.textColor = .white
        titleLabel.isEditable = false
        titleLabel.isBezeled = false
        titleLabel.drawsBackground = false
        headerView.addSubview(titleLabel)
        
        // Extra Header Content (Tabs, etc)
        extraHeaderStack.orientation = .horizontal
        extraHeaderStack.spacing = 4
        headerView.addSubview(extraHeaderStack)
        
        // --- Body ---
        bodyContainer.wantsLayer = true
        bodyContainer.layer?.backgroundColor = NSColor.clear.cgColor
        addSubview(bodyContainer)
        
        setupConstraints()
        updatePowerState()
    }
    
    private func setupConstraints() {
        headerView.translatesAutoresizingMaskIntoConstraints = false
        bodyContainer.translatesAutoresizingMaskIntoConstraints = false
        powerButton.translatesAutoresizingMaskIntoConstraints = false
        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        extraHeaderStack.translatesAutoresizingMaskIntoConstraints = false
        
        NSLayoutConstraint.activate([
            headerView.topAnchor.constraint(equalTo: topAnchor),
            headerView.leadingAnchor.constraint(equalTo: leadingAnchor),
            headerView.trailingAnchor.constraint(equalTo: trailingAnchor),
            headerView.heightAnchor.constraint(equalToConstant: headerHeight),
            
            bodyContainer.topAnchor.constraint(equalTo: headerView.bottomAnchor),
            bodyContainer.leadingAnchor.constraint(equalTo: leadingAnchor),
            bodyContainer.trailingAnchor.constraint(equalTo: trailingAnchor),
            bodyContainer.bottomAnchor.constraint(equalTo: bottomAnchor),
            
            powerButton.leadingAnchor.constraint(equalTo: headerView.leadingAnchor, constant: 4),
            powerButton.centerYAnchor.constraint(equalTo: headerView.centerYAnchor),
            powerButton.widthAnchor.constraint(equalToConstant: 10),
            powerButton.heightAnchor.constraint(equalToConstant: 10),
            
            titleLabel.leadingAnchor.constraint(equalTo: powerButton.trailingAnchor, constant: 6),
            titleLabel.centerYAnchor.constraint(equalTo: headerView.centerYAnchor),
            
            extraHeaderStack.leadingAnchor.constraint(equalTo: titleLabel.trailingAnchor, constant: 8),
            extraHeaderStack.centerYAnchor.constraint(equalTo: headerView.centerYAnchor),
            extraHeaderStack.trailingAnchor.constraint(lessThanOrEqualTo: headerView.trailingAnchor, constant: -4)
        ])
    }
    
    // MARK: - API
    
    public func addPluginContent(_ view: NSView) {
        view.frame = bodyContainer.bounds
        view.autoresizingMask = [.width, .height]
        bodyContainer.addSubview(view)
    }
    
    @objc private func powerToggled() {
        isEnabled = (powerButton.state == .on)
        onToggle?(isEnabled)
    }
    
    private func updatePowerState() {
        powerButton.state = isEnabled ? .on : .off
        powerButton.layer?.backgroundColor = isEnabled 
            ? NSColor(red: 0.3, green: 0.9, blue: 0.4, alpha: 1.0).cgColor 
            : NSColor(white: 0.4, alpha: 1.0).cgColor
        
        // Dim content when disabled
        bodyContainer.alphaValue = isEnabled ? 1.0 : 0.6
    }
}
