import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
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

const PREVIEW_QUERY = "v=plain";
const NO_STORE =
  "no-store, no-cache, must-revalidate, max-age=0";

function pathOf(url: string | undefined): string {
  return (url ?? "/").split("?")[0] ?? "/";
}

function isDocumentRequest(req: IncomingMessage): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const path = pathOf(req.url);
  return path === "/" || path === "/index.html";
}

/** Dev-only: Cursor's forwarded Simple Browser keeps a stale module graph
 *  (ASCII hero) after HMR. New document URL + no-store + new entry file. */
function marketingPreviewBust(): Plugin {
  return {
    name: "zeros-marketing-preview-bust",
    apply: "serve",
    transformIndexHtml(html) {
      const withMeta = html.includes('name="zeros-preview"')
        ? html
        : html.replace(
            "</head>",
            `    <meta name="zeros-preview" content="plain-hero" />\n  </head>`,
          );
      const withEntry = withMeta.replace(
        /src="\/src\/main\.tsx[^"]*"/,
        `src="/src/boot.tsx?${PREVIEW_QUERY}"`,
      );
      if (withEntry.includes("location.replace")) return withEntry;
      return withEntry.replace(
        '<div id="root"></div>',
        `<script>if(!/[?&]v=plain/.test(location.search)){const u=new URL(location.href);u.searchParams.set("v","plain");location.replace(u.pathname+u.search+u.hash)}</script>\n    <div id="root"></div>`,
      );
    },
    configureServer(server) {
      server.middlewares.use(
        (req: IncomingMessage, res: ServerResponse, next: () => void) => {
          res.setHeader("Cache-Control", NO_STORE);
          res.setHeader("Pragma", "no-cache");
          res.setHeader("Expires", "0");
          if (isDocumentRequest(req)) {
            const setHeader = res.setHeader.bind(res);
            res.setHeader = ((
              name: string,
              value: number | string | readonly string[],
            ) => {
              if (String(name).toLowerCase() === "etag") return res;
              return setHeader(name, value);
            }) as typeof res.setHeader;
          }
          next();
        },
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), marketingPreviewBust()],
  server: {
    port: 3000,
    strictPort: true,
    // Dual-stack. `--host 0.0.0.0` is IPv4-only; Cursor port-forward
    // often connects to ::1 and gets ERR_CONNECTION_REFUSED otherwise.
    host: true,
    // Cloud-agent / tunnel previews hit this via *.trycloudflare.com etc.
    allowedHosts: true,
    headers: {
      "Cache-Control": NO_STORE,
      Pragma: "no-cache",
      Expires: "0",
    },
  },
});
