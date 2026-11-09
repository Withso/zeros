// A worker thread of the Design recorder (design-recorder-documents.ts): it
// sanitizes each frame's markup and inserts its head, which parses the
// document, off the recorder's main thread, which drives every window.
import { parentPort } from "node:worker_threads";
import { designRecorderDocument } from "./design-recorder-document";

type Request = { id: number; html: string; colorScheme: "light" | "dark" };

parentPort?.on("message", (request: Request) => {
  void designRecorderDocument(request.html, request.colorScheme).then(
    (document) => parentPort!.postMessage({ id: request.id, document }),
    (error: unknown) => parentPort!.postMessage({ id: request.id, error: error instanceof Error ? error.message : "Could not prepare this frame." }),
  );
});
