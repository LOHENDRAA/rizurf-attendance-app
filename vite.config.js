import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Relative asset paths -- this app is served from a sub-path under
  // XAMPP (e.g. /qr-system/), not the domain root. Absolute "/assets/..."
  // paths would 404 there.
  base: './',
  server: {
    proxy: {
      // Forwards any /api/... request from the dev server (localhost:5173)
      // to the PHP backend running under Apache (localhost/qr-system/api/...)
      '/api': {
        target: 'http://localhost/qr-system',
        changeOrigin: true,
      },
    },
  },
})
