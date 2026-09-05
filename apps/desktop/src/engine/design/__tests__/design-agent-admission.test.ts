import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DesignAgentAdmissionManager } from "../design-agent-admission";
import { DesignAgentCapabilityManager } from "../design-agent-capability";
import {
  createDesignFrame,
  initializeDesignDocument,
  readDesignWebDocumentState,
} from "../document";

describe("Design-agent admission", () => {
  let root: string;
  let frame: string;
  let revision: string;
  let capabilities: DesignAgentCapabilityManager;
  let admissions: DesignAgentAdmissionManager;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zeros-design-admission-"));
    await initializeDesignDocument(root);
    frame = (await createDesignFrame(root, { title: "Admission draft" })).file;
    revision = (await readDesignWebDocumentState(root, frame)).revision;
    capabilities = new DesignAgentCapabilityManager();
    admissions = new DesignAgentAdmissionManager({ capabilities });
  });

  afterEach(async () => {
    await admissions.stopAll();
    await rm(root, { recursive: true, force: true });
  });

  it("keeps one run hot until explicit retirement and carries no filesystem writer", async () => {
    const admitted = await admissions.start({
      workspaceId: "workspace-1",
      workspacePath: root,
      agentRunId: "design-run-1",
      documentId: `frame:${frame}`,
      expectedRevision: revision,
    });

    expect(admitted.actor).toBe("design-agent");
    expect(admitted.agentRunId).toBe("design-run-1");
    expect(admitted.env.ZEROS_DESIGN_AGENT_CAPABILITY).toMatch(
      /^Bearer [a-f0-9]{64}$/,
    );
    expect(admitted.mcpServers).toHaveLength(1);
    expect(admitted.mcpServers[0]).toMatchObject({
      name: "design-draft",
      transport: "http",
      headersFromEnv: {
        Authorization: "ZEROS_DESIGN_AGENT_CAPABILITY",
      },
    });
    expect(JSON.stringify(admitted.mcpServers)).not.toContain(
      admitted.env.ZEROS_DESIGN_AGENT_CAPABILITY,
    );
    expect(admitted.trustedLocalPorts).toEqual([
      Number(new URL(admitted.mcpServers[0]!.url).port),
    ]);
    expect(capabilities.activeCount()).toBe(1);
    expect(admissions.activeCount()).toBe(1);

    const renewed = admissions.renew("design-run-1", 2_000);
    expect(renewed.agentRunId).toBe("design-run-1");
    expect(`Bearer ${renewed.token}`).toBe(
      admitted.env.ZEROS_DESIGN_AGENT_CAPABILITY,
    );

    expect(await admissions.stop("design-run-1")).toBe(true);
    expect(await admissions.stop("design-run-1")).toBe(false);
    expect(capabilities.activeCount()).toBe(0);
    expect(admissions.activeCount()).toBe(0);
  });

  it("rejects a duplicate live run identity", async () => {
    const input = {
      workspaceId: "workspace-1",
      workspacePath: root,
      agentRunId: "design-run-1",
      documentId: `frame:${frame}`,
      expectedRevision: revision,
    };
    await admissions.start(input);
    await expect(admissions.start(input)).rejects.toThrow(/already active/i);
  });
});
