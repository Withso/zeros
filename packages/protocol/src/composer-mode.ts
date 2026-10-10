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

/** A frame's output format is independent of the agent's authoring tools. */
export const DESIGN_FRAME_AUTHORING_INSTRUCTION =
  "Design frames render HTML, CSS and supported local assets. Use CSS @keyframes for animation and CSS transitions for visual states. Authored scripts, inline event handlers, JSX/TSX and application logic do not run in a frame. Represent controls as visual states; live components will use separate Code layers. Normal shell, Node and Python tools may generate and validate source. Preserve stable frame IDs and viewport dimensions, and verify the actual rendered frame. When implementing an application from a frame reference, follow that application's normal source and runtime conventions.";

/** Local mode is task intent. API-only executions retain their authoring policy. */
export function composerModeInstruction(
  mode: ComposerMode,
  revision?: number,
  authoringMethod: DesignAuthoringMethod = "native",
): string {
  if (authoringMethod === "native") {
    return `Current composer mode: ${mode === "design" ? "Design" : "Code"}. ${
      mode === "design"
        ? "Default to creating or editing Design source for the user's request."
        : "Default to implementing application code; attached Design frames are reference context. Design inspection and explicitly requested Design source edits are available in this context."
    } The user's explicit request determines the editing target. Use your normal Read, Write, Edit, patch and Bash tools for authorized Code and Design work. No mode switch or separate Design session is required. ${DESIGN_FRAME_AUTHORING_INSTRUCTION} Read the relevant directory's root rules.md and meta/canvas.json, then relevant source. Each page has a folder: create frames by writing <page.folder>/<name>.html and adding stable IDs, source paths and bounds to meta/canvas.json frames and that page's frames array. Follow the active page named in context unless the user says otherwise. Link ../tokens.css from a page's frame; shared tokens, components and assets stay at the Design root. Zeros refreshes the canvas from saved files. No Design API apply or publish is required; inspection and semantic API tools are optional. Provider Plan and permission settings still apply. Use Zeros lifecycle operations to create, migrate or remove directory registration at meta/design.toml; preserve directory, page and frame IDs during source conflict repair. Legacy root design.toml/canvas.json remain readable and upgrade on explicit Design authoring. Git operates on the same checkout in either context and does not change the Design tag. Saving never stages or commits. Re-read changed files before editing and preserve concurrent work. ${revision === undefined ? "" : `Composer intent revision: expectedRevision=${revision}.`}`;
  }
  return `Current composer mode: ${mode === "design" ? "Design" : "Code"}. Cloud retains API authoring for now as product policy. The workspace VM is the isolation boundary. There is no agent sandbox; agents share the non-root engine identity and can read engine and other-conversation state. ${DESIGN_FRAME_AUTHORING_INSTRUCTION} ${
    mode === "design"
      ? authoringMethod === "api"
        ? "Author designs through the Design API in this execution. Read design_capabilities for the active directory, page catalog and activePageId before editing. Use design_frame_create for new frames and design_frame_duplicate for copies. Supply the intended pageId when several pages exist; omission is accepted only for a single page. The active-page hint is context, so explicitly pass its ID when that is the user's target. Use design_document_open to obtain the exact revision, then design_transaction_apply for supported semantic edits. Reuse the same request ID and body after a lost reply; refresh stale revisions before preparing a new edit. Inspect, styles, validate and capture remain available helpers. No proposal or separate Design session is needed."
        : "Use your normal Read, Write, Edit, patch and Bash tools to author HTML, CSS, assets and meta/canvas.json in the active Design directory. Read its root rules.md and meta/canvas.json once, then read only relevant source. Each page has a folder: create a frame by writing <page.folder>/<name>.html and adding its stable ID, source, title and bounds to meta/canvas.json frames and that page's frames array. Patch existing source and preserve directory, page and frame IDs and unrelated metadata. Zeros refreshes the canvas from the saved files. No Design API apply or publish is required. Inspect, styles, validate and capture are optional helpers. No proposal or separate Design session is needed."
      : "Design inspection is available, but Design writes require Design mode."
  } Use design_mode_set to change modes only when the user's request authorizes that work; a mixed Code/Design request may authorize both switches. Opening or reading designs alone does not authorize a switch. ${revision === undefined ? "Use design_capabilities if you need the current mode revision." : `The current mode revision is expectedRevision=${revision}.`} Provider Plan and permission settings still apply. Code files remain available for normal authorized work. Registration lives at meta/design.toml and page metadata at meta/canvas.json; root rules.md, tokens.css, components and assets are shared. Legacy root design.toml/canvas.json remain readable. Use Zeros lifecycle tools for directory registration. Do not change permissions or use Git to bypass the authoring contract. Re-read files that changed before editing; do not overwrite concurrent work. Saving leaves normal uncommitted branch changes.`;
}
