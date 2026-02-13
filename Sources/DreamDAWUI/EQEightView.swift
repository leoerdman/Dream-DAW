import AppKit
import SwiftUI
import DreamDAWModels
import DreamDAWEngine
import Accelerate

/// A high-fidelity, Ableton-style EQ Eight interface.
/// Features a large frequency plot, real-time spectrum analysis, and interactive band controls.
public final class EQEightView: NSView {
    
    // MARK: - Properties
    
    public var onConfigChanged: ((AudioEffectConfig) -> Void)?
    
    private let config: AudioEffectConfig
    private let trackID: UUID
    private let levelMeter: AudioLevelMeter
    
    // UI Components
    private let plotView = EQPlotView()
    private let controlBar = NSStackView()
    private let sidePanel = NSStackView()
    
    private var displayLink: CVDisplayLink?
    
    // MARK: - Initialization
    
    public init(config: AudioEffectConfig, trackID: UUID, levelMeter: AudioLevelMeter) {
        self.config = config
        self.trackID = trackID
        self.levelMeter = levelMeter
        super.init(frame: .zero)
        
        setupUI()
        setupDisplayLink()
        
        // Initial sync
        plotView.configure(with: config)
    }
    
    required init?(coder: NSCoder) { fatalError() }
    
    deinit {
        if let dl = displayLink {
            CVDisplayLinkStop(dl)
        }
    }
    
    // MARK: - Setup
    
    private func setupUI() {
        wantsLayer = true
        layer?.backgroundColor = DreamTheme.bgSecondary.cgColor
        layer?.cornerRadius = DreamTheme.radiusCard
        
        // 1. Plot View (Main area)
        plotView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(plotView)
        
        // 2. Control Bar (Bottom)
        setupControlBar()
        
        NSLayoutConstraint.activate([
            plotView.topAnchor.constraint(equalTo: topAnchor, constant: 10),
            plotView.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            plotView.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            plotView.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -78),
            
            controlBar.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            controlBar.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            controlBar.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -10),
            controlBar.heightAnchor.constraint(equalToConstant: 58)
        ])
        
        plotView.onBandChanged = { [weak self] bandIndex, freq, gain, q in
            guard let self = self else { return }
            self.config.eqBands[bandIndex].frequency = Float(freq)
            self.config.eqBands[bandIndex].gain = Float(gain)
            self.config.eqBands[bandIndex].bandwidth = Float(q)
            self.onConfigChanged?(self.config)
            self.updateControls()
        }
    }
    
    private func setupControlBar() {
        controlBar.translatesAutoresizingMaskIntoConstraints = false
        controlBar.orientation = .horizontal
        controlBar.distribution = .fillEqually
        controlBar.spacing = 8
        addSubview(controlBar)
        
        // Create 8 band slots
        for i in 0..<8 {
            let slot = createBandSlot(index: i)
            controlBar.addArrangedSubview(slot)
        }
    }
    
    private func createBandSlot(index: Int) -> NSView {
        let band = config.eqBands[index]
        let view = NSView()
        view.wantsLayer = true
        view.layer?.backgroundColor = DreamTheme.bgTertiary.cgColor
        view.layer?.cornerRadius = DreamTheme.radiusSmall
        
        let toggle = NSButton(checkboxWithTitle: "", target: self, action: #selector(bandToggleClicked))
        toggle.tag = index
        toggle.state = band.isEnabled ? .on : .off
        toggle.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(toggle)
        
        let label = NSTextField(labelWithString: "\(index + 1)")
        label.font = DreamTheme.fontSmall
        label.textColor = band.isEnabled ? NSColor.systemYellow : DreamTheme.textSecondary
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)
        
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            label.topAnchor.constraint(equalTo: view.topAnchor, constant: 4),
            
            toggle.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            toggle.topAnchor.constraint(equalTo: label.bottomAnchor, constant: 4)
        ])
        
        return view
    }
    
    @objc private func bandToggleClicked(_ sender: NSButton) {
        let index = sender.tag
        config.eqBands[index].isEnabled = (sender.state == .on)
        updateControls()
        onConfigChanged?(config)
        plotView.configure(with: config)
    }
    
    private func updateControls() {
        // Update knobs/text fields if they existed
    }
    
    // MARK: - Spectrum Sync
    
    private func setupDisplayLink() {
        CVDisplayLinkCreateWithActiveCGDisplays(&displayLink)
        guard let dl = displayLink else { return }
        
        let callback: CVDisplayLinkOutputCallback = { (_, _, _, _, _, userData) -> CVReturn in
            let view = Unmanaged<EQEightView>.fromOpaque(userData!).takeUnretainedValue()
            view.updateSpectrum()
            return kCVReturnSuccess
        }
        
        CVDisplayLinkSetOutputCallback(dl, callback, Unmanaged.passUnretained(self).toOpaque())
        CVDisplayLinkStart(dl)
    }
    
    private func updateSpectrum() {
        let magnitudes = levelMeter.magnitudes(for: trackID)
        DispatchQueue.main.async {
            self.plotView.updateSpectrum(magnitudes)
        }
    }
}

