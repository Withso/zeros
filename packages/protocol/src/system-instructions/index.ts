
export {
  ADDITIONAL_DIRS_NOTICE,
  CLOUD_COMPUTER_ADMIN_WORKSPACE_NOTICE,
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
  effectiveCodeAgentDesignDirectories,
  buildFirstTurnInstructionBody,
  buildFirstTurnSystemInstruction,
  buildWorkspacePreamble,
  prependSystemInstruction,
  wrapSystemInstruction,
} from "./build";
export type { FirstTurnInstructionInput } from "./build";
