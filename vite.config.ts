import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * The service worker ships from public/ verbatim, so it needs a cache-busting
 * build id that changes on every build. Without this the browser keeps serving
 * the previous shell from the old cache name forever.
 */
function stampServiceWorker(): Plugin {
  return {
    name: 'stamp-service-worker',
    apply: 'build',
    closeBundle() {
      // process.cwd() rather than __dirname: with "type": "module" the config
      // is loaded as ESM, where __dirname does not exist.
      const swPath = resolve(process.cwd(), 'dist/sw.js')
      if (!existsSync(swPath)) return

      const build = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
      // replaceAll, not replace: the placeholder appears in sw.js's header
      // comment as well as in the constant, and replace() would only rewrite
      // the comment, silently leaving every build with the same cache name.
      const stamped = readFileSync(swPath, 'utf8').replaceAll('__SW_BUILD__', build)
      writeFileSync(swPath, stamped)

      if (stamped.includes('__SW_BUILD__')) {
        this.error('service worker build stamp was not applied')
      }
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  // In production nginx strips /api/ before proxying to psa_car_controller:5000.
  // The dev server does the same rewrite so the app code is identical either way.
  const target = env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:5001'

  return {
    plugins: [react(), stampServiceWorker()],
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ''),
        },
      },
    },
    build: {
      target: 'es2020',
      sourcemap: true,
    },
  }
})
