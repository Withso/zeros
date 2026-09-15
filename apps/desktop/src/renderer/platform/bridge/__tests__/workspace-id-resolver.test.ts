import { expect, it, vi } from "vitest";
const request = vi.hoisted(() => vi.fn());
vi.mock("../workspace-bridge", () => ({ requestWorkspaceList: request }));
import {
  refillBridgeWorkspaces,
  resolveBridgeWorkspaceIdForCwd,
} from "../workspace-id-resolver";
import type { RuntimeClient } from "../ws-client";

it("isolates workspace lookups across clients and runtime switches", async () => {
  const a = {
    executionIdentity: { kind: "local", sidecar: "active" },
  } as RuntimeClient;
  const b = {
    executionIdentity: {
      kind: "cloud",
      organizationId: "org",
      workspaceId: "remote",
      generation: 1,
    },
  } as RuntimeClient;
  let finish!: (rows: unknown[]) => void;
  request.mockImplementation((client) =>
    client === a
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve([{ id: "remote", path: "/repo" }]),
  );
  const first = refillBridgeWorkspaces(a);
  expect(await resolveBridgeWorkspaceIdForCwd(b, "/repo")).toBe("remote");
  finish([{ id: "local", path: "/repo" }]);
  await first;
  expect(await resolveBridgeWorkspaceIdForCwd(b, "/repo")).toBe("remote");
  (b as unknown as { executionIdentity: object }).executionIdentity = {
    kind: "local",
    sidecar: "active",
  };
  request.mockResolvedValue([{ id: "new-local", path: "/repo" }]);
  expect(await resolveBridgeWorkspaceIdForCwd(b, "/repo")).toBe("new-local");
});
