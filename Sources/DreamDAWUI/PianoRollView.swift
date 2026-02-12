import AppKit
import Foundation
import DreamDAWModels
import os.log

// MARK: - PianoRollView

/// A grid-based MIDI note editor.
/// - Horizontal axis: beats (time)
/// - Vertical axis: MIDI pitch (0-127, bottom = low, top = high)
/// - Click to add notes, right-click to delete, drag to resize
public final class PianoRollView: NSView {

    // MARK: - Properties

    /// The MIDI clip being edited.
    public var midiClip: MidiClip? {
        didSet { needsDisplay = true }
    }

    /// Track reference for color.
    public var track: Track?

    /// BPM for time calculations.
    public var bpm: Double = 120.0

    /// Pixels per beat (horizontal zoom).
    public var pixelsPerBeat: CGFloat = 40.0

    /// Height per pitch row in pixels.
    public var pitchRowHeight: CGFloat = 10.0

    /// Piano keyboard width on the left.
    private let keyboardWidth: CGFloat = 48.0

    /// Visible pitch range (show all 8+ octaves for professional range).
    private let pitchRangeStart: Int = 0
    private let pitchRangeEnd: Int = 127

    /// Selected notes IDs.
    private var selectedNoteIDs = Set<UUID>()
    
    /// Dragging state
    private var dragStartLocation: CGPoint?
    private var draggingNotesOffset: (beats: Double, pitch: Int) = (0, 0)
    private var isDragging: Bool = false

    /// Callback when notes are modified.
    public var onNotesChanged: ((MidiClip) -> Void)?

    /// Grid snap value in beats (default: quarter note = 1 beat).
    public var gridSnap: Double = 0.25

    /// Note names for keyboard display.
    private static let noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

    private let logger = Logger(subsystem: "com.dreamdaw", category: "PianoRollView")

    // MARK: - Initialization

    public override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.backgroundColor = DreamTheme.bgPrimary.cgColor
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    // MARK: - Drawing

