import { afterEach, expect, it, vi } from "vitest";
import { FileMediaStreams } from "../file-media-stream";
import { randomUUID } from "node:crypto";

afterEach(() => vi.useRealTimers());
function fixture(bytes = 200_000_000) {
  const streams = new FileMediaStreams(), send = vi.fn();
  const sourceId = randomUUID();
  const url = streams.register(1, { sourceId, bytes, mimeType: "video/mp4" }, send);
  return { streams, send, sourceId, url };
}
it("streams a seek on demand in at most 1 MiB reads, without prefetching the body", async () => {
  const { streams, send, url } = fixture();
  const response = streams.response(new Request(url, { headers: { Range: "bytes=180000000-181048579" } }));
  expect(response.status).toBe(206);
  expect(response.headers.get("content-range")).toBe("bytes 180000000-181048579/200000000");
  expect(send).not.toHaveBeenCalled();
  const reader = response.body!.getReader();
  for (let index = 0; index < 4; index++) {
    const read = reader.read(); await Promise.resolve();
    const request = send.mock.calls[index][0];
    expect(request).toMatchObject({ offset: 180000000 + index * 256 * 1024, length: 256 * 1024 });
    streams.reply(1, { requestId: request.requestId, base64: Buffer.alloc(256 * 1024, 7).toString("base64") });
    expect((await read).value?.length).toBe(256 * 1024);
    expect(send).toHaveBeenCalledTimes(index + 1);
  }
  const second = reader.read(); await Promise.resolve();
  const last = send.mock.calls[4][0];
  expect(last).toMatchObject({ offset: 181048576, length: 4 });
  streams.reply(1, { requestId: last.requestId, base64: "AQIDBA==" });
  expect((await second).value).toEqual(Buffer.from([1, 2, 3, 4]));
  expect((await reader.read()).done).toBe(true);
});
it("handles HEAD, suffix, EOF and bad ranges without widening a request", () => {
  const { streams, url, send } = fixture(10);
  expect(streams.response(new Request(url, { method: "HEAD" })).headers.get("content-length")).toBe("10");
  for (const range of ["bytes=10-", "bytes=9-8", "bytes=0-1,4-5", "bytes=-0", "items=0-1"])
    expect(streams.response(new Request(url, { headers: { range } })).status).toBe(416);
  const suffix = streams.response(new Request(url, { method: "HEAD", headers: { range: "bytes=-3" } }));
  expect(suffix.headers.get("content-range")).toBe("bytes 7-9/10");
  expect(send).not.toHaveBeenCalled();
  const empty = fixture(0);
  expect(empty.streams.response(new Request(empty.url)).headers.get("content-length")).toBe("0");
});
it("preserves the full advertised range so Chromium can seek past its buffered bytes", () => {
  const { streams, url, send } = fixture();
  const response = streams.response(new Request(url, { method: "HEAD", headers: { range: "bytes=50000000-" } }));
  expect(response.headers.get("content-range")).toBe("bytes 50000000-199999999/200000000");
  expect(response.headers.get("content-length")).toBe("150000000");
  expect(send).not.toHaveBeenCalled();
});
it("refuses foreign replies, malformed capabilities and oversized registrations", async () => {
  vi.useFakeTimers();
  const { streams, url, sourceId, send } = fixture(4);
  expect(() => streams.register(2, { sourceId, bytes: 200_000_001, mimeType: "video/mp4" }, send)).toThrow();
  expect(streams.response(new Request(`${url}?other=1`)).status).toBe(404);
  expect(streams.owns(2, url)).toBe(false);
  const body = streams.response(new Request(url)).body!.getReader();
  const read = body.read(); await Promise.resolve();
  streams.reply(2, { requestId: send.mock.calls[0][0].requestId, base64: "AQIDBA==" });
  const rejected = expect(read).rejects.toThrow(/timed out/);
  await vi.advanceTimersByTimeAsync(30_000); await rejected;
});
it("closing a source cancels a pending read and retires idle stream capacity", async () => {
  const { streams, url, sourceId, send } = fixture();
  const reader = streams.response(new Request(url)).body!.getReader();
  const read = reader.read(); await Promise.resolve();
  const rejected = expect(read).rejects.toThrow(/cancel/);
  streams.close(1, sourceId); await rejected;
  expect(streams.response(new Request(url)).status).toBe(404);
  for (let index = 0; index < 24; index++) {
    const id = randomUUID(), next = streams.register(1, { sourceId: id, bytes: 1, mimeType: "image/png" }, send);
    expect(streams.response(new Request(next)).status).toBe(200);
    streams.close(1, id);
  }
});
it("bounds upstream reads during rapid seek cancellation until their replies drain", async () => {
  const { streams, url, send } = fixture();
  for (let index = 0; index < 3; index++) {
    const reader = streams.response(new Request(url, { headers: { range: `bytes=${index}-` } })).body!.getReader();
    const read = reader.read(); await Promise.resolve();
    await reader.cancel(); await read;
  }
  expect(send).toHaveBeenCalledTimes(3);
  const response = streams.response(new Request(url));
  expect(response.status).toBe(200);
  const reader = response.body!.getReader(), read = reader.read(); await Promise.resolve();
  expect(send).toHaveBeenCalledTimes(3);
  streams.reply(1, { requestId: send.mock.calls[0][0].requestId, error: true });
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(4));
  await reader.cancel(); await read;
  for (const [request] of send.mock.calls) streams.reply(1, { requestId: request.requestId, error: true });
});
