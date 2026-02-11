import AppKit
import Foundation

// MARK: - Design System

/// Central design token registry — Ableton Live 11 exact color palette and dimensions.
/// All colors, fonts, spacings, and dimensions are defined here as the SSOT.
public enum DreamTheme {

    // MARK: - Background Colors (Ableton Live exact)

    public static let bgPrimary     = NSColor(red: 0.102, green: 0.102, blue: 0.102, alpha: 1.0)  // #1A1A1A — main background
    public static let bgSecondary   = NSColor(red: 0.145, green: 0.145, blue: 0.145, alpha: 1.0)  // #252525 — track lane even
    public static let bgTertiary    = NSColor(red: 0.160, green: 0.160, blue: 0.160, alpha: 1.0)  // #292929 — track lane odd
    public static let bgSurface     = NSColor(red: 0.200, green: 0.200, blue: 0.200, alpha: 1.0)  // #333333 — surfaces, panels
    public static let bgHeader      = NSColor(red: 0.176, green: 0.176, blue: 0.176, alpha: 1.0)  // #2D2D2D — control bar, headers
    public static let bgTransport   = NSColor(red: 0.176, green: 0.176, blue: 0.176, alpha: 1.0)  // #2D2D2D — control bar bg
    public static let bgBrowser     = NSColor(red: 0.125, green: 0.125, blue: 0.125, alpha: 1.0)  // #202020 — browser sidebar
    public static let bgBrowserItem = NSColor(red: 0.165, green: 0.165, blue: 0.165, alpha: 1.0)  // #2A2A2A — browser hover
    public static let bgTrackHeader = NSColor(red: 0.235, green: 0.235, blue: 0.235, alpha: 1.0)  // #3C3C3C — track header cells
    public static let bgStatusBar   = NSColor(red: 0.125, green: 0.125, blue: 0.125, alpha: 1.0)  // #202020 — status bar
    public static let bgSelected    = NSColor(red: 0.180, green: 0.220, blue: 0.310, alpha: 1.0)  // Blue selection
    public static let bgDropTarget  = NSColor(red: 0.200, green: 0.200, blue: 0.200, alpha: 0.5)  // Drop target highlight

    // MARK: - Accent Colors (Ableton-style)

    public static let accent          = NSColor(red: 1.0, green: 0.420, blue: 0.0, alpha: 1.0)     // #FF6B00 — orange accent
    public static let accentSecondary = NSColor(red: 0.0, green: 0.706, blue: 0.847, alpha: 1.0)   // #00B4D8 — cyan/blue
    public static let accentGreen     = NSColor(red: 0.400, green: 0.800, blue: 0.200, alpha: 1.0) // Green play
    public static let clipHighlight   = NSColor(red: 1.0, green: 1.0, blue: 1.0, alpha: 0.08)
    public static let selectionBorder = NSColor(red: 0.35, green: 0.55, blue: 0.90, alpha: 0.85)
    public static let selectionFill   = NSColor(red: 0.20, green: 0.35, blue: 0.60, alpha: 0.25)

    // MARK: - Text Colors (Ableton-style)

    public static let textPrimary   = NSColor(red: 0.867, green: 0.867, blue: 0.867, alpha: 1.0)  // #DDDDDD
    public static let textSecondary = NSColor(red: 0.600, green: 0.600, blue: 0.600, alpha: 1.0)  // #999999
    public static let textMuted     = NSColor(red: 0.400, green: 0.400, blue: 0.400, alpha: 1.0)  // #666666
    public static let textBright    = NSColor(red: 0.950, green: 0.950, blue: 0.950, alpha: 1.0)  // #F2F2F2
    public static let textOnColor   = NSColor(red: 0.050, green: 0.050, blue: 0.050, alpha: 1.0)  // Dark text on colored bg

    // MARK: - UI Element Colors

    public static let divider       = NSColor(red: 0.18, green: 0.18, blue: 0.18, alpha: 1.0)
    public static let dividerLight  = NSColor(red: 0.25, green: 0.25, blue: 0.25, alpha: 1.0)
    public static let gridLine      = NSColor(red: 0.16, green: 0.16, blue: 0.16, alpha: 1.0)
    public static let gridLineMajor = NSColor(red: 0.22, green: 0.22, blue: 0.22, alpha: 1.0)
    public static let playhead      = NSColor(red: 0.85, green: 0.85, blue: 0.85, alpha: 1.0)   // White playhead like Ableton
    public static let muteButton    = NSColor(red: 0.85, green: 0.65, blue: 0.20, alpha: 1.0)   // Yellow mute
    public static let soloButton    = NSColor(red: 0.20, green: 0.65, blue: 0.85, alpha: 1.0)   // Blue solo
    public static let armButton     = NSColor(red: 0.85, green: 0.25, blue: 0.25, alpha: 1.0)   // Red arm
    public static let midiIndicator = NSColor(red: 0.90, green: 0.70, blue: 0.20, alpha: 1.0)   // MIDI activity

    // MARK: - Fonts

    public static let fontTiny      = NSFont.systemFont(ofSize: 9, weight: .regular)
    public static let fontSmall     = NSFont.systemFont(ofSize: 10, weight: .regular)
    public static let fontBody      = NSFont.systemFont(ofSize: 11, weight: .regular)
    public static let fontBodyBold  = NSFont.systemFont(ofSize: 11, weight: .semibold)
    public static let fontHeading   = NSFont.systemFont(ofSize: 12, weight: .semibold)
    public static let fontMono      = NSFont.monospacedSystemFont(ofSize: 11, weight: .medium)
    public static let fontMonoSmall = NSFont.monospacedSystemFont(ofSize: 9, weight: .medium)
    public static let fontMonoLarge = NSFont.monospacedDigitSystemFont(ofSize: 16, weight: .semibold)
    public static let fontBrowser   = NSFont.systemFont(ofSize: 11, weight: .regular)
    public static let fontBrowserBold = NSFont.systemFont(ofSize: 11, weight: .semibold)

    // MARK: - Dimensions

    public static let controlBarHeight: CGFloat = 32        // Top control bar (Ableton-style, compact)
    public static let rulerHeight: CGFloat = 22             // Thinner ruler like Ableton
    public static let trackHeaderWidth: CGFloat = 220       // Right-side track headers
    public static let browserWidth: CGFloat = 240           // Left browser sidebar
    public static let browserMinWidth: CGFloat = 200        // Min browser width
    public static let browserMaxWidth: CGFloat = 400        // Max browser width
    public static let statusBarHeight: CGFloat = 20         // Bottom status bar
    public static let defaultTrackHeight: CGFloat = 32      // Ableton-compact track height
    public static let minTrackHeight: CGFloat = 24
    public static let maxTrackHeight: CGFloat = 300
    public static let transportBarHeight: CGFloat = 32      // Same as controlBarHeight
    public static let clipCornerRadius: CGFloat = 2         // Ableton uses minimal rounding
    public static let clipTitleHeight: CGFloat = 14
    public static let scrollbarSize: CGFloat = 10
    public static let playheadWidth: CGFloat = 1.0
    public static let dividerWidth: CGFloat = 1
    public static let colorStripeWidth: CGFloat = 3         // Track color indicator width

    // MARK: - Zoom

    public static let defaultPixelsPerBeat: CGFloat = 25
    public static let minPixelsPerBeat: CGFloat = 3
    public static let maxPixelsPerBeat: CGFloat = 200
}
