import type { PermissionOption, RequestPermissionRequest, RequestPermissionResponse } from "./agent-events";

const approvalMethods = [
  "item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval",
  // Migrated sessions can still emit the pinned app-server's v1 requests.
  "execCommandApproval", "applyPatchApproval",
] as const;
export type CodexApprovalMethod = typeof approvalMethods[number];
export const isCodexApprovalMethod = (method: string): method is CodexApprovalMethod => approvalMethods.some(value => value === method);
export interface CodexApprovalInput { method: CodexApprovalMethod; params: Record<string, unknown> }
export interface CodexApprovalSession { zerosSessionId: string; cwd: string; fileEditPathsByItemId: ReadonlyMap<string, string[]> }
export interface CodexApprovalPath { isAbsolute(value: string): boolean; resolve(...values: string[]): string; relative(from: string, to: string): string; sep: string }

interface NativeCommandChoice {
  option: PermissionOption;
  decision: unknown;
}

const BASE_COMMAND_DECISIONS = {
  accept: { name: "Approve once", kind: "allow_once" },
  acceptForSession: {
    name: "Approve for session",
    kind: "allow_always",
  },
  decline: { name: "Decline", kind: "reject_once" },
  cancel: { name: "Cancel", kind: "reject_always" },
} as const;

/** IDs reference the native request by position; renderer input cannot manufacture a policy. */
function nativeCommandChoice(
  decision: unknown,
  index: number,
): NativeCommandChoice | null {
  if (typeof decision === "string" && decision in BASE_COMMAND_DECISIONS) {
    const spec =
      BASE_COMMAND_DECISIONS[decision as keyof typeof BASE_COMMAND_DECISIONS];
    return {
      option: { optionId: decision, name: spec.name, kind: spec.kind },
      decision,
    };
  }

  const record = asRecord(decision);
  const exec = asRecord(record?.acceptWithExecpolicyAmendment);
  const execPolicy = exec?.execpolicy_amendment;
  if (
    Array.isArray(execPolicy) &&
    execPolicy.length > 0 &&
    execPolicy.every((part) => typeof part === "string")
  ) {
    return {
      option: {
        optionId: `acceptWithExecpolicyAmendment:${index}`,
        name: "Approve and remember command rule",
        kind: "allow_always",
      },
      decision,
    };
  }

  const network = asRecord(record?.applyNetworkPolicyAmendment);
  const amendment = asRecord(network?.network_policy_amendment);
  const host = stringField(amendment ?? {}, "host")?.trim();
  const action = amendment?.action;
  if (host && (action === "allow" || action === "deny")) {
    return {
      option: {
        optionId: `applyNetworkPolicyAmendment:${index}`,
        name:
          action === "allow"
            ? `Approve and allow ${host}`
            : `Deny and block ${host}`,
        kind: action === "allow" ? "allow_always" : "reject_always",
      },
      decision,
    };
  }
  return null;
}

function nativeCommandChoices(
  params: Record<string, unknown>,
): NativeCommandChoice[] | null {
  const available = params.availableDecisions;
  if (!Array.isArray(available)) return null;
  const choices: NativeCommandChoice[] = [];
  const seenIds = new Set<string>();
  for (let index = 0; index < available.length; index += 1) {
    const choice = nativeCommandChoice(available[index], index);
    if (!choice || seenIds.has(choice.option.optionId)) continue;
    seenIds.add(choice.option.optionId);
    choices.push(choice);
  }
  return choices;
}

