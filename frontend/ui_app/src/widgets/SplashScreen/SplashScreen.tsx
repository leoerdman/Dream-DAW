/* ═══════════════════════════════════════════════════════════════
   Dream DAW — Splash Screen (Premium Loading Overlay)

   Single-window approach:
   - App starts as 450×450 borderless window
   - This React overlay shows logo + version + status animation
   - On completion, calls Tauri `expand_window` to resize to full DAW
   - Overlay fades out revealing the Workspace
   ═════════════════════════════════════════════════════════════ */

import { useState, useEffect, useCallback } from 'react'
import { useEngineStore } from '@/shared/stores/useEngineStore'
import * as engineApi from '@/shared/api/engine'
import './SplashScreen.css'

interface SplashScreenProps {
    /** Minimum display duration in ms (prevents flash on fast loads) */
    minDuration?: number
    /** Called when the splash screen has fully faded out */
    onComplete?: () => void
}

export function SplashScreen({ minDuration = 2400, onComplete }: SplashScreenProps) {
    const [status, setStatus] = useState('Initializing Audio Engine...')
    const [phase, setPhase] = useState<'visible' | 'fading' | 'done'>('visible')

    const startTelemetryLoop = useEngineStore((s) => s.startTelemetryLoop)

    const dismiss = useCallback(async () => {
        // Expand the window to full DAW size
        try {
            await engineApi.expandWindow()
        } catch (e) {
            console.warn('[Splash] expand_window unavailable (browser dev?):', e)
        }

        // Start the 60fps telemetry loop — the DAW comes alive
        startTelemetryLoop()

        // Then fade out the overlay
        setPhase('fading')
        setTimeout(() => {
            setPhase('done')
            onComplete?.()
        }, 600)
    }, [onComplete, startTelemetryLoop])

    useEffect(() => {
        const steps = [
            { text: 'Loading Core Modules...', delay: 600 },
            { text: 'Initializing DSP Pipeline...', delay: 1200 },
            { text: 'Preparing Workspace...', delay: 1800 },
            { text: 'Ready', delay: 2200 },
        ]

        const timers = steps.map(({ text, delay }) =>
            setTimeout(() => setStatus(text), delay)
        )

        // Dismiss after minimum duration
        const dismissTimer = setTimeout(dismiss, minDuration)

        return () => {
            timers.forEach(clearTimeout)
            clearTimeout(dismissTimer)
        }
    }, [minDuration, dismiss])

    if (phase === 'done') return null

    return (
        <div
            className={`splash-overlay ${phase === 'fading' ? 'splash-fade-out' : ''}`}
            role="status"
            aria-label="Loading Dream DAW"
        >
            <div className="splash-card">
                {/* Gradient Background */}
                <div className="splash-gradient" />

                {/* Logo Container */}
                <div className="splash-logo-container">
                    <div className="splash-logo-glow" />
                    <img
                        src="/appicon.png"
                        alt="Dream DAW"
                        className="splash-logo"
                        width={180}
                        height={180}
                        draggable={false}
                    />
                </div>

                {/* Title */}
                <h1 className="splash-title">DREAM DAW</h1>

                {/* Version (auto-injected by Vite plugin) */}
                <span className="splash-version">v{__APP_VERSION__}</span>

                {/* Status */}
                <div className="splash-status-container">
                    <div className="splash-spinner" />
                    <span className="splash-status">{status}</span>
                </div>

                {/* Subtle border */}
                <div className="splash-border" />
            </div>
        </div>
    )
}
