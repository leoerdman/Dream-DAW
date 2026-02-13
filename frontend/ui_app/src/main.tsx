import { StrictMode, useState, Component } from 'react'
import type { ReactNode, ErrorInfo } from 'react'
import { createRoot } from 'react-dom/client'
import './global.css'
import { Workspace } from '@/pages/Workspace'
import { SplashScreen } from '@/widgets/SplashScreen'

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
          background: '#1a0000', color: '#ff6b6b', padding: 40,
          fontFamily: 'monospace', fontSize: 14, overflow: 'auto',
          width: '100vw', height: '100vh',
        }}>
          <h1 style={{ color: '#ff4444', fontSize: 24, marginBottom: 16 }}>
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

  return (
    <>
      {!splashDone && <SplashScreen onComplete={() => setSplashDone(true)} />}
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
