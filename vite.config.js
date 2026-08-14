import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFile } from 'node:fs/promises'

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

export default defineConfig({
  plugins: [react(), docsStaticRoute()],
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
