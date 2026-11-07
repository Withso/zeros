import { parentPort } from "node:worker_threads";
import { prepareDesignFrameIdentitiesInWorker } from "./document";
import { configureDesignFonts } from "./style-fonts";

// The engine sends a batch only when no App fonts are in play. A worker never
// downloads one either, so font readiness cannot differ from the engine's.
configureDesignFonts({ fetch: (async () => { throw new Error("Design preparation workers do not fetch."); }) as unknown as typeof fetch });

parentPort?.on("message", async (message: { id: number; workspacePath: string; catalogRevision: string; files: string[] }) => {
  try {
    const results = await prepareDesignFrameIdentitiesInWorker(message.workspacePath, message.catalogRevision, message.files);
    parentPort!.postMessage({ id: message.id, results });
  } catch (error) {
    parentPort!.postMessage({ id: message.id, error: error instanceof Error ? error.message : "Design preparation worker failed." });
  }
});
