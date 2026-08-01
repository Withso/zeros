import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  registerSchemesAsPrivileged: vi.fn(),
  fetch: vi.fn(),
  ensureEngineRunning: vi.fn(async () => 24193),
  currentLocalToken: vi.fn(() => "host-secret"),
}));

vi.mock("electron", () => ({
  net: { fetch: mocks.fetch },
  protocol: {
    handle: mocks.handle,
    registerSchemesAsPrivileged: mocks.registerSchemesAsPrivileged,
  },
}));

vi.mock("../sidecar", () => ({
  ensureEngineRunning: mocks.ensureEngineRunning,
  currentLocalToken: mocks.currentLocalToken,
}));

import {
  installDesignProtocol,
  parseDesignProtocolUrl,
  registerDesignProtocolPrivileges,
} from "../design-protocol";

describe("zeros-design protocol", () => {
  const capability = "c".repeat(64);
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetch.mockResolvedValue(
      new Response("ok", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    );
  });

  it("accepts only an exact workspace host, workspace id, resource path, and version", () => {
    expect(
      parseDesignProtocolUrl(
        `zeros-design://workspace/ws_abc123/${capability}/home.html?v=aaaaaaaaaaaaaaaaaaaaaaaa`,
      ),
    ).toEqual({
      workspaceId: "ws_abc123",
      capability,
      path: "home.html",
      sourceVersion: "aaaaaaaaaaaaaaaaaaaaaaaa",
    });
    expect(
      parseDesignProtocolUrl("zeros-design://other/ws_abc123/home.html"),
    ).toBeNull();
    expect(
      parseDesignProtocolUrl("zeros-design://workspace/ws_abc123/../secret"),
    ).toBeNull();
    expect(
      parseDesignProtocolUrl("zeros-design://workspace/ws_abc123/home.html"),
    ).toBeNull();
    expect(
      parseDesignProtocolUrl(
        "zeros-design://workspace/ws_abc123/not-a-capability/home.html",
      ),
    ).toBeNull();
    expect(
      parseDesignProtocolUrl(
        `zeros-design://workspace/ws_abc123/${capability}/assets%2F..%2Fsecret.png`,
      ),
    ).toBeNull();
    expect(
      parseDesignProtocolUrl(
        `zeros-design://workspace/ws_abc123/${capability}/home.html?v=wrong`,
      ),
    ).toBeNull();
  });

  it("registers a secure standard scheme and proxies without exposing the token", async () => {
    registerDesignProtocolPrivileges();
    expect(mocks.registerSchemesAsPrivileged).toHaveBeenCalledWith([
      expect.objectContaining({
        scheme: "zeros-design",
        privileges: expect.objectContaining({ standard: true, secure: true }),
      }),
    ]);

    installDesignProtocol();
    const handler = mocks.handle.mock.calls[0]?.[1] as (request: {
      method: string;
      url: string;
    }) => Promise<Response>;
    const result = await handler({
      method: "GET",
      url: `zeros-design://workspace/ws_abc123/${capability}/assets/logo.png?v=aaaaaaaaaaaaaaaaaaaaaaaa`,
    });

    expect(await result.text()).toBe("ok");
    expect(mocks.fetch).toHaveBeenCalledWith(
      `http://127.0.0.1:24193/design/ws_abc123/${capability}/assets/logo.png?v=aaaaaaaaaaaaaaaaaaaaaaaa`,
      expect.objectContaining({
        headers: { "X-Zeros-Engine-Token": "host-secret" },
      }),
    );
    expect(mocks.fetch.mock.calls[0]?.[0]).not.toContain("host-secret");
  });
});
