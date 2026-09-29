/** Bound response allocation as chunks arrive; never reflect parser/provider data. */
export async function boundedJson(
  response: Response,
  maximum: number,
): Promise<unknown> {
  if (
    !response.ok ||
    Number(response.headers.get("content-length") ?? 0) > maximum
  ) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Dev connection response unavailable");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Dev connection response unavailable");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > maximum) throw new Error("oversized");
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Dev connection response unavailable");
  } finally {
    await reader.cancel().catch(() => {});
  }
}