function commandApprovalContext(params: Record<string, unknown>): string[] {
  const items: string[] = [];
  const networkContext = asRecord(params.networkApprovalContext);
  const host = stringField(networkContext ?? {}, "host")?.trim();
  const protocol = stringField(networkContext ?? {}, "protocol")?.trim();
  if (host) {
    items.push(`Network · ${protocol ? `${protocol}://` : ""}${host}`);
  }

  const additional = asRecord(params.additionalPermissions);
  const network = asRecord(additional?.network);
  if (network?.enabled === true) items.push("Extra network access");
  const fileSystem = asRecord(additional?.fileSystem);
  for (const [label, value] of [
    ["Read", fileSystem?.read],
    ["Write", fileSystem?.write],
  ] as const) {
    if (!Array.isArray(value)) continue;
    for (const pathValue of value) {
      if (typeof pathValue === "string" && pathValue.trim()) {
        items.push(`${label} · ${pathValue}`);
      }
    }
  }
  if (Array.isArray(fileSystem?.entries)) {
    for (const entryValue of fileSystem.entries) {
      const entry = asRecord(entryValue);
      const access = stringField(entry ?? {}, "access");
      const pathSpec = asRecord(entry?.path);
      const pathValue =
        stringField(pathSpec ?? {}, "path") ??
        stringField(pathSpec ?? {}, "pattern") ??
        stringField(pathSpec ?? {}, "value");
      if (access && pathValue) items.push(`${access} · ${pathValue}`);
    }
  }
  // rawInput retains the full scope when the visible context needs bounding.
  return items.slice(0, 6);
}

/** A dedicated write card would hide mixed grants, stdin or policy amendments. */
function commandWriteAccessPath(params: Record<string, unknown>, sessionCwd: string, path: CodexApprovalPath): string | null {
  const additional = asRecord(params.additionalPermissions);
  const fileSystem = asRecord(additional?.fileSystem);
  if (!fileSystem || params.kind === "writeStdin" || params.networkApprovalContext != null ||
      asRecord(additional?.network)?.enabled === true ||
      (Array.isArray(params.proposedExecpolicyAmendment) && params.proposedExecpolicyAmendment.length > 0) ||
      (Array.isArray(params.proposedNetworkPolicyAmendments) && params.proposedNetworkPolicyAmendments.length > 0) ||
      (Array.isArray(params.availableDecisions) && params.availableDecisions.some(value => typeof value !== "string"))) return null;
  if (fileSystem.read != null && (!Array.isArray(fileSystem.read) || fileSystem.read.length > 0)) return null;
  if (fileSystem.write != null && !Array.isArray(fileSystem.write)) return null;
  const writes: string[] = [];
  for (const value of (fileSystem.write as unknown[] | null | undefined) ?? []) {
    if (typeof value !== "string" || !value.trim() || value.includes("\0")) return null;
    writes.push(value);
  }
  if (fileSystem.entries != null) {
    if (!Array.isArray(fileSystem.entries)) return null;
    for (const value of fileSystem.entries) {
      const entry = asRecord(value), target = asRecord(entry?.path);
      if (entry?.access !== "write" || target?.type !== "path" || typeof target.path !== "string" ||
          !target.path.trim() || target.path.includes("\0")) return null;
      writes.push(target.path);
    }
  }
  const cwd = stringField(params, "cwd") ?? sessionCwd;
  if (!cwd || !path.isAbsolute(cwd)) return null;
  const root = path.resolve(cwd), targets = [...new Set(writes.map(value => path.resolve(root, value)))];
  if (targets.length !== 1 || targets[0] === root || targets[0].startsWith(root + path.sep)) return null;
  return path.relative(root, targets[0]);
}

/** Preserve the provider's ordered choices and original grant scope in the existing permission card. */
export function mapCodexApprovalToPermission(
  session: CodexApprovalSession,
  request: CodexApprovalInput,
  runtime: { path: CodexApprovalPath; newId: () => string },
): RequestPermissionRequest {
  const params = request.params;
  const itemId =
    stringField(params, "itemId") ??
    stringField(params, "callId") ??
    runtime.newId();
  const reason = stringField(params, "reason");
  const command = commandField(params, "command");
  const cwd = stringField(params, "cwd");
  const commandApprovalKind =
    stringField(params, "kind") === "writeStdin" ? "writeStdin" : "command";
  const writeAccessPath = request.method === "item/commandExecution/requestApproval"
    ? commandWriteAccessPath(params, session.cwd, runtime.path) : null;

  let title: string;
  let kind: "execute" | "edit" | "switch_mode";
  let rawInput: unknown;
  switch (request.method) {
    case "item/commandExecution/requestApproval":
    case "execCommandApproval":
      title =
        request.method === "item/commandExecution/requestApproval" &&
        commandApprovalKind === "writeStdin"
          ? "Send input to running terminal"
          : command
            ? `Run: ${truncate(command, 60)}`
            : "Run shell command";
      kind = "execute";
      rawInput = {
        ...(request.method === "item/commandExecution/requestApproval"
          ? {
              approvalKind: commandApprovalKind,
              approvalId: stringField(params, "approvalId"),
            }
          : {}),
        command,
        cwd,
        reason,
        networkApprovalContext: params.networkApprovalContext,
        additionalPermissions: params.additionalPermissions,
        proposedExecpolicyAmendment: params.proposedExecpolicyAmendment,
        proposedNetworkPolicyAmendments: params.proposedNetworkPolicyAmendments,
        availableDecisions: params.availableDecisions,
        ...(writeAccessPath ? { codexWriteAccessPath: writeAccessPath } : {}),
      };
      break;
    case "item/fileChange/requestApproval": {
      // File approval params omit paths; the preceding streamed item owns them.
      const filePaths = session.fileEditPathsByItemId.get(itemId) ?? [];
      title = "Apply file changes";
      kind = "edit";
      rawInput = {
        reason,
        grantRoot: stringField(params, "grantRoot"),
        ...(filePaths.length > 0 ? { filePaths } : {}),
      };
      break;
    }
    case "applyPatchApproval": {
      const fileChanges = asRecord(params.fileChanges);
      const filePaths = fileChanges ? Object.keys(fileChanges) : [];
      title = "Apply file changes";
      kind = "edit";
      rawInput = {
        reason,
        grantRoot: stringField(params, "grantRoot"),
        ...(filePaths.length > 0 ? { filePaths } : {}),
      };
      break;
    }
    case "item/permissions/requestApproval":
      title = reason ? `Permission: ${reason}` : "Expand permissions";
      kind = "switch_mode";
      rawInput = { permissions: params.permissions, reason };
      break;
  }

  const nativeChoices =
    request.method === "item/commandExecution/requestApproval"
      ? nativeCommandChoices(params)
      : null;
  const options =
    nativeChoices === null
      ? [
          { optionId: "accept", name: "Approve", kind: "allow_once" },
          {
            optionId: "acceptForSession",
            name: "Approve for session",
            kind: "allow_always",
          },
          { optionId: "decline", name: "Decline", kind: "reject_once" },
          { optionId: "cancel", name: "Cancel", kind: "reject_always" },
        ]
      : nativeChoices.length > 0
        ? nativeChoices.map((choice) => choice.option)
        : [
            {
              optionId: "cancel",
              name: "Cancel unsupported approval",
              kind: "reject_always",
            },
          ];
  const contextItems =
    writeAccessPath ? [`Write · ${writeAccessPath}`] : request.method === "item/commandExecution/requestApproval"
      ? commandApprovalContext(params)
      : [];

  return {
    sessionId: session.zerosSessionId as never,
    ...(writeAccessPath ? { title: "Do you want to allow write access outside the workspace?" } : {}),
    toolCall: {
      toolCallId: itemId,
      title,
      kind: kind as never,
      status: "pending" as never,
      rawInput,
    } as never,
    options,
    // Local title/kind policies could choose the wrong native amendment; plain legacy gates retain their saved rules.
    ...(nativeChoices !== null
      ? { useOptionNames: true, allowLocalPolicies: false }
      : {}),
    ...(contextItems.length > 0 ? { contextItems } : {}),
  } as never;
}

/** Grants come only from the original native request, never from renderer-supplied policy data. */
export function mapCodexPermissionResponse(
  pending: CodexApprovalInput,
  response: RequestPermissionResponse,
): unknown {
  const { method, params } = pending;
  const outcome = response.outcome;
  if (outcome.outcome === "cancelled") {
    return defaultCodexApprovalResponse(method, "cancel");
  }
  const optionId = (outcome as { optionId: string }).optionId;
  switch (method) {
    case "item/commandExecution/requestApproval": {
      const choices = nativeCommandChoices(params);
      if (choices !== null) {
        const selected = choices.find(
          (choice) => choice.option.optionId === optionId,
        );
        return { decision: selected?.decision ?? "cancel" };
      }
      switch (optionId) {
        case "accept":
          return { decision: "accept" };
        case "acceptForSession":
          return { decision: "acceptForSession" };
        case "decline":
          return { decision: "decline" };
        case "cancel":
        default:
          return { decision: "cancel" };
      }
    }
    case "item/fileChange/requestApproval": {
      switch (optionId) {
        case "accept":
          return { decision: "accept" };
        case "acceptForSession":
          return { decision: "acceptForSession" };
        case "decline":
          return { decision: "decline" };
        case "cancel":
        default:
          return { decision: "cancel" };
      }
    }
    case "item/permissions/requestApproval": {
      if (optionId !== "accept" && optionId !== "acceptForSession") {
        return defaultCodexApprovalResponse(method, "decline");
      }
      const requested = asRecord(params.permissions);
      const requestedNetwork = asRecord(requested?.network);
      const requestedFileSystem = asRecord(requested?.fileSystem);
      return {
        permissions: {
          // Preserve entry-based and legacy grants; malformed branches grant nothing.
          network: requestedNetwork
            ? { ...requestedNetwork }
            : { enabled: false },
          fileSystem: requestedFileSystem
            ? { ...requestedFileSystem }
            : { read: [], write: [] },
        },
        scope: optionId === "acceptForSession" ? "session" : "turn",
      };
    }
    case "execCommandApproval":
    case "applyPatchApproval": {
      let decision: unknown;
      switch (optionId) {
        case "accept":
          decision = "approved";
          break;
        case "acceptForSession":
          decision = "approved_for_session";
          break;
        case "decline":
          decision = {
            denied: { rejection: "User declined this action." },
          };
          break;
        case "cancel":
        default:
          decision = "abort";
          break;
      }
      return { decision };
    }
  }
}

export function defaultCodexApprovalResponse(
  method: CodexApprovalMethod,
  decision: "cancel" | "decline",
): unknown {
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { decision };
    case "item/permissions/requestApproval":
      return {
        permissions: {
          network: { enabled: false },
          fileSystem: { read: [], write: [] },
        },
        scope: "turn",
      };
    case "execCommandApproval":
    case "applyPatchApproval":
      return decision === "cancel"
        ? { decision: "abort" }
        : {
            decision: {
              denied: { rejection: "User declined this action." },
            },
          };
  }
}

function stringField(
  params: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = params[key];
  return typeof v === "string" ? v : undefined;
}

function commandField(
  params: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = params[key];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((part) => typeof part === "string")) {
    return value.join(" ");
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function codexFileChangePaths(item: unknown): string[] {
  const changes = (item as { changes?: unknown } | null)?.changes;
  if (!Array.isArray(changes)) return [];
  const paths: string[] = [];
  for (const c of changes) {
    const p = (c as { path?: unknown } | null)?.path;
    if (typeof p === "string" && p.trim().length > 0) paths.push(p);
  }
  return paths;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
