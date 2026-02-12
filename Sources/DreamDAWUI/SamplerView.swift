import AppKit
import Foundation
import AVFoundation
import DreamDAWModels
import DreamDAWEngine

// MARK: - SamplerView

/// A high-fidelity, "Legendary" Sampler UI recreation based on Ableton Live.
/// Layout: [Mode Sidebar] [Waveform Area] [Parameters Grid] [Filter/LFO/Env Section]
public final class SamplerView: NSView {

    // MARK: - Properties
    
    public var config: InstrumentConfig {
        didSet { updateUI() }
    }
    
    private let track: Track
    
    // UI Components
    private let waveformView = WaveformView()
    private let sidebar = NSView()
    private let mainContent = NSView()
    private let parameterBar = NSView()
    private let lowerSection = NSView()
    
    // Controls
    private var modeButtons: [NSButton] = []
    private let volumeKnob = DAWKnob(label: "Volume")
    private let startControl = DAWNumberControl(label: "Start", unit: "%")
    private let endControl = DAWNumberControl(label: "End", unit: "%")
    private let loopControl = DAWNumberControl(label: "Loop", unit: "%")
    private let fadeControl = DAWNumberControl(label: "Fade", unit: "%")
    
    // ADSR Knobs
    private let attackKnob = DAWKnob(label: "Attack")
    private let decayKnob = DAWKnob(label: "Decay")
    private let sustainKnob = DAWKnob(label: "Sustain")
    private let releaseKnob = DAWKnob(label: "Release")
    
    // Filter
    private let filterToggle = NSButton(checkboxWithTitle: "Filter", target: nil, action: nil)
    private let cutoffKnob = DAWKnob(label: "Freq")
    private let resKnob = DAWKnob(label: "Res")
    // Callbacks
    public var onSampleURLChanged: ((URL) -> Void)?
    public var onParameterChanged: (() -> Void)?

    // MARK: - Initialization

