import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Website cluster ports (must not overlap with the Mac app at 5193):
//   marketing    → 3000   (this file)
//   accounts     → 3001
//
// Pinned with strictPort so a port collision fails loudly instead
// of silently falling back to 5174 — that fallback used to leave
// the marketing site occupying 5173, the Mac app's old default,
// causing Electron to load this site as the Mac app UI.
// See electron/main.ts DEV_URL.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 3000,
    strictPort: true,
    // Cloud-agent / tunnel previews hit this via *.trycloudflare.com etc.
    allowedHosts: true,
  },
})
