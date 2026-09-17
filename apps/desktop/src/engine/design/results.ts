import { designEvidenceBudget } from "./evidence-budget";
import { withDesignWorkspaceMutation } from "./document-write-lock";
import { createHash } from "node:crypto";
import { applyDesignTransaction } from "@zeros/design-core";
import { designWebTransactionAdapter } from "@zeros/design-web";
import { readDesignWebDocumentState } from "./document";
import { prepareFrameRenderSource } from "./render-preparation";
import type { DesignEvidenceRenderer } from "./capture-client";
import { DesignRequestStore, designRequestSignature } from "./request-store";
import { assertDesignReviewDirectory, assertReviewTransaction } from "./review";
import {
  DesignResultStore,
  designResultArtifact,
  type DesignResultBundle,
  type DesignResultManifest,
  type DesignResultArtifactName,
} from "./result-store";

export async function createDesignResult(
  root: string,
  directoryId: string,
  actorId: string,
  input: {
    requestId: string;
    createdAt: number;
    documentId: string;
    expectedRevision: string;
    proposalId?: string;
    width: number;
    height: number;
    capture: boolean;
  },
  options: { renderer?: DesignEvidenceRenderer; signal?: AbortSignal } = {},
): Promise<DesignResultManifest> {
  return designEvidenceBudget.run(async () => {
    const { before, after, signature, viewport, beforeRender, afterRender } =
      await withDesignWorkspaceMutation(root, async () => {
        assertDesignReviewDirectory(root, directoryId);
        options.signal?.throwIfAborted();
        const before = await readDesignWebDocumentState(
          root,
          input.documentId.replace(/^frame:/, ""),
        );
        if (before.revision !== input.expectedRevision)
          throw new Error(
            "Design result source changed. Reopen the document before generating evidence.",
          );
        let after = before;
        let signature: string | null = null;
        if (input.proposalId) {
          const proposal = (
            await new DesignRequestStore(root, directoryId).read()
          ).find(
            (record) =>
              record.id === input.proposalId && record.actorId === actorId,
          );
          if (proposal?.status !== "proposed")
            throw new Error(
              "Design result requires a pending proposal owned by this actor.",
            );
          assertReviewTransaction(proposal);
          after = applyDesignTransaction(
            before,
            proposal.transaction!,
            designWebTransactionAdapter,
          ).state;
          signature = proposal.signature;
        }
        const viewport = {
          width: input.width,
          height: input.height,
          deviceScaleFactor: 1 as const,
          colorScheme: "light" as const,
          reducedMotion: "reduce" as const,
        };
        const beforeRender = await prepareFrameRenderSource(
          root,
          before.files[before.entryFile]!,
          viewport,
          before.files,
        );
        const afterRender =
          after === before
            ? beforeRender
            : await prepareFrameRenderSource(
                root,
                after.files[after.entryFile]!,
                viewport,
                after.files,
              );
        return {
          before,
          after,
          signature,
          viewport,
          beforeRender,
          afterRender,
        };
      });
    const manifest: DesignResultManifest = {
      version: 1,
      id: designRequestSignature({ directoryId, actorId, input }),
      directoryId,
      actorId,
      requestId: input.requestId,
      proposalId: input.proposalId ?? null,
      proposalSignature: signature,
      createdAt: input.createdAt,
      documentId: input.documentId,
      baseRevision: before.revision,
      revision: after.revision,
      viewport: {
        width: input.width,
        height: input.height,
        deviceScaleFactor: 1,
      },
      fidelity: "authored-sanitized",
      validation: input.proposalId ? "semantic-dry-run" : "source-snapshot",
      renderer: null,
      artifacts: {},
    };
    const bundle: DesignResultBundle = { manifest, content: {} };
    const add = (
      name: DesignResultArtifactName,
      data: string | Uint8Array,
      mime: "application/json" | "text/html" | "image/png",
    ) => {
      const artifact = designResultArtifact(data, mime);
      bundle.content[name] = artifact.data;
      manifest.artifacts[name] = artifact.metadata;
    };
    // Source inputs and semantic metadata are retained alongside self-contained
    // composed HTML (including the exact binary asset bytes used in the render).
    add(
      "source.json",
      JSON.stringify({ before, ...(after !== before ? { after } : {}) }),
      "application/json",
    );
    add("before.html", beforeRender.sanitized, "text/html");
    add("after.html", afterRender.sanitized, "text/html");
    if (input.capture) {
      const render = options.renderer?.renderComposed;
      if (!render)
        throw new Error(
          "A source-bound capture host is unavailable for this workspace.",
        );
      for (const [name, state, prepared] of [
        ["before.png", before, beforeRender],
        ["after.png", after, afterRender],
      ] as const) {
        options.signal?.throwIfAborted();
        const artifact = await render({
          state,
          viewport,
          signal: options.signal,
          html: prepared.sanitized,
          sourceVersion: prepared.sourceVersion,
        });
        const hash = createHash("sha256")
          .update(prepared.sanitized)
          .digest("hex");
        if (
          artifact.revision !== state.revision ||
          artifact.metadata?.htmlSha256 !== hash
        )
          throw new Error(
            "The capture host returned evidence for different composed bytes.",
          );
        manifest.renderer = String(
          artifact.metadata?.renderer ?? "qualified-authored-host",
        );
        add(name, artifact.bytes, "image/png");
      }
    }
    return withDesignWorkspaceMutation(root, async () => {
      options.signal?.throwIfAborted();
      assertDesignReviewDirectory(root, directoryId);
      // Later source edits do not invalidate historical evidence. Its original
      // revisions remain explicit; applying a proposal still checks live source.
      return new DesignResultStore(root, directoryId).write(bundle);
    });
  });
}
