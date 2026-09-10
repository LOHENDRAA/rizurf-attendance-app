import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Only register the service worker in a real production build. Registering
// it during `npm run dev` caches dev-server responses (including module
// scripts that change or disappear on every restart), which causes the
// page to break in confusing ways whenever the dev server isn't running.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  // Relative path, not '/sw.js' -- the app is served from a sub-path
  // (e.g. /qr-system/), and an absolute path would look for the worker
  // at the domain root instead.
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js'))
}
