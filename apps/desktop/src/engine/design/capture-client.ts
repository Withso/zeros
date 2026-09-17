import { createHash } from "node:crypto";
import type { DesignHeadlessRenderer } from "@zeros/design-web";
import {
  DESIGN_CAPTURE_PNG_BYTES,
  DESIGN_CAPTURE_TIMEOUT_MS,
  designCaptureReplySchema,
} from "@zeros/protocol/design-capture";
import { assertDesignCapturePng } from "./capture-service";
import { prepareFrameRenderSource } from "./render-preparation";

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
    },
  ): ReturnType<DesignHeadlessRenderer["render"]>;
}

export function createDesignCaptureRenderer(
  workspacePath: string,
  config: DesignCaptureConfig | null = resolveDesignCaptureConfig(),
  fetchImpl: typeof fetch = fetch,
): DesignEvidenceRenderer | undefined {
  if (!config) return undefined;
  const renderComposed: NonNullable<
    DesignEvidenceRenderer["renderComposed"]
  > = async ({ state, viewport, signal, html, sourceVersion }) => {
    signal?.throwIfAborted();
    const composed = { sanitized: html, sourceVersion };
    const response = await fetchImpl(`${config.url}/capture`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
      },
      redirect: "error",
      signal: AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(DESIGN_CAPTURE_TIMEOUT_MS + 1_000),
      ]),
      body: JSON.stringify({
        version: 1,
        html: composed.sanitized,
        revision: state.revision,
        width: viewport.width,
        height: viewport.height,
        colorScheme: viewport.colorScheme,
      }),
    });
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
      reply.width !== viewport.width ||
      reply.height !== viewport.height
    )
      throw new Error(
        "Design capture returned a different source or viewport.",
      );
    const bytes = Buffer.from(reply.data, "base64");
    assertDesignCapturePng(bytes, viewport.width, viewport.height);
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
        reducedMotion: true,
      },
    };
  };
  return {
    renderComposed,
    async render(input) {
      input.signal?.throwIfAborted();
      const composed = await prepareFrameRenderSource(
        workspacePath,
        input.state.files[input.state.entryFile]!,
        input.viewport,
        input.state.files,
      );
      return renderComposed({
        ...input,
        html: composed.sanitized,
        sourceVersion: composed.sourceVersion,
      });
    },
  };
}
