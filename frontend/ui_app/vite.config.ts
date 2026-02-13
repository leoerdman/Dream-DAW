import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'
import { readFileSync, writeFileSync } from 'fs'

// ── Auto-Version Plugin ─────────────────────────────────────────
// Reads version.json, increments the build number on every build,
// and injects __APP_VERSION__ as a compile-time constant.
function autoVersionPlugin() {
  const versionPath = resolve(__dirname, 'version.json')

  return {
    name: 'dream-daw-auto-version',
    config() {
      const raw = readFileSync(versionPath, 'utf-8')
      const ver = JSON.parse(raw)

      // Increment build number
      ver.build += 1
      writeFileSync(versionPath, JSON.stringify(ver, null, 2) + '\n')

      const versionString = `${ver.major}.${ver.minor}.${ver.patch} (Build ${ver.build})`
      const shortVersion = `${ver.major}.${ver.minor}.${ver.patch}`

      console.log(`\n  🎹 Dream DAW v${versionString}\n`)

      return {
        define: {
          __APP_VERSION__: JSON.stringify(versionString),
          __APP_VERSION_SHORT__: JSON.stringify(shortVersion),
          __APP_BUILD__: JSON.stringify(ver.build),
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

