import { describe, expect, it } from "vitest";
import { CloudWorkspaceDetectedPortsSchema as desktopPorts, CloudWorkspaceRenameInputSchema as desktopRename } from "../cloud-workspaces";
import {
  CloudWorkspaceDetectedPortsSchema as serverPorts, CloudWorkspaceRenameInputSchema as serverRename,
} from "../../../../../control-plane/src/cloud-workspaces/workspace-ui-contracts";

describe("cloud UI control-plane/desktop schema parity", () => {
  it("agrees on port identity, empty/unknown state, timestamps and listener bounds", () => {
    const scope = { version: 1, organizationId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222", generation: 3, status: "ready" };
    const observedAt = "2026-10-07T10:00:00.000Z";
    const port = { port: 3000, protocol: "tcp", processLabel: "Server", health: "observed", observedAt, closedAt: null };
    for (const input of [
      { ...scope, observedAt: null, ports: null }, { ...scope, observedAt, ports: [] },
      { ...scope, observedAt, ports: [port] }, { ...scope, status: "stopped", observedAt, ports: [port] },
      { ...scope, observedAt: null, ports: [] }, { ...scope, observedAt, ports: null },
      { ...scope, observedAt, ports: Array(129).fill(port) },
      ...[{ port: 22 }, { port: 65536 }, { protocol: "udp" }, { health: "unknown" },
        { processLabel: "x".repeat(121) }, { observedAt: "bad" }, { command: "private" }]
        .map(change => ({ ...scope, observedAt, ports: [{ ...port, ...change }] })),
      { ...scope, observedAt, ports: [], generation: Number.MAX_SAFE_INTEGER + 1 },
      { ...scope, observedAt, ports: [], workspaceId: "foreign" },
    ]) {
      const desktop = desktopPorts.safeParse(input), server = serverPorts.safeParse(input);
      expect(desktop.success).toBe(server.success);
      if (desktop.success && server.success) expect(desktop.data).toEqual(server.data);
    }
  });
  it("agrees on normalized names, control characters and version CAS bounds", () => {
    for (const input of [
      { name: "  Build Work  ", version: 0 }, { name: "Build Work", version: Number.MAX_SAFE_INTEGER },
      { name: " ", version: 1 }, { name: "x".repeat(121), version: 1 },
      { name: "bad\nname", version: 1 }, { name: "Work", version: -1 },
      { name: "\nWork", version: 1 }, { name: "Work\t", version: 1 },
      { name: "Work", version: 0.1 }, { name: "Work", version: Number.MAX_SAFE_INTEGER + 1 },
      { name: "Work", version: 1, branch: "main" }, { name: "Work" },
    ]) {
      const desktop = desktopRename.safeParse(input), server = serverRename.safeParse(input);
      expect(desktop.success).toBe(server.success);
      if (desktop.success && server.success) expect(desktop.data).toEqual(server.data);
    }
  });
});
