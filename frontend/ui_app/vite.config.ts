import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'
import { readFileSync, writeFileSync } from 'fs'

// ── Auto-Version Plugin ─────────────────────────────────────────
// Reads version.json, increments the patch version on every build,
// syncs tauri.conf.json and workspace Cargo.toml,
// and injects __APP_VERSION__ as a compile-time constant.
function autoVersionPlugin() {
  const versionPath = resolve(__dirname, 'version.json')
  const tauriConfPath = resolve(__dirname, '../../apps/desktop_host/tauri.conf.json')
  const cargoTomlPath = resolve(__dirname, '../../Cargo.toml')

  return {
    name: 'dream-daw-auto-version',
    config() {
      const raw = readFileSync(versionPath, 'utf-8')
      const ver = JSON.parse(raw)

      // Increment patch version
      ver.patch += 1
      writeFileSync(versionPath, JSON.stringify(ver, null, 2) + '\n')

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
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
})

