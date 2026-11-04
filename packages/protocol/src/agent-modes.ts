import type { SessionModeState } from "./agent-events";

export type CloudPermissionMode = "plan" | "bypass";
export type CloudInteractionAgent = "claude" | "codex" | "cursor";

export function claudeRequiresExplicitApproval(options: { matchedAskRule?: unknown; defaultToNo?: boolean; suppressAlwaysAllowRule?: boolean }): boolean {
  return options.matchedAskRule != null || options.defaultToNo === true || options.suppressAlwaysAllowRule === true;
}

export function cloudModeId(agent: CloudInteractionAgent, mode: CloudPermissionMode): string {
  return mode === "plan" ? (agent === "codex" ? "read-only" : "plan")
    : agent === "codex" ? "full-access" : agent === "cursor" ? "agent" : "bypass";
}

export function cloudPermissionMode(agent: CloudInteractionAgent, modeId: string): CloudPermissionMode | undefined {
  if (modeId === cloudModeId(agent, "plan")) return "plan";
  if (modeId === cloudModeId(agent, "bypass")) return "bypass";
  return undefined;
}

export function cloudSessionModes(agent: CloudInteractionAgent, mode: CloudPermissionMode): SessionModeState {
  return { currentModeId: cloudModeId(agent, mode), availableModes: [
    { id: cloudModeId(agent, "plan"), name: "Plan", description: "Plan before making changes." },
    { id: cloudModeId(agent, "bypass"), name: "Full access", description: "Run tools with full permissions in this workspace." },
  ] };
}

export function claudePermissionMode(mode: "default" | "plan" | "accept-edits" | "auto" | "bypass") {
  switch (mode) {
    case "accept-edits": return "acceptEdits";
    case "bypass": return "bypassPermissions";
    case "plan": return "plan";
    case "auto": return "auto";
    default: return "default";
  }
}

export function cursorSdkMode(modeId: "agent" | "plan" | "auto"): "agent" | "plan" {
  return modeId === "plan" ? "plan" : "agent";
}
export function cursorAutoReview(modeId: "agent" | "plan" | "auto"): boolean { return modeId === "auto"; }

/** Default collaboration mode omits request_user_input unless this native feature is enabled. */
export function codexQuestionFeatureArgs(): string[] {
  return ["-c", "features.default_mode_request_user_input=true", "-c", "suppress_unstable_features_warning=true"];
}

interface CodexPermissionPolicy {
  approvalPolicy: "untrusted" | "on-request" | "never";
  sandboxMode: "workspace-write" | "danger-full-access" | "read-only";
  sandboxPolicy: { type: "dangerFullAccess" } | { type: "readOnly"; networkAccess: boolean } |
    { type: "workspaceWrite"; writableRoots: string[]; networkAccess: boolean; excludeTmpdirEnvVar: boolean; excludeSlashTmp: boolean };
}

export function codexModePolicy(modeId: "ask" | "auto-edit" | "full-access" | "read-only"): CodexPermissionPolicy {
  switch (modeId) {
    case "ask":
      return {
        // Ask First gates commands independently of the model's escalation choice.
        approvalPolicy: "untrusted",
        sandboxMode: "workspace-write",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      };
    case "auto-edit":
      return {
        // Codex's Auto preset allows sandboxed work and asks on escalation.
        approvalPolicy: "on-request",
        sandboxMode: "workspace-write",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      };
    case "full-access":
      return {
        approvalPolicy: "never",
        sandboxMode: "danger-full-access",
        sandboxPolicy: { type: "dangerFullAccess" },
      };
    case "read-only":
      return {
        approvalPolicy: "on-request",
        sandboxMode: "read-only",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      };
  }
}
