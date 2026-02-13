import AppKit
import Foundation
import Combine

// MARK: - Theme Protocol

/// Defines every visual token in the Dream DAW design system.
/// All UI components MUST reference these tokens — zero hardcoded values.
public protocol ThemeProtocol {

    // ─── Backgrounds (gray scale, darkest → lightest) ───────────────

    var bgBase: NSColor { get }           // deepest background (canvas behind everything)
    var bgPrimary: NSColor { get }        // main timeline / workspace background
    var bgSecondary: NSColor { get }      // track lanes (even rows)
    var bgTertiary: NSColor { get }       // track lanes (odd rows)
    var bgSurface: NSColor { get }        // panels, cards, plugin slots
    var bgElevated: NSColor { get }       // headers, toolbars, control bars
    var bgHover: NSColor { get }          // hover highlight on interactive items
    var bgSelected: NSColor { get }       // selected row / item
    var bgInput: NSColor { get }          // text fields, popup backgrounds

    // ─── Text ───────────────────────────────────────────────────────

    var textPrimary: NSColor { get }      // primary readable text
    var textSecondary: NSColor { get }    // secondary / labels
    var textMuted: NSColor { get }        // disabled / placeholder
    var textBright: NSColor { get }       // emphasized text
    var textOnAccent: NSColor { get }     // text on accent-colored backgrounds
    var textOnColor: NSColor { get }      // dark text on bright track color bg

    // ─── Accent (blue) ──────────────────────────────────────────────

    var accent: NSColor { get }           // primary accent (selections, links, active)
    var accentHover: NSColor { get }      // accent on hover / pressed
    var accentMuted: NSColor { get }      // subtle accent background tint

    // ─── Semantic Colors ────────────────────────────────────────────

    var success: NSColor { get }          // green — play button, enabled, active track
    var warning: NSColor { get }          // amber — mute, caution, MIDI indicator
    var danger: NSColor { get }           // red — record arm, clipping, delete
    var info: NSColor { get }             // blue — solo button

    // ─── UI Elements ────────────────────────────────────────────────

    var divider: NSColor { get }          // thin separators
    var dividerLight: NSColor { get }     // lighter separators
    var gridLine: NSColor { get }         // beat grid lines
    var gridLineMajor: NSColor { get }    // bar lines (prominent)
    var playhead: NSColor { get }         // playhead line
    var selectionBorder: NSColor { get }  // selection marquee border
    var selectionFill: NSColor { get }    // selection marquee fill
    var clipHighlight: NSColor { get }    // subtle clip hover overlay
    var dropTarget: NSColor { get }       // drag-and-drop highlight

    // ─── VU Meter Colors ────────────────────────────────────────────

    var meterBackground: NSColor { get }  // meter track background
    var meterNormal: NSColor { get }      // normal level (green)
    var meterHot: NSColor { get }         // hot signal (yellow)
    var meterClip: NSColor { get }        // clipping (red)
    var meterSilent: NSColor { get }      // near-silence / inactive

    // ─── Controls ───────────────────────────────────────────────────

    var controlBg: NSColor { get }        // button bg (inactive state)
    var controlBgActive: NSColor { get }  // button bg (active / toggled on)
    var controlBorder: NSColor { get }    // control border / outline
    var controlTint: NSColor { get }      // icon / symbol tint on controls

    // ─── Effect Type Tints ──────────────────────────────────────────

    var effectEQ: NSColor { get }
    var effectCompressor: NSColor { get }
    var effectDelay: NSColor { get }
    var effectReverb: NSColor { get }
    var effectChorus: NSColor { get }
    var effectUtility: NSColor { get }
    var effectVST: NSColor { get }

    // ─── Browser Category Icon Colors ───────────────────────────────

    var browserDefault: NSColor { get }
    var browserAudio: NSColor { get }
    var browserMIDI: NSColor { get }
    var browserPlugin: NSColor { get }
    var browserPreset: NSColor { get }

    // ─── Knob / Fader ───────────────────────────────────────────────

    var knobArcInactive: NSColor { get }
    var knobFill: NSColor { get }
    var knobValueText: NSColor { get }
    var faderTrackBg: NSColor { get }
    var faderGroove: NSColor { get }

    // ─── Piano Roll ─────────────────────────────────────────────────

    var pianoWhiteKey: NSColor { get }
    var pianoBlackKey: NSColor { get }
    var pianoGridLine: NSColor { get }
    var pianoCLine: NSColor { get }       // C octave marker row
    var pianoBarLine: NSColor { get }
    var pianoBeatLine: NSColor { get }
    var pianoSubLine: NSColor { get }

    // ─── Fonts ──────────────────────────────────────────────────────