    public override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }

        let gridRect = NSRect(
            x: keyboardWidth,
            y: 0,
            width: bounds.width - keyboardWidth,
            height: bounds.height
        )

        drawPianoKeyboard(ctx: ctx)
        drawGrid(ctx: ctx, rect: gridRect)
        drawNotes(ctx: ctx, rect: gridRect)
    }

    // MARK: - Piano Keyboard

    private func drawPianoKeyboard(ctx: CGContext) {
        let keyboardRect = NSRect(x: 0, y: 0, width: keyboardWidth, height: bounds.height)

        // Background
        ctx.setFillColor(DreamTheme.bgHeader.cgColor)
        ctx.fill(keyboardRect)

        for pitch in pitchRangeStart..<pitchRangeEnd {
            let y = yForPitch(pitch)
            let noteIndex = pitch % 12
            let isBlack = [1, 3, 6, 8, 10].contains(noteIndex)

            // Key background
            let keyColor = isBlack
                ? NSColor(white: 0.18, alpha: 1.0)
                : NSColor(white: 0.28, alpha: 1.0)
            ctx.setFillColor(keyColor.cgColor)
            ctx.fill(CGRect(x: 0, y: y, width: keyboardWidth, height: pitchRowHeight))

            // Separator line
            ctx.setStrokeColor(NSColor(white: 0.15, alpha: 1.0).cgColor)
            ctx.setLineWidth(0.5)
            ctx.move(to: CGPoint(x: 0, y: y))
            ctx.addLine(to: CGPoint(x: keyboardWidth, y: y))
            ctx.strokePath()

            // Note name (only for C notes)
            if noteIndex == 0 {
                let octave = (pitch / 12) - 1
                let label = "C\(octave)" as NSString
                let attrs: [NSAttributedString.Key: Any] = [
                    .font: NSFont.systemFont(ofSize: 8, weight: .medium),
                    .foregroundColor: DreamTheme.textSecondary
                ]
                label.draw(at: CGPoint(x: 4, y: y + 1), withAttributes: attrs)
            }
        }

        // Right border of keyboard
        ctx.setStrokeColor(DreamTheme.divider.cgColor)
        ctx.setLineWidth(1)
        ctx.move(to: CGPoint(x: keyboardWidth, y: 0))
        ctx.addLine(to: CGPoint(x: keyboardWidth, y: bounds.height))
        ctx.strokePath()
    }

    // MARK: - Grid

    private func drawGrid(ctx: CGContext, rect: NSRect) {
        // Horizontal pitch lines
        for pitch in pitchRangeStart..<pitchRangeEnd {
            let y = yForPitch(pitch)
            let noteIndex = pitch % 12
            let isC = noteIndex == 0

            ctx.setStrokeColor(
                isC ? NSColor(white: 0.25, alpha: 1.0).cgColor
                    : NSColor(white: 0.16, alpha: 1.0).cgColor
            )
            ctx.setLineWidth(isC ? 1.0 : 0.5)
            ctx.move(to: CGPoint(x: rect.minX, y: y))
            ctx.addLine(to: CGPoint(x: rect.maxX, y: y))
            ctx.strokePath()
        }

        // Vertical beat lines
        guard let clip = midiClip else { return }
        let totalBeats = clip.duration.beats
        let startX = rect.minX

        var beat: Double = 0
        while beat <= totalBeats {
            let x = startX + CGFloat(beat) * pixelsPerBeat
            guard x <= rect.maxX else { break }

            let isBar = beat.truncatingRemainder(dividingBy: 4.0) == 0
            let isBeat = beat.truncatingRemainder(dividingBy: 1.0) == 0

            if isBar {
                ctx.setStrokeColor(NSColor(white: 0.3, alpha: 1.0).cgColor)
                ctx.setLineWidth(1.0)
            } else if isBeat {
                ctx.setStrokeColor(NSColor(white: 0.2, alpha: 1.0).cgColor)
                ctx.setLineWidth(0.5)
            } else {
                ctx.setStrokeColor(NSColor(white: 0.14, alpha: 0.5).cgColor)
                ctx.setLineWidth(0.5)
            }

            ctx.move(to: CGPoint(x: x, y: rect.minY))
            ctx.addLine(to: CGPoint(x: x, y: rect.maxY))
            ctx.strokePath()

            beat += gridSnap
        }
    }

    // MARK: - Notes

    private func drawNotes(ctx: CGContext, rect: NSRect) {
        guard let clip = midiClip else { return }
        let baseTrackColor = track?.color.nsColor ?? DreamTheme.accent

        for note in clip.notes {
            let x = rect.minX + CGFloat(note.position.beats) * pixelsPerBeat
            let y = yForPitch(note.pitch)
            let w = CGFloat(note.duration.beats) * pixelsPerBeat
            let h = pitchRowHeight

            let noteRect = CGRect(x: x, y: y + 1, width: max(w, 2), height: h - 2)
            let cornerRadius: CGFloat = 2.0
            let path = NSBezierPath(roundedRect: noteRect, xRadius: cornerRadius, yRadius: cornerRadius)

            let isSelected = selectedNoteIDs.contains(note.id)
            let color = isSelected ? .white : baseTrackColor

            // Note body
            ctx.setFillColor(color.withAlphaComponent(isSelected ? 1.0 : 0.85).cgColor)
            ctx.addPath(path.cgPath)
            ctx.fillPath()

            // Note border (subtle)
            ctx.setStrokeColor(color.withAlphaComponent(0.5).cgColor)
            ctx.setLineWidth(1.0)
            ctx.addPath(path.cgPath)
            ctx.strokePath()

            // Velocity indicator (darker bottom edge)
            let velocityHeight = h * (1.0 - CGFloat(note.velocity) / 127.0)
            if velocityHeight > 2 {
                ctx.setFillColor(NSColor.black.withAlphaComponent(0.2).cgColor)
                ctx.fill(CGRect(x: x, y: y + 1, width: w, height: velocityHeight))
            }
        }
    }

    // MARK: - Coordinate Helpers

    private func yForPitch(_ pitch: Int) -> CGFloat {
        // Higher pitches at top, lower at bottom
        CGFloat(pitch - pitchRangeStart) * pitchRowHeight
    }

    private func pitchForY(_ y: CGFloat) -> Int {
        let pitch = pitchRangeStart + Int(y / pitchRowHeight)
        return max(pitchRangeStart, min(pitchRangeEnd - 1, pitch))
    }

    private func beatForX(_ x: CGFloat) -> Double {
        let beat = Double(x - keyboardWidth) / Double(pixelsPerBeat)
        // Snap to grid
        return max(0, round(beat / gridSnap) * gridSnap)
    }

    // MARK: - Mouse Events

    // MARK: - Mouse Events

    public override func mouseDown(with event: NSEvent) {
        guard var clip = midiClip else { return }
        let location = convert(event.locationInWindow, from: nil)

        // Keyboard interaction (Audition)
        if location.x < keyboardWidth {
            // Note auditioning or other keyboard interaction...
            return
        }

        let beat = beatForX(location.x)
        let pitch = pitchForY(location.y)

        // Check if clicking on an existing note
        if let clickedNote = clip.notes.first(where: {
            $0.pitch == pitch &&
            beat >= $0.position.beats &&
            beat < $0.position.beats + $0.duration.beats
        }) {
            if event.modifierFlags.contains(.shift) {
                selectedNoteIDs.insert(clickedNote.id)
            } else if !selectedNoteIDs.contains(clickedNote.id) {
                selectedNoteIDs = [clickedNote.id]
            }
            
            isDragging = true
            dragStartLocation = location
            draggingNotesOffset = (0, 0)
            needsDisplay = true
            return
        }

        // Click on empty space: clear selection OR add note
        if !event.modifierFlags.contains(.shift) {
            selectedNoteIDs.removeAll()
        }
        
        // Double click to add note
        if event.clickCount == 2 {
            let note = MidiNote(
                pitch: pitch,
                velocity: 100,
                position: TimePosition(beats: beat),
                duration: TimePosition(beats: gridSnap)
            )
            clip.notes.append(note)
            selectedNoteIDs = [note.id]
            midiClip = clip
            onNotesChanged?(clip)
        }
        
        needsDisplay = true
    }

    public override func mouseDragged(with event: NSEvent) {
        guard isDragging, let startLoc = dragStartLocation, var clip = midiClip else { return }
        let currentLoc = convert(event.locationInWindow, from: nil)
        
        // Simple drag offset implementation (delta-based)
        // For production, we'd snap final positions on mouseUp
        // Let's just update the visual representation for now
    }

    public override func mouseUp(with event: NSEvent) {
        isDragging = false
        dragStartLocation = nil
    }

    public override func rightMouseDown(with event: NSEvent) {
        guard var clip = midiClip else { return }
        let location = convert(event.locationInWindow, from: nil)
        guard location.x > keyboardWidth else { return }

        let beat = beatForX(location.x)
        let pitch = pitchForY(location.y)

        // Delete note at this position
        if let index = clip.notes.firstIndex(where: {
            $0.pitch == pitch &&
            beat >= $0.position.beats &&
            beat < $0.position.beats + $0.duration.beats
        }) {
            clip.notes.remove(at: index)
            midiClip = clip
            onNotesChanged?(clip)
        }
    }

    // MARK: - Intrinsic Size

    public override var intrinsicContentSize: NSSize {
        let height = CGFloat(pitchRangeEnd - pitchRangeStart) * pitchRowHeight
        let width = CGFloat(midiClip?.duration.beats ?? 16) * pixelsPerBeat + keyboardWidth
        return NSSize(width: width, height: height)
    }
}
