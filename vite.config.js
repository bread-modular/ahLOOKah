import { defineConfig } from 'vite'

export default defineConfig({
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
