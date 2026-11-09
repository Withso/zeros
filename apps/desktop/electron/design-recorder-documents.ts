// Frame documents for the Design recorder's windows, prepared on a worker
// thread. The recorder's main thread drives every window, and on a Mac
// 1,000-frame open it ran near a full core; each frame's sanitizing parse
// was its largest share of script time. A worker that can't start or stops
// leaves the work to the main thread, as before.
import { Worker } from "node:worker_threads";
import { designRecorderDocument } from "./design-recorder-document";

export interface DesignRecorderDocuments {
  /** The frame's sanitized document with its head markup. */
  prepare(html: string, colorScheme: "light" | "dark"): Promise<string>;
  stop(): void;
}

type Pending = { resolve: (document: string) => void; reject: (error: Error) => void; html: string; colorScheme: "light" | "dark" };

export function createDesignRecorderDocuments(options: { workerFile?: string | URL } = {}): DesignRecorderDocuments {
  const pending = new Map<number, Pending>();
  let nextId = 0;
  let worker: Worker | null = null;
  let failed = !options.workerFile;
  let stopped = false;

  /** The worker is gone: what it held is prepared here instead. */
  const fallBack = () => {
    failed = true;
    worker = null;
    const held = [...pending.values()];
    pending.clear();
    for (const request of held) designRecorderDocument(request.html, request.colorScheme).then(request.resolve, request.reject);
  };
  const start = (): Worker | null => {
    if (worker || failed || stopped) return worker;
    try {
      const started = new Worker(options.workerFile!);
      started.unref();
      started.on("message", (reply: { id: number; document?: string; error?: string }) => {
        const request = pending.get(reply.id);
        if (!request) return;
        pending.delete(reply.id);
        if (reply.document !== undefined) request.resolve(reply.document);
        else request.reject(new Error(reply.error ?? "Could not prepare this frame."));
      });
      started.once("error", () => { if (worker === started) fallBack(); });
      started.once("exit", () => { if (worker === started && !stopped) fallBack(); });
      worker = started;
    } catch {
      failed = true;
    }
    return worker;
  };

  // Started now, so the first frames don't wait for the thread to boot.
  start();
  return {
    prepare(html, colorScheme) {
      const thread = start();
      if (!thread) return designRecorderDocument(html, colorScheme);
      return new Promise<string>((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject, html, colorScheme });
        thread.postMessage({ id, html, colorScheme });
      });
    },
    stop() {
      stopped = true;
      const thread = worker;
      worker = null;
      void thread?.terminate();
      // Anything still held is prepared here, so no caller waits forever.
      const held = [...pending.values()];
      pending.clear();
      for (const request of held) designRecorderDocument(request.html, request.colorScheme).then(request.resolve, request.reject);
    },
  };
}
