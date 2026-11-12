import { HttpError } from "../../authz.js";
import type { CloudV2Agent } from "../contract.js";

export const actorChanged = () => new HttpError(409, "actor_changed", "Execution authority changed");
export const actorBusy = () => new HttpError(409, "actor_busy", "The preceding turn is still retiring");
export const executionUnavailable = () => new HttpError(503, "agent_credentials_unavailable", "Execution credentials are temporarily unavailable");
export const executionWorkerRequired = () => new HttpError(409, "worker_update_required", "This workspace requires an updated worker before shared execution");
export const memberAccessRevoked = () => new HttpError(403, "member_access_revoked", "Workspace access has been removed");
export const workspaceCreatorRequired = () => new HttpError(409, "workspace_creator_required", "This workspace needs an eligible Creator before messages can run");
export class AgentLoginRequired extends HttpError {
  constructor(readonly agent: CloudV2Agent, readonly loginRequiredFrom: "self" | "creator" = "self") {
    super(409, "agent_login_required", loginRequiredFrom === "self" ? `Connect your ${agent} account` : `The Creator needs to connect ${agent}`);
  }
}
