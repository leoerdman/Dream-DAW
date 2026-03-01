/* eslint-disable react-refresh/only-export-components */
import { StrictMode, useState, useEffect, useCallback, Component } from 'react'
import type { ReactNode, ErrorInfo } from 'react'
import { createRoot } from 'react-dom/client'
import './global.css'
import { Workspace } from '@/pages/Workspace'
import { SplashScreen } from '@/widgets/SplashScreen'
import * as engineApi from '@/shared/api/engine'
import { useAutoSave } from '@/shared/hooks/useAutoSave'
import { useSettingsStore } from '@/shared/stores/useSettingsStore'
import { useEngineStore } from '@/shared/stores/useEngineStore'
import { applyUiDisplayPrefs } from '@/shared/lib/uiDisplayPrefs'

const img = new Image()
img.src = '/appicon.png'

// ── Error Boundary: catch runtime crashes and show them visually ──
class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary] Component crash:', error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          background: 'var(--token-color-hex-1a0000)', color: 'var(--token-color-hex-ff6b6b)', padding: 40,
          fontFamily: 'var(--font-role-data)', fontSize: 14, overflow: 'auto',
          width: '100vw', height: '100vh',
        }}>
          <h1 style={{ color: 'var(--token-color-hex-ff4444)', fontSize: 24, marginBottom: 16 }}>
            ⚠️ Dream DAW — Component Crash
          </h1>
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {this.state.error.message}
          </pre>
          <pre style={{ marginTop: 16, opacity: 0.6, fontSize: 12 }}>
            {this.state.error.stack}
          </pre>
          {/* ENTERPRISE FIX (BUG-R06): Attempt auto-save before reload to prevent data loss */}
          <button
            onClick={async () => {
              try {
                const engineApi = await import('@/shared/api/engine');
                const status = await engineApi.getProjectStatus();
                // BUG-E004 FIX: Only auto-save if the project has been saved before and has a file path.
                if (status.filePath) {
                  await engineApi.saveProject();
                }
              } catch (saveErr) { console.warn('[Dream] Best-effort save before reload failed:', saveErr); }
              window.location.reload();
            }}
            style={{
              marginTop: 24, padding: '10px 24px', fontSize: 14, fontWeight: 600,
              background: 'var(--color-error)', color: 'var(--color-text-on-accent)', border: 'none', borderRadius: 6,
              cursor: 'pointer', fontFamily: 'var(--font-role-body)',
            }}
          >
            💾 Save & Reload Application
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

