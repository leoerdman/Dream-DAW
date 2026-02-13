import AppKit
import Foundation

/// A standardized container for DAW plugins (Shell).
/// Provides a dark header with a power toggle and plugin name.
/// Ensures the header does not overlap the plugin content.
public final class PluginSlotView: NSView {

    // MARK: - Properties
    
    private let headerView = NSView()
    private let bodyContainer = NSView()
    
    private let settingsButton = NSButton()
    private let eyeButton = NSButton()
    private let powerButton = NSButton()
    private let titleLabel = NSTextField(labelWithString: "")
    
    /// Optional stack for plugin-specific header controls (e.g. Sampler tabs)
    public let extraHeaderStack = NSStackView()
    
    public var onToggle: ((Bool) -> Void)?
    public var onSettingsClicked: (() -> Void)?
    public var onEyeClicked: (() -> Void)?
    
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
        layer?.backgroundColor = DreamTheme.meterBackground.cgColor
        layer?.cornerRadius = DreamTheme.radiusCard
        layer?.borderWidth = 1
        layer?.borderColor = DreamTheme.controlBorder.cgColor
        
        // --- Header ---
        headerView.wantsLayer = true
        headerView.layer?.backgroundColor = DreamTheme.knobFill.cgColor
        headerView.layer?.cornerRadius = DreamTheme.radiusCard
        headerView.layer?.maskedCorners = [.layerMinXMinYCorner, .layerMaxXMinYCorner]
        addSubview(headerView)
        
        // Power Toggle
        powerButton.title = ""
        powerButton.bezelStyle = .inline
        powerButton.setButtonType(.pushOnPushOff)
        powerButton.isBordered = false
        powerButton.wantsLayer = true
        powerButton.layer?.cornerRadius = DreamTheme.radiusCard + 1
        powerButton.target = self
        powerButton.action = #selector(powerToggled)
        headerView.addSubview(powerButton)
        
        // Title
        titleLabel.stringValue = title
        titleLabel.font = DreamTheme.fontSmall
        titleLabel.textColor = .white
        titleLabel.isEditable = false
        titleLabel.isBezeled = false
        titleLabel.drawsBackground = false
        headerView.addSubview(titleLabel)
        
        // Settings Button (Gear)
        settingsButton.title = ""
        settingsButton.bezelStyle = .inline
        settingsButton.isBordered = false
        settingsButton.wantsLayer = true
        settingsButton.image = NSImage(systemSymbolName: "gearshape.fill", accessibilityDescription: "Settings")
        settingsButton.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 9, weight: .bold)
        settingsButton.contentTintColor = DreamTheme.controlTint
        settingsButton.target = self
        settingsButton.action = #selector(settingsClicked)
        headerView.addSubview(settingsButton)
        
        // Eye Button (GUI)
        eyeButton.title = ""
        eyeButton.bezelStyle = .inline
        eyeButton.isBordered = false
        eyeButton.wantsLayer = true
        eyeButton.image = NSImage(systemSymbolName: "eye.fill", accessibilityDescription: "Open Interface")
        eyeButton.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 9, weight: .bold)
        eyeButton.contentTintColor = DreamTheme.controlTint
        eyeButton.target = self
        eyeButton.action = #selector(eyeClicked)
        headerView.addSubview(eyeButton)
        
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
        settingsButton.translatesAutoresizingMaskIntoConstraints = false
        eyeButton.translatesAutoresizingMaskIntoConstraints = false
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
            
            eyeButton.trailingAnchor.constraint(equalTo: headerView.trailingAnchor, constant: -4),
            eyeButton.centerYAnchor.constraint(equalTo: headerView.centerYAnchor),
            eyeButton.widthAnchor.constraint(equalToConstant: 16),
            eyeButton.heightAnchor.constraint(equalToConstant: 16),
            
            settingsButton.trailingAnchor.constraint(equalTo: eyeButton.leadingAnchor, constant: -2),
            settingsButton.centerYAnchor.constraint(equalTo: headerView.centerYAnchor),
            settingsButton.widthAnchor.constraint(equalToConstant: 16),
            settingsButton.heightAnchor.constraint(equalToConstant: 16),
            
            extraHeaderStack.leadingAnchor.constraint(equalTo: titleLabel.trailingAnchor, constant: 8),
            extraHeaderStack.centerYAnchor.constraint(equalTo: headerView.centerYAnchor),
            extraHeaderStack.trailingAnchor.constraint(lessThanOrEqualTo: settingsButton.leadingAnchor, constant: -4)
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
    
    @objc private func eyeClicked() {
        onEyeClicked?()
    }
    
    @objc private func settingsClicked() {
        onSettingsClicked?()
    }
    
    private func updatePowerState() {
        powerButton.state = isEnabled ? .on : .off
        powerButton.layer?.backgroundColor = isEnabled 
            ? DreamTheme.success.withAlphaComponent(0.9).cgColor 
            : DreamTheme.textMuted.cgColor
        
        // Dim content when disabled
        bodyContainer.alphaValue = isEnabled ? 1.0 : 0.6
    }
}
