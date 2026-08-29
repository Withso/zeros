import { createServer } from "node:http";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, WebSocket } from "ws";

import { ZsrPreviewGateway } from "../zsr-preview-gateway";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("ZsrPreviewGateway", () => {
  it("requires a capability and strips it before proxying HTTP", async () => {
    let observedUrl = "";
    let observedCookie = "";
    let observedHost = "";
    const target = createServer((request, response) => {
      observedUrl = request.url ?? "";
      observedCookie = request.headers.cookie ?? "";
      observedHost = request.headers.host ?? "";
      response.end("preview-ok");
    });
    await new Promise<void>((resolve) =>
      target.listen(0, "127.0.0.1", resolve),
    );
    cleanups.push(
      () =>
        new Promise<void>((resolve) => target.close(() => resolve())),
    );
    const address = target.address();
    if (!address || typeof address === "string") throw new Error("no target");

    const gateway = await ZsrPreviewGateway.open({
      targetHost: "127.0.0.1",
      targetPort: address.port,
      displayPort: 5173,
    });
    cleanups.push(() => gateway.close());

    const navigation = await gateway.navigation();
    expect(navigation.expiresAt).toBeGreaterThan(Date.now() + 50 * 60_000);
    expect(navigation.expiresAt).toBeLessThanOrEqual(
      Date.now() + 60 * 60_000,
    );

    const unauthorized = await fetch(gateway.baseUrl);
    expect(unauthorized.status).toBe(403);

    const capabilityUrl = gateway.capabilityUrl;
    const admission = await fetch(capabilityUrl, { redirect: "manual" });
    expect(admission.status).toBe(200);
    const cookie = admission.headers.get("set-cookie");
    expect(cookie).toContain("zsr_preview");
    expect(cookie).toContain("SameSite=None");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("Partitioned");
    expect(admission.headers.get("refresh")).toBe("0; url=/");
    const admissionBody = await admission.text();
    expect(admissionBody).not.toContain(
      new URL(capabilityUrl).searchParams.get("__zsr_cap"),
    );
    expect(admissionBody).not.toContain("<script");

    // Admission capabilities are one-use even before the cookie-backed page
    // navigation happens.
    expect((await fetch(capabilityUrl)).status).toBe(403);

    const response = await fetch(gateway.baseUrl, {
      headers: { Cookie: cookie?.split(";")[0] ?? "" },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("preview-ok");
    expect(observedUrl).toBe("/");
    expect(observedCookie).not.toContain("zsr_preview");
    expect(observedHost).toBe("localhost:5173");
    expect(response.url).not.toContain("__zsr_cap");

    // A browser-originated cross-site request cannot reuse the preview cookie.
    const crossSite = await fetch(gateway.baseUrl, {
      headers: {
        Cookie: cookie?.split(";")[0] ?? "",
        "Sec-Fetch-Site": "cross-site",
      },
    });
    expect(crossSite.status).toBe(403);
  });

  it("authenticates and proxies WebSocket upgrades", async () => {
    const target = createServer();
    const wss = new WebSocketServer({ server: target });
    wss.on("connection", (socket) => {
      socket.on("message", (data) => socket.send(`echo:${data.toString()}`));
    });
    await new Promise<void>((resolve) =>
      target.listen(0, "127.0.0.1", resolve),
    );
    cleanups.push(
      () =>
        new Promise<void>((resolve) => wss.close(() => target.close(() => resolve()))),
    );
    const address = target.address();
    if (!address || typeof address === "string") throw new Error("no target");

    const gateway = await ZsrPreviewGateway.open({
      targetHost: "127.0.0.1",
      targetPort: address.port,
      displayPort: address.port,
    });
    cleanups.push(() => gateway.close());
    const url = new URL(gateway.capabilityUrl);
    url.protocol = "ws:";
    const socket = new WebSocket(url);
    const echoed = await new Promise<string>((resolve, reject) => {
      socket.once("open", () => socket.send("hmr"));
      socket.once("message", (data) => resolve(data.toString()));
      socket.once("error", reject);
    });
    expect(echoed).toBe("echo:hmr");
    socket.terminate();
    await new Promise<void>((resolve) => socket.once("close", () => resolve()));
  });

  it("rejects a non-loopback target", async () => {
    await expect(
      ZsrPreviewGateway.open({
        targetHost: "0.0.0.0" as "127.0.0.1",
        targetPort: 3000,
        displayPort: 3000,
      }),
    ).rejects.toThrow("loopback");
  });
});
