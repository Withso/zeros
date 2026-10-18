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
/** Most frames one in-flight canvas document may place. */
export const MAX_DESIGN_AGENT_DRAFT_REGISTRATIONS = 256;
/** Largest processed stylesheet text a draft may carry. */
export const MAX_DESIGN_AGENT_DRAFT_STYLESHEET_CHARS = 4 * 1024 * 1024;

/** A frame an in-flight `meta/canvas.json` registers: where the agent is
 * placing a file the saved canvas may not list yet. */
export const designAgentDraftRegistrationSchema = z
  .object({
    /** Design-root-relative frame file, such as `page-1/card.html`. */
    file: z.string().min(1).max(1024),
    x: z.number().finite().min(-1_000_000).max(1_000_000),
    y: z.number().finite().min(-1_000_000).max(1_000_000),
    width: z.number().finite().min(1).max(16_384),
    height: z.number().finite().min(1).max(16_384),
    title: z.string().max(120).optional(),
  })
  .strict();
export type DesignAgentDraftRegistration = z.infer<
  typeof designAgentDraftRegistrationSchema
>;

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
    /** For a linked Design stylesheet: the CSS live frames apply in place of
     * its saved text, processed as the saved form renders (rebased and with
     * local assets inlined). */
    stylesheet: z
      .object({ css: z.string().max(MAX_DESIGN_AGENT_DRAFT_STYLESHEET_CHARS) })
      .strict()
      .optional(),
    /** For a canvas document: the frames it registers so far, in order. */
    registrations: z
      .array(designAgentDraftRegistrationSchema)
      .max(MAX_DESIGN_AGENT_DRAFT_REGISTRATIONS)
      .optional(),
  })
  .strict();
export type DesignAgentDraft = z.infer<typeof designAgentDraftSchema>;
