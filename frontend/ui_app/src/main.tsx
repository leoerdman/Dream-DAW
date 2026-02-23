/* eslint-disable react-refresh/only-export-components */
import { StrictMode, useState, useEffect, Component } from 'react'
import type { ReactNode, ErrorInfo } from 'react'
import { createRoot } from 'react-dom/client'
import './global.css'
import { Workspace } from '@/pages/Workspace'
import { SplashScreen } from '@/widgets/SplashScreen'
import * as engineApi from '@/shared/api/engine'
import { useAutoSave } from '@/shared/hooks/useAutoSave'

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
        </div>
      )
    }
    return this.props.children
  }
}

function App() {
  const [splashDone, setSplashDone] = useState(false)

  useEffect(() => {
    engineApi.expandWindow().catch((err) => {
      console.warn('[App] expandWindow failed, continuing:', err)
    })
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