    var fontMicro: NSFont { get }         // 8px — mini labels (IN/OUT, knob values)
    var fontSmall: NSFont { get }         // 9px — buttons (S, M), StatusBar
    var fontBody: NSFont { get }          // 10px regular — browser items, inspector
    var fontBodyMedium: NSFont { get }    // 10px medium — filter buttons, secondary
    var fontHeading: NSFont { get }       // 11px semibold — panel titles, track names
    var fontMono: NSFont { get }          // 11px medium monospaced — BPM, position, dB
    var fontMonoSmall: NSFont { get }     // 9px medium monospaced — fader dB, time
    var fontMonoBody: NSFont { get }      // 10px regular monospaced — numeric displays
    var fontMonoLarge: NSFont { get }     // 14px semibold mono-digit — large position

    // ─── Dimensions ─────────────────────────────────────────────────

    var radiusSmall: CGFloat { get }      // 2 — buttons, pills, VU bars
    var radiusCard: CGFloat { get }       // 4 — slots, cards, input fields

    var controlPadH: CGFloat { get }      // 4 — horizontal padding inside controls
    var sectionPadH: CGFloat { get }      // 8 — section-level horizontal padding

    var iconMicro: CGFloat { get }        // 6 — indicator dots
    var iconSmall: CGFloat { get }        // 9 — toolbar icons
    var iconMedium: CGFloat { get }       // 12 — transport buttons

    // ─── Layout ─────────────────────────────────────────────────────

    var controlBarHeight: CGFloat { get }
    var rulerHeight: CGFloat { get }
    var trackHeaderWidth: CGFloat { get }
    var browserWidth: CGFloat { get }
    var browserMinWidth: CGFloat { get }
    var browserMaxWidth: CGFloat { get }
    var statusBarHeight: CGFloat { get }
    var panelHeaderHeight: CGFloat { get }
    var defaultTrackHeight: CGFloat { get }
    var minTrackHeight: CGFloat { get }
    var maxTrackHeight: CGFloat { get }
    var trackResizeStep: CGFloat { get }
    var transportBarHeight: CGFloat { get }
    var clipCornerRadius: CGFloat { get }
    var clipTitleHeight: CGFloat { get }
    var scrollbarSize: CGFloat { get }
    var playheadWidth: CGFloat { get }
    var dividerWidth: CGFloat { get }
    var bottomPanelMinHeight: CGFloat { get }
    var colorStripeWidth: CGFloat { get }
    var browserRowHeight: CGFloat { get }

    // ─── Zoom ───────────────────────────────────────────────────────

    var defaultPixelsPerBeat: CGFloat { get }
    var minPixelsPerBeat: CGFloat { get }
    var maxPixelsPerBeat: CGFloat { get }

    // ─── Animation ──────────────────────────────────────────────────

    var springDamping: CGFloat { get }
    var springStiffness: CGFloat { get }
    var fastAnimation: TimeInterval { get }
    var standardAnimation: TimeInterval { get }
    var premiumAnimation: TimeInterval { get }

    // ─── Glass (HUD) ────────────────────────────────────────────────

    var glassMaterial: NSVisualEffectView.Material { get }
    var glassBlending: NSVisualEffectView.BlendingMode { get }
    var glassColor: NSColor { get }
    var glassBorder: NSColor { get }
}

// MARK: - Theme Manager

/// Central singleton that holds the active theme and notifies observers on change.
public final class ThemeManager: ObservableObject {
    public static let shared = ThemeManager()

    @Published public private(set) var current: any ThemeProtocol

    private init() {
        self.current = DarkTheme()
    }

    public func switchTo(_ theme: any ThemeProtocol) {
        current = theme
        NotificationCenter.default.post(name: .themeDidChange, object: nil)
    }

    public func toggleTheme() {
        if current is DarkTheme {
            switchTo(LightTheme())
        } else {
            switchTo(DarkTheme())
        }
    }
}

public extension Notification.Name {
    static let themeDidChange = Notification.Name("DreamDAW.themeDidChange")
}

// MARK: - DreamTheme Facade (Backwards Compatibility)

/// Static facade so existing code (`DreamTheme.bgPrimary`) continues to compile.
/// All properties proxy through `ThemeManager.shared.current`.
public enum DreamTheme {

    public static var current: any ThemeProtocol { ThemeManager.shared.current }

    // ── Backgrounds ─────────────────────────────────────────────────
    public static var bgBase: NSColor { current.bgBase }
    public static var bgPrimary: NSColor { current.bgPrimary }
    public static var bgSecondary: NSColor { current.bgSecondary }
    public static var bgTertiary: NSColor { current.bgTertiary }
    public static var bgSurface: NSColor { current.bgSurface }
    public static var bgElevated: NSColor { current.bgElevated }
    public static var bgHover: NSColor { current.bgHover }
    public static var bgSelected: NSColor { current.bgSelected }
    public static var bgInput: NSColor { current.bgInput }
    // Legacy aliases
    public static var bgHeader: NSColor { current.bgElevated }
    public static var bgTransport: NSColor { current.bgElevated }
    public static var bgBrowser: NSColor { current.bgBase }
    public static var bgBrowserItem: NSColor { current.bgHover }
    public static var bgTrackHeader: NSColor { current.bgSurface }
    public static var bgStatusBar: NSColor { current.bgBase }
    public static var bgDropTarget: NSColor { current.dropTarget }

