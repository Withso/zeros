import { WorkOS, type Event, type EventName, type User } from "@workos-inc/node";
import { createRemoteJWKSet, decodeJwt, jwtVerify } from "jose";

import type { AuthBackendConfig, WorkOSBackendConfig } from "./config.js";

const AUTH_CLAIM_NAMESPACE = "https://zeros.build/";

export type WorkOSUser = {
  id: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
};

export type WorkOSExchange = {
  sealedSession: string;
  sessionId: string;
  accessToken: string;
  accessTokenExpiresAt: number;
  user: WorkOSUser;
};

export type WorkOSRefreshResult =
  | ({ status: "active" } & WorkOSExchange)
  | {
      status: "transient";
      reason: string;
      retryAfter?: number;
      /** WorkOS may rotate before a later local verification step fails. */
      sealedSession?: string;
    }
  | { status: "terminal"; reason: string };

export type WorkOSRestoreResult =
  | ({ status: "active" } & WorkOSExchange)
  | { status: "terminal"; reason: string };

export interface WorkOSBrowserProvider {
  /** Build the Hosted AuthKit URL. Callers cannot select a connection or IdP. */
  authorizationUrl(options: {
    state: string;
    codeChallenge: string;
    redirectUri: string;
  }): string;
  exchange(options: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<WorkOSExchange>;
  restore(sealedSession: string): Promise<WorkOSRestoreResult>;
  refresh(sealedSession: string): Promise<WorkOSRefreshResult>;
  logoutUrl(options: { sessionId: string; returnTo: string }): string;
  revokeSession(sessionId: string): Promise<void>;
}

export interface WorkOSDesktopProvider {
  verifyDesktopBearer(accessToken: string): Promise<{
    subject: string;
    sessionId: string;
  }>;
  listSessions(
    subject: string,
    options: { limit: number; after?: string },
  ): Promise<{
    data: Array<{ id: string; status: string }>;
    listMetadata: { after: string | null };
  }>;
  revokeSession(sessionId: string): Promise<void>;
}

export interface WorkOSDesktopAuthorizationProvider {
  /** Build the Hosted AuthKit URL for the public desktop Application. */
  desktopAuthorizationUrl(options: {
    state: string;
    codeChallenge: string;
    redirectUri: string;
  }): string;
}

export type WorkOSOrganizationRecord = {
  id: string;
  name: string;
  externalId: string | null;
  updatedAt: string;
};

export type WorkOSMembershipRecord = {
  id: string;
  organizationId: string;
  userId: string;
  status: "active" | "inactive" | "pending";
  directoryManaged: boolean;
  roleSlug: string;
  updatedAt: string;
};

export type WorkOSInvitationRecord = {
  id: string;
  organizationId: string | null;
  email: string;
  state: "pending" | "accepted" | "expired" | "revoked";
  roleSlug: string | null;
  updatedAt: string;
};

export type WorkOSManagementEvent = {
  id: string;
  event: string;
  createdAt: string;
  data: Record<string, unknown>;
};

export interface WorkOSManagementProvider {
  constructWebhookEvent(
    payload: string,
    signature: string,
    secret: string,
  ): Promise<WorkOSManagementEvent>;
  listEvents(options: {
    events: string[];
    after?: string;
    limit: number;
  }): Promise<{ data: WorkOSManagementEvent[]; after: string | null }>;
  createOrganization(options: {
    name: string;
    externalId: string;
    idempotencyKey: string;
  }): Promise<WorkOSOrganizationRecord>;
  getOrganizationByExternalId(
    externalId: string,
  ): Promise<WorkOSOrganizationRecord>;
  updateOrganization(options: {
    organizationId: string;
    name: string;
    externalId: string;
  }): Promise<WorkOSOrganizationRecord>;
  deleteOrganization(organizationId: string): Promise<void>;
  createMembership(options: {
    organizationId: string;
    userId: string;
    roleSlug: string;
  }): Promise<WorkOSMembershipRecord>;
  updateMembership(options: {
    membershipId: string;
    roleSlug: string;
  }): Promise<WorkOSMembershipRecord>;
  deleteMembership(membershipId: string): Promise<void>;
  listMemberships(options: {
    organizationId: string;
    userId: string;
  }): Promise<WorkOSMembershipRecord[]>;
  sendInvitation(options: {
    organizationId: string;
    email: string;
    roleSlug: string;
    inviterUserId?: string;
  }): Promise<WorkOSInvitationRecord>;
  getInvitation(invitationId: string): Promise<WorkOSInvitationRecord>;
  findInvitationByToken(token: string): Promise<WorkOSInvitationRecord>;
  listInvitations(options: {
    organizationId: string;
    email: string;
  }): Promise<WorkOSInvitationRecord[]>;
  revokeInvitation(invitationId: string): Promise<WorkOSInvitationRecord>;
  revokeSession(sessionId: string): Promise<void>;
}

type WorkOSAuthConfig = Extract<AuthBackendConfig, { provider: "workos" }>;

function accessTokenExpiresAt(accessToken: string): number {
  const claims = decodeJwt(accessToken);
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) {
    throw new Error("WorkOS access token has no expiration");
  }
  return claims.exp * 1_000;
}

