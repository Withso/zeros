import { createServer, type Server } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { DesignCaptureAdmission } from "./capture-admission";
import {
  DESIGN_CAPTURE_HTML_BYTES,
  DESIGN_CAPTURE_PNG_BYTES,
  DESIGN_CAPTURE_TIMEOUT_MS,
  designCaptureRequestSchema,
  type DesignCaptureReply,
  type DesignCaptureRequest,
} from "@zeros/protocol/design-capture";

export interface DesignCaptureService {
  url: string;
  token: string;
  stop(): Promise<void>;
}
export type DesignCaptureHost = (
  input: DesignCaptureRequest,
  signal: AbortSignal,
) => Promise<{ bytes: Uint8Array; renderer: string }>;

export function assertDesignCapturePng(
  bytes: Uint8Array,
  width: number,
  height: number,
): void {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    data.length < 24 ||
    data.length > DESIGN_CAPTURE_PNG_BYTES ||
    !data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) ||
    data.toString("ascii", 12, 16) !== "IHDR" ||
    data.readUInt32BE(16) !== width ||
    data.readUInt32BE(20) !== height
  ) {
    throw new Error(
      "The Design capture is not a bounded PNG at the requested dimensions.",
    );
  }
}

/** Private per-boot main/worker→engine service. No filesystem paths or source
 * authority cross this boundary; it receives already composed authored HTML.
 * One admitted request includes upload, render and cleanup. Saturation fails
 * immediately instead of retaining queued HTML or allocating more browsers. */
