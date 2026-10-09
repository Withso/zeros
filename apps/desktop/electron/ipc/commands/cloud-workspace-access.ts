import type { CommandHandler } from "../router";
import { getCloudWorkspaceAccessBroker, getCloudWorkspacePortForwarding, revokeCloudWorkspaceNativeAccess, setCloudWorkspacePortForwardingPreferences } from "../../cloud-workspace-access-runtime";
import { cloudWorkspaceDesktopCapabilityEnabled } from "../../../src/engine/cloud-workspace-capability";
import { cloudRuntimeAccessErrorEnvelope } from "../../../src/renderer/platform/bridge/cloud-runtime-access-error";

export const cloudWorkspaceCapability: CommandHandler = () => ({ enabled: cloudWorkspaceDesktopCapabilityEnabled() });

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

function serviceContext(args: Record<string, unknown>) {
  const deviceId = args.deviceId === null ? null : requiredString(args, "deviceId");
  const keyVersion = args.keyVersion === null ? null : positiveInteger(args, "keyVersion");
  if ((deviceId === null) !== (keyVersion === null)) throw new Error("cloud workspace access: invalid device identity");
  return { authorityId: requiredString(args, "authorityId"), deviceId, keyVersion };
}

function accessBroker(args: Record<string, unknown>) {
  const broker = getCloudWorkspaceAccessBroker();
  // Additive intent fence: existing IPC names/legacy callers remain valid,
  // while the staff controls cannot issue into a replacement account/device.
  if (args.authorityId !== undefined) broker.listServices({ ...target(args), ...serviceContext(args) });
  return broker;
}

export const cloudWorkspaceSshCopy: CommandHandler = (args) =>
  accessBroker(args).copySshCommand(target(args));

export const cloudWorkspaceSshTerminal: CommandHandler = (args) =>
  accessBroker(args).openSshTerminal(target(args));

export const cloudWorkspaceSshIde: CommandHandler = (args) => {
  const appId = args.appId;
  if (appId !== "cursor" && appId !== "vscode") {
    throw new Error("cloud workspace access: unsupported remote IDE");
  }
  return accessBroker(args).openSshIde({
    ...target(args),
    appId,
  });
};

export const cloudWorkspaceTunnelStart: CommandHandler = (args) =>
  accessBroker(args).startTunnel({
    ...target(args),
    remotePort: port(args, "remotePort"),
    localPort: port(args, "localPort"),
  });

export const cloudWorkspaceAccessRevoke: CommandHandler = (args) =>
  revokeCloudWorkspaceNativeAccess(requiredString(args, "accessId"));

export const cloudWorkspaceAccessContext: CommandHandler = () =>
  getCloudWorkspaceAccessBroker().serviceContext();

export const cloudWorkspaceAccessList: CommandHandler = (args) => {
  return getCloudWorkspaceAccessBroker().listServices({ ...target(args), ...serviceContext(args) });
};

export const cloudWorkspacePortForwardingGet: CommandHandler = args =>
  getCloudWorkspacePortForwarding().readPreferences({ ...target(args), ...serviceContext(args) });

export const cloudWorkspacePortForwardingSet: CommandHandler = args => {
  const change: { forwardingEnabled?: boolean; autoForwardEnabled?: boolean } = {};
  for (const key of ["forwardingEnabled", "autoForwardEnabled"] as const) if (args[key] !== undefined) {
    if (typeof args[key] !== "boolean") throw new Error(`cloud workspace access: invalid ${key}`);
    change[key] = args[key];
  }
  if (!Object.keys(change).length) throw new Error("cloud workspace access: invalid forwarding preference");
  return setCloudWorkspacePortForwardingPreferences({ ...target(args), ...serviceContext(args) }, change);
};

export const cloudWorkspacePortForwardingRuntime: CommandHandler = args => {
  if (typeof args.connected !== "boolean") throw new Error("cloud workspace access: invalid connected state");
  const runtime = {
    ...target(args), runtimeId: requiredString(args, "runtimeId"), generation: positiveInteger(args, "generation"),
    authorityEpoch: positiveInteger(args, "authorityEpoch"), engineInstanceId: requiredString(args, "engineInstanceId"),
    connectionSequence: positiveInteger(args, "connectionSequence"), connected: args.connected,
  };
  getCloudWorkspacePortForwarding().publishRuntime(runtime);
  return getCloudWorkspaceAccessBroker().publishRuntimeConnection(runtime);
};

export const cloudWorkspacePortForwardingForget: CommandHandler = args => {
  accessBroker(args);
  getCloudWorkspacePortForwarding().removeWorkspace(target(args));
};

export const cloudWorkspaceRuntimeOpen: CommandHandler = async args => {
  try { return await getCloudWorkspaceAccessBroker().openRuntime(target(args)); }
  catch (error) { return cloudRuntimeAccessErrorEnvelope(error); }
};

export const cloudWorkspaceRuntimeRefresh: CommandHandler = async args => {
  try { return await getCloudWorkspaceAccessBroker().refreshRuntime({
    ...target(args),
    runtimeId: requiredString(args, "runtimeId"),
    generation: positiveInteger(args, "generation"),
    authorityEpoch: positiveInteger(args, "authorityEpoch"),
    engineInstanceId: requiredString(args, "engineInstanceId"),
    connectionSequence: positiveInteger(args, "connectionSequence"),
  }); } catch (error) { return cloudRuntimeAccessErrorEnvelope(error); }
};

export const cloudWorkspaceRuntimeClose: CommandHandler = (args) =>
  getCloudWorkspaceAccessBroker().closeRuntime(
    requiredString(args, "runtimeId"),
  );
