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
import { applyDeltasWithSnapshotSync } from '@/shared/stores/engine/snapshotSync'
import { withProjectLoad } from '@/shared/lib/projectLoadGuard'
import './SplashScreen.css'

interface SplashScreenProps {
    /** Minimum display duration in ms (prevents flash on fast loads) */
    minDuration?: number
    /** Called when the splash screen has fully faded out */
    onComplete?: () => void
}

export function SplashScreen({ minDuration = 2600, onComplete }: SplashScreenProps) {
    const isDev = import.meta.env.DEV
    const [status, setStatus] = useState('Initializing Audio Engine...')
    const [phase, setPhase] = useState<'visible' | 'fading' | 'done'>('visible')
    const [progress, setProgress] = useState(0)
    // BUG-5 fix: stale flag to cancel in-flight async work on unmount
    const cancelledRef = useRef(false)
    const finalizedRef = useRef(false)

    const startTelemetryLoop = useEngineStore((s) => s.startTelemetryLoop)

    const finalizeSplash = useCallback((reason: string) => {
        if (cancelledRef.current || finalizedRef.current) return
        finalizedRef.current = true
        if (isDev) console.debug(`[Splash] finalize (${reason})`)
        setProgress(100)
        setPhase('fading')
        window.setTimeout(() => {
            if (cancelledRef.current) return
            try {
                onComplete?.()
            } catch (e) {
                console.warn('[Splash] onComplete failed:', e)
            } finally {
                setPhase('done')
            }
        }, 400)
    }, [onComplete, isDev])

    const dismiss = useCallback(() => {
        if (isDev) console.debug('[Splash] dismiss() START')
        finalizeSplash('dismiss-started')

        // BUG-001 FIX: Per-step timeout to prevent hanging on unresponsive backend
        const withTimeout = <T,>(promise: Promise<T>, ms: number, label: string): Promise<T> =>
            Promise.race([
                promise,
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error(`[Splash] ${label} timed out after ${ms}ms`)), ms)
                ),
            ])

        void (async () => {
            try {
                // 1. Load user settings from disk in background.
                try {
                    if (isDev) console.debug('[Splash] step 1: loadSettings...')
                    await withTimeout(useSettingsStore.getState().loadSettings(), 3000, 'loadSettings')
                    if (isDev) console.debug('[Splash] step 1: loadSettings DONE')
                } catch (e) {
                    console.warn('[Splash] Failed to load settings:', e)
                }
                if (cancelledRef.current) {
                    if (isDev) console.debug('[Splash] cancelled after loadSettings')
                    return
                }

                const settings = useSettingsStore.getState().settings
                if (isDev) console.debug('[Splash] startupBehavior=', settings.startupBehavior)

                // 2. Start telemetry ASAP so UI is live even if project open is slow.
                if (isDev) console.debug('[Splash] step 2: startTelemetryLoop...')
                startTelemetryLoop()
                if (isDev) console.debug('[Splash] step 2: startTelemetryLoop DONE')

                // 3. Honor startup behavior: open last project on launch if selected.
                if (settings.startupBehavior === 'last') {
                    if (isDev) console.debug('[Splash] step 3: startupBehavior=last, loading recent...')
                    try {
                        const recents = await withTimeout(engineApi.getRecentProjects(), 3000, 'getRecentProjects')
                        const latest = recents[0]
                        if (latest?.path) {
                            await withProjectLoad('splash:start:last-project', async () => {
                                const isAbleton = latest.path.toLowerCase().endsWith('.als')
                                const response = isAbleton
                                    ? await withTimeout(engineApi.importAbletonProject(latest.path), 12000, 'importAbletonProject')
                                    : await withTimeout(engineApi.openProject(latest.path), 12000, 'openProject')
                                await applyDeltasWithSnapshotSync(
                                    useEngineStore.getState().applyProjectDeltas,
                                    response.deltas,
                                    'splash:start:last-project',
                                )
                            })
                            await withTimeout(useEngineStore.getState().syncProjectHistory(), 2000, 'syncProjectHistory')
                            if (isDev) console.debug('[Splash] step 3: open last DONE', latest.path)
                        } else if (isDev) {
                            console.debug('[Splash] step 3: no recent projects, skipping')
                        }
                    } catch (e) {
                        console.warn('[Splash] step 3: open last failed, continuing:', e)
                    }
                }
            } catch (e) {
                console.warn('[Splash] Unexpected startup error:', e)
            }
        })()
    }, [startTelemetryLoop, finalizeSplash, isDev])

    useEffect(() => {
        // Reset cancellation flag on (re-)mount — required for React StrictMode
        // which unmounts → remounts in dev, leaving the refs stale at `true`.
        cancelledRef.current = false
        finalizedRef.current = false

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
        // Hard fail-safe: splash must never block UI indefinitely.
        const watchdogTimer = setTimeout(
            () => finalizeSplash('watchdog-timeout'),
            Math.max(minDuration + 6000, 9000),
        )

        return () => {
            cancelledRef.current = true // cancel in-flight dismiss() work
            finalizedRef.current = true
            timers.forEach(clearTimeout)
            clearTimeout(dismissTimer)
            clearTimeout(watchdogTimer)
        }
    }, [minDuration, dismiss, finalizeSplash])

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
