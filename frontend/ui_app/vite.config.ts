import { type ConfigEnv, defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'
import { readFileSync, writeFileSync } from 'fs'

// ── Auto-Version Plugin ─────────────────────────────────────────
// Reads version.json and syncs tauri.conf.json + workspace Cargo.toml,
// and injects __APP_VERSION__ as a compile-time constant.
function autoVersionPlugin() {
  const versionPath = resolve(__dirname, 'version.json')
  const tauriConfPath = resolve(__dirname, '../../apps/desktop_host/tauri.conf.json')
  const cargoTomlPath = resolve(__dirname, '../../Cargo.toml')

  return {
    name: 'dream-daw-auto-version',
    config(_: unknown, env: ConfigEnv) {
      const raw = readFileSync(versionPath, 'utf-8')
      const ver = JSON.parse(raw) as { major: number; minor: number; patch: number }

      // Build semantics:
      // - version.json is the single source of truth
      // - on each production build, bump patch by +1 from CURRENT stored value
      // - manual edits to major/minor/patch become the next baseline automatically
      if (env.command === 'build' || env.command === 'serve') {
        ver.patch = Number.isFinite(ver.patch) ? Math.max(0, Math.floor(ver.patch)) + 1 : 1
        writeFileSync(versionPath, JSON.stringify(ver, null, 2) + '\n')
      }

      const versionString = `${ver.major}.${ver.minor}.${ver.patch}`

      // ── Sync tauri.conf.json ──
      try {
        const tauriRaw = readFileSync(tauriConfPath, 'utf-8')
        const tauriConf = JSON.parse(tauriRaw)
        tauriConf.version = versionString
        writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 4) + '\n')
      } catch (e) {
        console.warn('  ⚠ Could not sync tauri.conf.json:', e)
      }

      // ── Sync workspace Cargo.toml version ──
      try {
        let cargoRaw = readFileSync(cargoTomlPath, 'utf-8')
        cargoRaw = cargoRaw.replace(
          /^(version\s*=\s*)"[^"]*"/m,
          `$1"${versionString}"`
        )
        writeFileSync(cargoTomlPath, cargoRaw)
      } catch (e) {
        console.warn('  ⚠ Could not sync Cargo.toml:', e)
      }

      console.log(`\n  🎹 Dream DAW v${versionString}\n`)

      return {
        define: {
          __APP_VERSION__: JSON.stringify(versionString),
        },
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    autoVersionPlugin(),
    react(),
    tailwindcss(),
  ],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (
            id.includes('/react/')
            || id.includes('/react-dom/')
            || id.includes('/scheduler/')
            || id.includes('/react-is/')
            || id.includes('/use-sync-external-store/')
            || id.includes('/loose-envify/')
            || id.includes('/object-assign/')
          ) return 'vendor-react'
          if (id.includes('/@tauri-apps/')) return 'vendor-tauri'
          if (id.includes('/lodash.throttle/')) return 'vendor-utils'
          if (id.includes('/zustand/') || id.includes('/lucide-react/')) return 'vendor-ui'
          return 'vendor-misc'
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5179,
    strictPort: true,
  },
  preview: {
    port: 5179,
    strictPort: true,
  },
})
