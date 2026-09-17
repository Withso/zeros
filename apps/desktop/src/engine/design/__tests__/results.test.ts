import type { DesignEvidenceRenderer } from "../capture-client";
import { readDesignReviewEvidence } from "../review-evidence";
import { readDesignProposalReview } from "../review";
import { DesignRequestStore } from "../request-store";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  createDesignFrame,
  initializeDesignDocument,
  readDesignWebDocumentState,
  DESIGN_DIRECTORY_NAME,
} from "../document";
import {
  designDirectoryEntry,
  designPrivateStorageDirectory,
} from "../metadata";
import { DesignCodeTools } from "../code-tools";
import { DesignResultStore } from "../result-store";
import { getWorkspaceDesignApi } from "../design-api";
import { createDesignCaptureRenderer } from "../capture-client";
import {
  startDesignCaptureService,
  type DesignCaptureService,
} from "../capture-service";
let root: string,
  directoryId: string,
  frame: string,
  revision: string,
  nodeId: string;
let tools: DesignCodeTools;
let service: DesignCaptureService | undefined;
async function call(name: string, input: unknown) {
  const result = await tools.callTool(
    name,
    input,
    new AbortController().signal,
  );
  return JSON.parse((result.content[0] as { text: string }).text);
}
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "zeros-design-results-"));
  await initializeDesignDocument(root);
  frame = (await createDesignFrame(root, { title: "Evidence" })).file;
  const state = await readDesignWebDocumentState(root, frame);
  revision = state.revision;
  nodeId = /<main data-oid="([^"]+)"/.exec(state.files[frame]!)![1]!;
  directoryId = designDirectoryEntry(root, DESIGN_DIRECTORY_NAME)!.id;
  tools = new DesignCodeTools({
    workspaceId: "workspace",
    workspacePath: root,
    directory: DESIGN_DIRECTORY_NAME,
    directoryId,
    actorId: "agent-1",
    assertCurrent() {},
  });
});
afterEach(async () => {
  tools.dispose();
  await service?.stop();
  service = undefined;
  await rm(root, { recursive: true, force: true });
});
it("retains immutable source, before/after evidence, hashes, and proposal identity across later edits and restart", async () => {
  const tx = {
    schemaVersion: 1,
    transactionId: "proposal",
    actor: { kind: "agent", id: "agent-1" },
    createdAt: Date.now(),
    documentId: `frame:${frame}`,
    baseRevision: revision,
    intent: "Evidence",
    operations: [
      {
        operationId: "text",
        type: "node.set-text",
        nodeId,
        text: "Proposed evidence",
      },
    ],
  };
  await call("design_proposal_create", { transaction: tx });
  const manifest = await call("design_result_create", {
    requestId: "evidence-1",
    createdAt: Date.now(),
    documentId: tx.documentId,
    expectedRevision: revision,
    proposalId: "proposal",
  });
  expect(manifest.proposalId).toBe("proposal");
  expect(manifest.revision).not.toBe(revision);
  const store = new DesignResultStore(root, directoryId);
  const retained = await store.read(manifest.id, "agent-1");
  expect(retained.content["before.html"]).not.toContain("Proposed evidence");
  expect(retained.content["after.html"]).toContain("Proposed evidence");
  expect((await readDesignWebDocumentState(root, frame)).revision).toBe(
    revision,
  );
  await getWorkspaceDesignApi(root).apply({
    ...tx,
    transactionId: "human",
    actor: { kind: "human", id: "desktop" },
    operations: [{ ...tx.operations[0]!, text: "Later edit" }],
  });
  expect(
    await new DesignResultStore(root, directoryId).read(manifest.id, "agent-1"),
  ).toEqual(retained);
  await expect(store.read(manifest.id, "another-actor")).rejects.toThrow(
    /owner/,
  );
  const page = await call("design_result_read", {
    resultId: manifest.id,
    artifact: "after.html",
    limit: 31,
  });
  expect(page.data.length).toBe(31);
  expect(page.nextOffset).toBe(31);
  expect(retained.manifest.artifacts["after.html"]!.sha256).toBe(
    createHash("sha256").update(retained.content["after.html"]!).digest("hex"),
  );
  expect(
    await new DesignResultStore(
      root,
      directoryId,
      () => Date.now() + 8 * 24 * 60 * 60_000,
    ).list(),
  ).toEqual([]);
});
it("composes capture from frozen CSS/component inputs and keeps private host credentials out of the result", async () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1XcAAAAASUVORK5CYII=",
    "base64",
  );
  let html = "";
  service = await startDesignCaptureService(async (input) => {
    html = input.html;
    return { bytes: png, renderer: "fixture" };
  });
  const renderer = createDesignCaptureRenderer(root, {
    url: service.url,
    token: service.token,
  })!;
  const state = await readDesignWebDocumentState(root, frame);
  const modified = {
    ...state,
    files: {
      ...state.files,
      "tokens.css": ":root { --captured-only: 123px; }",
    },
  };
  const artifact = await renderer.render({
    state: modified,
    viewport: {
      width: 1,
      height: 1,
      deviceScaleFactor: 1,
      reducedMotion: "reduce",
      colorScheme: "light",
    },
  });
  expect(html).toContain("--captured-only");
  expect(artifact.metadata?.htmlSha256).toBe(
    createHash("sha256").update(html).digest("hex"),
  );
  expect(JSON.stringify(artifact)).not.toContain(service.token);
  expect(
    (await readDesignWebDocumentState(root, frame)).files["tokens.css"],
  ).not.toContain("--captured-only");
});

