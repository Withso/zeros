
import {
  ADDITIONAL_DIRS_NOTICE,
  CODE_AGENT_DESIGN_TERRITORY_NOTICE,
  DESIGN_AGENT_AUTHORITY_NOTICE,
  DESIGN_AGENT_CONTEXT_NOTICE,
  DESIGN_AGENT_WORKSPACE_PREAMBLE,
  SYSTEM_INSTRUCTION_CLOSE,
  SYSTEM_INSTRUCTION_OPEN,
  WORKSPACE_PREAMBLE,
} from "./templates";

export interface FirstTurnInstructionInput {
  workspaceDir: string;
  targetBranch?: string | null;
  /** /add-dir grants additional directories separately from this awareness notice. */
  additionalDirectories?: readonly string[];
  /** Read from [prompts] general through the send path. */
  customInstructions?: string | null;
  /** The active Design root affects the instruction independently of the current view. */
  designDirectory?: string | null;
  designDirectories?: readonly string[];
  /** Defaults to code for serialized/backward compatibility. */
  agentRole?: "code" | "design";
}

/** Retained legacy-role formatter; shared mode instructions live in composer-mode.ts. */
export function buildDesignAgentNotice(
  designDirectory?: string | null,
): string {
  const directory = designDirectory?.trim() || "the active Design draft";
  return DESIGN_AGENT_AUTHORITY_NOTICE.split("{DESIGN_DIR}").join(directory);
}

function buildDesignAgentWorkspacePreamble(workspaceDir: string): string {
  return DESIGN_AGENT_WORKSPACE_PREAMBLE.split("{WORKSPACE_DIR}").join(
    workspaceDir,
  );
}

function buildDesignAgentContextNotice(dirs?: readonly string[]): string {
  const clean = (dirs ?? []).map((entry) => entry.trim()).filter(Boolean);
  if (clean.length === 0) return "";
  return DESIGN_AGENT_CONTEXT_NOTICE.split("{DIRS}").join(clean.join(", "));
}

export function buildWorkspacePreamble(input: {
  workspaceDir: string;
  targetBranch?: string | null;
}): string {
  const branch = input.targetBranch?.trim() || "origin/main";
  // tsconfig.build.json targets ES2020, so do not use replaceAll.
  return WORKSPACE_PREAMBLE.split("{WORKSPACE_DIR}")
    .join(input.workspaceDir)
    .split("{TARGET_BRANCH}")
    .join(branch);
}

export function buildAdditionalDirsNotice(dirs?: readonly string[]): string {
  const clean = (dirs ?? []).map((d) => d.trim()).filter(Boolean);
  if (clean.length === 0) return "";
  return ADDITIONAL_DIRS_NOTICE.split("{DIRS}").join(clean.join(", "));
}

export function buildCodeAgentDesignTerritoryNotice(
  designDirectories?: string | readonly string[] | null,
): string {
  const directories = [
    ...new Set(
      (Array.isArray(designDirectories)
        ? designDirectories
        : [designDirectories]
      )
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
  if (directories.length === 0) return "";
  return CODE_AGENT_DESIGN_TERRITORY_NOTICE.split("{DESIGN_DIRS}").join(
    directories.join(", "),
  );
}

/** An empty discovery snapshot must not hide the active Design root. */
export function effectiveCodeAgentDesignDirectories(
  designDirectories: readonly string[] | undefined,
  designDirectory: string | null | undefined,
): readonly string[] | string | null | undefined {
  return designDirectories && designDirectories.length > 0
    ? designDirectories
    : designDirectory;
}

export function wrapSystemInstruction(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  return `${SYSTEM_INSTRUCTION_OPEN}\n${trimmed}\n${SYSTEM_INSTRUCTION_CLOSE}`;
}

/** Native channels such as Codex developerInstructions receive the body without the in-band wrapper. */
export function buildFirstTurnInstructionBody(
  input: FirstTurnInstructionInput,
): string {
  const designAgent = input.agentRole === "design";
  const parts = [
    designAgent
      ? buildDesignAgentWorkspacePreamble(input.workspaceDir)
      : buildWorkspacePreamble(input),
  ];
  const dirs = designAgent
    ? buildDesignAgentContextNotice(input.additionalDirectories)
    : buildAdditionalDirsNotice(input.additionalDirectories);
  if (dirs) parts.push(dirs);
  // Put user and repository prose before the engine-owned Design policy so the latter has the last word.
  const custom = input.customInstructions?.trim();
  if (custom) parts.push(custom);
  const territory = designAgent
    ? buildDesignAgentNotice(input.designDirectory)
    : buildCodeAgentDesignTerritoryNotice(
        effectiveCodeAgentDesignDirectories(
          input.designDirectories,
          input.designDirectory,
        ),
      );
  if (territory) parts.push(territory);
  return parts.join("\n\n").trim();
}

/** Adapters without a native instruction channel receive the wrapped body in-band. */
export function buildFirstTurnSystemInstruction(
  input: FirstTurnInstructionInput,
): string {
  return wrapSystemInstruction(buildFirstTurnInstructionBody(input));
}

/** Send only the additional-directory notice when /add-dir changes mid-chat. */
export function buildAdditionalDirsSystemInstruction(
  dirs?: readonly string[],
): string {
  return wrapSystemInstruction(buildAdditionalDirsNotice(dirs));
}

/** Use only on agent-facing text, never the user-visible bubble. */
export function prependSystemInstruction(
  block: string,
  userText: string,
): string {
  return block ? `${block}\n\n${userText}` : userText;
}
