import { z } from "zod";

/** Portable context identity, deliberately separate from tool/write authority. */
export const designContextReferenceSchema = z
  .object({
    version: z.literal(1),
    workspaceId: z.string().min(1).max(4096),
    directoryId: z.string().min(1).max(128),
    frame: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.html$/i),
    nodeId: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[^\x00-\x1f\x7f]+$/)
      .optional(),
    revision: z.string().regex(/^[a-f0-9]{24}$/),
  })
  .strict();

export type DesignContextReference = z.infer<
  typeof designContextReferenceSchema
>;
export type DesignContextInspection =
  | {
      status: "ready";
      reference: DesignContextReference;
      title: string;
      source: string;
      width: number;
      height: number;
    }
  | {
      status: "stale";
      reference: DesignContextReference;
      currentRevision: string;
    }
  | {
      status: "missing" | "wrong-directory";
      reference: DesignContextReference;
    };

/** Checkout diagnostics remain readable even when Design metadata cannot parse. */
export interface DesignCheckoutStatus {
  conflicts: string[];
  operation: "merge" | "rebase" | "cherry-pick" | "revert" | null;
}
