import { createHash, randomUUID } from "node:crypto";
import type { DesignHeadlessRenderer } from "@zeros/design-web";
import {
  DESIGN_CAPTURE_MAX_DIMENSION,
  DESIGN_CAPTURE_PNG_BYTES,
  DESIGN_CAPTURE_TIMEOUT_MS,
  DesignCaptureCleanupUnconfirmedError,
  designCaptureReplySchema,
} from "@zeros/protocol/design-capture";
import { assertDesignCapturePng } from "./capture-service";
import { prepareFrameRenderSource } from "./render-preparation";
import { readCanvas } from "./document-storage";
import { assertDesignThemeName } from "./document";
import { readDesignThemeCatalog } from "./themes";
import { withDesignTheme } from "./source";

const inherited = {
  url: process.env.ZEROS_DESIGN_CAPTURE_URL,
  token: process.env.ZEROS_DESIGN_CAPTURE_TOKEN,
};
// Main/worker authority is never ambient authority in an agent subprocess.
// This module is loaded before the native gateway can admit an execution.
delete process.env.ZEROS_DESIGN_CAPTURE_URL;
delete process.env.ZEROS_DESIGN_CAPTURE_TOKEN;
export interface DesignCaptureConfig {
  url: string;
  token: string;
}
let configuredHost: DesignCaptureConfig | undefined;
/** Engine/main ownership only; this setter is never a bridge or tool method. */
export function setDesignCaptureConfig(
  value: DesignCaptureConfig | undefined,
): void {
  configuredHost = value;
}
export function resolveDesignCaptureConfig(
  input = configuredHost ?? inherited,
): DesignCaptureConfig | null {
  if (!input.url || !input.token || !/^[a-f0-9]{64}$/.test(input.token))
    return null;
  try {
    const url = new URL(input.url);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      return null;
    return { url: url.origin, token: input.token };
  } catch {
    return null;
  }
}

export interface DesignEvidenceRenderer extends DesignHeadlessRenderer {
  renderComposed?(
    input: Parameters<DesignHeadlessRenderer["render"]>[0] & {
      html: string;
      sourceVersion: string;
      rasterSize?: { width: number; height: number };
    },
  ): ReturnType<DesignHeadlessRenderer["render"]>;
}