    // ── Text ────────────────────────────────────────────────────────
    public static var textPrimary: NSColor { current.textPrimary }
    public static var textSecondary: NSColor { current.textSecondary }
    public static var textMuted: NSColor { current.textMuted }
    public static var textBright: NSColor { current.textBright }
    public static var textOnColor: NSColor { current.textOnColor }
    public static var textOnAccent: NSColor { current.textOnAccent }

    // ── Accent ──────────────────────────────────────────────────────
    public static var accent: NSColor { current.accent }
    public static var accentSecondary: NSColor { current.accent } // legacy alias
    public static var accentGreen: NSColor { current.success }
    public static var accentHover: NSColor { current.accentHover }
    public static var accentMuted: NSColor { current.accentMuted }

    // ── Semantic ────────────────────────────────────────────────────
    public static var success: NSColor { current.success }
    public static var warning: NSColor { current.warning }
    public static var danger: NSColor { current.danger }
    public static var info: NSColor { current.info }

    // ── UI Elements ─────────────────────────────────────────────────
    public static var divider: NSColor { current.divider }
    public static var dividerLight: NSColor { current.dividerLight }
    public static var gridLine: NSColor { current.gridLine }
    public static var gridLineMajor: NSColor { current.gridLineMajor }
    public static var playhead: NSColor { current.playhead }
    public static var selectionBorder: NSColor { current.selectionBorder }
    public static var selectionFill: NSColor { current.selectionFill }
    public static var clipHighlight: NSColor { current.clipHighlight }

    // ── Buttons ─────────────────────────────────────────────────────
    public static var muteButton: NSColor { current.warning }
    public static var soloButton: NSColor { current.info }
    public static var armButton: NSColor { current.danger }
    public static var midiIndicator: NSColor { current.warning }

    // ── Meters ──────────────────────────────────────────────────────
    public static var meterBackground: NSColor { current.meterBackground }
    public static var meterNormal: NSColor { current.meterNormal }
    public static var meterHot: NSColor { current.meterHot }
    public static var meterClip: NSColor { current.meterClip }
    public static var meterSilent: NSColor { current.meterSilent }

    // ── Controls ────────────────────────────────────────────────────
    public static var controlBg: NSColor { current.controlBg }
    public static var controlBgActive: NSColor { current.controlBgActive }
    public static var controlBorder: NSColor { current.controlBorder }
    public static var controlTint: NSColor { current.controlTint }

    // ── Effects ─────────────────────────────────────────────────────
    public static var effectEQ: NSColor { current.effectEQ }
    public static var effectCompressor: NSColor { current.effectCompressor }
    public static var effectDelay: NSColor { current.effectDelay }
    public static var effectReverb: NSColor { current.effectReverb }
    public static var effectChorus: NSColor { current.effectChorus }
    public static var effectUtility: NSColor { current.effectUtility }
    public static var effectVST: NSColor { current.effectVST }

    // ── Browser ─────────────────────────────────────────────────────
    public static var browserDefault: NSColor { current.browserDefault }
    public static var browserAudio: NSColor { current.browserAudio }
    public static var browserMIDI: NSColor { current.browserMIDI }
    public static var browserPlugin: NSColor { current.browserPlugin }
    public static var browserPreset: NSColor { current.browserPreset }

    // ── Knob / Fader ────────────────────────────────────────────────
    public static var knobArcInactive: NSColor { current.knobArcInactive }
    public static var knobFill: NSColor { current.knobFill }
    public static var knobValueText: NSColor { current.knobValueText }
    public static var faderTrackBg: NSColor { current.faderTrackBg }
    public static var faderGroove: NSColor { current.faderGroove }

    // ── Piano Roll ──────────────────────────────────────────────────
    public static var pianoWhiteKey: NSColor { current.pianoWhiteKey }
    public static var pianoBlackKey: NSColor { current.pianoBlackKey }
    public static var pianoGridLine: NSColor { current.pianoGridLine }
    public static var pianoCLine: NSColor { current.pianoCLine }
    public static var pianoBarLine: NSColor { current.pianoBarLine }
    public static var pianoBeatLine: NSColor { current.pianoBeatLine }
    public static var pianoSubLine: NSColor { current.pianoSubLine }
    // Piano roll aliases (semantic names used in PianoRollView)
    public static var pianoGridC: NSColor { current.pianoCLine }
    public static var pianoSeparator: NSColor { current.pianoGridLine }

