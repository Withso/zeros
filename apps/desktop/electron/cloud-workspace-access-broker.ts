import type { CloudActorRuntimeGrant } from "@zeros/protocol/cloud-actors";
import { randomUUID } from "node:crypto";
import type { CloudRuntimeServiceAccess, CloudRuntimeServiceApi } from "./cloud-runtime-service-client";
import type { CloudServiceHandle, CloudServiceTunnel } from "./cloud-runtime-service-transport";
import type { CloudNativeSshHandle } from "./cloud-workspace-ssh-runtime";

import {
  CloudWorkspaceAccessClientError,
  type CloudWorkspaceEngineAdmission,
  type CloudWorkspacePreviewAccess,
  type CloudWorkspaceSshAccess,
  type CloudWorkspaceTunnelAccess,
} from "./cloud-workspace-access-client";
import type { CloudAgentPreviewTarget } from "@zeros/protocol/containment";

const ACCESS_TTL_MINUTES = 30;
const MAX_ACTIVE_ACCESS = 64;

export interface CloudWorkspaceAccessBrokerApi {
  revokeEngineAdmission(accessToken:string,input:{organizationId:string;workspaceId:string;grantToken:string}):Promise<void>;
  issueEngineAdmission(
    accessToken: string,
    input: { organizationId: string; workspaceId: string },
  ): Promise<CloudWorkspaceEngineAdmission>;
  issueSsh(
    accessToken: string,
    input: {
      organizationId: string;
      workspaceId: string;
      expiresInMinutes: number;
      idempotencyKey: string;
    },
  ): Promise<CloudWorkspaceSshAccess>;
  issueTunnel(
    accessToken: string,
    input: {
      organizationId: string;
      workspaceId: string;
      remotePort: number;
      deviceId: string;
      requestedLocalPort?: number;
      runtimeGeneration?: number;
      expiresInMinutes: number;
      idempotencyKey: string;
    },
  ): Promise<CloudWorkspaceTunnelAccess>;
  activateTunnel(
    accessToken: string,
    input: {
      organizationId: string;
      workspaceId: string;
      sessionId: string;
      deviceId: string;
      observedLocalPort: number;
    },
  ): Promise<{
    id: string;
    deviceId: string;
    state: "active";
    bindAddress: "127.0.0.1";
    observedLocalPort: number;
  }>;
  issuePreview(
    accessToken: string,
    input: {
      organizationId: string;
      workspaceId: string;
      port: number;
      target?: CloudAgentPreviewTarget;
      expiresInMinutes: number;
      idempotencyKey: string;
    },
  ): Promise<CloudWorkspacePreviewAccess>;
  revoke(
    accessToken: string,
    input: {
      organizationId: string;
      workspaceId: string;
      grantId: string;
      credential: string;
    },
  ): Promise<void>;
}

export interface CloudWorkspaceTunnelHandle {
  readonly localPort: number;
  stop(): Promise<void>;
}

type AccessTarget = { organizationId: string; workspaceId: string };
export type CloudServiceContext = { authorityId: string; deviceId: string | null; keyVersion: number | null };
export type CloudServiceReceipt = {
  accessId: string; kind: "ssh" | "tunnel"; generation: number; expiresAt: string;
  localPort: number | null; remotePort: number | null; closing: boolean;
  ownership?: "auto";
};
/** Safe native handle identity, without its one-use admission or URL. */
export type CloudWorkspaceRuntimeIdentity = AccessTarget & {
  runtimeId: string; generation: number; authorityEpoch: number; engineInstanceId: string; connectionSequence: number;
};
type NativeServices = {
  api: CloudRuntimeServiceApi;
  readDeviceIdentity(): { deviceId: string; keyVersion: number } | null;
  prepareSsh(access: CloudRuntimeServiceAccess): Promise<CloudNativeSshHandle>;
  startTunnel(access: CloudRuntimeServiceAccess, localPort: number): Promise<CloudServiceTunnel>;
};
type NativeLease = AccessTarget & {
  access: CloudRuntimeServiceAccess; token: string; handle: CloudServiceHandle;
  localPort: number | null; closing: boolean; retiring?: Promise<void>;
  automatic?: boolean;
};
type SshLaunch = {
  sshUsername: string;
  sshHost: string;
  expiresAt: string;
};
type TunnelLaunch = SshLaunch & {
  localHost: "127.0.0.1";
  localPort: number;
  remoteHost: "127.0.0.1";
  remotePort: number;
};
type DynamicTunnelLaunch = SshLaunch & {
  localHost: "127.0.0.1";
  remoteHost: "127.0.0.1";
  remotePort: number;
};
type RuntimeLease = {
  id: string;
  sequence: number;
  authorityEpoch: number;
  engineInstanceId: string;
  remotePort: number;
};
type AccessLease = AccessTarget & {
  grantId: string;
  generation: number;
  kind: "ssh" | "tunnel" | "preview";
  credential: string;
  expiresAt: string;
  frameName?: string;
  previewAuthorizationCleanup?: () => void;
  tunnel?: CloudWorkspaceTunnelHandle;
  runtime?: RuntimeLease;
};

export type CloudWorkspaceRuntimeConnectionTarget = {
  kind: "cloud";
  channel: "electron-ssh-tunnel" | "control-plane-websocket";
  runtimeId: string;
  organizationId: string;
  workspaceId: string;
  generation: number;
  authorityEpoch: number;
  engineInstanceId: string;
  connectionSequence: number;
  url: string;
  cloudToken: string;
  expiresAt: number;
};

type PreviewAuthorizer = (input: {
  frameName: string;
  origin: string;
  expiresAt: number;
  capability: string;
}) => boolean | (() => void);

function applicationPort(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1_024 || value > 65_535) {
    throw new CloudWorkspaceAccessClientError(
      0,
      "invalid_request",
      `${label} must be an application port`,
    );
  }
  return value;
}

function safeFrameName(value: string): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("zeros-browser-") ||
    value.length > 320 ||
    // eslint-disable-next-line no-control-regex -- reject C0/space/DEL in an IPC identity
    /[\u0000-\u0020\u007f]/.test(value)
  ) {
    throw new CloudWorkspaceAccessClientError(
      0,
      "invalid_request",
      "Cloud preview frame identity is invalid",
    );
  }
  return value;
}