    public init(config: InstrumentConfig, track: Track) {
        self.config = config
        self.track = track
        super.init(frame: .zero)
        setupUI()
        updateUI()
        registerForDraggedTypes([.fileURL, .browserItem])
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    // MARK: - Setup

    private func setupUI() {
        wantsLayer = true
        setupGradients()
        
        // --- Sidebar ---
        sidebar.wantsLayer = true
        sidebar.layer?.backgroundColor = NSColor(white: 0.12, alpha: 1.0).cgColor
        addSubview(sidebar)
        
        setupSidebar()
        
        // --- Main Content ---
        addSubview(mainContent)
        
        // Waveform
        mainContent.addSubview(waveformView)
        
        // Parameter Bar (Gain, Start, etc.)
        parameterBar.wantsLayer = true
        parameterBar.layer?.backgroundColor = NSColor(white: 0.18, alpha: 1.0).cgColor
        mainContent.addSubview(parameterBar)
        setupParameterBar()
        
        // Lower Section (Filter, LFO, Env)
        lowerSection.wantsLayer = true
        lowerSection.layer?.backgroundColor = NSColor(white: 0.22, alpha: 1.0).cgColor
        mainContent.addSubview(lowerSection)
        setupLowerSection()
        
        setupConstraints()
    }
    
    private func setupGradients() {
        wantsLayer = true
        let grad = CAGradientLayer()
        grad.colors = [
            NSColor(white: 0.2, alpha: 1.0).cgColor,
            NSColor(white: 0.15, alpha: 1.0).cgColor
        ]
        grad.frame = bounds
        grad.autoresizingMask = [.layerWidthSizable, .layerHeightSizable]
        layer?.addSublayer(grad)
    }
    
    private func setupConstraints() {
        sidebar.translatesAutoresizingMaskIntoConstraints = false
        mainContent.translatesAutoresizingMaskIntoConstraints = false
        waveformView.translatesAutoresizingMaskIntoConstraints = false
        parameterBar.translatesAutoresizingMaskIntoConstraints = false
        lowerSection.translatesAutoresizingMaskIntoConstraints = false
        
        NSLayoutConstraint.activate([
            sidebar.topAnchor.constraint(equalTo: topAnchor),
            sidebar.leadingAnchor.constraint(equalTo: leadingAnchor),
            sidebar.bottomAnchor.constraint(equalTo: bottomAnchor),
            sidebar.widthAnchor.constraint(equalToConstant: 44),
            
            mainContent.topAnchor.constraint(equalTo: topAnchor),
            mainContent.leadingAnchor.constraint(equalTo: sidebar.trailingAnchor),
            mainContent.trailingAnchor.constraint(equalTo: trailingAnchor),
            mainContent.bottomAnchor.constraint(equalTo: bottomAnchor),
            
            waveformView.topAnchor.constraint(equalTo: mainContent.topAnchor),
            waveformView.leadingAnchor.constraint(equalTo: mainContent.leadingAnchor),
            waveformView.trailingAnchor.constraint(equalTo: mainContent.trailingAnchor),
            waveformView.heightAnchor.constraint(equalToConstant: 80),
            
            parameterBar.topAnchor.constraint(equalTo: waveformView.bottomAnchor),
            parameterBar.leadingAnchor.constraint(equalTo: mainContent.leadingAnchor),
            parameterBar.trailingAnchor.constraint(equalTo: mainContent.trailingAnchor),
            parameterBar.heightAnchor.constraint(equalToConstant: 32),
            
            lowerSection.topAnchor.constraint(equalTo: parameterBar.bottomAnchor),
            lowerSection.leadingAnchor.constraint(equalTo: mainContent.leadingAnchor),
            lowerSection.trailingAnchor.constraint(equalTo: mainContent.trailingAnchor),
            lowerSection.bottomAnchor.constraint(equalTo: mainContent.bottomAnchor)
        ])
    }
    
    private func setupSidebar() {
        let sidebarStack = NSStackView()
        sidebarStack.orientation = .vertical
        sidebarStack.spacing = 4
        sidebarStack.edgeInsets = NSEdgeInsets(top: 8, left: 2, bottom: 8, right: 2)
        sidebarStack.alignment = .centerX
        sidebar.addSubview(sidebarStack)
        
        sidebarStack.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            sidebarStack.topAnchor.constraint(equalTo: sidebar.topAnchor),
            sidebarStack.leadingAnchor.constraint(equalTo: sidebar.leadingAnchor),
            sidebarStack.trailingAnchor.constraint(equalTo: sidebar.trailingAnchor)
        ])
        
        let modes = ["Classic", "1-Shot", "Slice"]
        for mode in modes {
            let btn = NSButton(title: mode, target: self, action: #selector(modeSelected(_:)))
            btn.bezelStyle = .recessed
            btn.setButtonType(.pushOnPushOff)
            btn.controlSize = .small
            btn.font = NSFont.systemFont(ofSize: 9, weight: .medium)
            
            btn.translatesAutoresizingMaskIntoConstraints = false
            btn.heightAnchor.constraint(equalToConstant: 32).isActive = true
            btn.widthAnchor.constraint(equalToConstant: 36).isActive = true
            
            sidebarStack.addArrangedSubview(btn)
            modeButtons.append(btn)
        }
    }
    