    // ── Fonts ───────────────────────────────────────────────────────
    public static var fontMicro: NSFont { current.fontMicro }
    public static var fontSmall: NSFont { current.fontSmall }
    public static var fontBody: NSFont { current.fontBody }
    public static var fontBodyMedium: NSFont { current.fontBodyMedium }
    public static var fontHeading: NSFont { current.fontHeading }
    public static var fontMono: NSFont { current.fontMono }
    public static var fontMonoSmall: NSFont { current.fontMonoSmall }
    public static var fontMonoBody: NSFont { current.fontMonoBody }
    public static var fontMonoLarge: NSFont { current.fontMonoLarge }
    // Legacy aliases
    public static var fontTiny: NSFont { current.fontSmall }
    public static var fontBodyBold: NSFont { current.fontHeading }
    public static var fontBrowser: NSFont { current.fontBody }
    public static var fontBrowserBold: NSFont { current.fontBodyMedium }

    // ── Dimensions ──────────────────────────────────────────────────
    public static var radiusSmall: CGFloat { current.radiusSmall }
    public static var radiusCard: CGFloat { current.radiusCard }
    public static var controlPadH: CGFloat { current.controlPadH }
    public static var sectionPadH: CGFloat { current.sectionPadH }
    public static var iconMicro: CGFloat { current.iconMicro }
    public static var iconSmall: CGFloat { current.iconSmall }
    public static var iconMedium: CGFloat { current.iconMedium }

    // ── Font Sizes (CGFloat, for SwiftUI .font(.system(size:))) ──
    public static var fontSizeMicro: CGFloat    { 8 }
    public static var fontSizeSmall: CGFloat    { 9 }
    public static var fontSizeBody: CGFloat     { 10 }
    public static var fontSizeHeading: CGFloat  { 11 }
    public static var fontSizeMono: CGFloat     { 12 }
    public static var fontSizeMonoLarge: CGFloat { 14 }

    // ── Layout ──────────────────────────────────────────────────────
    public static var controlBarHeight: CGFloat { current.controlBarHeight }
    public static var rulerHeight: CGFloat { current.rulerHeight }
    public static var trackHeaderWidth: CGFloat { current.trackHeaderWidth }
    public static var browserWidth: CGFloat { current.browserWidth }
    public static var browserMinWidth: CGFloat { current.browserMinWidth }
    public static var browserMaxWidth: CGFloat { current.browserMaxWidth }
    public static var statusBarHeight: CGFloat { current.statusBarHeight }
    public static var panelHeaderHeight: CGFloat { current.panelHeaderHeight }
    public static var defaultTrackHeight: CGFloat { current.defaultTrackHeight }
    public static var minTrackHeight: CGFloat { current.minTrackHeight }
    public static var maxTrackHeight: CGFloat { current.maxTrackHeight }
    public static var trackResizeStep: CGFloat { current.trackResizeStep }
    public static var transportBarHeight: CGFloat { current.transportBarHeight }
    public static var clipCornerRadius: CGFloat { current.clipCornerRadius }
    public static var clipTitleHeight: CGFloat { current.clipTitleHeight }
    public static var scrollbarSize: CGFloat { current.scrollbarSize }
    public static var playheadWidth: CGFloat { current.playheadWidth }
    public static var dividerWidth: CGFloat { current.dividerWidth }
    public static var bottomPanelMinHeight: CGFloat { current.bottomPanelMinHeight }
    public static var colorStripeWidth: CGFloat { current.colorStripeWidth }
    public static var browserRowHeight: CGFloat { current.browserRowHeight }

    // ── Zoom ────────────────────────────────────────────────────────
    public static var defaultPixelsPerBeat: CGFloat { current.defaultPixelsPerBeat }
    public static var minPixelsPerBeat: CGFloat { current.minPixelsPerBeat }
    public static var maxPixelsPerBeat: CGFloat { current.maxPixelsPerBeat }

    // ── Animation ───────────────────────────────────────────────────
    public static var springDamping: CGFloat { current.springDamping }
    public static var springStiffness: CGFloat { current.springStiffness }
    public static var fastAnimation: TimeInterval { current.fastAnimation }
    public static var standardAnimation: TimeInterval { current.standardAnimation }
    public static var premiumAnimation: TimeInterval { current.premiumAnimation }

    // ── Glass ────────────────────────────────────────────────────────
    public static var glassMaterial: NSVisualEffectView.Material { current.glassMaterial }
    public static var glassBlending: NSVisualEffectView.BlendingMode { current.glassBlending }
    public static var glassColor: NSColor { current.glassColor }
    public static var glassBorder: NSColor { current.glassBorder }
}

// MARK: - Shared Dimensions (theme-independent)

