import { parentPort } from "node:worker_threads";
import { withDesignDirectoryNameLease } from "./directory-registry";
import { prepareDesignFrameIdentitiesInWorker } from "./document";
import { configureDesignFonts } from "./style-fonts";
import { composeDesignFrameSourcesInWorker } from "./thumbnail-batch";

// The engine sends a batch only when no App fonts are in play. A worker never
// downloads one either, so font readiness cannot differ from the engine's.
configureDesignFonts({ fetch: (async () => { throw new Error("Design preparation workers do not fetch."); }) as unknown as typeof fetch });

/** `directory` is the engine's active Design folder: a worker has its own
 * empty directory registry, so it would otherwise read the default one. */
type Request = { id: number; workspacePath: string; directory: string } & (
  | { kind?: undefined; catalogRevision: string; files: string[] }
  | { kind: "compose"; frames: Array<{ file: string; width: number; height: number }>; deferTailwind: boolean });

parentPort?.on("message", async (message: Request) => {
  try {
    const results = await withDesignDirectoryNameLease<unknown[]>(message.workspacePath, message.directory, () => message.kind === "compose"
      ? composeDesignFrameSourcesInWorker(message.workspacePath, message.frames, { deferTailwind: message.deferTailwind })
      : prepareDesignFrameIdentitiesInWorker(message.workspacePath, message.catalogRevision, message.files));
    parentPort!.postMessage({ id: message.id, results });
  } catch (error) {
    parentPort!.postMessage({ id: message.id, error: error instanceof Error ? error.message : "Design preparation worker failed." });
  }
});
