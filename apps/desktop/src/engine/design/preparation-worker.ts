import { parentPort } from "node:worker_threads";
import { withDesignDirectoryNameLease } from "./directory-registry";
import { prepareDesignFrameIdentitiesInWorker } from "./document";
import { createDesignReadScope, withDesignReadScope, type DesignReadScope } from "./safe-files";
import { configureDesignFonts } from "./style-fonts";
import { composeDesignFrameSourcesInWorker } from "./thumbnail-batch";

// The engine sends a batch only when no App fonts are in play. A worker never
// downloads one either, so font readiness cannot differ from the engine's.
configureDesignFonts({ fetch: (async () => { throw new Error("Design preparation workers do not fetch."); }) as unknown as typeof fetch });

/** `directory` is the engine's active Design folder: a worker has its own
 * empty directory registry, so it would otherwise read the default one. */
type Request = { id: number; workspacePath: string; directory: string; scope?: number } & (
  | { kind?: undefined; catalogRevision: string; files: string[] }
  | { kind: "compose"; frames: Array<{ file: string; width: number; height: number }>; deferTailwind: boolean });

/** An engine call's frames arrive one message at a time; they share that
 * call's reads until the engine releases it. A lost release ages out. */
const scopes = new Map<number, DesignReadScope>();
const MAX_SCOPES = 4;
function scopeFor(id: number | undefined): DesignReadScope {
  if (id === undefined) return createDesignReadScope();
  let scope = scopes.get(id);
  if (!scope) {
    scopes.set(id, (scope = createDesignReadScope()));
    if (scopes.size > MAX_SCOPES) scopes.delete(scopes.keys().next().value!);
  }
  return scope;
}

parentPort?.on("message", async (message: Request | { kind: "release"; scope: number }) => {
  if (message.kind === "release") {
    scopes.delete(message.scope);
    return;
  }
  try {
    const results = await withDesignDirectoryNameLease<unknown[]>(message.workspacePath, message.directory, () =>
      withDesignReadScope<unknown[]>(() => message.kind === "compose"
        ? composeDesignFrameSourcesInWorker(message.workspacePath, message.frames, { deferTailwind: message.deferTailwind })
        : prepareDesignFrameIdentitiesInWorker(message.workspacePath, message.catalogRevision, message.files), scopeFor(message.scope)));
    parentPort!.postMessage({ id: message.id, results });
  } catch (error) {
    parentPort!.postMessage({ id: message.id, error: error instanceof Error ? error.message : "Design preparation worker failed." });
  }
});
