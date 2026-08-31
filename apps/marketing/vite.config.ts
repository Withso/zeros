import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Zeros development ports must not overlap:
//   marketing site → 3000 (this file)
//   web hub         → 8788 (apps/web)
//   desktop renderer→ 5193 (root vite.config.ts)
//
// Pinned with strictPort so a port collision fails loudly instead
// of silently falling back to 5174 — that fallback used to leave
// the marketing site occupying 5173, the Mac app's old default,
// causing Electron to load this site as the Mac app UI.
// See apps/desktop/electron/main.ts DEV_URL.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 3000,
    strictPort: true,
    // Dual-stack. `--host 0.0.0.0` is IPv4-only; Cursor port-forward
    // often connects to ::1 and gets ERR_CONNECTION_REFUSED otherwise.
    host: true,
    // Cloud-agent / tunnel previews hit this via *.trycloudflare.com etc.
    allowedHosts: true,
    headers: {
      "Cache-Control": "no-store",
    },
  },
});
