import { afterEach, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import {
  startDesignCaptureService,
  type DesignCaptureService,
} from "../capture-service";
import { resolveDesignCaptureConfig } from "../capture-client";
import { DesignCaptureAdmission } from "../capture-admission";
const services: DesignCaptureService[] = [];
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1XcAAAAASUVORK5CYII=",
  "base64",
);
const input = {
  version: 1,
  html: "<html><body>Capture</body></html>",
  revision: "revision-a",
  width: 1,
  height: 1,
};

it("shares native export capacity with an in-frame reservation until exact-owner cleanup", async () => {
  const admission = new DesignCaptureAdmission();
  const renderer = {};
  expect(admission.reserve(renderer, "iframe")).toBe(true);
  const render = vi.fn(async () => ({ bytes: png, renderer: "fixture" }));
  const service = await startDesignCaptureService(render, admission);
  services.push(service);
  expect((await request(service)).status).toBe(429);
  expect(render).not.toHaveBeenCalled();
  expect(admission.release({}, "iframe")).toBe(false);
  expect(admission.release(renderer, "old-job")).toBe(false);
  expect((await request(service)).status).toBe(429);
  expect(admission.release(renderer, "iframe")).toBe(true);
  expect((await request(service)).status).toBe(200);
  expect(admission.usage()).toEqual({ running: 0, reservedBytes: 0 });
});

it("holds shared admission through native cancellation and prioritizes an awaiting explicit capture", async () => {
  const admission = new DesignCaptureAdmission();
  const entered = deferred<AbortSignal>();
  const cleanup = deferred<void>();
  const service = await startDesignCaptureService(async (_input, signal) => {
    entered.resolve(signal);
    await cleanup.promise;
    signal.throwIfAborted();
    return { bytes: png, renderer: "fixture" };
  }, admission);
  services.push(service);
  const controller = new AbortController();
  const first = request(service, input, controller.signal).catch(() => {});
  const signal = await entered.promise;
  const renderer = {};
  try {
    expect(admission.reserve(renderer, "export")).toBe(false);
    controller.abort();
    await vi.waitFor(() => expect(signal.aborted).toBe(true));
    expect(admission.reserve(renderer, "export")).toBe(false);
  } finally {
    cleanup.resolve();
    await first;
    await service.stop();
  }
  expect(admission.reserve(renderer, "preview", false)).toBe(false);
  expect(admission.reserve(renderer, "export")).toBe(true);
  admission.retireOwner({});
  expect(admission.usage().running).toBe(1);
  admission.retireOwner(renderer);
  expect(admission.usage()).toEqual({ running: 0, reservedBytes: 0 });
});