export async function startDesignCaptureService(
  render: DesignCaptureHost,
  admission = new DesignCaptureAdmission(),
): Promise<DesignCaptureService> {
  const nativeOwner = {};
  const token = randomBytes(32).toString("hex");
  const expected = Buffer.from(`Bearer ${token}`);
  let stopped = false;
  let active: AbortController | null = null;
  let activeJob: string | null = null;
  const cancelledJobs = new Map<string, number>();
  const completedJobs = new Set<string>();
  let flight: Promise<void> | null = null;
  let serviceUrl = "";
  const server: Server = createServer(
    { maxHeaderSize: 16 * 1024 },
    (request, response) => {
      const fail = (status: number, error: string) => {
        response.writeHead(status, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          Connection: "close",
        });
        response.end(JSON.stringify({ error }));
      };
      const supplied = Buffer.from(request.headers.authorization ?? "");
      if (
        request.headers.origin ||
        request.headers.host !== new URL(serviceUrl).host ||
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      ) {
        fail(401, "Unauthorized capture request.");
        return;
      }
      const cancellation = request.method === "DELETE" && /^\/capture\/([a-f0-9-]{36})$/.exec(request.url ?? "");
      // Identified requests carry an absolute deadline. Expiring a tombstone
      // cannot resurrect a delayed POST: that POST's deadline has also expired.
      const deadlineHeader = request.headers["x-zeros-design-deadline"];
      const deadline = typeof deadlineHeader === "string" ? Number(deadlineHeader) : NaN;
      for (const [id, expires] of cancelledJobs) if (expires < Date.now()) cancelledJobs.delete(id);
      if (cancellation) {
        const id = cancellation[1]!;
        if (activeJob !== id && !completedJobs.has(id)) {
          if (!Number.isSafeInteger(deadline) || deadline > Date.now() + DESIGN_CAPTURE_TIMEOUT_MS + 1_000) { fail(422, "Invalid capture deadline."); return; }
          if (deadline >= Date.now()) {
            if (cancelledJobs.size >= 128 && !cancelledJobs.has(id)) { fail(429, "Capture cancellation capacity reached."); return; }
            cancelledJobs.set(id, deadline);
          }
        }
        const current = activeJob === id ? flight : null;
        if (activeJob === id) active?.abort(new Error("Design capture cancelled."));
        void Promise.resolve(current).then(() => {
          if (response.destroyed) return;
          response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          response.end(JSON.stringify({ settled: true }));
        });
        return;
      }
      if (request.method !== "POST" || request.url !== "/capture") {
        fail(404, "Unknown capture operation.");
        return;
      }
      if (stopped) {
        fail(
          429,
          "Design capture capacity reached. Wait for the active capture.",
        );
        return;
      }
      const controller = new AbortController();
      const job = request.headers["x-zeros-design-job"];
      if (job !== undefined && (typeof job !== "string" || !/^[a-f0-9-]{36}$/.test(job))) { fail(422, "Invalid capture job."); return; }
      if (job !== undefined && (!Number.isSafeInteger(deadline) || deadline < Date.now() || deadline > Date.now() + DESIGN_CAPTURE_TIMEOUT_MS + 1_000)) { fail(422, "Invalid capture deadline."); return; }
      if (typeof job === "string" && (cancelledJobs.has(job) || completedJobs.has(job))) {
        fail(422, "Design capture job already retired.");
        return;
      }
      if (cancelledJobs.size >= 128) { fail(429, "Capture cancellation capacity reached."); return; }
      const reservationId = typeof job === "string" ? job : randomUUID();
      if (!admission.reserve(nativeOwner, reservationId, request.headers["x-zeros-design-priority"] !== "optional")) {
        fail(429, "Design capture capacity reached. Wait for the active capture.");
        return;
      }
      active = controller;
      activeJob = typeof job === "string" ? job : null;
      const timeout = setTimeout(
        () => controller.abort(new Error("Design capture timed out.")),
        job === undefined ? DESIGN_CAPTURE_TIMEOUT_MS : Math.max(1, deadline - Date.now()),
      );
      const disconnect = () => {
        if (!response.writableEnded)
          controller.abort(new Error("Design capture disconnected."));
      };
      response.once("close", disconnect);
      const abort = () => {
        // Preserve cancellation even after its original POST settles. At most
        // one active job can join the 128 bounded cancel-before-start records.
        if (activeJob && deadline >= Date.now()) cancelledJobs.set(activeJob, deadline);
        if (!activeJob) {
          request.destroy();
          response.destroy();
        } else if (!request.complete) request.destroy();
      };
      controller.signal.addEventListener("abort", abort, { once: true });
      flight = (async () => {
        try {
          let size = 0;
          const chunks: Buffer[] = [];
          // JSON escapes can expand a valid HTML string; bound both transport and
          // decoded bytes. A hostile upload cannot keep the slot past its deadline.
          for await (const chunk of request) {
            size += chunk.length;
            if (size > DESIGN_CAPTURE_HTML_BYTES + 1024 * 1024) {
              fail(413, "Capture HTML is too large.");
              return;
            }
            chunks.push(Buffer.from(chunk));
          }
          controller.signal.throwIfAborted();
          if (activeJob && cancelledJobs.has(activeJob)) throw new Error("Design capture cancelled before admission.");
          const input = designCaptureRequestSchema.parse(
            JSON.parse(Buffer.concat(chunks).toString("utf8")),
          );
          if (Buffer.byteLength(input.html) > DESIGN_CAPTURE_HTML_BYTES) {
            fail(413, "Capture HTML is too large.");
            return;
          }
          const result = await render(input, controller.signal);
          controller.signal.throwIfAborted();
          assertDesignCapturePng(result.bytes, input.width, input.height);
          const value: DesignCaptureReply = {
            version: 1,
            revision: input.revision,
            width: input.width,
            height: input.height,
            data: Buffer.from(result.bytes).toString("base64"),
            renderer: result.renderer,
          };
          response.writeHead(200, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          });
          response.end(JSON.stringify(value));
        } catch {
          if (!response.destroyed && !response.headersSent)
            fail(422, "Design capture failed. The source was not changed.");
        } finally {
          clearTimeout(timeout);
          response.removeListener("close", disconnect);
          controller.signal.removeEventListener("abort", abort);
          active = null;
          if (activeJob) {
            completedJobs.add(activeJob);
            while (completedJobs.size > 128) completedJobs.delete(completedJobs.values().next().value!);
          }
          activeJob = null;
          flight = null;
          admission.release(nativeOwner, reservationId);
        }
      })();
    },
  );
  server.maxConnections = 8;
  server.headersTimeout = 5_000;
  server.requestTimeout = DESIGN_CAPTURE_TIMEOUT_MS;
  server.keepAliveTimeout = 1_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Capture service did not bind.");
  serviceUrl = `http://127.0.0.1:${address.port}`;
  return {
    url: serviceUrl,
    token,
    async stop() {
      if (stopped) return;
      stopped = true;
      active?.abort(new Error("Design capture host stopped."));
      // A trusted renderer must stop on AbortSignal. Do not release capacity
      // for another render while cleanup is still owned by the prior request.
      await flight;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      cancelledJobs.clear();
      completedJobs.clear();
    },
  };
}
