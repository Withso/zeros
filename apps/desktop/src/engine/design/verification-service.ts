import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { DesignContextReference, DesignVerificationAccess } from "@zeros/protocol/design-context";
import { isDesignFrameFile } from "@zeros/protocol/design-path";
import { DESIGN_CAPTURE_TIMEOUT_MS, DESIGN_STATIC_RENDER_CSS, designCaptureRasterSize } from "@zeros/protocol/design-capture";
import { createDesignCaptureRenderer, type DesignEvidenceRenderer } from "./capture-client";
import { assertDesignCapturePng } from "./capture-service";
import { createDesignContextReference, inspectDesignContext } from "./context";
import { assertDesignCheckoutReadable } from "./checkout-status";
import { withDesignDirectoryNameLease, withoutDesignDirectoryNameLease } from "./directory-registry";
import { readDirectoryDesignManifest } from "./metadata";
import { lintDesignDocument, listDesignFrames, readDesignWebDocumentState } from "./document";
import { prepareFrameRenderSource } from "./render-preparation";

const LEASE_MS = 30 * 60_000;
const MAX_LEASES = 32;
const PASSIVE_CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-same-origin";

export interface DesignVerificationOwner {
  workspaceId: string;
  workspacePath: string;
  directory: string;
  directoryId: string;
}
interface Lease extends DesignVerificationOwner { expiresAt: number; }

/** This command uses the same entrypoint in the Node dev engine and compiled
 * sidecar. Neither capture-host credentials nor a general engine token leave
 * the engine. The URL grants only bounded, read-only access to one directory. */
function commandPrefix(): string {
  const args = process.versions.bun
    ? [process.execPath, "design"]
    : [process.execPath, process.argv[1]!, "design"];
  return args.map((arg) => `'${arg.replace(/'/g, "'\\''")}'`).join(" ");
}

