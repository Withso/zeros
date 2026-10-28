import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface Importer {
  canonicalize(url: string, context: { fromImport: boolean; containingUrl: URL | null }): Promise<URL | null>;
  load(url: URL): Promise<{ contents: string; syntax: "scss" | "css" | "indented" } | null>;
}
const queue: Array<() => void> = [];
let active = 0;

async function acquire(signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) throw new Error("Sass compilation cancelled");
  await new Promise<void>((resolve, reject) => {
    if (queue.length >= 16) { reject(new Error("Sass compilation queue budget exceeded")); return; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); };
    const cancel = () => { const index = queue.indexOf(start); if (index >= 0) queue.splice(index, 1); cleanup(); reject(new Error("Sass compilation cancelled or queue budget exceeded")); };
    const start = () => { cleanup(); active++; resolve(); };
    if (active < 2) start();
    else { queue.push(start); timer = setTimeout(cancel, 10_000); signal?.addEventListener("abort", cancel, { once: true }); }
  });
  return () => { active--; queue.shift()?.(); };
}

function hostPaths() {
  let script = process.env.ZEROS_SASS_HOST_SCRIPT;
  if (!script) {
    // CJS development bundles have __dirname; source ESM has import.meta.url.
    // Neither path may depend on the repository being compiled.
    script = path.join(typeof __dirname === "string" ? __dirname : path.dirname(fileURLToPath(import.meta.url)), "sass-host.cjs");
  }
  if (!script || !path.isAbsolute(script) || !existsSync(script)) throw new Error("Sass compiler host is unavailable");
  const runtime = process.env.ZEROS_PTY_HOST_RUNTIME ?? (process.versions.bun ? null : process.execPath);
  if (!runtime || !path.isAbsolute(runtime)) throw new Error("Sass compiler requires the owned Node runtime");
  const resolvedModule = process.env.ZEROS_SASS_MODULE ?? createRequire(script).resolve("sass");
  // Electron main resolves through asar, but its Node-mode compiler cannot.
  // Packaging unpacks the compiler and its dependency closure beside it.
  const sassModule = resolvedModule.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
  if (!path.isAbsolute(sassModule)) throw new Error("Sass compiler module is unavailable");
  return { script, runtime, sassModule };
}

/** All expensive evaluation runs outside the engine. Resolve/reject only after
 * the child exits, retaining the slot until timed-out work has really stopped. */
export async function compileSassInOwnedProcess(
  input: { content: string; url: string; syntax: "scss" | "indented" },
  importer: Importer,
  options: { signal?: AbortSignal; executionTimeoutMs?: number },
): Promise<{ css: string; version: string | null }> {
  const release = await acquire(options.signal);
  try {
    if (options.signal?.aborted) throw new Error("Sass compilation cancelled");
    const { script, runtime, sassModule } = hostPaths();
    return await new Promise((resolve, reject) => {
      const child = spawn(runtime, ["--max-old-space-size=192", script, sassModule], {
        cwd: path.dirname(script), stdio: ["ignore", "ignore", "ignore", "ipc"],
        // No provider credentials, Node hooks or repository environment enter
        // the compiler. Node loads the product's absolute Sass module only.
        env: { ...(process.env.ZEROS_PTY_HOST_RUNTIME_ELECTRON === "1" ? { ELECTRON_RUN_AS_NODE: "1" } : {}) },
      });
      let stopped = false, ready = false, requests = 0, pending = 0;
      let result: { css: string; version: string | null } | undefined;
      let failure: Error | undefined;
      const stop = (error?: Error) => {
        if (stopped) return;
        stopped = true; failure = error; clearTimeout(timer); child.kill("SIGKILL");
      };
      let timer = setTimeout(() => stop(new Error("Sass compiler startup time budget exceeded")), 5000);
      const cancel = () => stop(new Error("Sass compilation cancelled"));
      options.signal?.addEventListener("abort", cancel, { once: true });
      child.once("error", () => stop(new Error("Sass compiler could not start")));
      child.once("close", () => {
        clearTimeout(timer); options.signal?.removeEventListener("abort", cancel);
        if (failure) reject(failure);
        else if (result) resolve(result);
        else reject(new Error("Sass compiler exceeded its memory or execution budget"));
      });
      const send = (value: unknown) => { if (!stopped && child.connected) child.send(value as object, error => { if (error) stop(new Error("Sass compiler channel closed")); }); };
      child.on("message", (message: unknown) => {
        if (stopped || !message || typeof message !== "object") return;
        const value = message as Record<string, unknown>;
        if (value.t === "ready" && !ready) {
          ready = true; clearTimeout(timer);
          const requested = options.executionTimeoutMs;
          const duration = requested !== undefined && Number.isFinite(requested) ? Math.max(1, Math.min(10_000, requested)) : 10_000;
          timer = setTimeout(() => stop(new Error("Sass compilation time budget exceeded")), duration);
          send({ t: "start", ...input });
        } else if (value.t === "result") {
          if (typeof value.css !== "string" || Buffer.byteLength(value.css) > 2 * 1024 * 1024) return stop(new Error("Sass output budget exceeded"));
          result = { css: value.css, version: typeof value.version === "string" && value.version.length <= 40 ? value.version : null };
          stop();
        } else if (value.t === "error") {
          stop(new Error(typeof value.error === "string" ? value.error.slice(0, 8192) : "Sass compilation failed"));
        } else if (value.t === "canonicalize" || value.t === "load") {
          if (++requests > 16_384 || ++pending > 16 || !Number.isSafeInteger(value.id) || typeof value.url !== "string" || value.url.length > 4096)
            return stop(new Error("Sass import budget exceeded"));
          void (async () => {
            try {
              const context = value.context as { fromImport?: boolean; containingUrl?: string | null } | undefined;
              const response = value.t === "load" ? await importer.load(new URL(value.url as string)) : await importer.canonicalize(value.url as string, {
                fromImport: context?.fromImport === true,
                containingUrl: typeof context?.containingUrl === "string" ? new URL(context.containingUrl) : null,
              });
              send({ t: "reply", id: value.id, value: response instanceof URL ? response.href : response });
            } catch (error) {
              send({ t: "reply", id: value.id, error: (error instanceof Error ? error.message : "Sass import failed").slice(0, 8192) });
            } finally { pending--; }
          })();
        }
      });
    });
  } finally { release(); }
}