/// Dimensions and fonts that don't change between themes are provided as defaults.
public extension ThemeProtocol {

    // ── Fonts ───────────────────────────────────────────────────────
    var fontMicro: NSFont     { NSFont.systemFont(ofSize: 8, weight: .medium) }
    var fontSmall: NSFont     { NSFont.systemFont(ofSize: 9, weight: .medium) }
    var fontBody: NSFont      { NSFont.systemFont(ofSize: 10, weight: .regular) }
    var fontBodyMedium: NSFont { NSFont.systemFont(ofSize: 10, weight: .medium) }
    var fontHeading: NSFont   { NSFont.systemFont(ofSize: 11, weight: .semibold) }
    var fontMono: NSFont      { NSFont.monospacedSystemFont(ofSize: 11, weight: .medium) }
    var fontMonoSmall: NSFont { NSFont.monospacedSystemFont(ofSize: 9, weight: .medium) }
    var fontMonoBody: NSFont  { NSFont.monospacedSystemFont(ofSize: 10, weight: .regular) }
    var fontMonoLarge: NSFont { NSFont.monospacedDigitSystemFont(ofSize: 14, weight: .semibold) }

    // ── Dimensions ──────────────────────────────────────────────────
    var radiusSmall: CGFloat   { 2 }
    var radiusCard: CGFloat    { 4 }
    var controlPadH: CGFloat   { 4 }
    var sectionPadH: CGFloat   { 8 }
    var iconMicro: CGFloat     { 6 }
    var iconSmall: CGFloat     { 9 }
    var iconMedium: CGFloat    { 12 }

    // ── Layout ──────────────────────────────────────────────────────
    var controlBarHeight: CGFloat    { 32 }
    var rulerHeight: CGFloat         { 22 }
    var trackHeaderWidth: CGFloat    { 220 }
    var browserWidth: CGFloat        { 240 }
    var browserMinWidth: CGFloat     { 200 }
    var browserMaxWidth: CGFloat     { 400 }
    var statusBarHeight: CGFloat     { 20 }
    var panelHeaderHeight: CGFloat   { 24 }
    var defaultTrackHeight: CGFloat  { 64 }
    var minTrackHeight: CGFloat      { 32 }
    var maxTrackHeight: CGFloat      { 640 }
    var trackResizeStep: CGFloat     { 8 }
    var transportBarHeight: CGFloat  { 32 }
    var clipCornerRadius: CGFloat    { 2 }
    var clipTitleHeight: CGFloat     { 14 }
    var scrollbarSize: CGFloat       { 10 }
    var playheadWidth: CGFloat       { 1.0 }
    var dividerWidth: CGFloat        { 1 }
    var bottomPanelMinHeight: CGFloat { 100 }
    var colorStripeWidth: CGFloat    { 3 }
    var browserRowHeight: CGFloat    { 22 }

    // ── Zoom ────────────────────────────────────────────────────────
    var defaultPixelsPerBeat: CGFloat { 25 }
    var minPixelsPerBeat: CGFloat     { 3 }
    var maxPixelsPerBeat: CGFloat     { 200 }

    // ── Animation ───────────────────────────────────────────────────
    var springDamping: CGFloat     { 0.8 }
    var springStiffness: CGFloat   { 150 }
    var fastAnimation: TimeInterval     { 0.15 }
    var standardAnimation: TimeInterval { 0.25 }
    var premiumAnimation: TimeInterval  { 0.4 }

    // ── Glass ────────────────────────────────────────────────────────
    var glassMaterial: NSVisualEffectView.Material     { .hudWindow }
    var glassBlending: NSVisualEffectView.BlendingMode { .withinWindow }
}

// MARK: - Dark Theme

/// Default dark theme — inspired by Ableton Live with UDS-style gray gradations.
public struct DarkTheme: ThemeProtocol {

    // ── Backgrounds ─────────────────────────────────────────────────
    public var bgBase      = NSColor(white: 0.08, alpha: 1.0)   // #141414
    public var bgPrimary   = NSColor(white: 0.12, alpha: 1.0)   // #1E1E1E
    public var bgSecondary = NSColor(white: 0.15, alpha: 1.0)   // #262626
    public var bgTertiary  = NSColor(white: 0.165, alpha: 1.0)  // #2A2A2A
    public var bgSurface   = NSColor(white: 0.19, alpha: 1.0)   // #303030
    public var bgElevated  = NSColor(white: 0.21, alpha: 1.0)   // #353535
    public var bgHover     = NSColor(white: 0.23, alpha: 1.0)   // #3A3A3A
    public var bgSelected  = NSColor(red: 0.11, green: 0.21, blue: 0.34, alpha: 1.0) // #1D3557
    public var bgInput     = NSColor(white: 0.145, alpha: 1.0)  // #252525