export class RailwayWorkOSProvider
  implements
    WorkOSBrowserProvider,
    WorkOSDesktopProvider,
    WorkOSDesktopAuthorizationProvider,
    WorkOSManagementProvider
{
  private readonly client: WorkOS;
  private readonly desktopJwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(
    private readonly auth: WorkOSAuthConfig,
    private readonly backend: WorkOSBackendConfig,
    client?: WorkOS,
  ) {
    this.client =
      client ??
      new WorkOS({
        apiKey: backend.apiKey,
        clientId: auth.webClientId,
        timeout: 8_000,
        maxRetries: 2,
      });
    this.desktopJwks = createRemoteJWKSet(new URL(auth.jwksUrl), {
      cooldownDuration: 5 * 60_000,
    });
  }

  authorizationUrl(options: {
    state: string;
    codeChallenge: string;
    redirectUri: string;
  }): string {
    return this.client.userManagement.getAuthorizationUrl({
      provider: "authkit",
      state: options.state,
      codeChallenge: options.codeChallenge,
      codeChallengeMethod: "S256",
      redirectUri: options.redirectUri,
    });
  }

  desktopAuthorizationUrl(options: {
    state: string;
    codeChallenge: string;
    redirectUri: string;
  }): string {
    return this.client.userManagement.getAuthorizationUrl({
      clientId: this.auth.desktopClientId,
      provider: "authkit",
      state: options.state,
      codeChallenge: options.codeChallenge,
      codeChallengeMethod: "S256",
      redirectUri: options.redirectUri,
    });
  }

  private async verifiedExchange(
    sealedSession: string,
    expectedUser?: User,
  ): Promise<WorkOSExchange> {
    const loaded = this.client.userManagement.loadSealedSession({
      sessionData: sealedSession,
      cookiePassword: this.backend.cookiePassword,
    });
    const authenticated = await loaded.authenticate();
    if (!authenticated.authenticated) {
      throw new Error(
        `WorkOS sealed session rejected: ${authenticated.reason}`,
      );
    }
    if (expectedUser && authenticated.user.id !== expectedUser.id) {
      throw new Error("WorkOS sealed-session user mismatch");
    }
    return {
      sealedSession,
      sessionId: authenticated.sessionId,
      accessToken: authenticated.accessToken,
      accessTokenExpiresAt: accessTokenExpiresAt(authenticated.accessToken),
      user: {
        id: authenticated.user.id,
        email: authenticated.user.email,
        emailVerified: authenticated.user.emailVerified,
        name: authenticated.user.name,
      },
    };
  }

  async exchange(options: {
    code: string;
    codeVerifier: string;
  }): Promise<WorkOSExchange> {
    const response = await this.client.userManagement.authenticateWithCode({
      code: options.code,
      codeVerifier: options.codeVerifier,
      session: {
        sealSession: true,
        cookiePassword: this.backend.cookiePassword,
      },
    });
    if (!response.sealedSession) {
      throw new Error("WorkOS did not return a sealed session");
    }
    return this.verifiedExchange(response.sealedSession, response.user);
  }

  async restore(sealedSession: string): Promise<WorkOSRestoreResult> {
    const loaded = this.client.userManagement.loadSealedSession({
      sessionData: sealedSession,
      cookiePassword: this.backend.cookiePassword,
    });
    const authenticated = await loaded.authenticate();
    if (!authenticated.authenticated) {
      return { status: "terminal", reason: String(authenticated.reason) };
    }
    return {
      status: "active",
      sealedSession,
      sessionId: authenticated.sessionId,
      accessToken: authenticated.accessToken,
      accessTokenExpiresAt: accessTokenExpiresAt(authenticated.accessToken),
      user: {
        id: authenticated.user.id,
        email: authenticated.user.email,
        emailVerified: authenticated.user.emailVerified,
        name: authenticated.user.name,
      },
    };
  }

  async refresh(sealedSession: string): Promise<WorkOSRefreshResult> {
    const loaded = this.client.userManagement.loadSealedSession({
      sessionData: sealedSession,
      cookiePassword: this.backend.cookiePassword,
    });
    const result = await loaded.refresh();
    if (!result.authenticated) {
      return result.retryable
        ? {
            status: "transient",
            reason: String(result.reason),
            ...(typeof result.retryAfter === "number"
              ? { retryAfter: result.retryAfter }
              : {}),
          }
        : { status: "terminal", reason: String(result.reason) };
    }
    if (!result.sealedSession) {
      return { status: "terminal", reason: "missing_sealed_session" };
    }
    try {
      return {
        status: "active",
        ...(await this.verifiedExchange(
          result.sealedSession,
          result.session?.user,
        )),
      };
    } catch {
      return {
        status: "transient",
        reason: "verification_unavailable",
        sealedSession: result.sealedSession,
      };
    }
  }

  logoutUrl(options: { sessionId: string; returnTo: string }): string {
    return this.client.userManagement.getLogoutUrl(options);
  }

  async verifyDesktopBearer(accessToken: string): Promise<{
    subject: string;
    sessionId: string;
  }> {
    const { payload } = await jwtVerify(accessToken, this.desktopJwks, {
      issuer: this.auth.issuer,
      audience: this.auth.audience,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "iat", "sub", "sid", "jti", "client_id"],
    });
    const subject = typeof payload.sub === "string" ? payload.sub.trim() : "";
    const sessionId = typeof payload.sid === "string" ? payload.sid.trim() : "";
    if (
      !subject ||
      !sessionId ||
      payload.client_id !== this.auth.desktopClientId ||
      payload[`${AUTH_CLAIM_NAMESPACE}email_verified`] !== true ||
      typeof payload[`${AUTH_CLAIM_NAMESPACE}email`] !== "string" ||
      !(payload[`${AUTH_CLAIM_NAMESPACE}email`] as string).trim()
    ) {
      throw new Error("Desktop access-token contract rejected");
    }
    return { subject, sessionId };
  }

  async listSessions(
    subject: string,
    options: { limit: number; after?: string },
  ): Promise<{
    data: Array<{ id: string; status: string }>;
    listMetadata: { after: string | null };
  }> {
    const page = await this.client.userManagement.listSessions(
      subject,
      options,
    );
    return {
      data: page.data.map((session) => ({
        id: session.id,
        status: session.status,
      })),
      listMetadata: { after: page.listMetadata.after ?? null },
    };
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.client.userManagement.revokeSession({ sessionId });
  }

  private managementEvent(event: Event): WorkOSManagementEvent {
    return {
      id: event.id,
      event: event.event,
      createdAt: event.createdAt,
      data: event.data as unknown as Record<string, unknown>,
    };
  }

  async constructWebhookEvent(
    payload: string,
    signature: string,
    secret: string,
  ): Promise<WorkOSManagementEvent> {
    return this.managementEvent(
      await this.client.webhooks.constructEvent({
        payload,
        sigHeader: signature,
        secret,
      }),
    );
  }

  async listEvents(options: {
    events: string[];
    after?: string;
    limit: number;
  }): Promise<{ data: WorkOSManagementEvent[]; after: string | null }> {
    const page = await this.client.events.listEvents({
      events: options.events as EventName[],
      limit: options.limit,
      order: "asc",
      ...(options.after ? { after: options.after } : {}),
    });
    return {
      data: page.data.map((event) => this.managementEvent(event)),
      after: page.listMetadata.after ?? null,
    };
  }

  private organizationRecord(organization: {
    id: string;
    name: string;
    externalId: string | null;
    updatedAt: string;
  }): WorkOSOrganizationRecord {
    return {
      id: organization.id,
      name: organization.name,
      externalId: organization.externalId,
      updatedAt: organization.updatedAt,
    };
  }

  async createOrganization(options: {
    name: string;
    externalId: string;
    idempotencyKey: string;
  }): Promise<WorkOSOrganizationRecord> {
    return this.organizationRecord(
      await this.client.organizations.createOrganization(
        { name: options.name, externalId: options.externalId },
        { idempotencyKey: options.idempotencyKey },
      ),
    );
  }

  async getOrganizationByExternalId(
    externalId: string,
  ): Promise<WorkOSOrganizationRecord> {
    return this.organizationRecord(
      await this.client.organizations.getOrganizationByExternalId(externalId),
    );
  }

  async updateOrganization(options: {
    organizationId: string;
    name: string;
    externalId: string;
  }): Promise<WorkOSOrganizationRecord> {
    return this.organizationRecord(
      await this.client.organizations.updateOrganization({
        organization: options.organizationId,
        name: options.name,
        externalId: options.externalId,
      }),
    );
  }

  async deleteOrganization(organizationId: string): Promise<void> {
    await this.client.organizations.deleteOrganization(organizationId);
  }

  private membershipRecord(membership: {
    id: string;
    organizationId: string;
    userId: string;
    status: "active" | "inactive" | "pending";
    directoryManaged: boolean;
    role: { slug: string };
    updatedAt: string;
  }): WorkOSMembershipRecord {
    return {
      id: membership.id,
      organizationId: membership.organizationId,
      userId: membership.userId,
      status: membership.status,
      directoryManaged: membership.directoryManaged,
      roleSlug: membership.role.slug,
      updatedAt: membership.updatedAt,
    };
  }

  async createMembership(options: {
    organizationId: string;
    userId: string;
    roleSlug: string;
  }): Promise<WorkOSMembershipRecord> {
    return this.membershipRecord(
      await this.client.userManagement.createOrganizationMembership({
        organizationId: options.organizationId,
        userId: options.userId,
        roleSlug: options.roleSlug,
      }),
    );
  }

  async updateMembership(options: {
    membershipId: string;
    roleSlug: string;
  }): Promise<WorkOSMembershipRecord> {
    return this.membershipRecord(
      await this.client.userManagement.updateOrganizationMembership(
        options.membershipId,
        { roleSlug: options.roleSlug },
      ),
    );
  }

  async deleteMembership(membershipId: string): Promise<void> {
    await this.client.userManagement.deleteOrganizationMembership(membershipId);
  }

  async listMemberships(options: {
    organizationId: string;
    userId: string;
  }): Promise<WorkOSMembershipRecord[]> {
    const page = await this.client.userManagement.listOrganizationMemberships({
      organizationId: options.organizationId,
      userId: options.userId,
      // WorkOS otherwise returns active memberships only.
      statuses: ["active", "inactive", "pending"],
      limit: 100,
    });
    return page.data.map((membership) => this.membershipRecord(membership));
  }

  private invitationRecord(invitation: {
    id: string;
    organizationId: string | null;
    email: string;
    state: "pending" | "accepted" | "expired" | "revoked";
    roleSlug: string | null;
    updatedAt: string;
  }): WorkOSInvitationRecord {
    return {
      id: invitation.id,
      organizationId: invitation.organizationId,
      email: invitation.email,
      state: invitation.state,
      roleSlug: invitation.roleSlug,
      updatedAt: invitation.updatedAt,
    };
  }

  async sendInvitation(options: {
    organizationId: string;
    email: string;
    roleSlug: string;
    inviterUserId?: string;
  }): Promise<WorkOSInvitationRecord> {
    return this.invitationRecord(
      await this.client.userManagement.sendInvitation({
        organizationId: options.organizationId,
        email: options.email,
        roleSlug: options.roleSlug,
        expiresInDays: 7,
        ...(options.inviterUserId
          ? { inviterUserId: options.inviterUserId }
          : {}),
      }),
    );
  }

  async findInvitationByToken(token: string): Promise<WorkOSInvitationRecord> {
    return this.invitationRecord(
      await this.client.userManagement.findInvitationByToken(token),
    );
  }

  async getInvitation(invitationId: string): Promise<WorkOSInvitationRecord> {
    return this.invitationRecord(
      await this.client.userManagement.getInvitation(invitationId),
    );
  }

  async listInvitations(options: {
    organizationId: string;
    email: string;
  }): Promise<WorkOSInvitationRecord[]> {
    const page = await this.client.userManagement.listInvitations({
      organizationId: options.organizationId,
      email: options.email,
      limit: 100,
    });
    return page.data.map((invitation) => this.invitationRecord(invitation));
  }

  async revokeInvitation(
    invitationId: string,
  ): Promise<WorkOSInvitationRecord> {
    return this.invitationRecord(
      await this.client.userManagement.revokeInvitation(invitationId),
    );
  }
}