function waitForCapacity(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const abort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export function createDesignCaptureRenderer(
  workspacePath: string,
  config: DesignCaptureConfig | null = resolveDesignCaptureConfig(),
  fetchImpl: typeof fetch = fetch,
  options: {
    /** The caller already refused themes the canvas does not offer. */
    themeChecked?: boolean;
    /** Wait for a busy capture slot (the default). Background previews pass
     * false: they yield the slot and ask again on their own schedule. */
    capacityRetry?: boolean;
  } = {},
): DesignEvidenceRenderer | undefined {
  if (!config) return undefined;
  const renderComposed: NonNullable<
    DesignEvidenceRenderer["renderComposed"]
  > = async ({ state, viewport, signal, html, sourceVersion, rasterSize }) => {
    signal?.throwIfAborted();
    const composed = { sanitized: html, sourceVersion };
    const raster = rasterSize ?? viewport;
    const body = JSON.stringify({
      version: 1,
      html: composed.sanitized,
      revision: state.revision,
      width: raster.width,
      height: raster.height,
      ...(raster.width !== viewport.width || raster.height !== viewport.height
        ? {
            layoutViewport: { width: viewport.width, height: viewport.height },
            // A preview raster below the default bound names its bound, so
            // the host computes the same scale (designCaptureRasterSize).
            ...(Math.max(raster.width, raster.height) < DESIGN_CAPTURE_MAX_DIMENSION
              ? { maxDimension: Math.max(raster.width, raster.height) } : {}),
          } : {}),
      colorScheme: viewport.colorScheme,
    });
    const post = async () => {
      signal?.throwIfAborted();
      const jobId = randomUUID();
      const deadline = String(Date.now() + DESIGN_CAPTURE_TIMEOUT_MS);
      let settled = false;
      let cancellation: Promise<void> | null = null;
      const transport = new AbortController();
      const cancel = () => {
        cancellation ??= fetchImpl(`${config.url}/capture/${jobId}`, {
          method: "DELETE", headers: { Authorization: `Bearer ${config.token}`, "X-Zeros-Design-Deadline": deadline }, redirect: "error",
          signal: AbortSignal.timeout(DESIGN_CAPTURE_TIMEOUT_MS + 5_000),
        }).then(async (response) => {
          if (!response.ok) { await response.body?.cancel(); throw new DesignCaptureCleanupUnconfirmedError(); }
          if ((await response.json() as { settled?: unknown }).settled !== true) throw new DesignCaptureCleanupUnconfirmedError();
        }).finally(() => {
          // Cleanup acknowledgement owns cancellation. Once it has settled,
          // a missing POST reply must not keep the caller or its socket alive.
          // An unconfirmed retirement still poisons admission below.
          transport.abort(signal?.reason);
        });
        void cancellation.catch(() => {});
      };
      signal?.addEventListener("abort", cancel, { once: true });
      let outcome: { response: Response } | { error: unknown };
      try {
        const response = await fetchImpl(`${config.url}/capture`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
        "X-Zeros-Design-Job": jobId,
        "X-Zeros-Design-Deadline": deadline,
        "X-Zeros-Design-Priority": options.capacityRetry === false ? "optional" : "explicit",
      },
      redirect: "error",
      // Caller abort joins native retirement before aborting this transport.
      // A missing host reply also needs a finite deadline; transport failure
      // still joins cancellation and never establishes retirement by itself.
      signal: AbortSignal.any([transport.signal, AbortSignal.timeout(DESIGN_CAPTURE_TIMEOUT_MS + 5_000)]),
      body,
        });
        settled = true; // The host sends headers only after render/cleanup.
        if (signal?.aborted) { await response.body?.cancel(); signal.throwIfAborted(); }
        outcome = { response };
      } catch (error) {
        // A broken response is not evidence that the host disposed its window.
        // Ask the authenticated job endpoint to cancel and join cleanup.
        cancel();
        outcome = { error };
      } finally {
        signal?.removeEventListener("abort", cancel);
      }
      try { await cancellation; }
      catch { if (!settled) throw new DesignCaptureCleanupUnconfirmedError(); }
      if ("error" in outcome) throw outcome.error;
      return outcome.response;
    };
    let response = await post();
    // The host renders one capture at a time and refuses the rest. A canvas
    // preview may hold the slot for one render, so an explicit capture waits
    // for it, bounded by the longest render, instead of failing.
    for (
      let delay = 100, deadline = Date.now() + DESIGN_CAPTURE_TIMEOUT_MS;
      response.status === 429 && options.capacityRetry !== false && Date.now() + delay < deadline;
      delay = Math.min(delay * 2, 1_000)
    ) {
      await response.body?.cancel();
      await waitForCapacity(delay, signal);
      response = await post();
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        response.status === 429
          ? "Design capture capacity reached. Try again when the active render finishes."
          : "Design capture host is unavailable or could not render this revision.",
      );
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Design capture returned no evidence.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > Math.ceil((DESIGN_CAPTURE_PNG_BYTES * 4) / 3) + 4096)
          throw new Error("Design capture response exceeds its byte limit.");
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const reply = designCaptureReplySchema.parse(
      JSON.parse(Buffer.concat(chunks).toString("utf8")),
    );
    if (
      reply.revision !== state.revision ||
      reply.width !== raster.width ||
      reply.height !== raster.height
    )
      throw new Error(
        "Design capture returned a different source or viewport.",
      );
    const bytes = Buffer.from(reply.data, "base64");
    assertDesignCapturePng(bytes, raster.width, raster.height);
    return {
      mimeType: "image/png",
      bytes,
      width: reply.width,
      height: reply.height,
      revision: state.revision,
      metadata: {
        renderer: reply.renderer,
        sourceVersion: composed.sourceVersion,
        htmlSha256: createHash("sha256")
          .update(composed.sanitized)
          .digest("hex"),
        pngSha256: createHash("sha256").update(bytes).digest("hex"),
        networkDisabled: true,
        authoredJavaScriptDisabled: true,
        deviceScaleFactor: 1,
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
        reducedMotion: true,
      },
    };
  };
  return {
    renderComposed,
    async render(input) {
      input.signal?.throwIfAborted();
      // API captures use the same default as the canvas, or a theme the canvas
      // Themes control offers (as `design capture --theme` does). Read the
      // theme and imported styles from one canvas snapshot; renderComposed
      // callers have already chosen their theme (an explicit CLI preview).
      const canvas = await readCanvas(workspacePath).catch(() => undefined);
      input.signal?.throwIfAborted();
      if (input.theme !== undefined && !options.themeChecked)
        await assertDesignThemeName(workspacePath, input.theme);
      input.signal?.throwIfAborted();
      const theme = input.theme ?? (canvas ? readDesignThemeCatalog(canvas).baseId : null);
      const composed = await prepareFrameRenderSource(
        workspacePath,
        input.state.files[input.state.entryFile]!,
        input.viewport,
        input.state.files,
        undefined,
        input.state.entryFile,
        canvas,
      );
      input.signal?.throwIfAborted();
      return renderComposed({
        ...input,
        html: theme === null ? composed.sanitized : withDesignTheme(composed.sanitized, theme),
        sourceVersion: composed.sourceVersion,
      });
    },
  };
}
