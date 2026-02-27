/* ═══════════════════════════════════════════════════════════════
   Dream DAW — App Startup Manager (Headless)

   Single-window approach has been migrated.
   - The native `splashscreen` window displays `splash.html`.
   - The `main` window starts completely hidden.
   - This React component runs invisibly in `main` to:
     1. Load settings.
     2. Connect telemetry.
     3. Restore the last project if applicable.
   - On completion, it calls `onComplete()` which then mounts Workspace
     and commands Tauri to close the splash/maximize the DAW.
   ═════════════════════════════════════════════════════════════ */

import { useEffect, useCallback, useRef } from 'react'
import { useEngineStore } from '@/shared/stores/useEngineStore'
import { useSettingsStore } from '@/shared/stores/useSettingsStore'
import * as engineApi from '@/shared/api/engine'
import { applyDeltasWithSnapshotSync } from '@/shared/stores/engine/snapshotSync'
import { withProjectLoad } from '@/shared/lib/projectLoadGuard'

interface AppStartupManagerProps {
    /** Minimum display duration in ms (still useful so splash text has time to be read) */
    minDuration?: number
    /** Called when the splash screen has fully faded out */
    onComplete?: () => void
}

export function SplashScreen({ minDuration = 2600, onComplete }: AppStartupManagerProps) {
    const isDev = import.meta.env.DEV
    const cancelledRef = useRef(false)
    const finalizedRef = useRef(false)

    const startTelemetryLoop = useEngineStore((s) => s.startTelemetryLoop)

    const finalizeSplash = useCallback((reason: string) => {
        if (cancelledRef.current || finalizedRef.current) return
        finalizedRef.current = true
        if (isDev) console.debug(`[StartupManager] finalize (${reason})`)
        try {
            onComplete?.()
        } catch (e) {
            console.warn('[StartupManager] onComplete failed:', e)
        }
    }, [onComplete, isDev])

    const startInitialization = useCallback(() => {
        if (isDev) console.debug('[StartupManager] initialization START')

        // BUG-001 FIX: Per-step timeout to prevent hanging on unresponsive backend
        const withTimeout = <T,>(promise: Promise<T>, ms: number, label: string): Promise<T> =>
            Promise.race([
                promise,
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error(`[StartupManager] ${label} timed out after ${ms}ms`)), ms)
                ),
            ])

        void (async () => {
            try {
                // 1. Load user settings from disk in background.
                try {
                    if (isDev) console.debug('[StartupManager] step 1: loadSettings...')
                    await withTimeout(useSettingsStore.getState().loadSettings(), 3000, 'loadSettings')
                    if (isDev) console.debug('[StartupManager] step 1: loadSettings DONE')
                } catch (e) {
                    console.warn('[StartupManager] Failed to load settings:', e)
                }
                if (cancelledRef.current) return

                const settings = useSettingsStore.getState().settings
                if (isDev) console.debug('[StartupManager] startupBehavior=', settings.startupBehavior)

                // 2. Start telemetry ASAP so UI is live even if project open is slow.
                if (isDev) console.debug('[StartupManager] step 2: startTelemetryLoop...')
                startTelemetryLoop()
                if (isDev) console.debug('[StartupManager] step 2: startTelemetryLoop DONE')

                // 2.5. Populate the tab bar with real backend project info.
                // The store starts with a placeholder 'default' tab — replace it
                // with the actual project list from the backend.
                try {
                    const projects = await withTimeout(engineApi.listOpenProjects(), 2000, 'listOpenProjects')
                    if (projects.length > 0) {
                        const tabs = projects.map(p => ({
                            id: p.id,
                            name: p.name,
                            filePath: p.filePath,
                            isDirty: p.isDirty,
                        }))
                        // Find the active project ID from the backend.
                        const activeId = await withTimeout(engineApi.getActiveProjectId(), 1000, 'getActiveProjectId')
                        useEngineStore.setState({
                            activeProjectId: activeId,
                            openProjects: tabs,
                        })
                        if (isDev) console.debug('[StartupManager] step 2.5: synced tabs =', tabs, 'activeId =', activeId)
                    }
                } catch (e) {
                    console.warn('[StartupManager] step 2.5: listOpenProjects failed:', e)
                }

                // 3. Honor startup behavior: open last project on launch if selected.
                if (settings.startupBehavior === 'last') {
                    if (isDev) console.debug('[StartupManager] step 3: startupBehavior=last, loading recent...')
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
                            if (isDev) console.debug('[StartupManager] step 3: open last DONE', latest.path)
                        } else if (isDev) {
                            console.debug('[StartupManager] step 3: no recent projects, skipping')
                        }
                    } catch (e) {
                        console.warn('[StartupManager] step 3: open last failed, continuing:', e)
                    }
                }
            } catch (e) {
                console.warn('[StartupManager] Unexpected startup error:', e)
            } finally {
                // Ensure the splash isn't closed too blindingly fast
                setTimeout(() => finalizeSplash('initialization-complete'), Math.max(0, minDuration - 500))
            }
        })()
    }, [startTelemetryLoop, finalizeSplash, isDev, minDuration])

    useEffect(() => {
        cancelledRef.current = false
        finalizedRef.current = false

        startInitialization()

        // Hard fail-safe: must never block UI indefinitely.
        const watchdogTimer = setTimeout(
            () => finalizeSplash('watchdog-timeout'),
            Math.max(minDuration + 6000, 9000),
        )

        return () => {
            cancelledRef.current = true
            finalizedRef.current = true
            clearTimeout(watchdogTimer)
        }
    }, [startInitialization, finalizeSplash, minDuration])

    return null
}