    // ── Text ────────────────────────────────────────────────────────
    public var textPrimary   = NSColor(white: 0.88, alpha: 1.0) // #E0E0E0
    public var textSecondary = NSColor(white: 0.60, alpha: 1.0) // #999999
    public var textMuted     = NSColor(white: 0.40, alpha: 1.0) // #666666
    public var textBright    = NSColor(white: 0.96, alpha: 1.0) // #F5F5F5
    public var textOnAccent  = NSColor(white: 1.0, alpha: 1.0)  // white
    public var textOnColor   = NSColor(white: 0.05, alpha: 1.0) // near-black

    // ── Accent (blue) ───────────────────────────────────────────────
    public var accent      = NSColor(red: 0.29, green: 0.62, blue: 1.00, alpha: 1.0)  // #4A9EFF
    public var accentHover = NSColor(red: 0.36, green: 0.68, blue: 1.00, alpha: 1.0)  // #5CADFF
    public var accentMuted = NSColor(red: 0.29, green: 0.62, blue: 1.00, alpha: 0.15) // blue tint

    // ── Semantic ────────────────────────────────────────────────────
    public var success = NSColor(red: 0.40, green: 0.80, blue: 0.20, alpha: 1.0) // #66CC33
    public var warning = NSColor(red: 0.85, green: 0.65, blue: 0.15, alpha: 1.0) // #D9A625
    public var danger  = NSColor(red: 0.85, green: 0.25, blue: 0.25, alpha: 1.0) // #D94040
    public var info    = NSColor(red: 0.20, green: 0.65, blue: 0.85, alpha: 1.0) // #33A6D9 (solo blue)

    // ── UI Elements ─────────────────────────────────────────────────
    public var divider        = NSColor(white: 0.18, alpha: 1.0)
    public var dividerLight   = NSColor(white: 0.25, alpha: 1.0)
    public var gridLine       = NSColor(white: 0.25, alpha: 1.0)
    public var gridLineMajor  = NSColor(white: 0.35, alpha: 1.0)
    public var playhead       = NSColor(white: 0.85, alpha: 1.0)
    public var selectionBorder = NSColor(red: 0.35, green: 0.55, blue: 0.90, alpha: 0.85)
    public var selectionFill   = NSColor(red: 0.20, green: 0.35, blue: 0.60, alpha: 0.25)
    public var clipHighlight   = NSColor(white: 1.0, alpha: 0.08)
    public var dropTarget      = NSColor(white: 0.20, alpha: 0.5)

    // ── VU Meters ───────────────────────────────────────────────────
    public var meterBackground = NSColor(white: 0.12, alpha: 1.0)
    public var meterNormal     = NSColor(red: 0.40, green: 0.80, blue: 0.20, alpha: 1.0) // green
    public var meterHot        = NSColor(red: 1.00, green: 0.80, blue: 0.10, alpha: 1.0) // yellow
    public var meterClip       = NSColor(red: 1.00, green: 0.20, blue: 0.20, alpha: 1.0) // red
    public var meterSilent     = NSColor(white: 0.30, alpha: 1.0)

    // ── Controls ────────────────────────────────────────────────────
    public var controlBg       = NSColor(white: 0.25, alpha: 1.0)
    public var controlBgActive = NSColor(white: 0.35, alpha: 1.0)
    public var controlBorder   = NSColor(white: 0.22, alpha: 1.0)
    public var controlTint     = NSColor(white: 0.60, alpha: 1.0)

    // ── Effect Types ────────────────────────────────────────────────
    public var effectEQ         = NSColor(red: 0.35, green: 0.55, blue: 0.85, alpha: 1.0)
    public var effectCompressor = NSColor(red: 0.70, green: 0.40, blue: 0.25, alpha: 1.0)
    public var effectDelay      = NSColor(red: 0.40, green: 0.65, blue: 0.45, alpha: 1.0)
    public var effectReverb     = NSColor(red: 0.55, green: 0.40, blue: 0.75, alpha: 1.0)
    public var effectChorus     = NSColor(red: 0.65, green: 0.50, blue: 0.30, alpha: 1.0)
    public var effectUtility    = NSColor(white: 0.50, alpha: 1.0)
    public var effectVST        = NSColor(red: 0.20, green: 0.60, blue: 0.40, alpha: 1.0)

    // ── Browser ─────────────────────────────────────────────────────
    public var browserDefault = NSColor(red: 0.55, green: 0.50, blue: 0.40, alpha: 1.0)
    public var browserAudio   = NSColor(red: 0.95, green: 0.75, blue: 0.25, alpha: 1.0)
    public var browserMIDI    = NSColor(red: 0.35, green: 0.70, blue: 0.90, alpha: 1.0)
    public var browserPlugin  = NSColor(red: 0.65, green: 0.50, blue: 0.90, alpha: 1.0)
    public var browserPreset  = NSColor(red: 0.20, green: 0.85, blue: 0.55, alpha: 1.0)

