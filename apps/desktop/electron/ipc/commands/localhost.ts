// ──────────────────────────────────────────────────────────
// IPC commands: localhost scan
// ──────────────────────────────────────────────────────────
//
// The repository navigation's LOCALHOST panel polls this to surface whatever is
// listening on common dev-server / database / engine ports. Plain
// TCP connect with a 120ms timeout — closed ports return refused
// instantly so the full sweep stays under ~100ms even on a cold
// machine.
// ──────────────────────────────────────────────────────────

import net from "node:net";
import type { CommandHandler } from "../router";
import {
  ENGINE_BASE_PORT_BETA,
  ENGINE_BASE_PORT_DEV,
  ENGINE_BASE_PORT_PROD,
  ENGINE_PORT_SPAN,
} from "../../../src/engine/runtime";

interface LocalhostService {
  port: number;
  url: string;
  kind: "dev-server" | "database" | "engine" | "unknown";
  label: string;
}

/** Engine entries cover every channel-owned range so the inspector labels
 *  Stable, Beta, and Dev even while they run side-by-side. Each span matches
 *  LocalTransport's port walk (ENGINE_PORT_SPAN). */
const ENGINE_PORTS: Array<{
  port: number;
  kind: LocalhostService["kind"];
  label: string;
}> = [
  { base: ENGINE_BASE_PORT_PROD, label: "Zeros engine" },
  { base: ENGINE_BASE_PORT_BETA, label: "Zeros engine (beta)" },
  { base: ENGINE_BASE_PORT_DEV, label: "Zeros engine (dev)" },
].flatMap(({ base, label }) =>
  Array.from({ length: ENGINE_PORT_SPAN }, (_, offset) => ({
    port: base + offset,
    kind: "engine" as const,
    label,
  })),
);

/** KNOWN_PORTS mirror. */
const KNOWN_PORTS: Array<{
  port: number;
  kind: LocalhostService["kind"];
  label: string;
}> = [
  // Zeros development servers use 3000 (marketing), 5193 (desktop renderer),
  // and 8788 (Wrangler web hub). See their respective Vite/package configs.
  // All other entries are common third-party tool defaults the user
  // is likely to spin up in the project they're inspecting.
  { port: 3000, kind: "dev-server", label: "Zeros marketing / app server" },
  { port: 3001, kind: "dev-server", label: "Alternate app server" },
  { port: 4000, kind: "dev-server", label: "Phoenix / misc" },
  { port: 4321, kind: "dev-server", label: "Astro" },
  { port: 5000, kind: "dev-server", label: "Flask / misc" },
  { port: 5173, kind: "dev-server", label: "Vite" },
  { port: 5174, kind: "dev-server", label: "Vite (alt)" },
  { port: 5193, kind: "dev-server", label: "Zeros Mac app (renderer)" },
  { port: 5500, kind: "dev-server", label: "Live Server" },
  { port: 8000, kind: "dev-server", label: "Python / misc" },
  { port: 8080, kind: "dev-server", label: "misc" },
  { port: 8788, kind: "dev-server", label: "Zeros web hub (Wrangler)" },
  // Databases
  { port: 3306, kind: "database", label: "MySQL" },
  { port: 5432, kind: "database", label: "Postgres" },
  { port: 6379, kind: "database", label: "Redis" },
  { port: 27017, kind: "database", label: "MongoDB" },
  // Zeros engine (Stable 24193–24200 + Beta 24203–24210 + Dev 24293–24300)
  ...ENGINE_PORTS,
];

/** Probe a single host (IPv4 or IPv6). Resolves true if a TCP
 *  connection is accepted within the timeout window. */
function tryHost(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 120);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, host);
  });
}

/** Vite (and other Node servers) often bind only to IPv6 loopback
 *  (`[::1]`) on newer macOS. An IPv4-only probe to `127.0.0.1` would
 *  miss those servers entirely. Probe BOTH stacks and resolve true
 *  if either responds. */
function portIsOpen(port: number): Promise<boolean> {
  return Promise.all([tryHost(port, "127.0.0.1"), tryHost(port, "::1")]).then(
    ([v4, v6]) => v4 || v6,
  );
}

export const discoverLocalhostServices: CommandHandler = async () => {
  // Scan all ports concurrently — each probe is bounded at 120ms so
  // the worst case is still ~150ms total.
  const results = await Promise.all(
    KNOWN_PORTS.map(async (entry): Promise<LocalhostService | null> => {
      const open = await portIsOpen(entry.port);
      if (!open) return null;
      return {
        port: entry.port,
        url: `http://localhost:${entry.port}`,
        kind: entry.kind,
        label: entry.label,
      };
    }),
  );
  return results.filter((r): r is LocalhostService => r !== null);
};
