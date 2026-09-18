import { afterEach, expect, it, vi } from "vitest";
import {
  startDesignCaptureService,
  type DesignCaptureService,
} from "../capture-service";
import { resolveDesignCaptureConfig } from "../capture-client";
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
