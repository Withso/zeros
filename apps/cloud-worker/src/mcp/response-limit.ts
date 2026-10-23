export const MAX_MCP_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Limit decoded HTTP bodies and individual SSE events without limiting the
 * lifetime of a healthy stream. Cancellation also withdraws the source reader. */
export function limitMcpResponse(response: Response, signal: AbortSignal): Response {
  if (!response.body) return response;
  const reader = response.body.getReader();
  const events = response.ok && response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() === "text/event-stream";
  let finished = false, bytes = 0, lineBytes = 0, afterCR = false;
  let abort: () => void;
  const stop = (reason?: unknown) => {
    if (finished) return Promise.resolve();
    finished = true; signal.removeEventListener("abort", abort);
    return reader.cancel(reason).catch(() => {}).finally(() => reader.releaseLock());
  };
  const check = () => { if (bytes > MAX_MCP_RESPONSE_BYTES) throw new Error("MCP response exceeded the size limit."); };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      abort = () => { if (!finished) { controller.error(signal.reason); void stop(signal.reason); } };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    },
    async pull(controller) {
      try {
        const next = await reader.read();
        if (finished) return;
        if (next.done) {
          finished = true; signal.removeEventListener("abort", abort); reader.releaseLock(); controller.close(); return;
        }
        if (events) {
          for (const byte of next.value) {
            if (afterCR) {
              afterCR = false;
              if (byte === 10) { if (bytes) { bytes++; check(); } continue; }
            }
            bytes++; check();
            if (byte === 10 || byte === 13) {
              if (!lineBytes) bytes = 0;
              lineBytes = 0; afterCR = byte === 13;
            } else lineBytes++;
          }
        } else { bytes += next.value.byteLength; check(); }
        controller.enqueue(next.value);
      } catch (error) {
        if (!finished) { controller.error(error); await stop(error); }
      }
    },
    cancel: stop,
  }, { highWaterMark: 0 });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
