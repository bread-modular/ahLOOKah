import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFile } from 'node:fs/promises'
import { generatePatternCatalog } from './scripts/generate-pattern-catalog.mjs'

// The built-in pattern catalog is generated from `src/sketches/**/*.pattern.js`
// before Vite scans dependencies, so dev/build/preview always see the current
// library — including from a clean checkout with no generated file present.
await generatePatternCatalog(new URL('.', import.meta.url).pathname)

// Serve the static /docs page for both `/docs` and `/docs/`.
// Vite's SPA fallback would otherwise serve the React app for these paths
// (dev: both `/docs` and `/docs/`; preview: `/docs` without a trailing slash).
const docsHtmlUrl = new URL('./public/docs/index.html', import.meta.url)

function docsStaticRoute() {
  let cached = null
  const loadDocs = async () => {
    cached ??= await readFile(docsHtmlUrl, 'utf8')
    return cached
  }
  const handler = async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()
    const pathname = (req.url || '').split('?')[0]
    if (pathname !== '/docs' && pathname !== '/docs/') return next()
    try {
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(req.method === 'HEAD' ? undefined : await loadDocs())
    } catch (err) {
      next(err)
    }
  }
  return {
    name: 'docs-static-route',
    // Register middleware directly (before Vite's public-dir + SPA fallback).
    configureServer(server) {
      server.middlewares.use(handler)
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler)
    },
  }
}

// Regenerate the built-in pattern catalog when `*.pattern.js` modules are
// added/removed/renamed during development, then request a full reload (never
// a hot-swap of an active renderer). Serialized + coalesced; normal edits to
// existing modules flow through Vite's own HMR/reload path.
function patternCatalogWatcher() {
  let pending = null
  const schedule = (server) => {
    if (pending) return pending
    pending = (async () => {
      await generatePatternCatalog(new URL('.', import.meta.url).pathname)
      server.ws.send({ type: 'full-reload', path: '*' })
    })().finally(() => { pending = null })
    return pending
  }
  const isPatternFile = (file) => typeof file === 'string' && file.endsWith('.pattern.js')
  return {
    name: 'pattern-catalog-watcher',
    configureServer(server) {
      server.watcher.on('add', (file) => { if (isPatternFile(file)) schedule(server) })
      server.watcher.on('unlink', (file) => { if (isPatternFile(file)) schedule(server) })
    },
  }
}

export default defineConfig({
  plugins: [react(), docsStaticRoute(), patternCatalogWatcher()],
  server: {
    host: true,
    port: 3000,
    allowedHosts: ['devbox2.local']
  },
  preview: {
    host: true,
    port: 3000,
    allowedHosts: ['devbox2.local']
  }
})
