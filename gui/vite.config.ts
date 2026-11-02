import { defineConfig } from 'vite'
import { copyFileSync } from 'node:fs'
import { resolve } from 'node:path'

const outputDirectory = process.env.AGRO_GUI_DIST || '/tmp/agro-gui-dist'

export default defineConfig({
  base: '/ui/',
  build: {
    outDir: outputDirectory, emptyOutDir: false,
    rollupOptions: {
      // This client-only application does not use React Server Components
      onwarn(warning, report) {
        if (warning.code === 'MODULE_LEVEL_DIRECTIVE' && warning.message.includes('use client')) return
        report(warning)
      },
      output: {manualChunks: {react: ['react', 'react-dom/client'], motion: ['motion/react']}}
    }
  },
  plugins: [{
    name: 'include-third-party-notices',
    writeBundle() {
      copyFileSync(new URL('./THIRD_PARTY_NOTICES.md', import.meta.url), resolve(outputDirectory, 'THIRD_PARTY_NOTICES.md'))
    }
  }],
  server: {
    host: '127.0.0.1',
    proxy: Object.fromEntries(['/studio', '/agent', '/robot-systems', '/system', '/packages', '/control', '/tasks', '/catalog', '/schemas', '/config', '/management', '/assets', '/templates', '/plans', '/diagnostics', '/trees', '/ros', '/state-machines', '/tutorial', '/operations'].map(path =>
      [path, { target: 'http://127.0.0.1:8765', changeOrigin: false }]))
  }
})