    // ── Knob / Fader ────────────────────────────────────────────────
    public var knobArcInactive = NSColor(white: 0.25, alpha: 1.0)
    public var knobFill        = NSColor(white: 0.18, alpha: 1.0)
    public var knobValueText   = NSColor(white: 0.70, alpha: 1.0)
    public var faderTrackBg    = NSColor(white: 0.15, alpha: 1.0)
    public var faderGroove     = NSColor(white: 0.12, alpha: 1.0)

    // ── Piano Roll ──────────────────────────────────────────────────
    public var pianoWhiteKey = NSColor(white: 0.28, alpha: 1.0)
    public var pianoBlackKey = NSColor(white: 0.18, alpha: 1.0)
    public var pianoGridLine = NSColor(white: 0.15, alpha: 1.0)
    public var pianoCLine    = NSColor(white: 0.25, alpha: 1.0)
    public var pianoBarLine  = NSColor(white: 0.30, alpha: 1.0)
    public var pianoBeatLine = NSColor(white: 0.20, alpha: 1.0)
    public var pianoSubLine  = NSColor(white: 0.14, alpha: 0.5)

    // ── Glass ───────────────────────────────────────────────────────
    public var glassColor  = NSColor(white: 1.0, alpha: 0.05)
    public var glassBorder = NSColor(white: 1.0, alpha: 0.12)

    public init() {}
}

// MARK: - Light Theme

/// Light theme — inverted gray scale with the same accent and track colors.
public struct LightTheme: ThemeProtocol {

    // ── Backgrounds ─────────────────────────────────────────────────
    public var bgBase      = NSColor(white: 1.00, alpha: 1.0)   // #FFFFFF
    public var bgPrimary   = NSColor(white: 0.96, alpha: 1.0)   // #F5F5F5
    public var bgSecondary = NSColor(white: 0.92, alpha: 1.0)   // #EBEBEB
    public var bgTertiary  = NSColor(white: 0.89, alpha: 1.0)   // #E3E3E3
    public var bgSurface   = NSColor(white: 0.94, alpha: 1.0)   // #F0F0F0
    public var bgElevated  = NSColor(white: 1.00, alpha: 1.0)   // #FFFFFF
    public var bgHover     = NSColor(white: 0.90, alpha: 1.0)   // #E5E5E5
    public var bgSelected  = NSColor(red: 0.85, green: 0.92, blue: 1.00, alpha: 1.0) // light blue
    public var bgInput     = NSColor(white: 1.00, alpha: 1.0)   // #FFFFFF

    // ── Text ────────────────────────────────────────────────────────
    public var textPrimary   = NSColor(white: 0.10, alpha: 1.0) // #1A1A1A
    public var textSecondary = NSColor(white: 0.40, alpha: 1.0) // #666666
    public var textMuted     = NSColor(white: 0.60, alpha: 1.0) // #999999
    public var textBright    = NSColor(white: 0.00, alpha: 1.0) // #000000
    public var textOnAccent  = NSColor(white: 1.0, alpha: 1.0)  // white
    public var textOnColor   = NSColor(white: 0.05, alpha: 1.0) // near-black

    // ── Accent (blue — slightly deeper for light bg) ────────────────
    public var accent      = NSColor(red: 0.00, green: 0.48, blue: 1.00, alpha: 1.0) // #007AFF
    public var accentHover = NSColor(red: 0.00, green: 0.40, blue: 0.88, alpha: 1.0) // #0066E0
    public var accentMuted = NSColor(red: 0.00, green: 0.48, blue: 1.00, alpha: 0.10)

    // ── Semantic ────────────────────────────────────────────────────
    public var success = NSColor(red: 0.20, green: 0.70, blue: 0.15, alpha: 1.0) // darker green
    public var warning = NSColor(red: 0.80, green: 0.60, blue: 0.00, alpha: 1.0) // darker amber
    public var danger  = NSColor(red: 0.80, green: 0.15, blue: 0.15, alpha: 1.0) // darker red
    public var info    = NSColor(red: 0.10, green: 0.50, blue: 0.80, alpha: 1.0) // darker solo blue

    // ── UI Elements ─────────────────────────────────────────────────
    public var divider        = NSColor(white: 0.82, alpha: 1.0)
    public var dividerLight   = NSColor(white: 0.88, alpha: 1.0)
    public var gridLine       = NSColor(white: 0.85, alpha: 1.0)
    public var gridLineMajor  = NSColor(white: 0.75, alpha: 1.0)
    public var playhead       = NSColor(white: 0.20, alpha: 1.0)
    public var selectionBorder = NSColor(red: 0.20, green: 0.45, blue: 0.85, alpha: 0.85)
    public var selectionFill   = NSColor(red: 0.20, green: 0.45, blue: 0.85, alpha: 0.12)
    public var clipHighlight   = NSColor(white: 0.0, alpha: 0.05)
    public var dropTarget      = NSColor(white: 0.80, alpha: 0.5)

