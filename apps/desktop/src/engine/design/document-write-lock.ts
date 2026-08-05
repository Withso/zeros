import path from "node:path";

const documentFlights = new Map<string, Promise<void>>();

/** Serialize every write-capable design-document operation by semantic
 * workspace owner. Reads that are guaranteed observational do not need this
 * queue; healing lint does, because it can replace frame source. */
export async function withDesignDocumentWrite<T>(
  workspacePath: string,
  run: () => Promise<T>,
): Promise<T> {
  const key = path.resolve(workspacePath);
  const previous = documentFlights.get(key) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => turn);
  documentFlights.set(key, queued);
  await previous;
  try {
    return await run();
  } finally {
    release();
    if (documentFlights.get(key) === queued) documentFlights.delete(key);
  }
}
