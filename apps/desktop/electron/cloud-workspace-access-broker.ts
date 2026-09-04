import { randomUUID } from "node:crypto";

import {
  CloudWorkspaceAccessClientError,
  type CloudWorkspaceEngineAdmission,
  type CloudWorkspacePreviewAccess,
  type CloudWorkspaceSshAccess,
  type CloudWorkspaceTunnelAccess,
} from "./cloud-workspace-access-client";

const ACCESS_TTL_MINUTES = 30;
const MAX_ACTIVE_ACCESS = 64;

export interface CloudWorkspaceAccessBrokerApi {
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
  channel: "electron-ssh-tunnel";
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
  private readonly api: CloudWorkspaceAccessBrokerApi;
  private readonly getAccessToken: () => Promise<string | null>;
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
  private pendingAccess = 0;
  // The auth store is cleared before its session-change listeners run. Keep
  // the most recent token that actually issued/revoked one of this broker's
  // grants so disposal can retire those grants with the same account instead
  // of accidentally using a replacement account (or no token at all).
  private lastAccessToken: string | null = null;
  private disposed = false;

  constructor(input: {
    api: CloudWorkspaceAccessBrokerApi;
    getAccessToken: () => Promise<string | null>;
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
    this.api = input.api;
    this.getAccessToken = input.getAccessToken;
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

  private reserveCapacity(): () => void {
    if (this.disposed) {
      throw new CloudWorkspaceAccessClientError(
        401,
        "signed_out",
        "Cloud workspace access authority has ended",
      );
    }
    this.pruneExpired();
    if (this.leases.size + this.pendingAccess >= MAX_ACTIVE_ACCESS) {
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
    const value = await this.getAccessToken();
    if (!value) {
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
      // Daytona revocation retires the sandbox's complete SSH token set. A
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
      if (this.disposed) {
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

  async openPreview(
    input: AccessTarget & { port: number; frameName: string },
    authorize: PreviewAuthorizer,
  ): Promise<{
    accessId: string;
    logicalUrl: string;
    origin: string;
    admissionUrl: string;
    expiresAt: string;
  }> {
    const frameName = safeFrameName(input.frameName);
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
          expiresInMinutes: ACCESS_TTL_MINUTES,
          idempotencyKey: this.key("preview"),
        });
        if (this.disposed) {
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
        if (this.disposed) {
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
      if (this.disposed) {
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
      if (this.disposed) {
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
      if (this.disposed) {
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
      if (this.disposed) {
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
      if (this.disposed) {
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
      if (this.disposed) {
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
    if (this.disposed) {
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
      return this.runtimeTarget(replacement, admission);
    } finally {
      releaseCapacity();
    }
  }

  async closeRuntime(runtimeId: string): Promise<boolean> {
    this.pruneExpired();
    const accessId = this.runtimeById.get(runtimeId);
    return accessId ? this.revoke(accessId) : false;
  }

  async revoke(accessId: string): Promise<boolean> {
    this.pruneExpired();
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
    // Daytona's bearer-free server-side revoke invalidates the entire
    // sandbox's SSH token set, so every sibling SSH/tunnel lease is stale too.
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
    this.disposed = true;
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
    const localCleanupResult = cleanupResults.at(-1);
    const localCleanupError =
      localCleanupResult?.status === "rejected"
        ? localCleanupResult.reason
        : undefined;
    const capturedToken = this.lastAccessToken;
    this.lastAccessToken = null;
    const token =
      capturedToken ?? (await this.getAccessToken().catch(() => null));
    if (!token) {
      if (localCleanupError) throw localCleanupError;
      return;
    }
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
