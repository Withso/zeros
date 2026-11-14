import type { CommandHandler } from "../router";
import { cloudCatalogStreamState } from "../../auth-security-monitor";
import { cloudWorkspaceDesktopCapabilityEnabled } from "../../../src/engine/cloud-workspace-capability";

/** Whether this build and channel offer cloud workspaces at all. */
export const cloudWorkspaceCapability: CommandHandler = () => ({ enabled: cloudWorkspaceDesktopCapabilityEnabled() });
/** R1 catalog-events-v1: whether the account stream currently announces catalog events (a late renderer asks once). */
export const cloudCatalogStreamStateCommand: CommandHandler = () => cloudCatalogStreamState();
