/* ═══════════════════════════════════════════════════════════════
   Dream DAW — Splash Screen (Premium Loading Overlay)

   Single-window approach:
   - App starts as 500×500 borderless window
   - This React overlay shows logo + version + status animation
   - On completion, calls onComplete (which mounts Workspace)
   - THEN expand_window runs — maximized window shows the DAW, not the splash
   ═════════════════════════════════════════════════════════════ */

import { useState, useEffect, useCallback } from 'react'
import { useEngineStore } from '@/shared/stores/useEngineStore'
import { useSettingsStore } from '@/shared/stores/useSettingsStore'
import * as engineApi from '@/shared/api/engine'
import './SplashScreen.css'

interface SplashScreenProps {
    /** Minimum display duration in ms (prevents flash on fast loads) */
    minDuration?: number
    /** Called when the splash screen has fully faded out */
    onComplete?: () => void
}

export function SplashScreen({ minDuration = 2600, onComplete }: SplashScreenProps) {
    const [status, setStatus] = useState('Initializing Audio Engine...')
    const [phase, setPhase] = useState<'visible' | 'fading' | 'done'>('visible')

    const startTelemetryLoop = useEngineStore((s) => s.startTelemetryLoop)

    const dismiss = useCallback(async () => {
        // 1. Load user settings from disk BEFORE expanding to workspace
        try {
            await useSettingsStore.getState().loadSettings()
        } catch (e) {
            console.warn('[Splash] Failed to load settings:', e)
        }

        // 2. Start telemetry loop — the DAW comes alive
        startTelemetryLoop()

        // 3. Await initial project fetch — ensures tracks/clips are in the store
        //    before the Workspace component mounts
        const fetchProject = useEngineStore.getState().fetchProject
        try {
            await fetchProject()
        } catch (e) {
            console.warn('[Splash] fetchProject failed:', e)
        }

        // 4. Fade out the splash overlay
        setPhase('fading')

        // 5. After fade completes:
        //    - FIRST expand the native window
        //    - THEN mount Workspace
        // This avoids rendering DAW layout at splash size (top-left squish).
        setTimeout(async () => {
            try {
                await engineApi.expandWindow()
            } catch (e) {
                console.warn('[Splash] expand_window unavailable (browser dev?):', e)
            }

            // Give layout observers one frame in expanded geometry, then mount DAW.
            await new Promise(r => setTimeout(r, 120))
            onComplete?.()
            setPhase('done')
        }, 400) // fade animation is 400ms
    }, [onComplete, startTelemetryLoop])

    useEffect(() => {
        const steps = [
            { text: 'Loading Core Modules...', delay: 500 },
            { text: 'Initializing DSP Pipeline...', delay: 1100 },
            { text: 'Scanning Audio Devices...', delay: 1700 },
            { text: 'Preparing Workspace...', delay: 2100 },
            { text: 'Ready', delay: 2400 },
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
            </div>
        </div>
    )
}