// MARK: - EQPlotView

internal final class EQPlotView: NSView {
    private var config: AudioEffectConfig?
    private var spectrumMagnitudes: [Float] = []
    
    var onBandChanged: ((Int, Float, Float, Float) -> Void)?
    
    override init(frame: NSRect = .zero) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = NSColor.black.withAlphaComponent(0.8).cgColor
        layer?.cornerRadius = DreamTheme.radiusCard
        layer?.borderWidth = 1
        layer?.borderColor = DreamTheme.divider.cgColor
    }
    
    required init?(coder: NSCoder) { fatalError() }
    
    func configure(with config: AudioEffectConfig) {
        self.config = config
        needsDisplay = true
    }
    
    func updateSpectrum(_ magnitudes: [Float]) {
        self.spectrumMagnitudes = magnitudes
        needsDisplay = true
    }
    
    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        
        drawGrid(ctx)
        drawSpectrum(ctx)
        drawEQCurve(ctx)
        drawMarkers(ctx)
    }
    
    private func drawGrid( _ ctx: CGContext) {
        // Frequencies: 20, 50, 100, 200, 500, 1k, 2k, 5k, 10k, 20k
        let freqs: [Float] = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]
        ctx.setStrokeColor(DreamTheme.divider.withAlphaComponent(0.3).cgColor)
        ctx.setLineWidth(0.5)
        
        for f in freqs {
            let x = xForFreq(f)
            ctx.move(to: CGPoint(x: x, y: 0))
            ctx.addLine(to: CGPoint(x: x, y: bounds.height))
            ctx.strokePath()
        }
        
        // Gains: +12, +6, 0, -6, -12
        let gains: [Float] = [12, 6, 0, -6, -12]
        for g in gains {
            let y = yForGain(g)
            ctx.move(to: CGPoint(x: 0, y: y))
            ctx.addLine(to: CGPoint(x: bounds.width, y: y))
            ctx.strokePath()
        }
    }
    
    private func drawSpectrum(_ ctx: CGContext) {
        guard !spectrumMagnitudes.isEmpty else { return }
        
        ctx.setStrokeColor(NSColor.systemGray.withAlphaComponent(0.4).cgColor)
        ctx.setLineWidth(1.0)
        
        let path = CGMutablePath()
        let binCount = spectrumMagnitudes.count
        
        for i in 0..<binCount {
            let freq = Float(i) * (22050.0 / Float(binCount)) // Approx
            if freq < 20 { continue }
            
            let x = xForFreq(freq)
            let mag = spectrumMagnitudes[i]
            let db = 20 * log10(max(mag, 1e-6))
            let y = yForGain(db)
            
            if i == 0 {
                path.move(to: CGPoint(x: x, y: bounds.height))
            } else {
                path.addLine(to: CGPoint(x: x, y: y))
            }
        }
        
        ctx.addPath(path)
        ctx.strokePath()
    }
    
    private func drawEQCurve(_ ctx: CGContext) {
        guard let config = config else { return }
        
        ctx.setStrokeColor(NSColor.systemYellow.cgColor)
        ctx.setLineWidth(2.0)
        
        let path = CGMutablePath()
        let steps = 200
        for i in 0...steps {
            let t = Float(i) / Float(steps)
            let freq = 20.0 * pow(20000.0/20.0, t)
            
            let x = CGFloat(t) * bounds.width
            let gain = totalGainAtFreq(freq, config: config)
            let y = yForGain(gain)
            
            if i == 0 {
                path.move(to: CGPoint(x: x, y: y))
            } else {
                path.addLine(to: CGPoint(x: x, y: y))
            }
        }
        
        ctx.addPath(path)
        ctx.strokePath()
        
        // Fill under curve
        path.addLine(to: CGPoint(x: bounds.width, y: bounds.height))
        path.addLine(to: CGPoint(x: 0, y: bounds.height))
        path.closeSubpath()
        
        ctx.addPath(path)
        ctx.setFillColor(NSColor.systemYellow.withAlphaComponent(0.1).cgColor)
        ctx.fillPath()
    }
    
    private func drawMarkers(_ ctx: CGContext) {
        guard let config = config else { return }
        
        for (i, band) in config.eqBands.enumerated() {
            if !band.isEnabled { continue }
            
            let x = xForFreq(Float(band.frequency))
            let y = yForGain(Float(band.gain))
            
            let rect = CGRect(x: x - 4, y: y - 4, width: 8, height: 8)
            ctx.setFillColor(NSColor.white.cgColor)
            ctx.fillEllipse(in: rect)
            
            // Band number
            let attributes: [NSAttributedString.Key: Any] = [
                .font: DreamTheme.fontMicro,
                .foregroundColor: NSColor.black
            ]
            let label = NSAttributedString(string: "\(i+1)", attributes: attributes)
            label.draw(at: CGPoint(x: x - 3, y: y - 5))
        }
    }
    
    // MARK: - Math Helpers
    
    private func xForFreq(_ f: Float) -> CGFloat {
        let logMin = log10(Float(20))
        let logMax = log10(Float(20000))
        let logF = log10(max(f, 20))
        let t = (logF - logMin) / (logMax - logMin)
        return CGFloat(t) * bounds.width
    }
    
    private func yForGain(_ g: Float) -> CGFloat {
        let minG: Float = -15
        let maxG: Float = 15
        let t = (g - minG) / (maxG - minG)
        return bounds.height * (1.0 - CGFloat(t))
    }
    
    private func totalGainAtFreq(_ f: Float, config: AudioEffectConfig) -> Float {
        var total: Float = 0
        for band in config.eqBands where band.isEnabled {
            let f0 = band.frequency
            let g = band.gain
            let q = band.bandwidth
            
            // Peak/Bell filter response approximation in log-freq space
            let octaves = log2(max(f, 20) / max(f0, 20))
            let width = 1.0 / max(q, 0.01)
            let response = exp(-pow(octaves / width, 2))
            total += g * response
        }
        return total
    }

    // MARK: - Interaction

    private var draggingBandIndex: Int? = nil

    override func mouseDown(with event: NSEvent) {
        guard let config = config else { return }
        let location = convert(event.locationInWindow, from: nil)

        // Find closest marker
        for (i, band) in config.eqBands.enumerated() where band.isEnabled {
            let x = xForFreq(Float(band.frequency))
            let y = yForGain(Float(band.gain))
            let markerRect = CGRect(x: x - 12, y: y - 12, width: 24, height: 24)

            if markerRect.contains(location) {
                draggingBandIndex = i
                return
            }
        }
    }

    override func mouseDragged(with event: NSEvent) {
        guard let index = draggingBandIndex, let config = config else { return }
        let location = convert(event.locationInWindow, from: nil)

        // Map X back to frequency (logarithmic)
        let tX = Float(max(0, min(1, location.x / bounds.width)))
        let logMin = log10f(20.0)
        let logMax = log10f(20000.0)
        let logF = logMin + tX * (logMax - logMin)
        let freq = powf(10.0, logF)

        // Map Y back to gain (linear in this range)
        let tY = 1.0 - (location.y / bounds.height)
        let minG: Float = -15
        let maxG: Float = 15
        let gain = minG + Float(tY) * (maxG - minG)

        onBandChanged?(index, Float(freq), Float(gain), Float(config.eqBands[index].bandwidth))
        needsDisplay = true
    }

    override func mouseUp(with event: NSEvent) {
        draggingBandIndex = nil
    }
}
