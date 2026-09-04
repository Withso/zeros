// ──────────────────────────────────────────────────────────
// system-instructions — public surface
// ──────────────────────────────────────────────────────────
//
// THE home for everything Zeros injects into agent prompts. Import from here:
//   import { buildFirstTurnSystemInstruction, prependSystemInstruction }
//     from "@zeros/protocol/system-instructions";
//
// Edit the prose in ./templates.ts; edit the assembly in ./build.ts.
// ──────────────────────────────────────────────────────────

export {
  ADDITIONAL_DIRS_NOTICE,
  CODE_AGENT_DESIGN_TERRITORY_NOTICE,
  DESIGN_AGENT_AUTHORITY_NOTICE,
  DESIGN_AGENT_CONTEXT_NOTICE,
  DESIGN_AGENT_WORKSPACE_PREAMBLE,
  SYSTEM_INSTRUCTION_CLOSE,
  SYSTEM_INSTRUCTION_OPEN,
  WORKSPACE_PREAMBLE,
} from "./templates";

export {
  buildAdditionalDirsNotice,
  buildAdditionalDirsSystemInstruction,
  buildCodeAgentDesignTerritoryNotice,
  buildDesignAgentNotice,
  buildFirstTurnInstructionBody,
  buildFirstTurnSystemInstruction,
  buildWorkspacePreamble,
  prependSystemInstruction,
  wrapSystemInstruction,
} from "./build";
export type { FirstTurnInstructionInput } from "./build";
