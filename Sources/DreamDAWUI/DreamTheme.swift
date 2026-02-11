import AppKit
import Foundation

// MARK: - Design System

/// Central design token registry for the Dream DAW dark theme.
/// All colors, fonts, spacings, and dimensions are defined here as the SSOT.
public enum DreamTheme {

    // MARK: - Background Colors

    public static let bgPrimary     = NSColor(red: 0.118, green: 0.118, blue: 0.118, alpha: 1.0)  // #1E1E1E
    public static let bgSecondary   = NSColor(red: 0.176, green: 0.176, blue: 0.176, alpha: 1.0)  // #2D2D2D
    public static let bgTertiary    = NSColor(red: 0.212, green: 0.212, blue: 0.212, alpha: 1.0)  // #363636
    public static let bgSurface     = NSColor(red: 0.235, green: 0.235, blue: 0.235, alpha: 1.0)  // #3C3C3C
    public static let bgHeader      = NSColor(red: 0.145, green: 0.145, blue: 0.145, alpha: 1.0)  // #252525
    public static let bgTransport   = NSColor(red: 0.110, green: 0.110, blue: 0.110, alpha: 1.0)  // #1C1C1C

    // MARK: - Accent Colors

    public static let accent          = NSColor(red: 1.0, green: 0.420, blue: 0.0, alpha: 1.0)     // #FF6B00
    public static let accentSecondary = NSColor(red: 0.0, green: 0.706, blue: 0.847, alpha: 1.0)   // #00B4D8
    public static let clipHighlight   = NSColor(red: 1.0, green: 1.0, blue: 1.0, alpha: 0.15)
    public static let selectionBorder = NSColor(red: 0.4, green: 0.7, blue: 1.0, alpha: 0.9)

    // MARK: - Text Colors

    public static let textPrimary   = NSColor(red: 0.878, green: 0.878, blue: 0.878, alpha: 1.0)  // #E0E0E0
    public static let textSecondary = NSColor(red: 0.533, green: 0.533, blue: 0.533, alpha: 1.0)  // #888888
    public static let textMuted     = NSColor(red: 0.400, green: 0.400, blue: 0.400, alpha: 1.0)  // #666666

    // MARK: - UI Element Colors

    public static let divider       = NSColor(red: 0.25, green: 0.25, blue: 0.25, alpha: 1.0)
    public static let gridLine      = NSColor(red: 0.22, green: 0.22, blue: 0.22, alpha: 1.0)
    public static let gridLineMajor = NSColor(red: 0.30, green: 0.30, blue: 0.30, alpha: 1.0)
    public static let playhead      = accent
    public static let muteButton    = NSColor(red: 0.85, green: 0.65, blue: 0.20, alpha: 1.0)
    public static let soloButton    = NSColor(red: 0.20, green: 0.65, blue: 0.85, alpha: 1.0)
    public static let armButton     = NSColor(red: 0.85, green: 0.25, blue: 0.25, alpha: 1.0)

    // MARK: - Fonts

    public static let fontSmall     = NSFont.systemFont(ofSize: 10, weight: .regular)
    public static let fontBody      = NSFont.systemFont(ofSize: 12, weight: .regular)
    public static let fontBodyBold  = NSFont.systemFont(ofSize: 12, weight: .semibold)
    public static let fontHeading   = NSFont.systemFont(ofSize: 14, weight: .semibold)
    public static let fontMono      = NSFont.monospacedSystemFont(ofSize: 12, weight: .medium)
    public static let fontMonoSmall = NSFont.monospacedSystemFont(ofSize: 10, weight: .medium)
    public static let fontMonoLarge = NSFont.monospacedDigitSystemFont(ofSize: 20, weight: .semibold)

    // MARK: - Dimensions

    public static let rulerHeight: CGFloat = 28
    public static let trackHeaderWidth: CGFloat = 200
    public static let defaultTrackHeight: CGFloat = 80
    public static let minTrackHeight: CGFloat = 40
    public static let maxTrackHeight: CGFloat = 300
    public static let transportBarHeight: CGFloat = 48
    public static let clipCornerRadius: CGFloat = 4
    public static let clipTitleHeight: CGFloat = 16
    public static let scrollbarSize: CGFloat = 12
    public static let playheadWidth: CGFloat = 1.5
    public static let dividerWidth: CGFloat = 1

    // MARK: - Zoom

    public static let defaultPixelsPerBeat: CGFloat = 30
    public static let minPixelsPerBeat: CGFloat = 5
    public static let maxPixelsPerBeat: CGFloat = 200
}
