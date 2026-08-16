// ──────────────────────────────────────────────────────────
// System-instruction ASSEMBLERS
// ──────────────────────────────────────────────────────────
//
// Pure functions that fill the templates in ./templates.ts and wrap them for
// injection. No I/O, no side effects — every input (workspace dir, branch,
// dirs, custom instructions) is passed in by the caller (the send path), so
// this is trivially unit-testable. See ./templates.ts for the strings and the
// delivery model.
// ──────────────────────────────────────────────────────────

import {
  ADDITIONAL_DIRS_NOTICE,
  CODE_AGENT_DESIGN_TERRITORY_NOTICE,
  SYSTEM_INSTRUCTION_CLOSE,
  SYSTEM_INSTRUCTION_OPEN,
  WORKSPACE_PREAMBLE,
} from "./templates";

/** Inputs for the first-turn workspace preamble. All optional except the
 *  workspace dir — missing pieces are simply omitted from the output. */
export interface FirstTurnInstructionInput {
  /** Absolute cwd of the chat's workspace → {WORKSPACE_DIR}. */
  workspaceDir: string;
  /** PR/diff target, e.g. "origin/main" → {TARGET_BRANCH}. Defaults to origin/main. */
  targetBranch?: string | null;
  /** Extra dirs granted via /add-dir (Claude). Empty/undefined → the notice is skipped. */
  additionalDirectories?: readonly string[];
  /** Repo/user `[prompts] general` from .zeros/settings.toml. Empty → skipped. */
  customInstructions?: string | null;
  /** Absolute active Design directory. When present, inject the permanent
   * code-actor territory rule independently of the UI's current view mode. */
  designDirectory?: string | null;
}

/** Fill {WORKSPACE_DIR} + {TARGET_BRANCH} in the base preamble. */
export function buildWorkspacePreamble(input: {
  workspaceDir: string;
  targetBranch?: string | null;
}): string {
  const branch = input.targetBranch?.trim() || "origin/main";
  // split/join (not replaceAll) so packages/protocol stays compatible with its
  // pre-ES2021 lib target.
  return WORKSPACE_PREAMBLE.split("{WORKSPACE_DIR}")
    .join(input.workspaceDir)
    .split("{TARGET_BRANCH}")
    .join(branch);
}

/** The /add-dir awareness line, or "" when there are no additional dirs. */
export function buildAdditionalDirsNotice(dirs?: readonly string[]): string {
  const clean = (dirs ?? []).map((d) => d.trim()).filter(Boolean);
  if (clean.length === 0) return "";
  return ADDITIONAL_DIRS_NOTICE.split("{DIRS}").join(clean.join(", "));
}

/** Code-actor Design-territory notice, or "" when this workspace has no
 * active Design document. */
export function buildCodeAgentDesignTerritoryNotice(
  designDirectory?: string | null,
): string {
  const directory = designDirectory?.trim();
  if (!directory) return "";
  return CODE_AGENT_DESIGN_TERRITORY_NOTICE.split("{DESIGN_DIR}").join(
    directory,
  );
}

/** Wrap a non-empty body in <system_instruction>…</system_instruction>.
 *  Returns "" for an empty/whitespace body (nothing to inject). */
export function wrapSystemInstruction(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  return `${SYSTEM_INSTRUCTION_OPEN}\n${trimmed}\n${SYSTEM_INSTRUCTION_CLOSE}`;
}

/** The UNWRAPPED first-turn instruction body: workspace preamble + (optional)
 *  /add-dir notice + (optional) custom instructions. For agents with a native
 *  instruction channel (Codex `thread/start.developerInstructions`) — a proper
 *  channel needs no <system_instruction> disguise. */
export function buildFirstTurnInstructionBody(input: FirstTurnInstructionInput): string {
  const parts = [buildWorkspacePreamble(input)];
  const dirs = buildAdditionalDirsNotice(input.additionalDirectories);
  if (dirs) parts.push(dirs);
  // Repository/user prose is untrusted with respect to runtime authority. Put
  // it before the engine-owned boundary so it can never be the last word on
  // whether the coding actor may mutate Design territory.
  const custom = input.customInstructions?.trim();
  if (custom) parts.push(custom);
  const territory = buildCodeAgentDesignTerritoryNotice(input.designDirectory);
  if (territory) parts.push(territory);
  return parts.join("\n\n").trim();
}

/** Assemble the ONE first-turn block: the body above, wrapped for in-band
 *  injection. This is what the send path prepends to the first user message's
 *  agent text (mechanism A — agents without a native instruction channel). */
export function buildFirstTurnSystemInstruction(input: FirstTurnInstructionInput): string {
  return wrapSystemInstruction(buildFirstTurnInstructionBody(input));
}

/** Standalone <system_instruction> carrying ONLY the /add-dir awareness — for
 *  injecting on a mid-chat turn where the user just added directories (the
 *  first-turn preamble already shipped). Returns "" when there are no dirs. */
export function buildAdditionalDirsSystemInstruction(dirs?: readonly string[]): string {
  return wrapSystemInstruction(buildAdditionalDirsNotice(dirs));
}

/** Prepend an assembled <system_instruction> block to the agent-facing user
 *  text. No-op (returns the text unchanged) when the block is empty. The block
 *  goes ONLY into the agent payload — never the displayed bubble. */
export function prependSystemInstruction(block: string, userText: string): string {
  return block ? `${block}\n\n${userText}` : userText;
}
