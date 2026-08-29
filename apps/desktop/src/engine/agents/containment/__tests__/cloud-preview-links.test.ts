import { createServer } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import {
  CloudPreviewGatewayFactory,
  parseCloudPreviewLinks,
  type CloudPreviewLinks,
} from "../cloud-preview-links";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

function fixture(port: number, now = Date.now()): CloudPreviewLinks {
  return {
    version: 1,
    audience: "zeros-cloud-preview-v1",
    generation: "preview-generation-1234567890",
    issuedAt: now - 1_000,
    expiresAt: now + 60_000,
    links: [
      {
        port,
        signedUrl: `https://${port}-provider-capability.preview.example/`,
      },
    ],
  };
}

describe("cloud preview link contract", () => {
  it("accepts only bounded, unique, HTTPS signed ingress links", async () => {
    const port = await freePort();
    const value = fixture(port);
    expect(parseCloudPreviewLinks(JSON.stringify(value), Date.now())).toEqual(
      value,
    );

    for (const invalid of [
      { ...value, permissive: true },
      { ...value, expiresAt: Date.now() - 1 },
      {
        ...value,
        links: [
          {
            ...value.links[0],
            signedUrl: `http://${port}-provider-capability.preview.example/`,
          },
        ],
      },
      {
        ...value,
        links: [
          value.links[0],
          { ...value.links[0] },
        ],
      },
      {
        ...value,
        links: [
          {
            ...value.links[0],
            signedUrl: "https://different.preview.example/",
          },
        ],
      },
      {
        ...value,
        links: [
          {
            ...value.links[0],
            signedUrl: `${value.links[0].signedUrl}?__zsr_cap=smuggled`,
          },
        ],
      },
    ]) {
      expect(() =>
        parseCloudPreviewLinks(JSON.stringify(invalid), Date.now()),
      ).toThrow(/cloud preview/i);
    }
  });

  it("binds the exact provider-mapped port and refreshes signed admission without restarting the app", async () => {
    const target = createServer((_request, response) => response.end("cloud-app"));
    await new Promise<void>((resolve) =>
      target.listen(0, "127.0.0.1", resolve),
    );
    cleanups.push(
      () => new Promise<void>((resolve) => target.close(() => resolve())),
    );
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress === "string") {
      throw new Error("no target");
    }

    const ingressPort = await freePort();
    let links = fixture(ingressPort);
    const factory = new CloudPreviewGatewayFactory({
      loadLinks: () => links,
      listenHost: "127.0.0.1",
    });
    const gateway = await factory.open({
      targetHost: "127.0.0.1",
      targetPort: targetAddress.port,
      displayPort: 5173,
    });
    cleanups.push(() => gateway.close());

    const first = await gateway.navigation();
    expect(first.url).toBe("http://localhost:5173/");
    expect(first.expiresAt).toBe(links.expiresAt);
    expect(first.admissionUrl).toContain("provider-capability.preview.example");
    expect(first.admissionUrl).toContain("__zsr_cap=");

    links = {
      ...links,
      generation: "preview-generation-rotated-1234",
      links: [
        {
          ...links.links[0],
          signedUrl: `https://${ingressPort}-rotated-capability.preview.example/`,
        },
      ],
    };
    const rotated = await gateway.navigation();
    expect(rotated.url).toBe("http://localhost:5173/");
    expect(rotated.admissionUrl).toContain("rotated-capability.preview.example");
    expect(rotated.admissionUrl).not.toContain("provider-capability");

    const admission = new URL(rotated.admissionUrl);
    const localAdmission = new URL(`http://127.0.0.1:${ingressPort}/`);
    localAdmission.searchParams.set(
      "__zsr_cap",
      admission.searchParams.get("__zsr_cap") ?? "",
    );
    const admitted = await fetch(localAdmission, { redirect: "manual" });
    expect(admitted.status).toBe(200);
    expect(admitted.headers.get("refresh")).toBe("0; url=/");
    const cookie = admitted.headers.get("set-cookie")?.split(";")[0] ?? "";
    const response = await fetch(`http://127.0.0.1:${ingressPort}/`, {
      headers: { Cookie: cookie },
    });
    expect(await response.text()).toBe("cloud-app");
  });
});