    private func setupParameterBar() {
        let parameterStack = NSStackView()
        parameterStack.orientation = .horizontal
        parameterStack.spacing = 8
        parameterStack.edgeInsets = NSEdgeInsets(top: 0, left: 8, bottom: 0, right: 8)
        parameterStack.alignment = .centerY
        parameterBar.addSubview(parameterStack)
        
        parameterStack.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            parameterStack.topAnchor.constraint(equalTo: parameterBar.topAnchor),
            parameterStack.bottomAnchor.constraint(equalTo: parameterBar.bottomAnchor),
            parameterStack.leadingAnchor.constraint(equalTo: parameterBar.leadingAnchor),
            parameterStack.trailingAnchor.constraint(equalTo: parameterBar.trailingAnchor)
        ])
        
        let controls = [startControl, endControl, loopControl, fadeControl]
        for ctrl in controls {
            parameterStack.addArrangedSubview(ctrl)
            ctrl.translatesAutoresizingMaskIntoConstraints = false
            ctrl.widthAnchor.constraint(equalToConstant: 65).isActive = true
            ctrl.heightAnchor.constraint(equalToConstant: 24).isActive = true
        }
        
        startControl.onValueChanged = { [weak self] val in 
            self?.config.startPercent = val
            self?.onParameterChanged?()
        }
        endControl.onValueChanged = { [weak self] val in 
            self?.config.endPercent = val
            self?.onParameterChanged?()
        }
        loopControl.onValueChanged = { [weak self] val in 
            self?.config.loopPercent = val
            self?.onParameterChanged?()
        }
        fadeControl.onValueChanged = { [weak self] val in 
            self?.config.fadePercent = val
            self?.onParameterChanged?()
        }
    }
    
    private func setupLowerSection() {
        let mainStack = NSStackView()
        mainStack.orientation = .horizontal
        mainStack.spacing = 15 // Reduced from 20
        mainStack.edgeInsets = NSEdgeInsets(top: 2, left: 10, bottom: 2, right: 10) // Tighter
        mainStack.alignment = .centerY
        lowerSection.addSubview(mainStack)
        
        mainStack.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            mainStack.topAnchor.constraint(equalTo: lowerSection.topAnchor),
            mainStack.bottomAnchor.constraint(equalTo: lowerSection.bottomAnchor),
            mainStack.leadingAnchor.constraint(equalTo: lowerSection.leadingAnchor),
            mainStack.trailingAnchor.constraint(equalTo: lowerSection.trailingAnchor)
        ])
        
        // Filter Group
        let filterSection = NSStackView()
        filterSection.orientation = .vertical
        filterSection.spacing = 8
        filterSection.alignment = .centerX
        
        let filterHeader = NSTextField(labelWithString: "FILTER")
        filterHeader.font = NSFont.systemFont(ofSize: 9, weight: .bold)
        filterHeader.textColor = NSColor(white: 0.5, alpha: 1.0)
        filterSection.addArrangedSubview(filterHeader)
        
        let filterControls = NSStackView()
        filterControls.spacing = 12
        filterControls.alignment = .centerY
        filterControls.addArrangedSubview(filterToggle)
        filterControls.addArrangedSubview(cutoffKnob)
        filterControls.addArrangedSubview(resKnob)
        filterSection.addArrangedSubview(filterControls)
        
        mainStack.addArrangedSubview(filterSection)
        
        // Divider
        mainStack.addArrangedSubview(makeDivider())
        
        // Envelope Group
        let envStack = NSStackView()
        envStack.orientation = .vertical
        envStack.spacing = 2
        envStack.alignment = .centerX
        
        let envLabel = NSTextField(labelWithString: "ENVELOPES")
        envLabel.font = NSFont.systemFont(ofSize: 8, weight: .bold)
        envLabel.textColor = NSColor(white: 0.6, alpha: 1.0)
        envStack.addArrangedSubview(envLabel)
        
        let knobStack = NSStackView()
        knobStack.spacing = 10
        knobStack.addArrangedSubview(attackKnob)
        knobStack.addArrangedSubview(decayKnob)
        knobStack.addArrangedSubview(sustainKnob)
        knobStack.addArrangedSubview(releaseKnob)
        envStack.addArrangedSubview(knobStack)
        
        mainStack.addArrangedSubview(envStack)

        // Divider
        mainStack.addArrangedSubview(makeDivider())

        // Volume Group
        let volSection = NSStackView()
        volSection.orientation = .vertical
        volSection.spacing = 8
        volSection.alignment = .centerX
        
        let volHeader = NSTextField(labelWithString: "GLOBAL")
        volHeader.font = NSFont.systemFont(ofSize: 9, weight: .bold)
        volHeader.textColor = NSColor(white: 0.5, alpha: 1.0)
        volSection.addArrangedSubview(volHeader)
        
        volSection.addArrangedSubview(volumeKnob)
        mainStack.addArrangedSubview(volSection)
        
        attackKnob.onValueChanged = { [weak self] v in 
            self?.config.attack = v
            self?.onParameterChanged?()
        }
        decayKnob.onValueChanged = { [weak self] v in 
            self?.config.decay = v
            self?.onParameterChanged?()
        }
        sustainKnob.onValueChanged = { [weak self] v in 
            self?.config.sustain = v
            self?.onParameterChanged?()
        }
        releaseKnob.onValueChanged = { [weak self] v in 
            self?.config.release = v
            self?.onParameterChanged?()
        }
        volumeKnob.onValueChanged = { [weak self] v in
            self?.config.gain = Float(v * 2.0)
            self?.onParameterChanged?()
        }
    }

    private func makeDivider() -> NSView {
        let divider = NSView()
        divider.wantsLayer = true
        divider.layer?.backgroundColor = NSColor(white: 0.3, alpha: 0.5).cgColor
        divider.translatesAutoresizingMaskIntoConstraints = false
        divider.widthAnchor.constraint(equalToConstant: 1).isActive = true
        divider.heightAnchor.constraint(equalToConstant: 45).isActive = true
        return divider
    }



    private func updateUI() {
        // Load waveform
        if let url = config.sampleURL {
            waveformView.loadSample(url: url)
        }
        
        // Sync controls
        startControl.value = config.startPercent
        endControl.value = config.endPercent
        loopControl.value = config.loopPercent
        fadeControl.value = config.fadePercent
        
        attackKnob.value = config.attack
        decayKnob.value = config.decay
        sustainKnob.value = config.sustain
        releaseKnob.value = config.release
        
        cutoffKnob.value = config.filterCutoff
        resKnob.value = config.filterResonance
        volumeKnob.value = Double(config.gain / 2.0)
    }

    @objc private func modeSelected(_ sender: NSButton) {
        // Toggle behavior logic
    }
    
    // MARK: - Drag and Drop
    
    public override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        let pb = sender.draggingPasteboard
        
        // Check for audio files
        if let urls = pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingContentsConformToTypes: ["public.audio"]]) as? [URL], !urls.isEmpty {
            return .copy
        }
        
        // Check for browser items (samples)
        if let payload = pb.string(forType: .browserItem) {
            let parts = payload.split(separator: ":", maxSplits: 1)
            if parts.count == 2 && String(parts[0]) == "sample" {
                return .copy
            }
        }
        
        return []
    }
    
    public override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let pb = sender.draggingPasteboard
        
        // 1. Try file URLs
        if let urls = pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingContentsConformToTypes: ["public.audio"]]) as? [URL], let url = urls.first {
            loadSample(url: url)
            return true
        }
        
        // 2. Try browser items (if we support a 'sample' type directly)
        if let payload = pb.string(forType: .browserItem) {
            let parts = payload.split(separator: ":", maxSplits: 1)
            if parts.count == 2 && String(parts[0]) == "sample" {
                let path = String(parts[1])
                let url = URL(fileURLWithPath: path)
                loadSample(url: url)
                return true
            }
        }
        
        return false
    }
    
    private func loadSample(url: URL) {
        waveformView.loadSample(url: url)
        onSampleURLChanged?(url)
    }
    
    private var gradientLayer: CAGradientLayer?
    
    public override func layout() {
        super.layout()
        gradientLayer?.frame = bounds
        sidebar.frame = NSRect(x: 0, y: 0, width: 44, height: bounds.height)
        mainContent.frame = NSRect(x: 44, y: 0, width: bounds.width - 44, height: bounds.height)
        
        let barH: CGFloat = 28
        let lowerH: CGFloat = bounds.height * 0.45
        let waveH = bounds.height - barH - lowerH
        
        waveformView.frame = NSRect(x: 0, y: barH + lowerH, width: mainContent.bounds.width, height: waveH)
        parameterBar.frame = NSRect(x: 0, y: lowerH, width: mainContent.bounds.width, height: barH)
        lowerSection.frame = NSRect(x: 0, y: 0, width: mainContent.bounds.width, height: lowerH)
    }
}