    // ── VU Meters ───────────────────────────────────────────────────
    public var meterBackground = NSColor(white: 0.88, alpha: 1.0)
    public var meterNormal     = NSColor(red: 0.20, green: 0.70, blue: 0.15, alpha: 1.0)
    public var meterHot        = NSColor(red: 0.95, green: 0.70, blue: 0.05, alpha: 1.0)
    public var meterClip       = NSColor(red: 0.90, green: 0.15, blue: 0.15, alpha: 1.0)
    public var meterSilent     = NSColor(white: 0.75, alpha: 1.0)

    // ── Controls ────────────────────────────────────────────────────
    public var controlBg       = NSColor(white: 0.85, alpha: 1.0)
    public var controlBgActive = NSColor(white: 0.78, alpha: 1.0)
    public var controlBorder   = NSColor(white: 0.80, alpha: 1.0)
    public var controlTint     = NSColor(white: 0.45, alpha: 1.0)

    // ── Effect Types (same hues, slightly adjusted for light bg) ────
    public var effectEQ         = NSColor(red: 0.30, green: 0.50, blue: 0.80, alpha: 1.0)
    public var effectCompressor = NSColor(red: 0.65, green: 0.35, blue: 0.20, alpha: 1.0)
    public var effectDelay      = NSColor(red: 0.35, green: 0.60, blue: 0.40, alpha: 1.0)
    public var effectReverb     = NSColor(red: 0.50, green: 0.35, blue: 0.70, alpha: 1.0)
    public var effectChorus     = NSColor(red: 0.60, green: 0.45, blue: 0.25, alpha: 1.0)
    public var effectUtility    = NSColor(white: 0.50, alpha: 1.0)
    public var effectVST        = NSColor(red: 0.15, green: 0.55, blue: 0.35, alpha: 1.0)

    // ── Browser ─────────────────────────────────────────────────────
    public var browserDefault = NSColor(red: 0.50, green: 0.45, blue: 0.35, alpha: 1.0)
    public var browserAudio   = NSColor(red: 0.85, green: 0.65, blue: 0.10, alpha: 1.0)
    public var browserMIDI    = NSColor(red: 0.25, green: 0.60, blue: 0.80, alpha: 1.0)
    public var browserPlugin  = NSColor(red: 0.55, green: 0.40, blue: 0.80, alpha: 1.0)
    public var browserPreset  = NSColor(red: 0.15, green: 0.70, blue: 0.45, alpha: 1.0)

    // ── Knob / Fader ────────────────────────────────────────────────
    public var knobArcInactive = NSColor(white: 0.78, alpha: 1.0)
    public var knobFill        = NSColor(white: 0.92, alpha: 1.0)
    public var knobValueText   = NSColor(white: 0.30, alpha: 1.0)
    public var faderTrackBg    = NSColor(white: 0.88, alpha: 1.0)
    public var faderGroove     = NSColor(white: 0.90, alpha: 1.0)

    // ── Piano Roll ──────────────────────────────────────────────────
    public var pianoWhiteKey = NSColor(white: 0.95, alpha: 1.0)
    public var pianoBlackKey = NSColor(white: 0.82, alpha: 1.0)
    public var pianoGridLine = NSColor(white: 0.85, alpha: 1.0)
    public var pianoCLine    = NSColor(white: 0.78, alpha: 1.0)
    public var pianoBarLine  = NSColor(white: 0.72, alpha: 1.0)
    public var pianoBeatLine = NSColor(white: 0.82, alpha: 1.0)
    public var pianoSubLine  = NSColor(white: 0.88, alpha: 0.5)

    // ── Glass ───────────────────────────────────────────────────────
    public var glassColor  = NSColor(white: 0.0, alpha: 0.03)
    public var glassBorder = NSColor(white: 0.0, alpha: 0.08)

    public init() {}
}

// MARK: - NSBezierPath CGPath Extension

extension NSBezierPath {
    /// Compatibility property for macOS < 14.0
    public var asCGPath: CGPath {
        let path = CGMutablePath()
        var points = [CGPoint](repeating: .zero, count: 3)
        for i in 0..<self.elementCount {
            let type = self.element(at: i, associatedPoints: &points)
            switch type {
            case .moveTo:
                path.move(to: points[0])
            case .lineTo:
                path.addLine(to: points[0])
            case .curveTo:
                path.addCurve(to: points[2], control1: points[0], control2: points[1])
            case .closePath:
                path.closeSubpath()
            @unknown default:
                break
            }
        }
        return path
    }
}
