import { statSync } from "node:fs";
import path from "node:path";

import { engineRuntimeDir } from "../src/engine/db/paths";

/** Both development reloaders use the engine's ten-second heartbeat. There
 * is no duration limit on a healthy turn; only an abandoned marker expires. */
export function engineTurnIsActive(root: string, now = Date.now()): boolean {
  try {
    const marker = statSync(path.join(engineRuntimeDir(root), "busy"));
    return !marker.isFile() || now - marker.mtimeMs < 30_000;
  } catch (error) {
    // An unreadable marker cannot establish that restarting is safe.
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/** Private parent/child IPC, present only in a supervised development app.
 * Nothing is exposed through renderer IPC or the engine's network routes. */
export function installDevMainRestartCheck(options: {
  enabled: boolean;
  port: Pick<NodeJS.Process, "on" | "off" | "send">;
  currentRoot: () => string | null;
  quit: () => void;
}): () => void {
  const { port } = options;
  if (!options.enabled || !port.send) return () => {};
  const onMessage = (message: unknown) => {
    if (!message || typeof message !== "object") return;
    const request = message as Record<string, unknown>;
    if (
      request.type !== "zeros:dev-main-restart-check" ||
      !Number.isSafeInteger(request.requestId) ||
      (request.requestId as number) < 1
    )
      return;
    const root = options.currentRoot();
    try {
      port.send!(
        {
          type: "zeros:dev-main-restart-status",
          requestId: request.requestId,
          // During startup there is no authoritative engine identity yet.
          busy: root === null || engineTurnIsActive(root),
        },
        () => {},
      );
    } catch {
      // A disconnected supervisor cannot authorize a restart.
    }
  };
  const onTerminate = () => options.quit();
  port.on("message", onMessage);
  // SIGTERM does not reliably invoke Electron's before-quit by itself.
  port.on("SIGTERM", onTerminate);
  return () => {
    port.off("message", onMessage);
    port.off("SIGTERM", onTerminate);
  };
}
