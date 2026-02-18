/* ═══════════════════════════════════════════════════════════════
   Dream DAW — Splash Screen (Premium Loading Overlay)

   Single-window approach:
   - App starts as 500×500 borderless window
   - This React overlay shows logo + version + status animation
   - On completion, calls onComplete (which mounts Workspace)
   - THEN expand_window runs — maximized window shows the DAW, not the splash
   ═════════════════════════════════════════════════════════════ */

import { useState, useEffect, useCallback, useRef } from 'react'
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
    const [progress, setProgress] = useState(0)
    // BUG-5 fix: stale flag to cancel in-flight async work on unmount
    const cancelledRef = useRef(false)

    const startTelemetryLoop = useEngineStore((s) => s.startTelemetryLoop)

    const dismiss = useCallback(async () => {
        console.log('[Splash] dismiss() START')
        // 1. Load user settings from disk BEFORE expanding to workspace
        try {
            console.log('[Splash] step 1: loadSettings...')
            await useSettingsStore.getState().loadSettings()
            console.log('[Splash] step 1: loadSettings DONE')
        } catch (e) {
            console.warn('[Splash] Failed to load settings:', e)
        }
        if (cancelledRef.current) { console.log('[Splash] cancelled after loadSettings'); return }

        const settings = useSettingsStore.getState().settings
        const shouldOpenLastProject = settings.startupBehavior === 'last'
        console.log('[Splash] startupBehavior=', settings.startupBehavior, 'shouldOpenLastProject=', shouldOpenLastProject)

        if (shouldOpenLastProject) {
            try {
                console.log('[Splash] step 2: getRecentProjects...')
                const recent = await engineApi.getRecentProjects()
                console.log('[Splash] step 2: getRecentProjects DONE, count=', recent.length)
                if (cancelledRef.current) { console.log('[Splash] cancelled after getRecentProjects'); return }
                const lastProject = recent[0]
                if (lastProject?.path) {
                    console.log('[Splash] step 2b: openProject...', lastProject.path)
                    await engineApi.openProject(lastProject.path)
                    console.log('[Splash] step 2b: openProject DONE')
                    if (cancelledRef.current) { console.log('[Splash] cancelled after openProject'); return }
                    // Eagerly activate external VST3 plugins and restore their saved state
                    engineApi.eagerActivateExternalPlugins().catch((err) =>
                        console.warn('[Splash] Eager plugin activation (non-fatal):', err)
                    )
                    console.info('[Splash] Opened last project on startup:', lastProject.path)
                } else {
                    console.info('[Splash] startupBehavior=last but recent list is empty')
                }
            } catch (e) {
                console.warn('[Splash] Failed to open last project on startup:', e)
            }
        }
        if (cancelledRef.current) { console.log('[Splash] cancelled before telemetry'); return }

        // 2. Start telemetry loop — the DAW comes alive
        console.log('[Splash] step 3: startTelemetryLoop...')
        startTelemetryLoop()
        console.log('[Splash] step 3: startTelemetryLoop DONE')

        // 3. Await initial project fetch — ensures tracks/clips are in the store
        //    before the Workspace component mounts
        const fetchProject = useEngineStore.getState().fetchProject
        try {
            console.log('[Splash] step 4: fetchProject...')
            await fetchProject()
            console.log('[Splash] step 4: fetchProject DONE')
        } catch (e) {
            console.warn('[Splash] fetchProject failed:', e)
        }
        if (cancelledRef.current) { console.log('[Splash] cancelled after fetchProject'); return }

        // 4. Now fade out the splash overlay
        console.log('[Splash] step 5: FADING OUT')
        setProgress(100)
        setPhase('fading')

        // 5. After fade completes - mount Workspace
        setTimeout(() => {
            if (cancelledRef.current) return
            console.log('[Splash] step 6: onComplete — mounting Workspace')
            onComplete?.()
            setPhase('done')
        }, 400) // fade animation is 400ms
    }, [onComplete, startTelemetryLoop])

    useEffect(() => {
        // Reset cancellation flag on (re-)mount — required for React StrictMode
        // which unmounts → remounts in dev, leaving the ref stale at `true`.
        cancelledRef.current = false

        const steps = [
            { text: 'Loading Core Modules...', delay: 500, pct: 20 },
            { text: 'Initializing DSP Pipeline...', delay: 1100, pct: 45 },
            { text: 'Scanning Audio Devices...', delay: 1700, pct: 70 },
            { text: 'Preparing Workspace...', delay: 2100, pct: 88 },
            { text: 'Ready', delay: 2400, pct: 96 },
        ]

        const timers = steps.map(({ text, delay, pct }) =>
            setTimeout(() => { setStatus(text); setProgress(pct); }, delay)
        )

        // Dismiss after minimum duration
        const dismissTimer = setTimeout(dismiss, minDuration)

        return () => {
            cancelledRef.current = true // cancel in-flight dismiss() work
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
                    <div className="splash-progress-bar">
                        <div className="splash-progress-fill" style={{ width: `${progress}%` }} />
                    </div>
                </div>
            </div>
        </div>
    )
}
