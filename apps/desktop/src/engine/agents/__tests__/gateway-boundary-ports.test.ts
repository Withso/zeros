import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ExecutionBoundaryPortsSnapshot } from "@zeros/protocol/containment";

import { AgentGateway } from "../gateway";
import type { PreparedBoundary } from "../containment/types";
import type { AgentAdapter } from "../types";
import { testExecutionBoundary } from "./helpers/test-execution-boundary";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("AgentGateway boundary port publication", () => {
  it("publishes an initial snapshot and redacts live port mappings", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-port-events-"));
    temporaryDirectories.push(root);
    const snapshots: ExecutionBoundaryPortsSnapshot[] = [];
    const gateway = new AgentGateway({
      projectRoot: root,
      executionBoundary: testExecutionBoundary(),
      events: {
        onSessionUpdate: () => {},
        onPermissionRequest: () => {},
        onQuestionRequest: () => {},
        onAgentStderr: () => {},
        onAgentExit: () => {},
        onBoundaryPortsChanged: (_agentId, executionId, snapshot) => {
          expect(executionId).toBe("execution-1");
          snapshots.push(snapshot);
        },
      },
    });
    const internal = gateway as unknown as {
      prepareExecutionBoundary(
        executionId: string,
        cwd: string,
        workspaceRoot: string,
        adapter: AgentAdapter,
        territory: undefined,
        env: undefined,
        mcpServers: [],
        stage: "newSession",
      ): Promise<PreparedBoundary>;
    };

    const prepared = await internal.prepareExecutionBoundary(
      "execution-1",
      root,
      root,
      { agentId: "fake" } as unknown as AgentAdapter,
      undefined,
      undefined,
      [],
      "newSession",
    );

    expect(snapshots).toEqual([
      {
        version: 1,
        discovery: { state: "idle" },
        ports: [],
      },
    ]);

    await prepared.requestPort({
      protocol: "tcp",
      preferredPort: 5173,
      purpose: "dev-server",
    });

    const current = snapshots.at(-1);
    expect(current).toEqual({
      version: 1,
      discovery: { state: "idle" },
      ports: [
        {
          id: expect.stringMatching(/^[A-Za-z0-9_-]{20,64}$/),
          protocol: "tcp",
          port: 5173,
          purpose: "dev-server",
          source: "requested",
        },
      ],
    });
    const serialized = JSON.stringify(current);
    expect(serialized).not.toContain("127.0.0.1");
    expect(serialized).not.toContain(prepared.generation);
    expect(serialized).not.toContain("targetPort");
    expect(serialized).not.toContain("leaseId");

    await prepared.stopAndProve();
  });

  it("opens only the opaque live mapping and revokes its browser façade", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-port-open-"));
    temporaryDirectories.push(root);
    let latest: ExecutionBoundaryPortsSnapshot | null = null;
    const gateway = new AgentGateway({
      projectRoot: root,
      executionBoundary: testExecutionBoundary(),
      events: {
        onSessionUpdate: () => {},
        onPermissionRequest: () => {},
        onQuestionRequest: () => {},
        onAgentStderr: () => {},
        onAgentExit: () => {},
        onBoundaryPortsChanged: (_agentId, _executionId, snapshot) => {
          latest = snapshot;
        },
      },
    });
    const internal = gateway as unknown as {
      executionBoundaries: Map<string, PreparedBoundary>;
      prepareExecutionBoundary(
        executionId: string,
        cwd: string,
        workspaceRoot: string,
        adapter: AgentAdapter,
        territory: undefined,
        env: undefined,
        mcpServers: [],
        stage: "newSession",
      ): Promise<PreparedBoundary>;
    };
    const prepared = await internal.prepareExecutionBoundary(
      "execution-open",
      root,
      root,
      { agentId: "fake" } as unknown as AgentAdapter,
      undefined,
      undefined,
      [],
      "newSession",
    );
    internal.executionBoundaries.set("execution-open", prepared);

    const target = createServer((_request, response) => response.end("app"));
    await new Promise<void>((resolve) =>
      target.listen(0, "127.0.0.1", resolve),
    );
    const address = target.address();
    if (!address || typeof address === "string") throw new Error("no target");
    try {
      await prepared.requestPort({
        protocol: "tcp",
        preferredPort: address.port,
        purpose: "preview",
      });
      const portId = (latest as ExecutionBoundaryPortsSnapshot | null)?.ports[0]
        ?.id;
      expect(portId).toBeTruthy();
      await expect(
        gateway.openBoundaryPort("execution-open", "x".repeat(32)),
      ).rejects.toThrow("no longer active");

      const opened = await gateway.openBoundaryPort(
        "execution-open",
        portId as string,
      );
      const admission = await fetch(opened.admissionUrl, {
        redirect: "manual",
      });
      const cookie = admission.headers.get("set-cookie")?.split(";")[0];
      const response = await fetch(opened.url, {
        headers: { Cookie: cookie ?? "" },
      });
      expect(await response.text()).toBe("app");

      await gateway.dispose();
      await expect(fetch(opened.url)).rejects.toThrow();
    } finally {
      await gateway.dispose();
      await new Promise<void>((resolve) => target.close(() => resolve()));
    }
  });
});