// MARK: - Subviews

class WaveformView: NSView {
    private var buffer: AVAudioPCMBuffer?
    private var path: CGPath?
    
    func loadSample(url: URL) {
        Task.detached(priority: .userInitiated) {
            do {
                let file = try AVAudioFile(forReading: url)
                let format = file.processingFormat
                let frameCount = AVAudioFrameCount(file.length)
                guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount) else { return }
                try file.read(into: buffer)
                
                await MainActor.run {
                    self.buffer = buffer
                    self.path = self.generateWaveformPath(from: buffer, size: self.bounds.size)
                    self.needsDisplay = true
                }
            } catch {
                print("Failed to load sampler waveform: \(error)")
            }
        }
    }
    
    private func generateWaveformPath(from buffer: AVAudioPCMBuffer, size: CGSize) -> CGPath? {
        guard let data = buffer.floatChannelData?[0] else { return nil }
        let frameCount = Int(buffer.frameLength)
        let width = Int(size.width)
        guard width > 0 else { return nil }
        let samplesPerPoint = max(1, frameCount / width)
        
        let path = CGMutablePath()
        let midY = size.height / 2
        
        path.move(to: CGPoint(x: 0, y: midY))
        
        for x in 0..<Int(size.width) {
            let start = x * samplesPerPoint
            let end = min(start + samplesPerPoint, frameCount)
            var maxAmp: Float = 0
            for i in start..<end {
                maxAmp = max(maxAmp, abs(data[i]))
            }
            
            let yOffset = CGFloat(maxAmp) * midY * 0.9
            path.addLine(to: CGPoint(x: CGFloat(x), y: midY - yOffset))
        }
        
        for x in (0..<Int(size.width)).reversed() {
            let start = x * samplesPerPoint
            let end = min(start + samplesPerPoint, frameCount)
            var maxAmp: Float = 0
            for i in start..<end {
                maxAmp = max(maxAmp, abs(data[i]))
            }
            
            let yOffset = CGFloat(maxAmp) * midY * 0.9
            path.addLine(to: CGPoint(x: CGFloat(x), y: midY + yOffset))
        }
        
        path.closeSubpath()
        return path
    }
    
    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        
        // Background grid (subtle)
        ctx.setStrokeColor(NSColor(white: 0.2, alpha: 1.0).cgColor)
        ctx.setLineWidth(1.0)
        for i in 1...4 {
            let x = bounds.width * CGFloat(i) / 5.0
            ctx.move(to: CGPoint(x: x, y: 0))
            ctx.addLine(to: CGPoint(x: x, y: bounds.height))
            ctx.strokePath()
        }
        
        // Draw Waveform
        if let path = path {
            ctx.addPath(path)
            ctx.setFillColor(NSColor(red: 1.0, green: 0.57, blue: 0.08, alpha: 0.9).cgColor)
            ctx.fillPath()
            
            // Highlight line
            ctx.addPath(path)
            ctx.setStrokeColor(NSColor(red: 1.0, green: 0.7, blue: 0.2, alpha: 1.0).cgColor)
            ctx.setLineWidth(1.0)
            ctx.strokePath()
        } else {
            // Placeholder text
            let attr: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 12, weight: .medium),
                .foregroundColor: NSColor(white: 0.4, alpha: 1.0)
            ]
            let str = NSAttributedString(string: "Drop Sample Here", attributes: attr)
            str.draw(at: CGPoint(x: (bounds.width - str.size().width)/2, y: (bounds.height - str.size().height)/2))
        }
    }
}

