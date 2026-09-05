import type { CommandHandler } from "../router";
import { getCloudWorkspaceAccessBroker } from "../../cloud-workspace-access-runtime";

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 512 ||
    // eslint-disable-next-line no-control-regex -- IPC identifiers reject C0/space/DEL
    /[\u0000-\u0020\u007f]/.test(value)
  ) {
    throw new Error(`cloud workspace access: invalid ${key}`);
  }
  return value;
}

function target(args: Record<string, unknown>): {
  organizationId: string;
  workspaceId: string;
} {
  return {
    organizationId: requiredString(args, "organizationId"),
    workspaceId: requiredString(args, "workspaceId"),
  };
}

function port(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < 1_024 ||
    Number(value) > 65_535
  ) {
    throw new Error(`cloud workspace access: invalid ${key}`);
  }
  return Number(value);
}

function positiveInteger(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`cloud workspace access: invalid ${key}`);
  }
  return Number(value);
}

export const cloudWorkspaceSshCopy: CommandHandler = (args) =>
  getCloudWorkspaceAccessBroker().copySshCommand(target(args));

export const cloudWorkspaceSshTerminal: CommandHandler = (args) =>
  getCloudWorkspaceAccessBroker().openSshTerminal(target(args));

export const cloudWorkspaceSshIde: CommandHandler = (args) => {
  const appId = args.appId;
  if (appId !== "cursor" && appId !== "vscode") {
    throw new Error("cloud workspace access: unsupported remote IDE");
  }
  return getCloudWorkspaceAccessBroker().openSshIde({
    ...target(args),
    appId,
  });
};

export const cloudWorkspaceTunnelStart: CommandHandler = (args) =>
  getCloudWorkspaceAccessBroker().startTunnel({
    ...target(args),
    remotePort: port(args, "remotePort"),
    localPort: port(args, "localPort"),
  });

export const cloudWorkspaceAccessRevoke: CommandHandler = (args) =>
  getCloudWorkspaceAccessBroker().revoke(requiredString(args, "accessId"));

export const cloudWorkspaceRuntimeOpen: CommandHandler = (args) =>
  getCloudWorkspaceAccessBroker().openRuntime(target(args));

export const cloudWorkspaceRuntimeRefresh: CommandHandler = (args) =>
  getCloudWorkspaceAccessBroker().refreshRuntime({
    ...target(args),
    runtimeId: requiredString(args, "runtimeId"),
    generation: positiveInteger(args, "generation"),
    authorityEpoch: positiveInteger(args, "authorityEpoch"),
    engineInstanceId: requiredString(args, "engineInstanceId"),
    connectionSequence: positiveInteger(args, "connectionSequence"),
  });

export const cloudWorkspaceRuntimeClose: CommandHandler = (args) =>
  getCloudWorkspaceAccessBroker().closeRuntime(
    requiredString(args, "runtimeId"),
  );
