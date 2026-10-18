import { z } from "zod";

// ──────────────────────────────────────────────────────────
// Design agent drafts — transient previews of in-flight native edits
// ──────────────────────────────────────────────────────────
//
// While a Local agent's file tool call that targets the active Design
// directory is still streaming, the engine sends the trusted local desktop a
// sanitized, script-free render of the content received so far. Drafts are
// never persisted, journaled, replayed or relayed to other devices; the saved
// file and the ordinary snapshot refresh remain authoritative and replace them.

export const DESIGN_AGENT_DRAFT_PHASES = [
  /** Tool input is still streaming. */
  "writing",
  /** Input is complete; the tool is running or awaiting permission. */
  "saving",
  /** The tool reported success; the canvas refresh replaces the draft. */
  "saved",
  /** The call failed, was refused or stopped, or its turn ended unsaved. */
  "discarded",
] as const;
export type DesignAgentDraftPhase = (typeof DESIGN_AGENT_DRAFT_PHASES)[number];

/** Largest preview document a draft may carry (sanitized HTML plus CSS). */
export const MAX_DESIGN_AGENT_DRAFT_PREVIEW_BYTES = 8 * 1024 * 1024;

export const designAgentDraftSchema = z
  .object({
    /** Opaque, stable for one native tool call. */
    id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    chatId: z.string().min(1).max(256).optional(),
    /** Active Design directory, relative to the workspace. */
    directory: z.string().min(1).max(512),
    /** Design-root-relative path, such as `page-1/card.html` or `tokens.css`. */
    file: z.string().min(1).max(1024),
    operation: z.enum(["write", "edit"]),
    phase: z.enum(DESIGN_AGENT_DRAFT_PHASES),
    /** Monotonic per draft; a lower revision never replaces a higher one. */
    revision: z.number().int().nonnegative().max(1_000_000),
    preview: z
      .object({
        srcDoc: z.string().max(MAX_DESIGN_AGENT_DRAFT_PREVIEW_BYTES),
        width: z.number().finite().min(1).max(16_384),
        height: z.number().finite().min(1).max(16_384),
        title: z.string().max(200).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type DesignAgentDraft = z.infer<typeof designAgentDraftSchema>;