class DAWKnob: NSView {
    var label: String = "" { didSet { needsDisplay = true } }
    var value: Double = 0.5 { didSet { needsDisplay = true } }
    var onValueChanged: ((Double) -> Void)?
    
    private var lastMouseY: CGFloat = 0

    init(label: String) {
        self.label = label
        super.init(frame: NSRect(x: 0, y: 0, width: 54, height: 60))
    }
    
    public override var intrinsicContentSize: NSSize {
        return NSSize(width: 54, height: 60)
    }
    
    required init?(coder: NSCoder) { fatalError() }
    
    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        
        let center = CGPoint(x: bounds.midX, y: bounds.maxY - 18)
        let radius: CGFloat = 10
        
        // Title
        let attr: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 7, weight: .bold),
            .foregroundColor: NSColor(white: 0.6, alpha: 1.0)
        ]
        let str = NSAttributedString(string: label, attributes: attr)
        str.draw(at: CGPoint(x: center.x - str.size().width/2, y: bounds.minY + 4))
        
        // Track
        ctx.setStrokeColor(NSColor(white: 0.1, alpha: 1.0).cgColor)
        ctx.setLineWidth(3.0)
        ctx.addArc(center: center, radius: radius, startAngle: 0.75 * .pi, endAngle: 2.25 * .pi, clockwise: false)
        ctx.strokePath()
        
        // Active
        ctx.setStrokeColor(NSColor(red: 0.1, green: 0.7, blue: 0.9, alpha: 1.0).cgColor)
        let endAngle = 0.75 * .pi + (value * 1.5 * .pi)
        ctx.addArc(center: center, radius: radius, startAngle: 0.75 * .pi, endAngle: endAngle, clockwise: false)
        ctx.strokePath()
        
        // Knob dot
        let dotX = center.x + cos(endAngle) * (radius - 4)
        let dotY = center.y + sin(endAngle) * (radius - 4)
        ctx.setFillColor(NSColor.white.cgColor)
        ctx.fillEllipse(in: CGRect(x: dotX - 1.5, y: dotY - 1.5, width: 3, height: 3))
    }
    
    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 {
            value = 0.5
            onValueChanged?(value)
            return
        }
        lastMouseY = convert(event.locationInWindow, from: nil).y
    }
    
    override func mouseDragged(with event: NSEvent) {
        let location = convert(event.locationInWindow, from: nil)
        let y = location.y
        let isFine = event.modifierFlags.contains(.shift)
        let sensitivity = isFine ? 0.001 : 0.005
        let delta = Double(y - lastMouseY) * sensitivity
        value = max(0, min(1, value + delta))
        onValueChanged?(value)
        lastMouseY = y
    }
}

