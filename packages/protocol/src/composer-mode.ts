import { z } from "zod";

/** Product authoring intent, independent of provider permissions and Plan. */
export const composerModeSchema = z.enum(["code", "design"]);
export type ComposerMode = z.infer<typeof composerModeSchema>;
export const composerModeSnapshotSchema = z
  .object({
    mode: composerModeSchema,
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type ComposerModeSnapshot = z.infer<typeof composerModeSnapshotSchema>;

export const DESIGN_MCP_SERVER = "design-draft";
export type DesignAuthoringMethod = "native" | "api";

/** This is instruction policy, not a filesystem sandbox or proof of consent. */
export function composerModeInstruction(
  mode: ComposerMode,
  revision?: number,
  authoringMethod: DesignAuthoringMethod = "native",
): string {
  return `Current composer mode: ${mode === "design" ? "Design" : "Code"}. ${
    mode === "design"
      ? authoringMethod === "api"
        ? "Author designs through the Design API in this execution. Native file writes to Design are unavailable under the execution boundary. Read design_capabilities for the active directory before editing. Use design_frame_create for new frames and design_document_open to obtain the exact revision, then use design_transaction_apply for supported semantic edits. Reuse the same request ID and body after a lost reply; refresh stale revisions before preparing a new edit. Inspect, styles, validate and capture remain available helpers. No proposal or separate Design session is needed."
        : "Use your normal Read, Write, Edit, patch and Bash tools to author HTML, CSS, assets and canvas.json in the active Design directory. Read its rules.md and canvas.json once, then read only relevant source. Create a frame by writing its HTML and adding its stable ID, source, title and bounds to canvas.json frames and pages[0].frames. Patch existing source and preserve IDs and unrelated metadata. Zeros refreshes the canvas from the saved files. No Design API apply or publish is required. Inspect, styles, validate and capture are optional helpers. No proposal or separate Design session is needed."
      : "Design inspection is available, but Design writes require Design mode."
  } Use design_mode_set to change modes only when the user's request authorizes that work; a mixed Code/Design request may authorize both switches. Opening or reading designs alone does not authorize a switch. ${revision === undefined ? "Use design_capabilities if you need the current mode revision." : `The current mode revision is expectedRevision=${revision}.`} Provider Plan and permission settings still apply. Code files remain available for normal authorized work. Use Zeros lifecycle tools for directory registration and design.toml. Do not change permissions or use Git to bypass the authoring contract. Re-read files that changed before editing; do not overwrite concurrent work. Saving leaves normal uncommitted branch changes.`;
}