// Only this trusted wrapper executes scripts. Authored content lives in a
// separate iframe with no script capability. One visible-page refresh at a
// time, no background capture or open browser owned by this service.
const PREVIEW_SCRIPT = `
const frame = document.querySelector('iframe');
const status = document.querySelector('output');
const expectedId = new URL(location.href).searchParams.get('frameId');
let version = '', stopped = false, initialized = false, readyDocument = null;
window.__ZEROS_FRAME_PREVIEW__ = { ready: false };
function invalidateDocument() {
  readyDocument = null;
  const error = 'Preview document replaced. Refreshing frame.';
  window.__ZEROS_FRAME_PREVIEW__ = { ready: false, error };
  status.textContent = error;
}
frame.addEventListener('load', () => {
  if (readyDocument && frame.contentDocument !== readyDocument) invalidateDocument();
});
frame.addEventListener('error', invalidateDocument);
async function refresh() {
  if (stopped) return;
  // Native browser tabs can start offscreen. Render their explicit navigation
  // once; only subsequent refresh work requires a visible page.
  if (!document.hidden || !initialized) try {
    initialized = true;
    const response = await fetch('./state' + (expectedId ? '?frameId=' + encodeURIComponent(expectedId) : ''), { cache: 'no-store', signal: AbortSignal.timeout(${DESIGN_CAPTURE_TIMEOUT_MS + 2000}) });
    const state = await response.json();
    if (!response.ok) throw new Error(state.error || 'Preview unavailable');
    if (state.reference.revision !== version || !window.__ZEROS_FRAME_PREVIEW__.ready) {
      version = state.reference.revision;
      readyDocument = null;
      window.__ZEROS_FRAME_PREVIEW__ = { ...state, ready: false };
      frame.width = state.width; frame.height = state.height;
      await new Promise((resolve, reject) => {
        let settled = false;
        const finish = error => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          frame.onload = frame.onerror = null;
          error ? reject(error) : resolve();
        };
        const timer = setTimeout(() => finish(new Error('Frame resources timed out. Retrying preview.')), ${DESIGN_CAPTURE_TIMEOUT_MS});
        frame.onerror = () => finish(new Error('Frame could not load. Retrying preview.'));
        frame.onload = async () => {
          try {
            const doc = frame.contentDocument;
            if (doc?.querySelector('meta[name="zeros-frame-revision"]')?.content !== version) throw new Error('Frame changed; refreshing');
            // Authored links retain their appearance, but this static preview
            // cannot navigate away from the document whose readiness it reports.
            const preventNavigation = event => {
              if (event.target.closest?.('a[href],area[href]')) event.preventDefault();
            };
            doc.addEventListener('click', preventNavigation, true);
            doc.addEventListener('auxclick', preventNavigation, true);
            await doc.fonts.ready;
            await Promise.all([...doc.images].map(img => img.complete ? Promise.resolve() : new Promise(done => { img.onload = done; img.onerror = done; })));
            if (settled || stopped) return;
            if (doc !== frame.contentDocument) throw new Error('Preview replaced');
            readyDocument = doc;
            window.__ZEROS_FRAME_PREVIEW__ = { ...state, ready: true };
            status.textContent = state.width + ' × ' + state.height + ' · ' + version;
            finish();
          } catch (error) { finish(error); }
        };
        frame.src = './document?revision=' + version + '&frameId=' + encodeURIComponent(state.reference.frameId || '');
      });
    }
  } catch (error) {
    window.__ZEROS_FRAME_PREVIEW__ = { ready: false, error: error.message };
    status.textContent = error.message;
  }
  if (!stopped) setTimeout(refresh, 1500);
}
addEventListener('pagehide', () => { stopped = true; });
refresh();`;
const PREVIEW_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Design preview</title><style>body{margin:0;background:Canvas;color:CanvasText;font:12px system-ui}output{display:block;padding:8px}iframe{display:block;border:0;background:Canvas}</style></head><body><output>Loading frame…</output><iframe title="Design frame" sandbox="allow-same-origin"></iframe><script>${PREVIEW_SCRIPT}</script></body></html>`;
const PREVIEW_CSP = `default-src 'none'; script-src 'sha256-${createHash("sha256").update(PREVIEW_SCRIPT).digest("base64")}'; style-src 'unsafe-inline'; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'`;

interface DesignVerificationOptions {
  renderer?: (root: string) => DesignEvidenceRenderer | undefined;
  now?: () => number;
}

export function startDesignVerificationService(options: DesignVerificationOptions = {}) {
  return withoutDesignDirectoryNameLease(() => startVerificationServer(options));
}