export class CloudWorkspaceAccessBroker {
  private readonly nativeServices?: NativeServices;
  private readonly nativeLeases = new Map<string, NativeLease>();
  private readonly nativeAuthorityId = randomUUID();
  private readonly api: CloudWorkspaceAccessBrokerApi;
  private readonly getAccessToken: () => Promise<string | null>;
  private readonly getAccountSessionKey: () => string | null;
  private readonly accountSessionKey: string | null;
  private readonly onRuntimeRetired: (runtimeIds: string[]) => void;
  private readonly getDeviceId: () => Promise<string>;
  private readonly randomId: () => string;
  private readonly now: () => number;
  private readonly writeClipboard: (value: string) => void | Promise<void>;
  private readonly launchTerminal: (input: SshLaunch) => Promise<void>;
  private readonly launchIde: (
    input: SshLaunch & { appId: "cursor" | "vscode" },
  ) => Promise<void>;
  private readonly startTunnelProcess: (
    input: TunnelLaunch,
  ) => Promise<CloudWorkspaceTunnelHandle>;
  private readonly startDynamicTunnelProcess: (
    input: DynamicTunnelLaunch,
  ) => Promise<CloudWorkspaceTunnelHandle>;
  private readonly disposeLocalAccess: () => Promise<void>;
  private readonly leases = new Map<string, AccessLease>();
  private readonly previewByFrame = new Map<string, string>();
  private readonly previewFrameTails = new Map<string, Promise<void>>();
  private readonly runtimeById = new Map<string, string>();
  private readonly actorRuntimes = new Map<string,{target:CloudWorkspaceRuntimeConnectionTarget;grantToken:string;retainUntil:number;closing?:boolean}>();
  private pendingAccess = 0;
  // The auth store is cleared before its session-change listeners run. Keep
  // the most recent token that actually issued/revoked one of this broker's
  // grants so disposal can retire those grants with the same account instead
  // of accidentally using a replacement account (or no token at all).
  private lastAccessToken: string | null = null;
  private disposed = false;

