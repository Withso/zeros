import { randomUUID } from "node:crypto";
import type {
  DesignReviewEvidence,
  DesignReviewEvidenceSummary,
} from "@zeros/protocol/design-review";
import { createDesignCaptureRenderer } from "./capture-client";
import { DesignRequestStore } from "./request-store";
import { DesignResultStore, type DesignResultManifest } from "./result-store";
import { createDesignResult } from "./results";
import { assertDesignReviewDirectory, assertReviewTransaction } from "./review";
import { withDesignWorkspaceMutation } from "./document-write-lock";

export function designEvidenceSummary(
  manifest: DesignResultManifest,
): DesignReviewEvidenceSummary {
  return {
    id: manifest.id,
    baseRevision: manifest.baseRevision,
    revision: manifest.revision,
    createdAt: manifest.createdAt,
    viewport: manifest.viewport,
    renderer: manifest.renderer,
  };
}
interface Identity {
  directoryId: string;
  actorId: string;
  requestId: string;
  signature: string;
}
export async function captureDesignProposalEvidence(
  root: string,
  input: Identity,
): Promise<DesignReviewEvidenceSummary> {
  const document = await withDesignWorkspaceMutation(root, async () => {
    assertDesignReviewDirectory(root, input.directoryId);
    const record = (
      await new DesignRequestStore(root, input.directoryId).read()
    ).find(
      (entry) =>
        entry.actorId === input.actorId && entry.id === input.requestId,
    );
    if (
      !record ||
      record.status !== "proposed" ||
      record.signature !== input.signature
    )
      throw new Error("The proposal changed. Refresh review before capturing.");
    assertReviewTransaction(record);
    return {
      documentId: record.transaction!.documentId,
      expectedRevision: record.transaction!.baseRevision,
    };
  });
  // Capture owns no write lane while the browser is busy. The bundle retains
  // its original revisions even if a human continues editing in the meantime.
  const manifest = await createDesignResult(
    root,
    input.directoryId,
    input.actorId,
    {
      ...document,
      requestId: `review:${randomUUID()}`,
      createdAt: Date.now(),
      proposalId: input.requestId,
      width: 1024,
      height: 768,
      capture: true,
    },
    { renderer: createDesignCaptureRenderer(root) },
  );
  return designEvidenceSummary(manifest);
}
export async function readDesignReviewEvidence(
  root: string,
  input: Identity & { resultId: string },
): Promise<DesignReviewEvidence> {
  return withDesignWorkspaceMutation(root, async () => {
    assertDesignReviewDirectory(root, input.directoryId);
    const record = (
      await new DesignRequestStore(root, input.directoryId).read()
    ).find(
      (entry) =>
        entry.actorId === input.actorId && entry.id === input.requestId,
    );
    if (!record || record.signature !== input.signature)
      throw new Error("This proposal is no longer available.");
    const { manifest, content } = await new DesignResultStore(
      root,
      input.directoryId,
    ).read(input.resultId, input.actorId);
    if (
      manifest.proposalId !== input.requestId ||
      manifest.proposalSignature !== input.signature ||
      !content["before.png"] ||
      !content["after.png"]
    )
      throw new Error("This capture does not belong to the reviewed proposal.");
    return {
      ...designEvidenceSummary(manifest),
      before: content["before.png"],
      after: content["after.png"],
    };
  });
}