async function startVerificationServer(options: DesignVerificationOptions) {
  const now = options.now ?? Date.now;
  const rendererFor = options.renderer ?? createDesignCaptureRenderer;
  const leases = new Map<string, Lease>();
  let origin = "";
  let stopped = false;
  let active = 0;
  const controllers = new Set<AbortController>();
  const flights = new Set<Promise<void>>();
  const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
    const fail = (code: number, message: string) => {
      if (response.destroyed || response.headersSent) return;
      response.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ error: message }));
    };
    if (stopped || request.headers.host !== new URL(origin).host ||
        (request.headers.origin && request.headers.origin !== origin) ||
        (request.headers["sec-fetch-site"] === "cross-site" && request.headers["sec-fetch-mode"] !== "navigate")) {
      fail(403, "This preview is available only through its local workspace URL."); return;
    }
    if (request.method !== "GET" || (request.url?.length ?? 0) > 2048) { fail(405, "Use GET for Design verification."); return; }
    const url = new URL(request.url!, origin);
    const [, token, ...resource] = url.pathname.split("/");
    let action = "";
    if (resource.at(-1) === "") resource.pop();
    else if (["state", "validate", "document", "capture"].includes(resource.at(-1) ?? "")) action = resource.pop()!;
    const file = resource.join("/");
    const lease = token ? leases.get(token) : undefined;
    if (!lease || lease.expiresAt <= now()) {
      if (token) leases.delete(token);
      fail(410, "This Design preview expired. Open a fresh preview from the canvas or send the frame again."); return;
    }
    if (active >= 4) { fail(429, "Design verification is busy. Retry when the current request finishes."); return; }
    if (file !== "frames" && !isDesignFrameFile(file)) { fail(404, "Unknown Design frame."); return; }
    active++;
    const controller = new AbortController();
    controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(new Error("Design verification timed out.")), DESIGN_CAPTURE_TIMEOUT_MS + 2000);
    const disconnect = () => { if (!response.writableEnded) controller.abort(new Error("Preview disconnected.")); };
    response.once("close", disconnect);
    const send = (body: string | Uint8Array, type: string, headers: Record<string, string> = {}) => {
      controller.signal.throwIfAborted();
      response.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", ...headers });
      response.end(body);
    };
    const flight = withDesignDirectoryNameLease(lease.workspacePath, lease.directory, async () => {
      const assertOwner = () => {
        controller.signal.throwIfAborted();
        if (leases.get(token!) !== lease || lease.expiresAt <= now() ||
            readDirectoryDesignManifest(lease.workspacePath, lease.directory)?.id !== lease.directoryId)
          throw new Error("The Design directory was removed or replaced. Open a fresh preview.");
      };
      assertOwner();
      await assertDesignCheckoutReadable(lease.workspacePath);
      if (file === "frames") {
        const frames = await listDesignFrames(lease.workspacePath, { writeBack: false });
        assertOwner(); send(JSON.stringify({ frames }), "application/json"); return;
      }
      const reference = await createDesignContextReference(lease.workspacePath, lease.workspaceId, file!, undefined, lease.directoryId);
      if ((url.searchParams.has("revision") && url.searchParams.get("revision") !== reference.revision) ||
          (url.searchParams.has("frameId") && url.searchParams.get("frameId") !== reference.frameId)) {
        fail(409, "The frame changed. Validate the current revision before capturing it."); return;
      }
      const inspection = await inspectDesignContext(lease.workspacePath, reference);
      if (inspection.status !== "ready") { fail(409, "The frame changed while reading. Retry verification."); return; }
      const state = { reference, title: inspection.title, width: inspection.width, height: inspection.height };
      const assertRevision = async () => {
        assertOwner();
        if ((await inspectDesignContext(lease.workspacePath, reference)).status !== "ready")
          throw new Error("The frame changed during verification. Discard this result and capture its current revision.");
        assertOwner();
      };
      if (!action) {
        assertOwner(); send(PREVIEW_HTML, "text/html; charset=utf-8", { "Content-Security-Policy": PREVIEW_CSP }); return;
      }
      if (action === "state") {
        assertOwner(); send(JSON.stringify(state), "application/json"); return;
      }
      if (action === "validate") {
        const { workspacePath: _root, ...report } = await lintDesignDocument(lease.workspacePath, file, { healOids: false, includeRuntimeAudits: false });
        await assertRevision(); send(JSON.stringify({ ...state, report }), "application/json"); return;
      }
      const composed = await prepareFrameRenderSource(lease.workspacePath, inspection.source, state, undefined, undefined, file);
      if (composed.sourceVersion !== reference.revision) { fail(409, "Frame resources changed. Retry verification."); return; }
      if (action === "document") {
        await assertRevision();
        // Marker is added in the head by the parser-safe existing helper.
        const { insertDesignHeadMarkup } = await import("./source");
        const html = insertDesignHeadMarkup(composed.sanitized, `<meta name="zeros-frame-revision" content="${reference.revision}"><style>${DESIGN_STATIC_RENDER_CSS}html{color-scheme:light}</style>`);
        send(html, "text/html; charset=utf-8", { "Content-Security-Policy": PASSIVE_CSP }); return;
      }
      if (action === "capture") {
        const renderer = rendererFor(lease.workspacePath);
        if (!renderer?.renderComposed) { fail(503, "No qualified Design capture host is available. Validation and HTTP preview remain available."); return; }
        const document = await readDesignWebDocumentState(lease.workspacePath, file!);
        await assertRevision();
        const capturedAt = now();
        const viewport = { width: Math.ceil(state.width), height: Math.ceil(state.height), deviceScaleFactor: 1, colorScheme: "light" as const, reducedMotion: "reduce" as const };
        const rasterSize = designCaptureRasterSize(viewport);
        const artifact = await renderer.renderComposed({
          state: document, viewport, rasterSize,
          html: composed.sanitized, sourceVersion: reference.revision, signal: controller.signal,
        });
        assertDesignCapturePng(artifact.bytes, rasterSize.width, rasterSize.height);
        await assertRevision();
        send(artifact.bytes, "image/png", {
          "X-Design-Revision": reference.revision, "X-Design-Width": String(rasterSize.width), "X-Design-Height": String(rasterSize.height),
          "X-Design-Captured-At": String(capturedAt), "X-Design-Motion": "reduced",
        }); return;
      }
      fail(404, "Unknown Design verification operation.");
    }).catch((error: unknown) => {
      fail(controller.signal.aborted ? 408 : 409, error instanceof Error ? error.message : "Design verification failed.");
    }).finally(() => {
      clearTimeout(timeout); response.removeListener("close", disconnect);
      controllers.delete(controller); active--; flights.delete(flight);
    });
    flights.add(flight);
  });
  server.maxConnections = 16;
  server.headersTimeout = 5000;
  server.requestTimeout = DESIGN_CAPTURE_TIMEOUT_MS + 3000;
  server.keepAliveTimeout = 1000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Design verification did not bind.");
  origin = `http://127.0.0.1:${address.port}`;
  server.unref();
  return {
    register(owner: DesignVerificationOwner): DesignVerificationAccess {
      if (stopped) throw new Error("Design verification stopped.");
      for (const [key, lease] of leases) if (lease.expiresAt <= now()) leases.delete(key);
      // Reuse the exact owner without broadening an existing capability.
      let token = [...leases].find(([, lease]) => lease.workspaceId === owner.workspaceId && lease.workspacePath === owner.workspacePath && lease.directoryId === owner.directoryId && lease.directory === owner.directory)?.[0];
      if (!token) {
        if (leases.size >= MAX_LEASES) leases.delete(leases.keys().next().value!);
        token = randomBytes(24).toString("hex");
      }
      const expiresAt = now() + LEASE_MS;
      const existing = leases.get(token);
      if (existing) existing.expiresAt = expiresAt;
      else leases.set(token, { ...owner, expiresAt });
      return { url: `${origin}/${token}`, command: commandPrefix(), expiresAt, captureAvailable: !!rendererFor(owner.workspacePath)?.renderComposed };
    },
    revoke(workspaceId: string) { for (const [key, lease] of leases) if (lease.workspaceId === workspaceId) leases.delete(key); },
    async stop() {
      stopped = true; leases.clear(); for (const controller of controllers) controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.allSettled(flights);
    },
  };
}

let shared: ReturnType<typeof startDesignVerificationService> | undefined;
export async function openDesignVerification(owner: DesignVerificationOwner): Promise<DesignVerificationAccess> {
  shared ??= startDesignVerificationService().catch((error) => { shared = undefined; throw error; });
  return (await shared).register(owner);
}
export async function stopDesignVerification(): Promise<void> {
  const current = shared; shared = undefined; if (current) await (await current).stop();
}
export async function revokeDesignVerification(workspaceId: string): Promise<void> { if (shared) (await shared).revoke(workspaceId); }

export function designFramePreviewUrl(access: Pick<DesignVerificationAccess, "url">, reference: DesignContextReference): string {
  return `${access.url}/${reference.frame.split("/").map(encodeURIComponent).join("/")}/?frameId=${encodeURIComponent(reference.frameId ?? "")}`;
}
