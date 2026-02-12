import AppKit
import Foundation

/// A professional loading overlay with blur effect and progress indicator.
public final class LoadingOverlayView: NSView {
    
    private let blurView = NSVisualEffectView()
    private let spinner = NSProgressIndicator()
    private let label = NSTextField(labelWithString: "Loading...")

    public override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        setup()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        setup()
    }

    private func setup() {
        wantsLayer = true
        layer?.backgroundColor = NSColor.black.withAlphaComponent(0.2).cgColor
        
        blurView.state = .active
        blurView.material = .dark
        blurView.blendingMode = .withinWindow
        blurView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(blurView)
        
        spinner.style = .spinning
        spinner.controlSize = .large
        spinner.translatesAutoresizingMaskIntoConstraints = false
        addSubview(spinner)
        
        label.font = .systemFont(ofSize: 13, weight: .medium)
        label.textColor = .secondaryLabelColor
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        
        NSLayoutConstraint.activate([
            blurView.topAnchor.constraint(equalTo: topAnchor),
            blurView.bottomAnchor.constraint(equalTo: bottomAnchor),
            blurView.leadingAnchor.constraint(equalTo: leadingAnchor),
            blurView.trailingAnchor.constraint(equalTo: trailingAnchor),
            
            spinner.centerXAnchor.constraint(equalTo: centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: centerYAnchor, constant: -10),
            
            label.topAnchor.constraint(equalTo: spinner.bottomAnchor, constant: 12),
            label.centerXAnchor.constraint(equalTo: centerXAnchor)
        ])
    }
    
    public func show(message: String) {
        label.stringValue = message
        spinner.startAnimation(nil)
        isHidden = false
    }
    
    public func hide() {
        spinner.stopAnimation(nil)
        isHidden = true
    }
}
