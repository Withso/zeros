/** Git packs can be much larger than API/receipt responses. Stream with a
 * small lookbehind so a credential spanning chunks is never emitted. Errors
 * terminate the transfer with fixed text; upstream diagnostics stay private. */
export function githubGitDownload(
  body: ReadableStream<Uint8Array> | null,
  secrets: string[],
): ReadableStream<Uint8Array> | null {
  if (!body) return null;
  const hold =
    Math.max(...secrets.map((secret) => Buffer.byteLength(secret))) - 1;
  const reader = body.getReader();
  let tail = Buffer.alloc(0);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) {
            if (tail.length) controller.enqueue(tail);
            reader.releaseLock();
            controller.close();
            return;
          }
          const bytes = Buffer.concat([tail, chunk.value]);
          if (secrets.some((secret) => bytes.includes(secret)))
            throw new Error();
          const emit = Math.max(0, bytes.length - hold);
          tail = Buffer.from(bytes.subarray(emit));
          if (emit) {
            controller.enqueue(bytes.subarray(0, emit));
            return;
          }
        }
      } catch {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
        controller.error(new Error("GitHub response unavailable"));
      }
    },
    async cancel() {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    },
  });
}