  constructor(input: {
    nativeServices?: NativeServices;
    api: CloudWorkspaceAccessBrokerApi;
    getAccessToken: () => Promise<string | null>;
    getAccountSessionKey: () => string | null;
    onRuntimeRetired?: (runtimeIds: string[]) => void;
    getDeviceId?: () => Promise<string>;
    randomId?: () => string;
    now?: () => number;
    writeClipboard?: (value: string) => void | Promise<void>;
    launchTerminal?: (input: SshLaunch) => Promise<void>;
    launchIde?: (
      input: SshLaunch & { appId: "cursor" | "vscode" },
    ) => Promise<void>;
    startTunnel?: (input: TunnelLaunch) => Promise<CloudWorkspaceTunnelHandle>;
    startDynamicTunnel?: (
      input: DynamicTunnelLaunch,
    ) => Promise<CloudWorkspaceTunnelHandle>;
    disposeLocalAccess?: () => Promise<void>;
  }) {
    this.nativeServices = input.nativeServices;
    this.api = input.api;
    this.getAccessToken = input.getAccessToken;
    this.getAccountSessionKey = input.getAccountSessionKey;
    this.accountSessionKey = input.getAccountSessionKey();
    this.onRuntimeRetired = input.onRuntimeRetired ?? (() => undefined);
    this.getDeviceId =
      input.getDeviceId ??
      (async () => {
        throw new CloudWorkspaceAccessClientError(
          401,
          "signed_out",
          "A trusted desktop device is required for cloud forwarding",
        );
      });
    this.randomId = input.randomId ?? randomUUID;
    this.now = input.now ?? Date.now;
    this.writeClipboard =
      input.writeClipboard ??
      (() => {
        throw new Error("The system clipboard is unavailable");
      });
    this.launchTerminal =
      input.launchTerminal ??
      (async () => {
        throw new Error("Terminal launch is unavailable");
      });
    this.launchIde =
      input.launchIde ??
      (async () => {
        throw new Error("Remote IDE launch is unavailable");
      });
    this.startTunnelProcess =
      input.startTunnel ??
      (async () => {
        throw new Error("SSH forwarding is unavailable");
      });
    this.startDynamicTunnelProcess =
      input.startDynamicTunnel ??
      (async () => {
        throw new Error("Collision-free SSH forwarding is unavailable");
      });
    this.disposeLocalAccess =
      input.disposeLocalAccess ?? (async () => undefined);
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [id, lease] of this.nativeLeases) {
      if (Date.parse(lease.access.grant.expiresAt) > now) continue;
      this.nativeLeases.delete(id);
      void this.retireNativeLease(lease).catch(() => undefined);
    }
    for (const [id, runtime] of this.actorRuntimes) if(runtime.retainUntil<=now)this.actorRuntimes.delete(id);
    for (const [id, lease] of this.leases) {
      if (Date.parse(lease.expiresAt) > now) continue;
      this.forgetLease(id, lease);
      if (lease.frameName && this.previewByFrame.get(lease.frameName) === id) {
        this.previewByFrame.delete(lease.frameName);
      }
      lease.previewAuthorizationCleanup?.();
      if (lease.tunnel) void lease.tunnel.stop().catch(() => undefined);
    }
  }

  private forgetLease(id: string, lease: AccessLease): void {
    this.leases.delete(id);
    if (lease.runtime && this.runtimeById.get(lease.runtime.id) === id) {
      this.runtimeById.delete(lease.runtime.id);
    }
  }

  /** A broker and every handle it issues belong to one canonical source session.
   * Access-token rotation does not replace that identity. */
  hasCurrentSession(): boolean {
    let current: string | null = null;
    try { current = this.getAccountSessionKey(); } catch { /* fail closed */ }
    if (!this.disposed && this.accountSessionKey && current === this.accountSessionKey) return true;
    if (!this.disposed) void this.dispose().catch(() => undefined);
    return false;
  }

  private reserveCapacity(): () => void {
    if (!this.hasCurrentSession()) {
      throw new CloudWorkspaceAccessClientError(
        401,
        "signed_out",
        "Cloud workspace access authority has ended",
      );
    }
    this.pruneExpired();
    if (this.leases.size + this.nativeLeases.size + this.actorRuntimes.size + this.pendingAccess >= MAX_ACTIVE_ACCESS) {
      throw new CloudWorkspaceAccessClientError(
        429,
        "cloud_access_local_limit",
        "Too many cloud workspace access sessions are active on this Mac",
      );
    }
    this.pendingAccess += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pendingAccess = Math.max(0, this.pendingAccess - 1);
    };
  }

  private async token(): Promise<string> {
    if (!this.hasCurrentSession()) throw new CloudWorkspaceAccessClientError(401, "signed_out", "Cloud workspace access authority has ended");
    const value = await this.getAccessToken();
    if (!value || !this.hasCurrentSession()) {
      throw new CloudWorkspaceAccessClientError(
        401,
        "signed_out",
        "Sign in before opening cloud workspace access",
      );
    }
    this.lastAccessToken = value;
    return value;
  }

  private async lockPreviewFrame(frameName: string): Promise<() => void> {
    const previous = this.previewFrameTails.get(frameName) ?? Promise.resolve();
    let unlock!: () => void;
    const current = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    this.previewFrameTails.set(frameName, tail);
    await previous.catch(() => undefined);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      unlock();
      if (this.previewFrameTails.get(frameName) === tail) {
        this.previewFrameTails.delete(frameName);
      }
    };
  }

  private key(kind: "ssh" | "tunnel" | "preview"): string {
    return `desktop:${kind}:${this.randomId()}`;
  }

  private remember(lease: AccessLease): void {
    this.leases.set(lease.grantId, lease);
    if (lease.frameName)
      this.previewByFrame.set(lease.frameName, lease.grantId);
    if (lease.runtime) this.runtimeById.set(lease.runtime.id, lease.grantId);
  }

  private async cleanup(
    accessToken: string,
    lease: AccessTarget & { grantId: string; credential: string },
  ): Promise<void> {
    await this.api.revoke(accessToken, {
      organizationId: lease.organizationId,
      workspaceId: lease.workspaceId,
      grantId: lease.grantId,
      credential: lease.credential,
    });
  }

  private async cleanupSsh(
    accessToken: string,
    lease: AccessTarget & {
      grantId: string;
      generation: number;
      credential: string;
    },
  ): Promise<void> {
    try {
      await this.cleanup(accessToken, lease);
    } finally {
      // Provider revocation retires the resource's complete SSH token set. A
      // timeout is an unknown result, so fail closed locally in that case too.
      for (const [id, candidate] of this.leases) {
        if (
          candidate.kind === "preview" ||
          candidate.organizationId !== lease.organizationId ||
          candidate.workspaceId !== lease.workspaceId ||
          candidate.generation !== lease.generation
        ) {
          continue;
        }
        this.forgetLease(id, candidate);
        await candidate.tunnel?.stop().catch(() => undefined);
      }
    }
  }

  private async issueSsh(target: AccessTarget): Promise<{
    token: string;
    response: CloudWorkspaceSshAccess;
    releaseCapacity: () => void;
  }> {
    const releaseCapacity = this.reserveCapacity();
    try {
      const token = await this.token();
      const response = await this.api.issueSsh(token, {
        ...target,
        expiresInMinutes: ACCESS_TTL_MINUTES,
        idempotencyKey: this.key("ssh"),
      });
      if (!this.hasCurrentSession()) {
        await this.cleanupSsh(token, {
          ...target,
          grantId: response.grant.id,
          generation: response.grant.generation,
          credential: response.ssh.username,
        });
        throw new CloudWorkspaceAccessClientError(
          401,
          "signed_out",
          "Cloud workspace access authority has ended",
        );
      }
      return { token, response, releaseCapacity };
    } catch (error) {
      releaseCapacity();
      throw error;
    }
  }

  /** Read-only local metadata: no enrollment, token refresh, or new grant. The
   * renderer must send this exact account/device authority back on list reads. */
  serviceContext(): CloudServiceContext {
    if (!this.hasCurrentSession() || !this.nativeServices) throw new CloudWorkspaceAccessClientError(401, "signed_out", "Cloud service authority is unavailable.");
    const device = this.nativeServices.readDeviceIdentity();
    for (const lease of this.nativeLeases.values()) {
      if (lease.access.grant.deviceId !== device?.deviceId || lease.access.deviceKeyVersion !== device.keyVersion)
        void this.retireNativeLease(lease).catch(() => undefined);
    }
    return { authorityId: this.nativeAuthorityId, deviceId: device?.deviceId ?? null, keyVersion: device?.keyVersion ?? null };
  }

  listServices(input: AccessTarget & CloudServiceContext): CloudServiceReceipt[] {
    const current = this.serviceContext();
    if (input.authorityId !== current.authorityId || input.deviceId !== current.deviceId || input.keyVersion !== current.keyVersion)
      throw new CloudWorkspaceAccessClientError(409, "cloud_workspace_access_superseded", "Cloud service authority changed. Refresh access.");
    this.pruneExpired();
    return [...this.nativeLeases.values()].filter(lease => lease.organizationId === input.organizationId && lease.workspaceId === input.workspaceId &&
      lease.access.grant.deviceId === current.deviceId && lease.access.deviceKeyVersion === current.keyVersion).map(lease => ({
      accessId: lease.access.grant.id, kind: lease.access.grant.kind, generation: lease.access.grant.generation,
      expiresAt: lease.access.grant.expiresAt, localPort: lease.localPort, remotePort: lease.access.grant.remotePort, closing: lease.closing,
      ...(lease.automatic ? { ownership: "auto" as const } : {}),
    }));
  }

  private assertNativeAuthority(access: CloudRuntimeServiceAccess): void {
    if (!this.hasCurrentSession()) throw new CloudWorkspaceAccessClientError(401, "signed_out", "Cloud service authority has ended.");
    const device = this.nativeServices!.readDeviceIdentity();
    if (device?.deviceId !== access.grant.deviceId || device.keyVersion !== access.deviceKeyVersion || Date.parse(access.grant.expiresAt) <= this.now())
      throw new CloudWorkspaceAccessClientError(409, "cloud_workspace_access_superseded", "Cloud service device authority has changed or expired.");
  }

  private retireNativeLease(lease: NativeLease): Promise<void> {
    if (lease.retiring) return lease.retiring;
    lease.closing = true;
    // Close locally before any auth/network wait. Refresh only within this
    // issuing session; retirement after sign-out uses its last captured token.
    const local = lease.handle.stop();
    // Publish the in-flight retirement before a token refresh can discover an
    // account switch and enter dispose(), which also retires these leases.
    lease.retiring = Promise.resolve().then(async () => {
      const remote = async () => {
        let token = this.lastAccessToken ?? lease.token;
        if (!this.disposed) {
          try { token = await this.token(); } catch { /* retain issuing-account authority only */ }
        }
        lease.token = token;
        await this.nativeServices!.api.revoke(token, {
          organizationId: lease.organizationId, workspaceId: lease.workspaceId, grantId: lease.access.grant.id,
        });
      };
      const results = await Promise.allSettled([local, remote()]);
      if (results[1]!.status === "fulfilled" && this.nativeLeases.get(lease.access.grant.id) === lease) this.nativeLeases.delete(lease.access.grant.id);
      for (const result of results) if (result.status === "rejected") throw result.reason;
    }).finally(() => { lease.retiring = undefined; });
    return lease.retiring;
  }

  private async openNativeService(input: AccessTarget, action: "copy" | "terminal" | { remotePort: number; localPort: number; automaticRuntime?: CloudWorkspaceRuntimeIdentity }): Promise<{
    accessId: string; expiresAt: string; localHost: "127.0.0.1"; localPort: number | null; remotePort: number | null;
  }> {
    const release = this.reserveCapacity();
    const services = this.nativeServices!;
    let token: string | undefined, access: CloudRuntimeServiceAccess | undefined, handle: CloudServiceHandle | undefined, lease: NativeLease | undefined;
    try {
      const initiatingDevice = services.readDeviceIdentity();
      const automaticRuntime = typeof action === "object" ? action.automaticRuntime : undefined;
      if (automaticRuntime) this.assertRuntime(automaticRuntime);
      const tunnel = typeof action === "object" ? { remotePort: applicationPort(action.remotePort, "Remote port"), localPort: applicationPort(action.localPort, "Local port") } : null;
      token = await this.token();
      access = await services.api.issue(token, { ...input, kind: tunnel ? "tunnel" : "ssh", ...(tunnel ? { remotePort: tunnel.remotePort } : {}),
        expiresInMinutes: 15, idempotencyKey: automaticRuntime ? `desktop:auto-tunnel:${this.randomId()}` : this.key(tunnel ? "tunnel" : "ssh") });
      this.assertNativeAuthority(access);
      if (automaticRuntime) {
        this.assertRuntime(automaticRuntime);
        if (access.grant.generation !== automaticRuntime.generation) throw new CloudWorkspaceAccessClientError(409, "cloud_workspace_access_superseded", "The cloud workspace runtime session has been superseded");
      }
      if (initiatingDevice && (access.grant.deviceId !== initiatingDevice.deviceId || access.deviceKeyVersion !== initiatingDevice.keyVersion))
        throw new CloudWorkspaceAccessClientError(409, "cloud_workspace_access_superseded", "Cloud service device authority changed during admission.");
      let localPort: number | null = null;
      if (tunnel) {
        const forwarded = await services.startTunnel(access, tunnel.localPort); handle = forwarded; localPort = forwarded.localPort;
        if (localPort !== tunnel.localPort) throw new Error("Cloud forwarding bound an unexpected local port.");
      } else {
        handle = await services.prepareSsh(access);
      }
      this.assertNativeAuthority(access);
      if (automaticRuntime) this.assertRuntime(automaticRuntime);
      lease = { ...input, access, token, handle, localPort, closing: false, ...(automaticRuntime ? { automatic: true } : {}) };
      const current = lease;
      this.nativeLeases.set(access.grant.id, current);
      void handle.closed.then(() => {
        if (this.nativeLeases.get(current.access.grant.id) === current) void this.retireNativeLease(current).catch(() => undefined);
      });
      if (!tunnel) {
        const ssh = handle as CloudNativeSshHandle;
        if (action === "copy") await this.writeClipboard(ssh.command); else await ssh.launchTerminal();
      }
      this.assertNativeAuthority(access);
      if (automaticRuntime) this.assertRuntime(automaticRuntime);
      if (lease.closing || this.nativeLeases.get(access.grant.id) !== lease) throw new Error("Cloud service connection has ended.");
      return { accessId: access.grant.id, expiresAt: access.grant.expiresAt, localHost: "127.0.0.1", localPort, remotePort: access.grant.remotePort };
    } catch (error) {
      if (lease) await this.retireNativeLease(lease).catch(() => undefined);
      else if (access && token) {
        // Admission may have succeeded before a local bind/preparation failed.
        // Keep an unsuccessful retirement visible to this issuing session so
        // the user can retry it instead of blocking idle until grant expiry.
        const cleanup: NativeLease = { ...input, access, token,
          handle: handle ?? { closed: Promise.resolve(), stop: async () => {} },
          localPort: typeof action === "object" ? action.localPort : null, closing: true,
          ...(typeof action === "object" && action.automaticRuntime ? { automatic: true } : {}) };
        if (this.hasCurrentSession()) this.nativeLeases.set(access.grant.id, cleanup);
        await this.retireNativeLease(cleanup).catch(() => undefined);
      }
      throw error;
    } finally { release(); }
  }

  async openPreview(
    input: AccessTarget & { port: number; frameName: string; target?: CloudAgentPreviewTarget } & Partial<CloudServiceContext>,
    authorize: PreviewAuthorizer,
  ): Promise<{
    accessId: string;
    logicalUrl: string;
    origin: string;
    admissionUrl: string;
    expiresAt: string;
  }> {
    const frameName = safeFrameName(input.frameName);
    const context = this.nativeServices ? this.serviceContext() : null;
    const assertContext = () => {
      if (context && (JSON.stringify(this.serviceContext()) !== JSON.stringify(context) ||
        (input.authorityId !== undefined && (input.authorityId !== context.authorityId || input.deviceId !== context.deviceId || input.keyVersion !== context.keyVersion))))
        throw new CloudWorkspaceAccessClientError(409, "cloud_workspace_access_superseded", "Cloud preview authority changed.");
    };
    assertContext();
    const releaseFrame = await this.lockPreviewFrame(frameName);
    try {
      const prior = this.previewByFrame.get(frameName);
      if (prior) await this.revoke(prior);
      const releaseCapacity = this.reserveCapacity();
      try {
        const token = await this.token();
        const response = await this.api.issuePreview(token, {
          organizationId: input.organizationId,
          workspaceId: input.workspaceId,
          port: applicationPort(input.port, "Preview port"),
          ...(input.target ? { target: input.target } : {}),
          expiresInMinutes: ACCESS_TTL_MINUTES,
          idempotencyKey: this.key("preview"),
        });
        if (!this.hasCurrentSession()) {
          await this.cleanup(token, {
            organizationId: input.organizationId,
            workspaceId: input.workspaceId,
            grantId: response.grant.id,
            credential: response.preview.capability,
          });
          throw new CloudWorkspaceAccessClientError(
            401,
            "signed_out",
            "Cloud workspace access authority has ended",
          );
        }
        let authorized = false;
        let previewAuthorizationCleanup: (() => void) | undefined;
        try {
          assertContext();
          const authorization = authorize({
            frameName,
            origin: response.preview.origin,
            expiresAt: Date.parse(response.grant.expiresAt),
            capability: response.preview.capability,
          });
          authorized =
            authorization === true || typeof authorization === "function";
          if (typeof authorization === "function") {
            previewAuthorizationCleanup = authorization;
          }
        } catch {
          authorized = false;
        }
        if (!authorized) {
          await this.cleanup(token, {
            organizationId: input.organizationId,
            workspaceId: input.workspaceId,
            grantId: response.grant.id,
            credential: response.preview.capability,
          });
          throw new Error("Cloud preview frame authorization did not complete");
        }
        if (!this.hasCurrentSession()) {
          previewAuthorizationCleanup?.();
          await this.cleanup(token, {
            organizationId: input.organizationId,
            workspaceId: input.workspaceId,
            grantId: response.grant.id,
            credential: response.preview.capability,
          });
          throw new CloudWorkspaceAccessClientError(
            401,
            "signed_out",
            "Cloud workspace access authority has ended",
          );
        }
        this.remember({
          organizationId: input.organizationId,
          workspaceId: input.workspaceId,
          grantId: response.grant.id,
          generation: response.grant.generation,
          kind: "preview",
          credential: response.preview.capability,
          expiresAt: response.grant.expiresAt,
          frameName,
          ...(previewAuthorizationCleanup
            ? { previewAuthorizationCleanup }
            : {}),
        });
        return {
          accessId: response.grant.id,
          logicalUrl: response.preview.logicalUrl,
          origin: response.preview.origin,
          admissionUrl: `${response.preview.origin}/`,
          expiresAt: response.grant.expiresAt,
        };
      } finally {
        releaseCapacity();
      }
    } finally {
      releaseFrame();
    }
  }

  async copySshCommand(
    input: AccessTarget,
  ): Promise<{ accessId: string; expiresAt: string }> {
    if (this.nativeServices) {
      const { accessId, expiresAt } = await this.openNativeService(input, "copy");
      return { accessId, expiresAt };
    }
    const { token, response, releaseCapacity } = await this.issueSsh(input);
    try {
      try {
        await this.writeClipboard(response.ssh.command);
      } catch (error) {
        await this.cleanupSsh(token, {
          ...input,
          grantId: response.grant.id,
          generation: response.grant.generation,
          credential: response.ssh.username,
        }).catch(() => undefined);
        throw error;
      }
      if (!this.hasCurrentSession()) {
        await this.cleanupSsh(token, {
          ...input,
          grantId: response.grant.id,
          generation: response.grant.generation,
          credential: response.ssh.username,
        });
        throw new CloudWorkspaceAccessClientError(
          401,
          "signed_out",
          "Cloud workspace access authority has ended",
        );
      }
      this.remember({
        ...input,
        grantId: response.grant.id,
        generation: response.grant.generation,
        kind: "ssh",
        credential: response.ssh.username,
        expiresAt: response.grant.expiresAt,
      });
      return {
        accessId: response.grant.id,
        expiresAt: response.grant.expiresAt,
      };
    } finally {
      releaseCapacity();
    }
  }

  async openSshTerminal(
    input: AccessTarget,
  ): Promise<{ accessId: string; expiresAt: string }> {
    if (this.nativeServices) {
      const { accessId, expiresAt } = await this.openNativeService(input, "terminal");
      return { accessId, expiresAt };
    }
    const { token, response, releaseCapacity } = await this.issueSsh(input);
    try {
      try {
        await this.launchTerminal({
          sshUsername: response.ssh.username,
          sshHost: response.ssh.host,
          expiresAt: response.grant.expiresAt,
        });
      } catch (error) {
        await this.cleanupSsh(token, {
          ...input,
          grantId: response.grant.id,
          generation: response.grant.generation,
          credential: response.ssh.username,
        }).catch(() => undefined);
        throw error;
      }
      if (!this.hasCurrentSession()) {
        await this.cleanupSsh(token, {
          ...input,
          grantId: response.grant.id,
          generation: response.grant.generation,
          credential: response.ssh.username,
        });
        throw new CloudWorkspaceAccessClientError(
          401,
          "signed_out",
          "Cloud workspace access authority has ended",
        );
      }
      this.remember({
        ...input,
        grantId: response.grant.id,
        generation: response.grant.generation,
        kind: "ssh",
        credential: response.ssh.username,
        expiresAt: response.grant.expiresAt,
      });
      return {
        accessId: response.grant.id,
        expiresAt: response.grant.expiresAt,
      };
    } finally {
      releaseCapacity();
    }
  }

  async openSshIde(
    input: AccessTarget & { appId: "cursor" | "vscode" },
  ): Promise<{ accessId: string; expiresAt: string }> {
    if (this.nativeServices) throw new Error("Native cloud IDE connections have not been qualified. Use Terminal or Copy SSH command.");
    const { token, response, releaseCapacity } = await this.issueSsh(input);
    try {
      try {
        await this.launchIde({
          appId: input.appId,
          sshUsername: response.ssh.username,
          sshHost: response.ssh.host,
          expiresAt: response.grant.expiresAt,
        });
      } catch (error) {
        await this.cleanupSsh(token, {
          ...input,
          grantId: response.grant.id,
          generation: response.grant.generation,
          credential: response.ssh.username,
        }).catch(() => undefined);
        throw error;
      }
      if (!this.hasCurrentSession()) {
        await this.cleanupSsh(token, {
          organizationId: input.organizationId,
          workspaceId: input.workspaceId,
          grantId: response.grant.id,
          generation: response.grant.generation,
          credential: response.ssh.username,
        });
        throw new CloudWorkspaceAccessClientError(
          401,
          "signed_out",
          "Cloud workspace access authority has ended",
        );
      }
      this.remember({
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        grantId: response.grant.id,
        generation: response.grant.generation,
        kind: "ssh",
        credential: response.ssh.username,
        expiresAt: response.grant.expiresAt,
      });
      return {
        accessId: response.grant.id,
        expiresAt: response.grant.expiresAt,
      };
    } finally {
      releaseCapacity();
    }
  }

  async startTunnel(
    input: AccessTarget & {
      remotePort: number;
      localPort: number;
    },
  ): Promise<{
    accessId: string;
    localHost: "127.0.0.1";
    localPort: number;
    remotePort: number;
    expiresAt: string;
  }> {
    if (this.nativeServices) {
      const result = await this.openNativeService({ organizationId: input.organizationId, workspaceId: input.workspaceId }, { remotePort: input.remotePort, localPort: input.localPort });
      return { ...result, localPort: result.localPort!, remotePort: result.remotePort! };
    }
    const releaseCapacity = this.reserveCapacity();
    try {
      const remotePort = applicationPort(input.remotePort, "Remote port");
      const localPort = applicationPort(input.localPort, "Local port");
      const token = await this.token();
      const deviceId = await this.getDeviceId();
      const response = await this.api.issueTunnel(token, {
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        remotePort,
        deviceId,
        requestedLocalPort: localPort,
        expiresInMinutes: ACCESS_TTL_MINUTES,
        idempotencyKey: this.key("tunnel"),
      });
      if (!this.hasCurrentSession()) {
        await this.cleanupSsh(token, {
          organizationId: input.organizationId,
          workspaceId: input.workspaceId,
          grantId: response.grant.id,
          generation: response.grant.generation,
          credential: response.tunnel.sshUsername,
        });
        throw new CloudWorkspaceAccessClientError(
          401,
          "signed_out",
          "Cloud workspace access authority has ended",
        );
      }
      let tunnel: CloudWorkspaceTunnelHandle;
      try {
        tunnel = await this.startTunnelProcess({
          localHost: "127.0.0.1",
          localPort,
          remoteHost: "127.0.0.1",
          remotePort,
          sshUsername: response.tunnel.sshUsername,
          sshHost: response.tunnel.sshHost,
          expiresAt: response.grant.expiresAt,
        });
        if (tunnel.localPort !== localPort) {
          await tunnel.stop().catch(() => undefined);
          throw new Error("SSH tunnel bound an unexpected local port");
        }
      } catch (error) {
        await this.cleanupSsh(token, {
          organizationId: input.organizationId,
          workspaceId: input.workspaceId,
          grantId: response.grant.id,
          generation: response.grant.generation,
          credential: response.tunnel.sshUsername,
        }).catch(() => undefined);
        throw error;
      }
      if (!this.hasCurrentSession()) {
        await tunnel.stop().catch(() => undefined);
        await this.cleanupSsh(token, {
          organizationId: input.organizationId,
          workspaceId: input.workspaceId,
          grantId: response.grant.id,
          generation: response.grant.generation,
          credential: response.tunnel.sshUsername,
        });
        throw new CloudWorkspaceAccessClientError(
          401,
          "signed_out",
          "Cloud workspace access authority has ended",
        );
      }
      try {
        await this.api.activateTunnel(token, {
          organizationId: input.organizationId,
          workspaceId: input.workspaceId,
          sessionId: response.tunnel.session.id,
          deviceId,
          observedLocalPort: tunnel.localPort,
        });
      } catch (error) {
        await tunnel.stop().catch(() => undefined);
        await this.cleanupSsh(token, {
          organizationId: input.organizationId,
          workspaceId: input.workspaceId,
          grantId: response.grant.id,
          generation: response.grant.generation,
          credential: response.tunnel.sshUsername,
        }).catch(() => undefined);
        throw error;
      }
      if (!this.hasCurrentSession()) {
        await tunnel.stop().catch(() => undefined);
        await this.cleanupSsh(token, {
          organizationId: input.organizationId,
          workspaceId: input.workspaceId,
          grantId: response.grant.id,
          generation: response.grant.generation,
          credential: response.tunnel.sshUsername,
        }).catch(() => undefined);
        throw new CloudWorkspaceAccessClientError(
          401,
          "signed_out",
          "Cloud workspace access authority has ended",
        );
      }
      this.remember({
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        grantId: response.grant.id,
        generation: response.grant.generation,
        kind: "tunnel",
        credential: response.tunnel.sshUsername,
        expiresAt: response.grant.expiresAt,
        tunnel,
      });
      return {
        accessId: response.grant.id,
        localHost: "127.0.0.1",
        localPort,
        remotePort,
        expiresAt: response.grant.expiresAt,
      };
    } finally {
      releaseCapacity();
    }
  }

  /** Admission describes authority, not connectivity. The main coordinator
   * separately requires the renderer's exact connected-handle publication. */
  assertRuntime(input: CloudWorkspaceRuntimeIdentity): void {
    const actor = this.actorRuntimes.get(input.runtimeId);
    const accessId = this.runtimeById.get(input.runtimeId), legacy = accessId ? this.leases.get(accessId) : undefined;
    const current = actor && !actor.closing ? actor.target : legacy?.runtime ? {
      ...legacy, runtimeId: legacy.runtime.id, authorityEpoch: legacy.runtime.authorityEpoch,
      engineInstanceId: legacy.runtime.engineInstanceId, connectionSequence: legacy.runtime.sequence,
    } : undefined;
    if (!this.hasCurrentSession() || !current ||
      current.organizationId !== input.organizationId || current.workspaceId !== input.workspaceId || current.generation !== input.generation ||
      current.authorityEpoch !== input.authorityEpoch || current.engineInstanceId !== input.engineInstanceId || current.connectionSequence !== input.connectionSequence)
      throw new CloudWorkspaceAccessClientError(409, "cloud_workspace_access_superseded", "The cloud workspace runtime session has been superseded");
  }

  async startAutomaticTunnel(input: CloudWorkspaceRuntimeIdentity & CloudServiceContext & { remotePort: number; localPort: number }): Promise<{
    accessId: string; expiresAt: string; localHost: "127.0.0.1"; localPort: number; remotePort: number;
  }> {
    if (!this.nativeServices) throw new Error("Native cloud forwarding is unavailable.");
    this.listServices(input);
    this.assertRuntime(input);
    const result = await this.openNativeService({ organizationId: input.organizationId, workspaceId: input.workspaceId }, {
      remotePort: input.remotePort, localPort: input.localPort, automaticRuntime: input,
    });
    return { ...result, localPort: result.localPort!, remotePort: result.remotePort! };
  }

  private actorRuntimeTarget(admission:CloudActorRuntimeGrant,runtimeId:string,sequence:number):CloudWorkspaceRuntimeConnectionTarget {
    return {kind:"cloud",channel:"control-plane-websocket",runtimeId,connectionSequence:sequence,
      organizationId:admission.organizationId,workspaceId:admission.workspaceId,generation:admission.generation,
      authorityEpoch:admission.authorityEpoch,engineInstanceId:admission.engineInstanceId,url:admission.bridgeUrl,
      cloudToken:admission.grantToken,expiresAt:Date.parse(admission.expiresAt)};
  }

  private async releaseActorAdmission(token:string,admission:{organizationId:string;workspaceId:string;grantToken:string}) {
    await this.api.revokeEngineAdmission(token,{organizationId:admission.organizationId,workspaceId:admission.workspaceId,grantToken:admission.grantToken});
  }

  private runtimeTarget(
    lease: AccessLease & { runtime: RuntimeLease },
    admission: CloudWorkspaceEngineAdmission,
  ): CloudWorkspaceRuntimeConnectionTarget {
    const expiresAt = Math.min(
      Date.parse(admission.expiresAt),
      Date.parse(lease.expiresAt),
    );
    if (
      admission.organizationId !== lease.organizationId ||
      admission.workspaceId !== lease.workspaceId ||
      admission.generation !== lease.generation ||
      admission.authorityEpoch !== lease.runtime.authorityEpoch ||
      admission.engineInstanceId !== lease.runtime.engineInstanceId ||
      admission.remotePort !== lease.runtime.remotePort ||
      !Number.isFinite(expiresAt) ||
      expiresAt - this.now() < 5_000
    ) {
      throw new CloudWorkspaceAccessClientError(
        409,
        "cloud_workspace_access_superseded",
        "The cloud workspace changed while runtime access was being issued",
      );
    }
    return {
      kind: "cloud",
      channel: "electron-ssh-tunnel",
      runtimeId: lease.runtime.id,
      organizationId: lease.organizationId,
      workspaceId: lease.workspaceId,
      generation: lease.generation,
      authorityEpoch: lease.runtime.authorityEpoch,
      engineInstanceId: lease.runtime.engineInstanceId,
      connectionSequence: lease.runtime.sequence,
      url: `ws://127.0.0.1:${lease.tunnel!.localPort}/ws`,
      cloudToken: admission.grantToken,
      expiresAt,
    };
  }

  private async createRuntimeLease(input: {
    token: string;
    target: AccessTarget;
    admission: CloudWorkspaceEngineAdmission;
    runtimeId: string;
    sequence: number;
  }): Promise<
    AccessLease & { runtime: RuntimeLease; tunnel: CloudWorkspaceTunnelHandle }
  > {
    const deviceId = await this.getDeviceId();
    const response = await this.api.issueTunnel(input.token, {
      ...input.target,
      remotePort: input.admission.remotePort,
      deviceId,
      runtimeGeneration: input.admission.generation,
      expiresInMinutes: ACCESS_TTL_MINUTES,
      idempotencyKey: this.key("tunnel"),
    });
    const provisional: AccessLease = {
      ...input.target,
      grantId: response.grant.id,
      generation: response.grant.generation,
      kind: "tunnel",
      credential: response.tunnel.sshUsername,
      expiresAt: response.grant.expiresAt,
    };
    if (
      response.grant.generation !== input.admission.generation ||
      response.tunnel.remotePort !== input.admission.remotePort ||
      this.leases.has(response.grant.id)
    ) {
      await this.cleanupSsh(input.token, provisional).catch(() => undefined);
      throw new CloudWorkspaceAccessClientError(
        409,
        "cloud_workspace_access_superseded",
        "The cloud workspace changed while runtime access was being issued",
      );
    }
    let tunnel: CloudWorkspaceTunnelHandle;
    try {
      tunnel = await this.startDynamicTunnelProcess({
        localHost: "127.0.0.1",
        remoteHost: "127.0.0.1",
        remotePort: input.admission.remotePort,
        sshUsername: response.tunnel.sshUsername,
        sshHost: response.tunnel.sshHost,
        expiresAt: response.grant.expiresAt,
      });
      applicationPort(tunnel.localPort, "Local port");
    } catch (error) {
      await this.cleanupSsh(input.token, provisional).catch(() => undefined);
      throw error;
    }
    try {
      await this.api.activateTunnel(input.token, {
        ...input.target,
        sessionId: response.tunnel.session.id,
        deviceId,
        observedLocalPort: tunnel.localPort,
      });
    } catch (error) {
      await tunnel.stop().catch(() => undefined);
      await this.cleanupSsh(input.token, provisional).catch(() => undefined);
      throw error;
    }
    const lease: AccessLease & {
      runtime: RuntimeLease;
      tunnel: CloudWorkspaceTunnelHandle;
    } = {
      ...provisional,
      tunnel,
      runtime: {
        id: input.runtimeId,
        sequence: input.sequence,
        authorityEpoch: input.admission.authorityEpoch,
        engineInstanceId: input.admission.engineInstanceId,
        remotePort: input.admission.remotePort,
      },
    };
    if (!this.hasCurrentSession()) {
      await tunnel.stop().catch(() => undefined);
      await this.cleanupSsh(input.token, provisional).catch(() => undefined);
      throw new CloudWorkspaceAccessClientError(
        401,
        "signed_out",
        "Cloud workspace access authority has ended",
      );
    }
    return lease;
  }

  /** Open the engine bridge through a desktop-owned, collision-free loopback
   * proxy. Only the short-lived one-use engine admission crosses IPC. */
  async openRuntime(
    input: AccessTarget,
  ): Promise<CloudWorkspaceRuntimeConnectionTarget> {
    const releaseCapacity = this.reserveCapacity();
    try {
      const token = await this.token();
      const admission = await this.api.issueEngineAdmission(token, input);
      if(admission.version===2){
        if(!this.hasCurrentSession()){await this.releaseActorAdmission(token,admission).catch(()=>undefined);throw new CloudWorkspaceAccessClientError(401,"signed_out","Cloud workspace access authority has ended");}
        const target=this.actorRuntimeTarget(admission,this.randomId(),1);
        this.actorRuntimes.set(target.runtimeId,{target,grantToken:admission.grantToken,retainUntil:this.now()+24*60*60_000});
        return target;
      }

      const lease = await this.createRuntimeLease({
        token,
        target: input,
        admission,
        runtimeId: this.randomId(),
        sequence: 1,
      });
      try {
        const target = this.runtimeTarget(lease, admission);
        this.remember(lease);
        return target;
      } catch (error) {
        await lease.tunnel.stop().catch(() => undefined);
        await this.cleanupSsh(token, lease).catch(() => undefined);
        throw error;
      }
    } finally {
      releaseCapacity();
    }
  }

  /** Mint a fresh one-use admission for the exact active runtime session. A
   * sequence compare-and-swap prevents concurrent refreshes from publishing
   * two descriptors for one reconnect boundary. */
  async refreshRuntime(input: {
    runtimeId: string;
    organizationId: string;
    workspaceId: string;
    generation: number;
    authorityEpoch: number;
    engineInstanceId: string;
    connectionSequence: number;
  }): Promise<CloudWorkspaceRuntimeConnectionTarget> {
    this.pruneExpired();
    const actor=this.actorRuntimes.get(input.runtimeId);
    if(actor){
      const target=actor.target;
      if(!this.hasCurrentSession()||actor.closing||target.organizationId!==input.organizationId||target.workspaceId!==input.workspaceId||target.generation!==input.generation||
        target.authorityEpoch!==input.authorityEpoch||target.engineInstanceId!==input.engineInstanceId||target.connectionSequence!==input.connectionSequence)
        throw new CloudWorkspaceAccessClientError(409,"cloud_workspace_access_superseded","The cloud workspace runtime session has been superseded");
      const token=await this.token();
      const admission=await this.api.issueEngineAdmission(token,{organizationId:input.organizationId,workspaceId:input.workspaceId});
      if(admission.version!==2)throw new CloudWorkspaceAccessClientError(409,"cloud_workspace_access_superseded","An actor-aware cloud runtime is required");
      if(!this.hasCurrentSession()||actor.closing||this.actorRuntimes.get(input.runtimeId)!==actor){
        await this.releaseActorAdmission(token,admission).catch(()=>undefined);
        throw new CloudWorkspaceAccessClientError(409,"cloud_workspace_access_superseded","The cloud workspace runtime session has been superseded");
      }
      const next=this.actorRuntimeTarget(admission,input.runtimeId,input.connectionSequence+1);
      this.actorRuntimes.set(input.runtimeId,{target:next,grantToken:admission.grantToken,retainUntil:this.now()+24*60*60_000});
      await this.releaseActorAdmission(token,{...target,grantToken:actor.grantToken}).catch(()=>undefined);
      const published=this.actorRuntimes.get(input.runtimeId);
      if(!this.hasCurrentSession()||published?.target!==next||published.closing)throw new CloudWorkspaceAccessClientError(409,"cloud_workspace_access_superseded","The cloud workspace runtime session has been superseded");
      return next;
    }
    const accessId = this.runtimeById.get(input.runtimeId);
    const current = accessId ? this.leases.get(accessId) : null;
    if (
      !current?.runtime ||
      !current.tunnel ||
      current.organizationId !== input.organizationId ||
      current.workspaceId !== input.workspaceId ||
      current.generation !== input.generation ||
      current.runtime.authorityEpoch !== input.authorityEpoch ||
      current.runtime.engineInstanceId !== input.engineInstanceId ||
      current.runtime.sequence !== input.connectionSequence
    ) {
      throw new CloudWorkspaceAccessClientError(
        409,
        "cloud_workspace_access_superseded",
        "The cloud workspace runtime session has been superseded",
      );
    }
    const token = await this.token();
    const admission = await this.api.issueEngineAdmission(token, {
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
    });
    const stillCurrent = this.runtimeById.get(input.runtimeId);
    if (
      stillCurrent !== accessId ||
      this.leases.get(accessId!) !== current ||
      current.runtime.sequence !== input.connectionSequence
    ) {
      throw new CloudWorkspaceAccessClientError(
        409,
        "cloud_workspace_access_superseded",
        "The cloud workspace runtime session has been superseded",
      );
    }

    if(admission.version!==1)throw new CloudWorkspaceAccessClientError(409,"cloud_workspace_access_superseded","Reopen the upgraded cloud workspace runtime");
    const rotateTunnel =
      admission.generation !== current.generation ||
      admission.remotePort !== current.runtime.remotePort ||
      Date.parse(current.expiresAt) - this.now() < 2 * 60_000;
    if (!rotateTunnel) {
      current.runtime = {
        ...current.runtime,
        sequence: current.runtime.sequence + 1,
        authorityEpoch: admission.authorityEpoch,
        engineInstanceId: admission.engineInstanceId,
      };
      return this.runtimeTarget(
        current as AccessLease & {
          runtime: RuntimeLease;
          tunnel: CloudWorkspaceTunnelHandle;
        },
        admission,
      );
    }

    const releaseCapacity = this.reserveCapacity();
    try {
      const replacement = await this.createRuntimeLease({
        token,
        target: {
          organizationId: input.organizationId,
          workspaceId: input.workspaceId,
        },
        admission,
        runtimeId: input.runtimeId,
        sequence: input.connectionSequence + 1,
      });
      if (
        this.runtimeById.get(input.runtimeId) !== accessId ||
        current.runtime.sequence !== input.connectionSequence
      ) {
        await replacement.tunnel.stop().catch(() => undefined);
        await this.cleanupSsh(token, replacement).catch(() => undefined);
        throw new CloudWorkspaceAccessClientError(
          409,
          "cloud_workspace_access_superseded",
          "The cloud workspace runtime session has been superseded",
        );
      }
      current.runtime = undefined;
      this.remember(replacement);
      await current.tunnel.stop().catch(() => undefined);
      current.tunnel = undefined;
      if (current.generation !== replacement.generation) {
        if (this.leases.get(current.grantId) === current) {
          this.forgetLease(current.grantId, current);
        }
        // Provider revocation is generation-wide. It is safe and necessary
        // once the replacement belongs to a newer generation, but revoking a
        // same-generation predecessor would also retire the replacement.
        await this.cleanupSsh(token, current).catch(() => undefined);
      }
      return this.runtimeTarget(replacement, admission);
    } finally {
      releaseCapacity();
    }
  }

  async closeRuntime(runtimeId: string): Promise<boolean> {
    this.pruneExpired();
    const actor=this.actorRuntimes.get(runtimeId);
    if(actor){
      if (!actor.closing) {
        actor.closing=true;
        try { this.onRuntimeRetired([runtimeId]); } catch { /* remote cleanup must continue */ }
      }
      const token=await this.token();
      await this.releaseActorAdmission(token,{...actor.target,grantToken:actor.grantToken});
      if(this.actorRuntimes.get(runtimeId)===actor)this.actorRuntimes.delete(runtimeId);
      return true;
    }
    const accessId = this.runtimeById.get(runtimeId);
    return accessId ? this.revoke(accessId) : false;
  }

  async revoke(accessId: string): Promise<boolean> {
    this.pruneExpired();
    const native = this.nativeLeases.get(accessId);
    if (native) { await this.retireNativeLease(native); return true; }
    const lease = this.leases.get(accessId);
    if (!lease) return false;
    let localCleanupError: unknown;
    if (lease.tunnel) {
      try {
        await lease.tunnel.stop();
      } catch (error) {
        // Local process cleanup and remote provider authority are independent
        // security boundaries. Never leave the provider credential live merely
        // because killing the local forwarding process or removing its private
        // files failed.
        localCleanupError = error;
      }
    }
    const token = await this.token();
    await this.api.revoke(token, {
      organizationId: lease.organizationId,
      workspaceId: lease.workspaceId,
      grantId: lease.grantId,
      credential: lease.credential,
    });
    if (lease.kind === "preview") {
      this.forgetLease(accessId, lease);
      if (
        lease.frameName &&
        this.previewByFrame.get(lease.frameName) === accessId
      ) {
        this.previewByFrame.delete(lease.frameName);
      }
      lease.previewAuthorizationCleanup?.();
      return true;
    }
    // Provider-wide revocation invalidates the generation's SSH/tunnel grants,
    // so every sibling lease must close too.
    for (const [id, candidate] of this.leases) {
      if (
        candidate.organizationId !== lease.organizationId ||
        candidate.workspaceId !== lease.workspaceId ||
        candidate.generation !== lease.generation ||
        candidate.kind === "preview"
      ) {
        continue;
      }
      this.forgetLease(id, candidate);
      if (id !== accessId && candidate.tunnel) {
        await candidate.tunnel.stop().catch(() => undefined);
      }
    }
    if (localCleanupError) throw localCleanupError;
    return true;
  }

  async revokePreviewFrame(frameName: string): Promise<boolean> {
    const accessId = this.previewByFrame.get(safeFrameName(frameName));
    return accessId ? this.revoke(accessId) : false;
  }

  /** Stop every local tunnel immediately and best-effort revoke every live
   * provider grant. Used when the account session or app lifetime ends. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const nativeCleanup = Promise.allSettled([...this.nativeLeases.values()].map(lease => this.retireNativeLease(lease)));
    const runtimeIds = [...this.actorRuntimes.keys(), ...this.runtimeById.keys()];
    try { this.onRuntimeRetired(runtimeIds); } catch { /* local cleanup must continue */ }
    const actorRuntimes=[...this.actorRuntimes.values()];this.actorRuntimes.clear();
    const leases = [...this.leases.values()];
    this.leases.clear();
    this.previewByFrame.clear();
    this.runtimeById.clear();
    for (const lease of leases) lease.previewAuthorizationCleanup?.();
    const localCleanup = Promise.resolve().then(() =>
      this.disposeLocalAccess(),
    );
    const cleanupResults = await Promise.allSettled([
      ...leases.map((lease) => lease.tunnel?.stop() ?? Promise.resolve()),
      localCleanup,
    ]);
    await nativeCleanup;
    this.nativeLeases.clear();
    const localCleanupResult = cleanupResults.at(-1);
    const localCleanupError =
      localCleanupResult?.status === "rejected"
        ? localCleanupResult.reason
        : undefined;
    const capturedToken = this.lastAccessToken;
    this.lastAccessToken = null;
    const token = capturedToken;
    if (!token) {
      if (localCleanupError) throw localCleanupError;
      return;
    }
    await Promise.allSettled(actorRuntimes.map(actor=>this.releaseActorAdmission(token,{...actor.target,grantToken:actor.grantToken})));
    const providerRevocations: AccessLease[] = [];
    const sshGenerations = new Set<string>();
    for (const lease of leases) {
      if (lease.kind === "preview") {
        providerRevocations.push(lease);
        continue;
      }
      const key = `${lease.organizationId}:${lease.workspaceId}:${lease.generation}`;
      if (sshGenerations.has(key)) continue;
      sshGenerations.add(key);
      providerRevocations.push(lease);
    }
    await Promise.allSettled(
      providerRevocations.map((lease) =>
        this.api.revoke(token, {
          organizationId: lease.organizationId,
          workspaceId: lease.workspaceId,
          grantId: lease.grantId,
          credential: lease.credential,
        }),
      ),
    );
    if (localCleanupError) throw localCleanupError;
  }
}