class DAWNumberControl: NSView {
    var label: String = ""
    var unit: String = ""
    var value: Double = 0.0 { didSet { needsDisplay = true } }
    var onValueChanged: ((Double) -> Void)?
    
    private var lastMouseY: CGFloat = 0

    init(label: String, unit: String) {
        self.label = label
        self.unit = unit
        super.init(frame: NSRect(x: 0, y: 0, width: 80, height: 26))
    }
    
    public override var intrinsicContentSize: NSSize {
        return NSSize(width: 80, height: 26)
    }
    
    required init?(coder: NSCoder) { fatalError() }
    
    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        
        // Background
        ctx.setFillColor(NSColor(white: 0.1, alpha: 1.0).cgColor)
        ctx.fill(bounds)
        
        // Robust attribute creation (avoiding nil insertion crashes)
        let font = NSFont.monospacedSystemFont(ofSize: 9, weight: .bold)
        let lFont = NSFont.systemFont(ofSize: 7, weight: .medium)
        
        let attr: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: NSColor(red: 0.1, green: 0.8, blue: 0.9, alpha: 1.0)
        ]
        
        let lAttr: [NSAttributedString.Key: Any] = [
            .font: lFont,
            .foregroundColor: NSColor(white: 0.5, alpha: 1.0)
        ]
        
        // Text
        let valStr = String(format: "%.1f", value) + " " + unit
        let str = NSAttributedString(string: valStr, attributes: attr)
        str.draw(at: CGPoint(x: 4, y: (bounds.height - str.size().height)/2))
        
        // Label
        let lStr = NSAttributedString(string: label.uppercased(), attributes: lAttr)
        lStr.draw(at: CGPoint(x: bounds.width - lStr.size().width - 4, y: (bounds.height - lStr.size().height)/2))
    }
    
    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 {
            value = 0.0
            onValueChanged?(value)
            return
        }
        lastMouseY = convert(event.locationInWindow, from: nil).y
    }
    
    override func mouseDragged(with event: NSEvent) {
        let y = convert(event.locationInWindow, from: nil).y
        let isFine = event.modifierFlags.contains(.shift)
        let sensitivity = isFine ? 0.05 : 0.5
        let delta = Double(y - lastMouseY) * sensitivity
        value += delta
        onValueChanged?(value)
        lastMouseY = y
    }
}
