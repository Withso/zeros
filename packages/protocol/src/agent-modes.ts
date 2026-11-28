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

export type CodexPermissionModeId = "ask" | "auto-edit" | "full-access" | "read-only";

export function codexModePolicy(modeId: CodexPermissionModeId): CodexPermissionPolicy {
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

/** The approval and sandbox allow-lists of Codex `configRequirements/read`
 * (requirements.toml, MDM or the ChatGPT workspace). A null or absent list is
 * unrestricted; values Zeros never sends (granular approvals) are ignored. */
export interface CodexPolicyRequirements {
  allowedApprovalPolicies?: readonly unknown[] | null;
  allowedSandboxModes?: readonly unknown[] | null;
}

/** Most to least restrictive. Read-only with on-request still asks before any
 * write, so it is the nearest stricter stand-in for Ask First. */
const CODEX_MODE_RESTRICTIVENESS: readonly CodexPermissionModeId[] = ["read-only", "ask", "auto-edit", "full-access"];

export function codexModeAllowed(modeId: CodexPermissionModeId, requirements: CodexPolicyRequirements | null | undefined): boolean {
  const { approvalPolicy, sandboxMode } = codexModePolicy(modeId);
  const approvals = requirements?.allowedApprovalPolicies;
  const sandboxes = requirements?.allowedSandboxModes;
  return (!Array.isArray(approvals) || approvals.includes(approvalPolicy)) &&
    (!Array.isArray(sandboxes) || sandboxes.includes(sandboxMode));
}

/** The exact mode when allowed, else the nearest allowed among `offered`,
 * more restrictive first; null when managed policy allows none of them. */
export function resolveCodexMode(
  modeId: CodexPermissionModeId,
  requirements: CodexPolicyRequirements | null | undefined,
  offered: readonly CodexPermissionModeId[] = CODEX_MODE_RESTRICTIVENESS,
): CodexPermissionModeId | null {
  const ranked = CODEX_MODE_RESTRICTIVENESS.filter((id) => offered.includes(id));
  const at = ranked.indexOf(modeId);
  const candidates = at < 0 ? ranked : [...ranked.slice(0, at + 1).reverse(), ...ranked.slice(at + 1)];
  return candidates.find((id) => codexModeAllowed(id, requirements)) ?? null;
}

function allowedList(values: readonly unknown[] | null | undefined): string {
  if (!Array.isArray(values)) return "any";
  const names = values.map((value) => typeof value === "string" ? value
    : value && typeof value === "object" && "granular" in value ? "granular" : "").filter(Boolean).slice(0, 8);
  return names.length ? names.join(", ") : "none";
}

/** User-facing refusal naming the managed policy. Without a mode it means no
 * Zeros permission mode can start a Codex thread. */
export function codexPolicyBlockedMessage(
  requirements: CodexPolicyRequirements | null | undefined,
  modeId?: CodexPermissionModeId,
): string {
  const allowed = `Allowed approval policies: ${allowedList(requirements?.allowedApprovalPolicies)}; allowed sandbox modes: ${allowedList(requirements?.allowedSandboxModes)}.`;
  if (!modeId) {
    return `Your organization's Codex policy allows none of Zeros' permission modes. ${allowed} Ask your administrator to allow one.`;
  }
  const { approvalPolicy, sandboxMode } = codexModePolicy(modeId);
  return `Your organization's Codex policy does not allow the "${modeId}" permission mode (approval "${approvalPolicy}", sandbox "${sandboxMode}"). ${allowed} Choose another mode.`;
}