it("acknowledges a native job cancellation only after the renderer has disposed", async () => {
  const ready = deferred<AbortSignal>();
  const cleanup = deferred<void>();
  const service = await startDesignCaptureService(async (_input, signal) => {
    ready.resolve(signal);
    await cleanup.promise;
    signal.throwIfAborted();
    return { bytes: png, renderer: "fixture" };
  });
  services.push(service);
  const id = "a74675d2-627d-44ed-8954-0b9d80519a49";
  const first = fetch(`${service.url}/capture`, { method: "POST", headers: {
    Authorization: `Bearer ${service.token}`, "Content-Type": "application/json", "X-Zeros-Design-Job": id, "X-Zeros-Design-Deadline": String(Date.now() + 20_000),
  }, body: JSON.stringify(input) });
  const signal = await ready.promise;
  let settled = false;
  const cancel = fetch(`${service.url}/capture/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${service.token}`, "X-Zeros-Design-Deadline": String(Date.now() + 20_000) } }).then((response) => { settled = true; return response; });
  try {
    await vi.waitFor(() => expect(signal.aborted).toBe(true), { timeout: 1000 });
    expect(settled).toBe(false);
    expect((await request(service)).status).toBe(429);
  } finally {
    cleanup.resolve();
    await first;
    await cancel;
  }
  expect((await cancel).status).toBe(200);
  expect((await first).status).toBe(422);
  const replay = await fetch(`${service.url}/capture`, { method: "POST", headers: {
    Authorization: `Bearer ${service.token}`, "Content-Type": "application/json", "X-Zeros-Design-Job": id, "X-Zeros-Design-Deadline": String(Date.now() + 20_000),
  }, body: JSON.stringify(input) });
  expect(replay.status).toBe(422);
  await replay.arrayBuffer();
});
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()));
});
function request(
  service: DesignCaptureService,
  body: unknown = input,
  signal?: AbortSignal,
) {
  return fetch(`${service.url}/capture`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${service.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });
}
it("requires a private loopback bearer and exact bounded input/output", async () => {
  const render = vi.fn(async () => ({ bytes: png, renderer: "fixture" }));
  const service = await startDesignCaptureService(render);
  services.push(service);
  expect(
    (await fetch(`${service.url}/capture`, { method: "POST" })).status,
  ).toBe(401);
  expect(
    (
      await fetch(`${service.url}/capture`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${service.token}`,
          Origin: "https://example.invalid",
        },
      })
    ).status,
  ).toBe(401);
  expect((await request(service, { ...input, width: 2049 })).status).toBe(422);
  expect(render).not.toHaveBeenCalled();
  const reply = await (await request(service)).json();
  expect(reply).toMatchObject({
    version: 1,
    revision: "revision-a",
    width: 1,
    height: 1,
    data: png.toString("base64"),
  });
  expect((await request(service, { ...input, width: 2 })).status).toBe(422);
  expect(
    resolveDesignCaptureConfig({
      url: "https://example.invalid",
      token: service.token,
    }),
  ).toBeNull();
  expect(
    resolveDesignCaptureConfig({
      url: `${service.url}/escape`,
      token: service.token,
    }),
  ).toBeNull();
});
it("rejects saturation and forwards cancellation to the active renderer before admitting another", async () => {
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let cancelled!: () => void;
  const aborted = new Promise<void>((resolve) => {
    cancelled = resolve;
  });
  const service = await startDesignCaptureService(async (_input, signal) => {
    entered();
    await new Promise<void>((_resolve, reject) =>
      signal.addEventListener(
        "abort",
        () => {
          cancelled();
          reject(signal.reason);
        },
        { once: true },
      ),
    );
    return { bytes: png, renderer: "fixture" };
  });
  services.push(service);
  const controller = new AbortController();
  const first = request(service, input, controller.signal).catch(
    (error) => error,
  );
  await ready;
  expect((await request(service)).status).toBe(429);
  controller.abort();
  await aborted;
  await first;
  await service.stop();
});
it("revokes the render owner on service shutdown", async () => {
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let signal: AbortSignal | undefined;
  const service = await startDesignCaptureService(async (_input, current) => {
    signal = current;
    entered();
    await new Promise<void>((_resolve, reject) =>
      current.addEventListener("abort", () => reject(current.reason), {
        once: true,
      }),
    );
    return { bytes: png, renderer: "fixture" };
  });
  services.push(service);
  const pending = request(service).catch((error) => error);
  await ready;
  await service.stop();
  await pending;
  expect(signal?.aborted).toBe(true);
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}


it("bounds cancellation tombstones without a lifetime quota on late completed jobs", async () => {
  const render = vi.fn(async () => ({ bytes: png, renderer: "fixture" }));
  const service = await startDesignCaptureService(render);
  services.push(service);
  for (let index = 0; index < 132; index++) {
    const id = randomUUID();
    const response = await fetch(`${service.url}/capture`, { method: "POST", headers: {
      Authorization: `Bearer ${service.token}`, "Content-Type": "application/json", "X-Zeros-Design-Job": id, "X-Zeros-Design-Deadline": String(Date.now() + 20_000),
    }, body: JSON.stringify(input) });
    await response.arrayBuffer();
    const cancel = await fetch(`${service.url}/capture/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${service.token}`, "X-Zeros-Design-Deadline": String(Date.now() + 20_000) } });
    expect(cancel.status).toBe(200);
    expect(await cancel.json()).toEqual({ settled: true });
  }
  expect(render).toHaveBeenCalledTimes(132);
});

it("refuses a delayed POST after its cancel-before-start acknowledgement", async () => {
  const render = vi.fn(async () => ({ bytes: png, renderer: "fixture" }));
  const service = await startDesignCaptureService(render);
  services.push(service);
  const id = randomUUID();
  const cancel = await fetch(`${service.url}/capture/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${service.token}`, "X-Zeros-Design-Deadline": String(Date.now() + 20_000) } });
  expect(await cancel.json()).toEqual({ settled: true });
  const response = await fetch(`${service.url}/capture`, { method: "POST", headers: {
    Authorization: `Bearer ${service.token}`, "Content-Type": "application/json", "X-Zeros-Design-Job": id, "X-Zeros-Design-Deadline": String(Date.now() + 20_000),
  }, body: JSON.stringify(input) });
  expect(response.status).toBe(422);
  await response.arrayBuffer();
  const replay = await fetch(`${service.url}/capture`, { method: "POST", headers: {
    Authorization: `Bearer ${service.token}`, "Content-Type": "application/json", "X-Zeros-Design-Job": id, "X-Zeros-Design-Deadline": String(Date.now() + 20_000),
  }, body: JSON.stringify(input) });
  expect(replay.status).toBe(422);
  await replay.arrayBuffer();
  expect(render).not.toHaveBeenCalled();
});


it("expires tombstones while refusing the delayed original POST", async () => {
  const render = vi.fn(async () => ({ bytes: png, renderer: "fixture" }));
  const service = await startDesignCaptureService(render);
  services.push(service);
  const deadline = Date.now() + 20_000;
  const headers = { Authorization: `Bearer ${service.token}`, "X-Zeros-Design-Deadline": String(deadline) };
  const id = randomUUID();
  expect((await fetch(`${service.url}/capture/${id}`, { method: "DELETE", headers })).status).toBe(200);
  const clock = vi.spyOn(Date, "now").mockReturnValue(deadline + 1);
  try {
    const result = await fetch(`${service.url}/capture`, { method: "POST", headers: { ...headers, "X-Zeros-Design-Job": id }, body: JSON.stringify(input) });
    expect(result.status).toBe(422);
    await result.arrayBuffer();
    expect(render).not.toHaveBeenCalled();
  } finally { clock.mockRestore(); }
});

function batchRequest(service: DesignCaptureService, body: unknown) {
  return fetch(`${service.url}/batch`, {
    method: "POST",
    headers: { Authorization: `Bearer ${service.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
const css = "body{color:red}";
const cssHash = createHash("sha256").update(css).digest("hex");
const batchInput = (items = [{ id: "a", html: `<html><head><link rel="stylesheet" href="zeros-capture://css/${cssHash}"></head><body>A</body></html>`,
  viewport: { width: 1, height: 1 }, maxDimension: 64 }]) => ({ version: 1, revision: "batch-a", colorScheme: "light",
  stylesheets: { [cssHash]: css }, items });

it("renders a batch of frames in one admitted reservation and checks every picture it returns", async () => {
  const renderBatch = vi.fn(async (input: { items: Array<{ id: string }> }) => ({ renderer: "fixture",
    items: input.items.map(item => item.id === "wrong" ? { id: item.id, bytes: Buffer.from("not a png") }
      : item.id === "failed" ? { id: item.id, error: "layout failed" } : { id: item.id, bytes: png }) }));
  const service = await startDesignCaptureService(vi.fn(), new DesignCaptureAdmission(), renderBatch);
  services.push(service);
  expect((await fetch(`${service.url}/batch`, { method: "POST" })).status).toBe(401);
  const base = batchInput().items[0]!;
  const reply = await (await batchRequest(service, batchInput([base, { ...base, id: "wrong" }, { ...base, id: "failed" }]))).json();
  expect(reply).toEqual({ version: 1, revision: "batch-a", renderer: "fixture", items: [
    { id: "a", width: 1, height: 1, data: png.toString("base64") },
    { id: "wrong", error: "Design batch capture is not a bounded PNG at the requested size." },
    { id: "failed", error: "layout failed" },
  ] });
  expect(renderBatch).toHaveBeenCalledTimes(1);
});

it("refuses a batch whose sheets are not content-addressed or are missing, before rendering", async () => {
  const renderBatch = vi.fn(async () => ({ renderer: "fixture", items: [] }));
  const service = await startDesignCaptureService(vi.fn(), new DesignCaptureAdmission(), renderBatch);
  services.push(service);
  const forged = { ...batchInput(), stylesheets: { [cssHash]: "body{color:blue}" } };
  expect((await batchRequest(service, forged)).status).toBe(422);
  const missing = batchInput([{ ...batchInput().items[0]!, html: `<link rel="stylesheet" href="zeros-capture://css/${"0".repeat(64)}">` }]);
  expect((await batchRequest(service, missing)).status).toBe(422);
  expect((await batchRequest(service, { ...batchInput(), items: [] })).status).toBe(422);
  // Detail pictures go a few per batch: 64 at 1,280 px would exceed the pixel budget.
  const detail = batchInput(Array.from({ length: 11 }, (_, index) => ({ ...batchInput().items[0]!, id: `d${index}`, maxDimension: 1280 })));
  expect((await batchRequest(service, detail)).status).toBe(422);
  expect(renderBatch).not.toHaveBeenCalled();
});

it("gives an explicit capture the slot over a background batch and refuses a batch while it is held", async () => {
  const admission = new DesignCaptureAdmission();
  const renderBatch = vi.fn(async () => ({ renderer: "fixture", items: [] }));
  const service = await startDesignCaptureService(vi.fn(), admission, renderBatch);
  services.push(service);
  const owner = {};
  expect(admission.reserve(owner, "explicit-job", true)).toBe(true);
  expect((await batchRequest(service, batchInput())).status).toBe(429);
  admission.release(owner, "explicit-job");
  expect((await batchRequest(service, batchInput())).status).toBe(200);
  expect(renderBatch).toHaveBeenCalledTimes(1);
  // A service without a batch host keeps today's single-capture surface only.
  const single = await startDesignCaptureService(vi.fn());
  services.push(single);
  expect((await batchRequest(single, batchInput())).status).toBe(404);
});