function App() {
  const [splashDone, setSplashDone] = useState(false)
  const [workspaceMounted, setWorkspaceMounted] = useState(false)
  const [fatalError, setFatalError] = useState<string | null>(null)
  const theme = useSettingsStore((s) => s.settings.theme)
  const darkThemeShade = useSettingsStore((s) => s.settings.darkThemeShade)
  const darkThemeTintPercent = useSettingsStore((s) => s.settings.darkThemeTintPercent)
  const forestThemeCanopyPercent = useSettingsStore((s) => s.settings.forestThemeCanopyPercent)
  const forestThemeFogPercent = useSettingsStore((s) => s.settings.forestThemeFogPercent)
  const lightThemeTexturePercent = useSettingsStore((s) => s.settings.lightThemeTexturePercent)
  const themeDetailPercent = useSettingsStore((s) => s.settings.themeDetailPercent)
  const themePanelsDetailPercent = useSettingsStore((s) => s.settings.themePanelsDetailPercent)
  const themeTimelineDetailPercent = useSettingsStore((s) => s.settings.themeTimelineDetailPercent)
  const themeMotionEnabled = useSettingsStore((s) => s.settings.themeMotionEnabled)
  const themeMotionPercent = useSettingsStore((s) => s.settings.themeMotionPercent)
  const themeOverlayEnabled = useSettingsStore((s) => s.settings.themeOverlayEnabled)
  const themePanelsOrnamentsEnabled = useSettingsStore((s) => s.settings.themePanelsOrnamentsEnabled)
  const themeTimelineOrnamentsEnabled = useSettingsStore((s) => s.settings.themeTimelineOrnamentsEnabled)
  const settingsLoaded = useSettingsStore((s) => s.loaded)

  useEffect(() => {
    applyUiDisplayPrefs()
  }, [])

  useEffect(() => {
    const toMessage = (raw: unknown): string => {
      if (raw instanceof Error && raw.message) return raw.message
      if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim()
      try {
        return JSON.stringify(raw)
      } catch (jsonErr) {
        console.warn('[Dream] JSON.stringify failed for error object:', jsonErr);
        return String(raw)
      }
    }
    const reportFatal = (source: string, reason: unknown) => {
      const message = `${source}: ${toMessage(reason)}`
      setFatalError((prev) => prev ?? message)
      try {
        if ('__TAURI_INTERNALS__' in window) {
          engineApi.logFrontendError('AppRuntime', message).catch(() => { })
        }
      } catch (reportErr) {
        console.warn('[Dream] Tauri reporting failed:', reportErr);
      }
      console.error('[AppRuntime]', message)
    }
    const onWindowError = (event: ErrorEvent) => {
      reportFatal('window.error', event.error ?? event.message)
    }
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      reportFatal('unhandledrejection', event.reason)
    }
    window.addEventListener('error', onWindowError)
    window.addEventListener('unhandledrejection', onUnhandledRejection)
    return () => {
      window.removeEventListener('error', onWindowError)
      window.removeEventListener('unhandledrejection', onUnhandledRejection)
    }
  }, [])

  useEffect(() => {
    if (!settingsLoaded) return
    const root = document.documentElement
    const normalizedTheme = theme === 'light' || theme === 'forest' ? theme : 'dark'
    root.setAttribute('data-theme', normalizedTheme)
    const clampedShade = Number.isFinite(darkThemeShade) ? Math.min(255, Math.max(0, Math.round(darkThemeShade))) : 0
    const clampedPercent = Number.isFinite(darkThemeTintPercent) ? Math.min(100, Math.max(0, Math.round(darkThemeTintPercent))) : 0
    // Dark tint model:
    // shade: 0..255 mapped to grayscale tone (0=black, 255=white),
    // intensity: 0..100 controls how much that tone is mixed into dark tokens.
    const appliedPercent = normalizedTheme === 'dark' ? clampedPercent : 0
    const canopyStrength = Number.isFinite(forestThemeCanopyPercent) ? Math.min(100, Math.max(0, Math.round(forestThemeCanopyPercent))) : 100
    const fogStrength = Number.isFinite(forestThemeFogPercent) ? Math.min(100, Math.max(0, Math.round(forestThemeFogPercent))) : 100
    const lightTextureStrength = Number.isFinite(lightThemeTexturePercent) ? Math.min(100, Math.max(0, Math.round(lightThemeTexturePercent))) : 72
    const detailStrength = Number.isFinite(themeDetailPercent) ? Math.min(100, Math.max(0, Math.round(themeDetailPercent))) : 100
    const panelsDetailRaw = Number.isFinite(themePanelsDetailPercent) ? Math.min(100, Math.max(0, Math.round(themePanelsDetailPercent))) : 100
    const timelineDetailRaw = Number.isFinite(themeTimelineDetailPercent) ? Math.min(100, Math.max(0, Math.round(themeTimelineDetailPercent))) : 100
    const panelsDetailStrength = themePanelsOrnamentsEnabled ? panelsDetailRaw : 0
    const timelineDetailStrength = themeTimelineOrnamentsEnabled ? timelineDetailRaw : 0
    const overlayStrength = themeOverlayEnabled ? 1 : 0
    const motionStrength = Number.isFinite(themeMotionPercent) ? Math.min(100, Math.max(0, Math.round(themeMotionPercent))) : 100
    root.style.setProperty('--theme-dark-tint-rgb', `${clampedShade} ${clampedShade} ${clampedShade}`)
    root.style.setProperty('--theme-dark-tint-strength', `${appliedPercent}%`)
    root.style.setProperty('--theme-forest-canopy-strength', `${canopyStrength / 100}`)
    root.style.setProperty('--theme-forest-fog-strength', `${fogStrength / 100}`)
    root.style.setProperty('--theme-light-texture-strength', `${lightTextureStrength / 100}`)
    root.style.setProperty('--theme-ornament-master-strength', `${detailStrength / 100}`)
    root.style.setProperty('--theme-ornament-panels-strength', `${panelsDetailStrength / 100}`)
    root.style.setProperty('--theme-ornament-timeline-strength', `${timelineDetailStrength / 100}`)
    root.style.setProperty('--theme-overlay-strength', `${overlayStrength}`)
    root.style.setProperty('--theme-motion-strength', `${motionStrength / 100}`)
    root.style.setProperty('--theme-motion-play-state', themeMotionEnabled ? 'running' : 'paused')
  }, [
    theme,
    darkThemeShade,
    darkThemeTintPercent,
    forestThemeCanopyPercent,
    forestThemeFogPercent,
    lightThemeTexturePercent,
    themeDetailPercent,
    themePanelsDetailPercent,
    themeTimelineDetailPercent,
    themeMotionEnabled,
    themeMotionPercent,
    themeOverlayEnabled,
    themePanelsOrnamentsEnabled,
    themeTimelineOrnamentsEnabled,
    settingsLoaded,
  ])

  // BUG-005 FIX: Retry closeSplashscreen with exponential backoff (max 3 attempts)
  // BUG-029 FIX: Set error state on final failure so user gets visual feedback.
  const [windowError, setWindowError] = useState(false)

  const attemptCloseSplashscreen = useCallback(async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await engineApi.closeSplashscreen()
        return // success
      } catch (err) {
        const delay = (attempt + 1) * 500 // 500ms, 1000ms, 1500ms
        console.warn(`[App] closeSplashscreen attempt ${attempt + 1} failed, retrying in ${delay}ms:`, err)
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
    console.error('[App] closeSplashscreen failed after 3 attempts')
    setWindowError(true)
  }, [])

  useEffect(() => {
    // BUG-028 FIX: Check connection state before dismissing splash.
    // Previously, timeout always dismissed splash even if backend never connected.
    if (splashDone) return
    const timeoutId = window.setTimeout(() => {
      setSplashDone(true)
      // If we haven't connected by splash timeout, something is wrong.
      // The workspace will load but may show connection-related errors.
    }, 8000)
    return () => window.clearTimeout(timeoutId)
  }, [splashDone])

  // ── Strike 6: Auto-Save (3 min timer, dirty-check) ──
  // Only active after splash; pauses when tab is hidden.
  useAutoSave(splashDone ? 3 * 60 * 1000 : Infinity)

  const handleSplashComplete = () => {
    // Only signals that headless init is done.
    // We do NOT close the window yet; we wait for React to mount <Workspace />
    setSplashDone(true)
  }

  const engineConnected = useEngineStore((s) => s.connected)

  useEffect(() => {
    if (workspaceMounted && engineConnected) {
      // Instantly try to close splash and reveal window the moment the 
      // Main DAW interface has been fully mounted and painted to the DOM AND
      // the initial backend sync has populated the store (avoids "grey flash no tracks").
      // Uses setTimeout to break the synchronous React batch and prevent cascading renders.
      setTimeout(() => {
        attemptCloseSplashscreen().catch(console.error);
      }, 0);
    }
  }, [workspaceMounted, engineConnected, attemptCloseSplashscreen])

  // CRITICAL FIX: Fallback to force-close splash if engineConnected never arrives.
  // This handles the case where Tauri event listeners fail to register
  // (e.g., IPC race during dev mode startup), which leaves `connected` as false
  // and the native splash window stuck showing "Ready" forever.
  useEffect(() => {
    if (!workspaceMounted) return
    if (engineConnected) return // Already handled by the effect above
    const fallbackTimer = window.setTimeout(() => {
      console.warn('[App] Forced splash close: engine did not connect within 4s after workspace mount')
      attemptCloseSplashscreen().catch(console.error)
    }, 4000)
    return () => window.clearTimeout(fallbackTimer)
  }, [workspaceMounted, engineConnected, attemptCloseSplashscreen])

  return (
    <>
      {/* BUG-029: Show visual warning if window expansion failed */}
      {windowError && (
        <div style={{
          position: 'fixed', top: 8, right: 8, zIndex: 'var(--z-fatal-error, 100000)', padding: '6px 12px',
          background: 'color-mix(in srgb, var(--color-status-warning) 90%, transparent)', color: 'var(--color-text-on-accent)', borderRadius: 6, fontSize: 12,
          fontFamily: 'var(--font-role-data)'
        }}>
          Window resize failed — some UI elements may be clipped
        </div>
      )}
      {fatalError && (
        <div style={{
          position: 'fixed',
          inset: 0,
          // BUG-030 FIX: Lowered z-index so ErrorBoundary recovery button
          // is accessible. Previously 999999 blocked everything.
          zIndex: 'var(--z-toast, 99999)',
          background: 'var(--token-color-hex-1a0000)',
          color: 'var(--token-color-hex-ff6b6b)',
          padding: 40,
          fontFamily: 'var(--font-role-data)',
          fontSize: 14,
          overflow: 'auto',
        }}>
          <h1 style={{ color: 'var(--token-color-hex-ff4444)', fontSize: 24, marginBottom: 16 }}>
            Dream DAW Runtime Crash
          </h1>
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{fatalError}</pre>
          <button
            onClick={async () => {
              try {
                const engineApi = await import('@/shared/api/engine');
                await engineApi.saveProject();
              } catch (saveErr) { console.warn('[Dream] Best-effort save before reload failed:', saveErr); }
              window.location.reload();
            }}
            style={{
              marginTop: 24, padding: '10px 24px', fontSize: 14, fontWeight: 600,
              background: 'var(--color-error)', color: 'var(--color-text-on-accent)', border: 'none', borderRadius: 6,
              cursor: 'pointer', fontFamily: 'var(--font-role-body)',
            }}
          >
            💾 Save & Reload
          </button>
        </div>
      )}

      <ErrorBoundary>
        {/* Show splash in expanded window */}
        {!splashDone && <SplashScreen onComplete={handleSplashComplete} />}

        {/* Workspace mounts ONLY after splash is done, window is already maximized */}
        {splashDone && <Workspace onMounted={() => setWorkspaceMounted(true)} />}
      </ErrorBoundary>
    </>
  )
}

// ENTERPRISE FIX (BUG-R08): Explicit null check with meaningful error
// instead of non-null assertion that produces cryptic runtime error.
const rootEl = document.getElementById('root');
if (!rootEl) {
  const fatalEl = document.createElement('pre');
  fatalEl.textContent = 'Fatal: Missing #root element in index.html';
  fatalEl.style.cssText = 'color:#ff6b6b;padding:40px';
  document.body.appendChild(fatalEl);
  throw new Error('Fatal: Missing #root element in index.html');
}
createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
