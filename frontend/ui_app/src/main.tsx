/* eslint-disable react-refresh/only-export-components */
import { StrictMode, useState, useEffect, Component } from 'react'
import type { ReactNode, ErrorInfo } from 'react'
import { createRoot } from 'react-dom/client'
import './global.css'
import { Workspace } from '@/pages/Workspace'
import { SplashScreen } from '@/widgets/SplashScreen'
import * as engineApi from '@/shared/api/engine'
import { useAutoSave } from '@/shared/hooks/useAutoSave'
import { useSettingsStore } from '@/shared/stores/useSettingsStore'

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
          fontFamily: 'monospace', fontSize: 14, overflow: 'auto',
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
          {/* BUG-039 FIX: Recovery button */}
          <button
            onClick={() => window.location.reload()}
            style={{
              marginTop: 24, padding: '10px 24px', fontSize: 14, fontWeight: 600,
              background: '#ff4444', color: '#fff', border: 'none', borderRadius: 6,
              cursor: 'pointer', fontFamily: 'sans-serif',
            }}
          >
            🔄 Reload Application
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

function App() {
  const [splashDone, setSplashDone] = useState(false)
  const theme = useSettingsStore((s) => s.settings.theme)
  const darkThemeShade = useSettingsStore((s) => s.settings.darkThemeShade)
  const darkThemeTintPercent = useSettingsStore((s) => s.settings.darkThemeTintPercent)
  const settingsLoaded = useSettingsStore((s) => s.loaded)

  useEffect(() => {
    if (!settingsLoaded) return
    const root = document.documentElement
    const normalizedTheme = theme === 'light' || theme === 'forest' ? theme : 'dark'
    root.setAttribute('data-theme', normalizedTheme)
    const clampedShade = Number.isFinite(darkThemeShade) ? Math.min(255, Math.max(0, Math.round(darkThemeShade))) : 0
    const clampedPercent = Number.isFinite(darkThemeTintPercent) ? Math.min(100, Math.max(0, Math.round(darkThemeTintPercent))) : 0
    const appliedPercent = normalizedTheme === 'dark' && clampedShade > 0 ? clampedPercent : 0
    root.style.setProperty('--theme-dark-tint-rgb', `${clampedShade} ${clampedShade} ${clampedShade}`)
    root.style.setProperty('--theme-dark-tint-strength', `${appliedPercent}%`)
  }, [theme, darkThemeShade, darkThemeTintPercent, settingsLoaded])

  useEffect(() => {
    // BUG-005 FIX: Retry expandWindow with exponential backoff (max 3 attempts)
    const retryExpandWindow = async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await engineApi.expandWindow()
          return // success
        } catch (err) {
          const delay = (attempt + 1) * 500 // 500ms, 1000ms, 1500ms
          console.warn(`[App] expandWindow attempt ${attempt + 1} failed, retrying in ${delay}ms:`, err)
          await new Promise(resolve => setTimeout(resolve, delay))
        }
      }
      console.error('[App] expandWindow failed after 3 attempts')
    }
    retryExpandWindow()
  }, [])

  // ── Strike 6: Auto-Save (3 min timer, dirty-check) ──
  // Only active after splash; pauses when tab is hidden.
  useAutoSave(splashDone ? 3 * 60 * 1000 : Infinity)

  const handleSplashComplete = () => {
    setSplashDone(true)
    setTimeout(() => {
      engineApi.maximizeWindow().catch((err) => {
        console.warn('[App] maximizeWindow failed:', err)
      })
    }, 400)
  }

  return (
    <>
      {/* Show splash in expanded window */}
      {!splashDone && <SplashScreen onComplete={handleSplashComplete} />}

      {/* Workspace mounts ONLY after splash is done, window is already maximized */}
      {splashDone && (
        <ErrorBoundary>
          <Workspace />
        </ErrorBoundary>
      )}
    </>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