it("fails closed on an unsafe evidence index and rejects mismatched artifact bytes", async () => {
  const manifest = await call("design_result_create", {
    requestId: "integrity",
    createdAt: Date.now(),
    documentId: `frame:${frame}`,
    expectedRevision: revision,
  });
  const store = new DesignResultStore(root, directoryId);
  const bundle = await store.read(manifest.id);
  bundle.manifest.id = "b".repeat(64);
  bundle.content["before.html"] = "tampered";
  await expect(store.write(bundle)).rejects.toThrow(/hash/);
  const target = path.join(designPrivateStorageDirectory(root), "results.json");
  await rm(target);
  const outside = path.join(root, "unsafe-evidence-index.json");
  await writeFile(outside, "[]");
  await symlink(outside, target);
  await expect(store.list()).rejects.toThrow(/unsafe/);
});

it("keeps concurrent human edits and request receipts while rendering immutable proposal evidence", async () => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const renderer: DesignEvidenceRenderer = {
    async render() {
      throw new Error("Requires composed evidence");
    },
    async renderComposed({ state, html }) {
      entered();
      await held;
      return {
        mimeType: "image/png",
        bytes: Buffer.from("fixture-image"),
        width: 1,
        height: 1,
        revision: state.revision,
        metadata: {
          htmlSha256: createHash("sha256").update(html).digest("hex"),
          renderer: "fixture",
        },
      };
    },
  };
  tools.dispose();
  tools = new DesignCodeTools(
    {
      workspaceId: "workspace",
      workspacePath: root,
      directory: DESIGN_DIRECTORY_NAME,
      directoryId,
      actorId: "agent-1",
      assertCurrent() {},
    },
    { renderer },
  );
  const tx = {
    schemaVersion: 1,
    transactionId: "pending-proposal",
    actor: { kind: "agent", id: "agent-1" },
    createdAt: Date.now(),
    documentId: `frame:${frame}`,
    baseRevision: revision,
    intent: "Captured proposal",
    operations: [
      { operationId: "text", type: "node.set-text", nodeId, text: "Proposed" },
    ],
  };
  await call("design_proposal_create", { transaction: tx });
  const result = call("design_result_create", {
    requestId: "slow-capture",
    createdAt: Date.now(),
    documentId: tx.documentId,
    expectedRevision: revision,
    proposalId: tx.transactionId,
    capture: true,
    width: 1,
    height: 1,
  });
  await started;
  await call("design_proposal_create", {
    transaction: { ...tx, transactionId: "concurrent-proposal" },
  });
  await getWorkspaceDesignApi(root).apply({
    ...tx,
    schemaVersion: 1,
    transactionId: "human",
    actor: { kind: "human", id: "desktop" },
    operations: [
      {
        operationId: "human-text",
        type: "node.set-text",
        nodeId,
        text: "Human during capture",
      },
    ],
  });
  release();
  const manifest = await result;
  const records = await new DesignRequestStore(root, directoryId).read();
  expect(records.map((record) => record.id)).toEqual(
    expect.arrayContaining([
      "pending-proposal",
      "concurrent-proposal",
      "slow-capture",
    ]),
  );
  expect(
    (await readDesignWebDocumentState(root, frame)).files[frame],
  ).toContain("Human during capture");
  const proposal = await readDesignProposalReview(root, {
    directoryId,
    actorId: "agent-1",
    requestId: tx.transactionId,
  });
  expect(proposal.applicable).toBe(false);
  expect(proposal.evidence?.id).toBe(manifest.id);
  const identity = {
    directoryId,
    actorId: "agent-1",
    requestId: tx.transactionId,
    signature: proposal.proposal.signature,
    resultId: manifest.id,
  };
  expect((await readDesignReviewEvidence(root, identity)).baseRevision).toBe(
    revision,
  );
  await expect(
    readDesignReviewEvidence(root, {
      ...identity,
      requestId: "concurrent-proposal",
    }),
  ).rejects.toThrow();
});
