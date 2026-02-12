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
    private let tabSectionsContainer = NSView()
    private let editTabContent = NSView()
    private let controlTabContent = NSView()
    
    // Tabs
    private enum SamplerTab { case edit, control }
    private var activeTab: SamplerTab = .edit
    
    // Controls
    // Callback buttons
    private var modeButtons: [NSButton] = []
    
    private let volumeKnob = DAWKnob(label: "VOL")
    private let startControl = DAWNumberControl(label: "START", unit: "%")
    private let endControl = DAWNumberControl(label: "END", unit: "%")
    private let loopControl = DAWNumberControl(label: "LOOP", unit: "%")
    private let fadeControl = DAWNumberControl(label: "FADE", unit: "%")
    
    // ADSR Knobs
    private let attackKnob = DAWKnob(label: "Attack")
    private let decayKnob = DAWKnob(label: "Decay")
    private let sustainKnob = DAWKnob(label: "Sustain")
    private let releaseKnob = DAWKnob(label: "Release")
    
    // Filter
    private var filterToggle: NSButton!
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
        let fToggle = NSButton(checkboxWithTitle: "", target: self, action: #selector(filterToggled))
        self.filterToggle = fToggle
        
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
        
        // Add top-level subviews
        addSubview(sidebar)
        addSubview(mainContent)
        
        // --- Tab Content Area ---
        mainContent.addSubview(tabSectionsContainer)
        tabSectionsContainer.addSubview(editTabContent)
        tabSectionsContainer.addSubview(controlTabContent)
        
        setupEditTab()
        setupControlTab()
        setupCallbacks()
        updateTabVisibility()
        
        setupSidebar()
        setupConstraints()
    }

    private func setupCallbacks() {
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
        
        cutoffKnob.onValueChanged = { [weak self] v in
            self?.config.filterCutoff = v
            self?.onParameterChanged?()
        }
        resKnob.onValueChanged = { [weak self] v in
            self?.config.filterResonance = v
            self?.onParameterChanged?()
        }
        
        volumeKnob.onValueChanged = { [weak self] v in
            self?.config.gain = Float(v * 2.0)
            self?.onParameterChanged?()
        }
        
        filterToggle.target = self
        filterToggle.action = #selector(filterToggled)
    }

    @objc private func filterToggled() {
        config.filterEnabled = (filterToggle.state == .on)
        onParameterChanged?()
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
        tabSectionsContainer.translatesAutoresizingMaskIntoConstraints = false
        editTabContent.translatesAutoresizingMaskIntoConstraints = false
        controlTabContent.translatesAutoresizingMaskIntoConstraints = false
        
        NSLayoutConstraint.activate([
            sidebar.topAnchor.constraint(equalTo: topAnchor),
            sidebar.leadingAnchor.constraint(equalTo: leadingAnchor),
            sidebar.bottomAnchor.constraint(equalTo: bottomAnchor),
            sidebar.widthAnchor.constraint(equalToConstant: 72),
            
            mainContent.topAnchor.constraint(equalTo: topAnchor),
            mainContent.leadingAnchor.constraint(equalTo: sidebar.trailingAnchor),
            mainContent.trailingAnchor.constraint(equalTo: trailingAnchor),
            mainContent.bottomAnchor.constraint(equalTo: bottomAnchor),
            
            tabSectionsContainer.topAnchor.constraint(equalTo: mainContent.topAnchor),
            tabSectionsContainer.leadingAnchor.constraint(equalTo: mainContent.leadingAnchor),
            tabSectionsContainer.trailingAnchor.constraint(equalTo: mainContent.trailingAnchor),
            tabSectionsContainer.bottomAnchor.constraint(equalTo: mainContent.bottomAnchor),
            
            editTabContent.topAnchor.constraint(equalTo: tabSectionsContainer.topAnchor),
            editTabContent.leadingAnchor.constraint(equalTo: tabSectionsContainer.leadingAnchor),
            editTabContent.trailingAnchor.constraint(equalTo: tabSectionsContainer.trailingAnchor),
            editTabContent.bottomAnchor.constraint(equalTo: tabSectionsContainer.bottomAnchor),
            
            controlTabContent.topAnchor.constraint(equalTo: tabSectionsContainer.topAnchor),
            controlTabContent.leadingAnchor.constraint(equalTo: tabSectionsContainer.leadingAnchor),
            controlTabContent.trailingAnchor.constraint(equalTo: tabSectionsContainer.trailingAnchor),
            controlTabContent.bottomAnchor.constraint(equalTo: tabSectionsContainer.bottomAnchor)
        ])
    }
    
    private func setupSidebar() {
        let sidebarStack = NSStackView()
        sidebarStack.orientation = .vertical
        sidebarStack.spacing = 8
        sidebarStack.edgeInsets = NSEdgeInsets(top: 10, left: 6, bottom: 10, right: 6)
        sidebarStack.alignment = .centerX
        sidebar.addSubview(sidebarStack)
        
        sidebarStack.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            sidebarStack.topAnchor.constraint(equalTo: sidebar.topAnchor),
            sidebarStack.leadingAnchor.constraint(equalTo: sidebar.leadingAnchor),
            sidebarStack.trailingAnchor.constraint(equalTo: sidebar.trailingAnchor)
        ])
        
        // --- Modes ---
        let modes = SamplerMode.allCases
        for mode in modes {
            let btn = createSidebarButton(title: mode.displayName, action: #selector(modeSelected(_:)))
            btn.tag = modes.firstIndex(of: mode) ?? 0
            sidebarStack.addArrangedSubview(btn)
            modeButtons.append(btn)
        }
        
        // Initial state
        updateModeButtons()
    }
    
    private func updateModeButtons() {
        let currentMode = config.samplerMode
        let modes = SamplerMode.allCases
        for (i, btn) in modeButtons.enumerated() {
            btn.state = (modes[i] == currentMode) ? .on : .off
        }
    }

    private func createSidebarButton(title: String, action: Selector) -> NSButton {
        let btn = NSButton(title: title, target: self, action: action)
        btn.bezelStyle = .recessed
        btn.setButtonType(.pushOnPushOff)
        btn.controlSize = .small
        btn.font = NSFont.systemFont(ofSize: 10, weight: .bold)
        btn.translatesAutoresizingMaskIntoConstraints = false
        btn.heightAnchor.constraint(equalToConstant: 32).isActive = true
        btn.widthAnchor.constraint(equalToConstant: 60).isActive = true
        return btn
    }

    public func setCurrentTab(_ index: Int) {
        // 0 = Edit, 1 = Control
        activeTab = (index == 1) ? .control : .edit
        updateTabVisibility()
    }

    private func updateTabVisibility() {
        editTabContent.isHidden = (activeTab != .edit)
        controlTabContent.isHidden = (activeTab != .control)
    }

    private func setupEditTab() {
        // Massive Waveform + Main Params
        editTabContent.addSubview(waveformView)
        
        let pBar = NSView()
        pBar.wantsLayer = true
        pBar.layer?.backgroundColor = NSColor(white: 0.1, alpha: 0.5).cgColor
        pBar.layer?.cornerRadius = 4
        editTabContent.addSubview(pBar)
        
        waveformView.translatesAutoresizingMaskIntoConstraints = false
        pBar.translatesAutoresizingMaskIntoConstraints = false
        
        NSLayoutConstraint.activate([
            waveformView.topAnchor.constraint(equalTo: editTabContent.topAnchor, constant: 4),
            waveformView.leadingAnchor.constraint(equalTo: editTabContent.leadingAnchor, constant: 4),
            waveformView.trailingAnchor.constraint(equalTo: editTabContent.trailingAnchor, constant: -4),
            waveformView.bottomAnchor.constraint(equalTo: editTabContent.bottomAnchor, constant: -44),
            
            pBar.bottomAnchor.constraint(equalTo: editTabContent.bottomAnchor, constant: -4),
            pBar.leadingAnchor.constraint(equalTo: editTabContent.leadingAnchor, constant: 4),
            pBar.heightAnchor.constraint(equalToConstant: 34)
        ])
        
        // Add controls to pBar
        let parameterStack = NSStackView()
        parameterStack.orientation = .horizontal
        parameterStack.spacing = 8
        parameterStack.edgeInsets = NSEdgeInsets(top: 0, left: 8, bottom: 0, right: 8)
        parameterStack.alignment = .centerY
        pBar.addSubview(parameterStack)
        
        parameterStack.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            parameterStack.topAnchor.constraint(equalTo: pBar.topAnchor),
            parameterStack.bottomAnchor.constraint(equalTo: pBar.bottomAnchor),
            parameterStack.leadingAnchor.constraint(equalTo: pBar.leadingAnchor),
            parameterStack.trailingAnchor.constraint(equalTo: pBar.trailingAnchor)
        ])
        
        let controls = [startControl, endControl, loopControl, fadeControl]
        for ctrl in controls {
            parameterStack.addArrangedSubview(ctrl)
            ctrl.translatesAutoresizingMaskIntoConstraints = false
            ctrl.widthAnchor.constraint(equalToConstant: 72).isActive = true
        }
        
        // Volume Knob (Pinned Bottom Right)
        editTabContent.addSubview(volumeKnob)
        volumeKnob.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            volumeKnob.trailingAnchor.constraint(equalTo: editTabContent.trailingAnchor, constant: -12),
            volumeKnob.bottomAnchor.constraint(equalTo: editTabContent.bottomAnchor, constant: -2),
            volumeKnob.widthAnchor.constraint(equalToConstant: 44),
            volumeKnob.heightAnchor.constraint(equalToConstant: 50)
        ])
    }

    private func setupControlTab() {
        // Envelopes, Filter, Modulation
        let mainStack = NSStackView()
        mainStack.orientation = .horizontal
        mainStack.spacing = 30
        mainStack.edgeInsets = NSEdgeInsets(top: 10, left: 20, bottom: 10, right: 20)
        mainStack.alignment = .centerY
        controlTabContent.addSubview(mainStack)
        
        mainStack.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            mainStack.centerXAnchor.constraint(equalTo: controlTabContent.centerXAnchor),
            mainStack.centerYAnchor.constraint(equalTo: controlTabContent.centerYAnchor)
        ])
        
        // ENV
        let envStack = createGroup(title: "AMPLITUDE ENVELOPE", items: [attackKnob, decayKnob, sustainKnob, releaseKnob])
        mainStack.addArrangedSubview(envStack)
        
        mainStack.addArrangedSubview(makeDivider())
        
        // FILTER
        let filterControls = NSStackView()
        filterControls.spacing = 15
        filterControls.addArrangedSubview(filterToggle)
        filterControls.addArrangedSubview(cutoffKnob)
        filterControls.addArrangedSubview(resKnob)
        let filterStack = createGroup(title: "FILTER", items: [filterControls])
        mainStack.addArrangedSubview(filterStack)
    }

    private func createGroup(title: String, items: [NSView]) -> NSStackView {
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.spacing = 12
        stack.alignment = .centerX
        
        let label = NSTextField(labelWithString: title)
        label.font = NSFont.systemFont(ofSize: 8, weight: .bold)
        label.textColor = NSColor(white: 0.5, alpha: 1.0)
        stack.addArrangedSubview(label)
        
        let subStack = NSStackView()
        subStack.spacing = 10
        items.forEach { subStack.addArrangedSubview($0) }
        stack.addArrangedSubview(subStack)
        
        return stack
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
        filterToggle.state = config.filterEnabled ? .on : .off
        volumeKnob.value = Double(config.gain / 2.0)
        
        updateModeButtons()
    }

    @objc private func modeSelected(_ sender: NSButton) {
        let modes = SamplerMode.allCases
        guard sender.tag < modes.count else { return }
        
        let newMode = modes[sender.tag]
        config.samplerMode = newMode
        updateModeButtons()
        onParameterChanged?()
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
        // WaveformView needs a frame for its CGPath generation
        // but we manage the main layout via constraints.
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
                let frameCount = AVAudioFrameCount(file.length)
                guard let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: frameCount) else { return }
                try file.read(into: buffer)
                
                await MainActor.run {
                    self.buffer = buffer
                    self.updatePath()
                }
            } catch {
                print("Failed to load sampler waveform: \(error)")
            }
        }
    }
    
    override func layout() {
        super.layout()
        updatePath()
    }
    
    private func updatePath() {
        guard let buffer = buffer else { return }
        self.path = generateWaveformPath(from: buffer, size: bounds.size)
        self.needsDisplay = true
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
        
        let center = CGPoint(x: bounds.midX, y: bounds.midY + 4)
        let radius: CGFloat = 12
        
        // Glow Effect
        ctx.setShadow(offset: .zero, blur: 5, color: NSColor.systemBlue.withAlphaComponent(0.3).cgColor)
        
        // Title
        let pStyle = NSMutableParagraphStyle()
        pStyle.alignment = .center
        let attr: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 8, weight: .bold),
            .foregroundColor: NSColor(white: 0.7, alpha: 1.0),
            .paragraphStyle: pStyle
        ]
        let str = NSAttributedString(string: label.uppercased(), attributes: attr)
        str.draw(in: CGRect(x: 0, y: 2, width: bounds.width, height: 12))
        
        // Track
        ctx.setStrokeColor(NSColor(white: 0.08, alpha: 1.0).cgColor)
        ctx.setLineWidth(4.0)
        ctx.setLineCap(.round)
        ctx.addArc(center: center, radius: radius, startAngle: 0.8 * .pi, endAngle: 2.2 * .pi, clockwise: false)
        ctx.strokePath()
        
        // Active (Gradient/Glass)
        let endAngle = 0.8 * .pi + (value * 1.4 * .pi)
        ctx.setStrokeColor(NSColor.systemBlue.cgColor)
        ctx.addArc(center: center, radius: radius, startAngle: 0.8 * .pi, endAngle: endAngle, clockwise: false)
        ctx.strokePath()
        
        // Indicator Line
        ctx.setStrokeColor(NSColor.white.cgColor)
        ctx.setLineWidth(2.0)
        ctx.move(to: center)
        let tip = CGPoint(x: center.x + cos(endAngle) * radius, y: center.y + sin(endAngle) * radius)
        ctx.addLine(to: tip)
        ctx.strokePath()
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
        
        // --- Robust Attribute Creation ---
        // We use explicit NSObjects and check for nil to avoid SIGABRT bridged-dictionary crashes
        let fontValue: NSFont = NSFont.monospacedSystemFont(ofSize: 9, weight: .bold)
        let lFontValue: NSFont = NSFont.systemFont(ofSize: 7, weight: .medium)
        let colorValue: NSColor = NSColor(red: 0.1, green: 0.8, blue: 0.9, alpha: 1.0)
        let lColorValue: NSColor = NSColor(white: 0.5, alpha: 1.0)

        let attr = [
            NSAttributedString.Key.font: fontValue,
            NSAttributedString.Key.foregroundColor: colorValue
        ] as [NSAttributedString.Key: Any]
        
        let lAttr = [
            NSAttributedString.Key.font: lFontValue,
            NSAttributedString.Key.foregroundColor: lColorValue
        ] as [NSAttributedString.Key: Any]
        
        // --- Render Value ---
        let valStrRaw = String(format: "%.1f", value) + " " + unit
        let str = NSAttributedString(string: valStrRaw, attributes: attr)
        let strSize = str.size()
        str.draw(at: CGPoint(x: 4, y: (bounds.height - strSize.height)/2))
        
        // --- Render Label ---
        let labelText = label.uppercased()
        if !labelText.isEmpty {
            let lStr = NSAttributedString(string: labelText, attributes: lAttr)
            let lSize = lStr.size()
            lStr.draw(at: CGPoint(x: bounds.width - lSize.width - 4, y: (bounds.height - lSize.height)/2))
        }
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
