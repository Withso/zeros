import type { CommandHandler } from "../router";
import { cloudWorkspaceDesktopCapabilityEnabled } from "../../../src/engine/cloud-workspace-capability";

/** Whether this build and channel offer cloud workspaces at all. */
export const cloudWorkspaceCapability: CommandHandler = () => ({ enabled: cloudWorkspaceDesktopCapabilityEnabled() });
