// Owned Node host for the pure Sass compiler. The supervising thread stays
// responsive even when Sass loops forever, including after the engine dies.
"use strict";
const { Worker, isMainThread, parentPort, workerData } = require("node:worker_threads");

if (isMainThread) {
  const worker = new Worker(__filename, {
    workerData: { sassModule: process.argv[2] },
    resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
  });
  const stop = () => { void worker.terminate().finally(() => process.exit()); };
  const deadline = setTimeout(stop, 15_000);
  process.on("disconnect", stop);
  process.on("message", message => worker.postMessage(message));
  worker.on("message", message => {
    if (!process.connected) return stop();
    process.send(message, () => {
      if (message.t === "result" || message.t === "error") stop();
    });
  });
  worker.on("error", () => {
    if (process.connected) process.send({ t: "error", error: "Sass compiler memory or execution budget exceeded" }, stop);
    else stop();
  });
  worker.on("exit", () => { clearTimeout(deadline); process.exit(); });
} else {
  const sass = require(workerData.sassModule);
  const pending = new Map();
  let nextId = 0, started = false;
  const ask = (t, fields) => new Promise((resolve, reject) => {
    if (pending.size >= 16) return reject(new Error("Sass import concurrency budget exceeded"));
    const id = ++nextId;
    pending.set(id, { resolve, reject }); parentPort.postMessage({ t, id, ...fields });
  });
  const importer = {
    nonCanonicalScheme: "pkg",
    async canonicalize(url, context) {
      const result = await ask("canonicalize", { url, context: { fromImport: context.fromImport, containingUrl: context.containingUrl?.href ?? null } });
      return result === null ? null : new URL(result);
    },
    load(url) { return ask("load", { url: url.href }); },
  };
  parentPort.on("message", message => {
    if (message.t === "reply") {
      const task = pending.get(message.id); if (!task) return;
      pending.delete(message.id);
      if (message.error) task.reject(new Error(message.error)); else task.resolve(message.value);
    } else if (message.t === "start" && !started) {
      started = true;
      void sass.compileStringAsync(message.content, {
        url: new URL(message.url), syntax: message.syntax, importer, importers: [importer],
        style: "expanded", charset: false, sourceMap: false, logger: sass.Logger.silent,
      }).then(result => {
        if (Buffer.byteLength(result.css) > 2 * 1024 * 1024) throw new Error("Sass output budget exceeded");
        parentPort.postMessage({ t: "result", css: result.css, version: /\b(\d+\.\d+\.\d+)\b/.exec(sass.info)?.[1] ?? null });
      }).catch(error => parentPort.postMessage({ t: "error", error: String(error?.message || "Sass compilation failed").slice(0, 8192) }));
    }
  });
  parentPort.postMessage({ t: "ready" });
}
