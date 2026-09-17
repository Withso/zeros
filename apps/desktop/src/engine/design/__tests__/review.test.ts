import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DesignCodeTools } from "../code-tools";
import {
  createDesignFrame,
  initializeDesignDocument,
  readDesignWebDocumentState,
  DESIGN_DIRECTORY_NAME,
} from "../document";
import { designDirectoryEntry } from "../metadata";
import { getWorkspaceDesignApi } from "../design-api";
import {
  readDesignProposalReview,
  resolveDesignProposalReview,
} from "../review";
import { DesignRequestStore } from "../request-store";
import type { DesignTransaction } from "@zeros/design-core";

let root: string;
let tools: DesignCodeTools;
let tx: DesignTransaction;
let identity: { actorId: string; requestId: string; directoryId: string };
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "zeros-design-review-"));
  await initializeDesignDocument(root);
  const frame = (await createDesignFrame(root, { title: "Review" })).file;
  const state = await readDesignWebDocumentState(root, frame);
  identity = {
    actorId: "conversation-review",
    requestId: "proposal-review",
    directoryId: designDirectoryEntry(root, DESIGN_DIRECTORY_NAME)!.id,
  };
  tools = new DesignCodeTools({
    workspaceId: "workspace-review",
    workspacePath: root,
    directory: DESIGN_DIRECTORY_NAME,
    directoryId: identity.directoryId,
    actorId: identity.actorId,
    assertCurrent() {},
  });
  tx = {
    schemaVersion: 1,
    transactionId: identity.requestId,
    documentId: state.documentId,
    baseRevision: state.revision,
    actor: { kind: "agent", id: identity.actorId },
    intent: "Update heading",
    createdAt: Date.now(),
    operations: [
      {
        type: "node.set-text",
        operationId: "text",
        nodeId: /<main data-oid="([^"]+)"/.exec(state.files[frame]!)![1]!,
        text: "Reviewed result",
      },
    ],
  };
  await tools.callTool(
    "design_proposal_create",
    { transaction: tx },
    new AbortController().signal,
  );
});
afterEach(async () => {
  tools?.dispose();
  await rm(root, { recursive: true, force: true });
});

it("previews without writes, accepts once, and keeps human approval distinct from the agent receipt", async () => {
  const review = await readDesignProposalReview(root, identity);
  expect(review).toMatchObject({
    applicable: true,
    currentRevision: tx.baseRevision,
    truncated: false,
  });
  expect(review.patch).toMatch(/\+\s*<main/);
  expect(review.patch).toContain("Reviewed result");
  expect((await getWorkspaceDesignApi(root).open(tx.documentId)).revision).toBe(
    tx.baseRevision,
  );
  const decision = {
    ...identity,
    signature: review.proposal.signature,
    decision: "accept" as const,
  };
  tools.dispose(); // A human can review after the agent execution ends.
  const resolved = await resolveDesignProposalReview(root, decision);
  expect(resolved).toMatchObject({
    status: "committed",
    review: { decision: "accept", reviewerId: "desktop" },
  });
  expect(await resolveDesignProposalReview(root, decision)).toEqual(resolved);
  const record = (
    await new DesignRequestStore(root, identity.directoryId).read()
  )[0]!;
  expect(record.result).toMatchObject({ receipt: { actor: tx.actor } });
  expect(record.transaction).toBeUndefined();
});

it("rejects without modifying source and never labels tool resolution as human approval", async () => {
  const review = await readDesignProposalReview(root, identity);
  await tools.callTool(
    "design_proposal_resolve",
    { requestId: identity.requestId, decision: "reject" },
    new AbortController().signal,
  );
  expect(
    (await readDesignProposalReview(root, identity)).proposal.review,
  ).toBeUndefined();
  await expect(
    resolveDesignProposalReview(root, {
      ...identity,
      signature: review.proposal.signature,
      decision: "accept",
    }),
  ).rejects.toThrow(/already resolved/);
  expect((await getWorkspaceDesignApi(root).open(tx.documentId)).revision).toBe(
    tx.baseRevision,
  );
});

it("preserves a stale proposal after concurrent human edits and allows rejection", async () => {
  await getWorkspaceDesignApi(root).apply({
    ...tx,
    transactionId: "human-edit",
    actor: { kind: "human", id: "desktop" },
    operations: [
      {
        ...tx.operations[0]!,
        type: "node.set-text",
        nodeId: "nodeId" in tx.operations[0]! ? tx.operations[0].nodeId : "",
        text: "Human result",
      },
    ],
  });
  const review = await readDesignProposalReview(root, identity);
  expect(review.applicable).toBe(false);
  expect(review.reason).toMatch(/source changed/);
  await expect(
    resolveDesignProposalReview(root, {
      ...identity,
      signature: review.proposal.signature,
      decision: "accept",
    }),
  ).rejects.toThrow();
  expect((await readDesignProposalReview(root, identity)).proposal.status).toBe(
    "proposed",
  );
  await resolveDesignProposalReview(root, {
    ...identity,
    signature: review.proposal.signature,
    decision: "reject",
  });
  expect(
    (await readDesignProposalReview(root, identity)).proposal.review?.decision,
  ).toBe("reject");
});

it("pins directory, actor, request body, and resolution under simultaneous decisions", async () => {
  await expect(
    readDesignProposalReview(root, { ...identity, directoryId: "different" }),
  ).rejects.toThrow(/directory changed/);
  await expect(
    readDesignProposalReview(root, { ...identity, actorId: "other-actor" }),
  ).rejects.toThrow(/no longer available/);
  await expect(
    resolveDesignProposalReview(root, {
      ...identity,
      signature: "b".repeat(64),
      decision: "accept",
    }),
  ).rejects.toThrow(/proposal changed/);
  const review = await readDesignProposalReview(root, identity);
  const result = await Promise.allSettled(
    ["accept", "reject"].map((decision) =>
      resolveDesignProposalReview(root, {
        ...identity,
        signature: review.proposal.signature,
        decision: decision as "accept" | "reject",
      }),
    ),
  );
  expect(result.filter((item) => item.status === "fulfilled")).toHaveLength(1);
  expect(result.filter((item) => item.status === "rejected")).toHaveLength(1);
});

it("refuses a retained proposal whose operations no longer match its review signature", async () => {
  const store = new DesignRequestStore(root, identity.directoryId);
  const records = await store.read();
  records[0]!.transaction!.intent = "Tampered after proposal creation";
  store.write(records);
  const review = await readDesignProposalReview(root, identity);
  expect(review.applicable).toBe(false);
  await expect(
    resolveDesignProposalReview(root, {
      ...identity,
      signature: review.proposal.signature,
      decision: "accept",
    }),
  ).rejects.toThrow(/authorized/);
});
