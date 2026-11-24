// The fake's organizations: the kept isolation organization's routes as the product answers them (create, invite, accept,
// members, deletion), and its personal projects, workspaces, environments and token sign-ins, each visible to its owner
// only. Every other viewer gets 404 not_found, exactly as for an id that does not exist, unless a test leaks a route.
import { randomUUID } from "node:crypto";
import type { ApiReply } from "../rehearsal/contract.js";

type Organization = { id: string; slug: string; name: string; members: Map<string, string>; personalAllowed: boolean; deletionScheduled: boolean };
type Project = { id: string; org: string; owner: string; name: string; repository: string };
type Workspace = { id: string; org: string; owner: string; project: string; number: number; state: string; archivedAt: string | null; archiveReason: string | null };

export class FakeOrganizations {
  readonly organizations = new Map<string, Organization>();
  readonly projects = new Map<string, Project>();
  readonly workspaces = new Map<string, Workspace>();
  readonly invitations = new Map<string, { org: string; email: string }>();
  readonly environments = new Map<string, { revision: number; files: Map<string, string> }>();
  /** Token sign-ins by `<organization>:<user>`, each with its connection id. */
  readonly signIns = new Map<string, string>();
  /** Routes (method and path with ids as :id) wrongly answered to someone who is not the thing's owner, with the status. */
  readonly leaks = new Map<string, number>();
  /** Accepts answered `503 invite_preparing` before the invitation reaches WorkOS. */
  preparingAccepts = 1;
  invitationsSent = 0;
  private numbers = 0;
  constructor(private readonly emails: ReadonlyMap<string, string>) {}

  /** The organizations a user belongs to, as /v1/me lists them. */
  memberships(user: string): Record<string, unknown>[] {
    return [...this.organizations.values()].filter(org => org.members.has(user))
      .map(org => ({ id: org.id, slug: org.slug, name: org.name, role: org.members.get(user), isPersonal: false, seat: "free" }));
  }

  /** The reply for a request this world owns, or null for the rest of the fake. */
  handle(user: string, method: string, path: string, body: Record<string, unknown> = {}): ApiReply | null {
    const reply = (status: number, value: unknown = {}): ApiReply => ({ status, body: value });
    // The same answer the rest of the fake gives for an id that does not exist.
    const missing = () => reply(404, { error: { code: "not_found" } });
    const url = new URL(path, "https://alpha.test"), parts = url.pathname.split("/").filter(Boolean);
    const shape = `${method} ${url.pathname.replace(/[0-9a-f-]{36}/g, ":id")}`;
    const leaked = (owner: string) => owner !== user ? this.leaks.get(shape) : undefined;
    if (url.pathname === "/v1/organizations" && method === "POST") {
      const slug = String(body.slug);
      if ([...this.organizations.values()].some(org => org.slug === slug)) return reply(409, { error: { code: "organization_id_taken" } });
      const org: Organization = { id: randomUUID(), slug, name: String(body.name), members: new Map([[user, "owner"]]), personalAllowed: false, deletionScheduled: false };
      this.organizations.set(org.id, org);
      return reply(201, { organization: { id: org.id, slug, name: org.name, role: "owner" } });
    }
    if (url.pathname === "/v1/deletions") return reply(200, { deletions: [...this.organizations.values()]
      .filter(org => org.deletionScheduled && org.members.get(user) === "owner").map(org => ({ targetKind: "organization", targetId: org.id, state: "scheduled" })) });
    if (url.pathname === "/v1/invitations/accept" && method === "POST") {
      const invitation = this.invitations.get(String(body.token));
      if (!invitation) return reply(404, { error: { code: "invalid_invite" } });
      if (this.preparingAccepts > 0) { this.preparingAccepts--; return reply(503, { error: { code: "invite_preparing" } }); }
      if (this.emails.get(user) !== invitation.email) return reply(403, { error: { code: "wrong_account" } });
      this.organizations.get(invitation.org)!.members.set(user, "member");
      this.invitations.delete(String(body.token));
      return reply(200, { organization: { id: invitation.org } });
    }
    const org = parts[0] === "v1" && parts[1] === "organizations" ? this.organizations.get(parts[2] ?? "") : undefined;
    if (org) {
      const role = org.members.get(user);
      if (!role) return missing();
      if (parts[3] === "invitations" && method === "POST") {
        if (role === "member") return reply(403, { error: { code: "forbidden" } });
        const token = randomUUID().replace(/-/g, "");
        this.invitations.set(token, { org: org.id, email: String(body.email) }); this.invitationsSent++;
        return reply(201, { invitation: { id: randomUUID(), token, acceptUrl: "https://alpha.test/invite" } });
      }
      if (parts[3] === "members" && method === "DELETE") {
        if (role !== "owner" && parts[4] !== user) return reply(403, { error: { code: "forbidden" } });
        org.members.delete(parts[4]!);
        // A member who leaves: its workspaces there are archived at once (member_left).
        for (const row of this.workspaces.values()) if (row.org === org.id && row.owner === parts[4]) { row.archivedAt = new Date(0).toISOString(); row.archiveReason = "member_left"; }
        return reply(200, { ok: true });
      }
      if (parts.length === 3 && method === "DELETE") {
        if (role !== "owner" || body.confirmation !== org.name) return reply(403, { error: { code: "forbidden" } });
        org.deletionScheduled = true;
        return reply(202, { deletion: { targetId: org.id, state: "scheduled" } });
      }
      return reply(200, { organization: { id: org.id, slug: org.slug, role } });
    }
    // The organization's cloud routes.
    const cloudOrg = parts[1] === "cloud-v2" && parts[2] === "organizations" ? this.organizations.get(parts[3] ?? "") : undefined;
    const queryOrg = this.organizations.get(url.searchParams.get("organizationId") ?? String(body.organizationId ?? ""));
    if (url.pathname === "/v1/cloud-v2/github/connection" && queryOrg) {
      const key = `${queryOrg.id}:${user}`;
      if (method === "POST") { if (body.action === "pat") this.signIns.set(key, randomUUID()); if (body.action === "disconnect") this.signIns.delete(key); }
      return reply(200, { generation: "1", selectedMethod: this.signIns.has(key) ? "pat" : null,
        methods: { pat: { configured: this.signIns.has(key) }, "github-app": { configured: false } } });
    }
    if (url.pathname === "/v1/cloud-v2/workspaces" && queryOrg) {
      if (!queryOrg.members.has(user)) return missing();
      if (method === "GET") return reply(200, { workspaces: [...this.workspaces.values()].filter(row => row.org === queryOrg.id && row.owner === user && row.state !== "deleted")
        .map(row => this.workspace(row)) });
      const project = this.projects.get(String(body.projectId));
      if (!project || project.owner !== user || project.org !== queryOrg.id) return missing();
      const row: Workspace = { id: randomUUID(), org: queryOrg.id, owner: user, project: project.id, number: ++this.numbers, state: "running", archivedAt: null, archiveReason: null };
      this.workspaces.set(row.id, row);
      return reply(201, { workspace: this.workspace(row) });
    }
    if (cloudOrg) {
      if (!cloudOrg.members.has(user)) return missing();
      if (parts[4] === "cloud-projects") {
        if (parts[5] === "settings" && method === "PUT") {
          if (cloudOrg.members.get(user) === "member") return reply(403, { error: { code: "forbidden" } });
          cloudOrg.personalAllowed = body.personalAllowed === true; return reply(200, { personalAllowed: cloudOrg.personalAllowed });
        }
        if (!parts[5] && method === "GET") return reply(200, { personalAllowed: cloudOrg.personalAllowed,
          projects: [...this.projects.values()].filter(row => row.org === cloudOrg.id && row.owner === user).map(row => this.project(row)) });
        if (!parts[5] && method === "POST") {
          const repositories = (body.repositories ?? []) as { repository: string; connectionId?: string }[];
          if (repositories.some(row => row.connectionId && row.connectionId !== this.signIns.get(`${cloudOrg.id}:${user}`))) return missing();
          if (!cloudOrg.personalAllowed || !this.signIns.has(`${cloudOrg.id}:${user}`)) return reply(403, { error: { code: "forbidden" } });
          const row: Project = { id: randomUUID(), org: cloudOrg.id, owner: user, name: String(body.name), repository: repositories[0]!.repository };
          this.projects.set(row.id, row);
          return reply(201, { project: this.project(row) });
        }
        const project = this.projects.get(parts[5] ?? "");
        if (!project || project.org !== cloudOrg.id) return missing();
        const leak = leaked(project.owner);
        if (leak) return reply(leak, {});
        if (project.owner !== user) return missing();
        if (parts[6] === "ready-copy") return reply(200, { status: { state: "ready" }, history: [{ generation: 1, state: "ready", output: false }] });
        if (parts[6] === "build-secrets") return reply(200, { names: [] });
        if (method === "DELETE") { this.projects.delete(project.id); return reply(200, { ok: true }); }
        return reply(200, { project: this.project(project) });
      }
      if (parts[4] === "github" && parts[5] === "connections") {
        const owner = [...this.signIns.entries()].find(([, id]) => id === parts[6])?.[0].split(":")[1];
        if (parts[6]) { const leak = owner ? leaked(owner) : undefined; return leak ? reply(leak, {}) : owner === user ? reply(200, { ok: true }) : missing(); }
        const own = this.signIns.get(`${cloudOrg.id}:${user}`);
        return reply(200, { organization: [], personal: own ? [{ id: own, accountLogin: "zr-fixture", state: "active" }] : [] });
      }
      if (parts[4] === "environment") {
        const key = `${cloudOrg.id}:${user}:${parts[5]}`, environment = this.environments.get(key) ?? { revision: 0, files: new Map<string, string>() };
        if (method === "PATCH") {
          if (body.expectedRevision !== environment.revision) return reply(409, { error: { code: "cloud_environment_conflict" } });
          if (body.clear) environment.files.clear();
          for (const file of (body.files ?? []) as { path: string; content: string }[]) environment.files.set(file.path, file.content);
          environment.revision++; this.environments.set(key, environment);
        }
        return reply(200, { environment: { revision: environment.revision, variables: [], files: [...environment.files.keys()].map(file => ({ path: file, bytes: 1 })) } });
      }
      return missing();
    }
    // A workspace of this world, by id or by number.
    if (parts[1] === "cloud-v2" && parts[2] === "workspaces" && parts[3] === "by-number") {
      const holder = [...this.organizations.values()].find(row => row.slug === parts[4]);
      if (!holder) return null;
      const row = [...this.workspaces.values()].find(entry => entry.org === holder.id && entry.number === Number(parts[5]));
      return row && row.owner === user && holder.members.has(user) ? reply(200, { workspace: this.workspace(row) }) : missing();
    }
    const workspace = parts[1] === "cloud-v2" && parts[2] === "workspaces" ? this.workspaces.get(parts[3] ?? "") : undefined;
    if (workspace) {
      const leak = leaked(workspace.owner);
      if (leak) return reply(leak, {});
      if (workspace.owner !== user || !this.organizations.get(workspace.org)!.members.has(user) || workspace.state === "deleted") return missing();
      if (parts[4] === "stop" && method === "POST") workspace.state = "stopped";
      if (!parts[4] && method === "DELETE") { workspace.state = "deleted"; return reply(202, { workspace: this.workspace(workspace) }); }
      return reply(200, { workspace: this.workspace(workspace) });
    }
    return null;
  }

  /** The database's view of a workspace of this world. */
  archive(id: string): Record<string, unknown> | undefined {
    const row = this.workspaces.get(id);
    return row ? { archived: row.archivedAt !== null, archive_reason: row.archiveReason } : undefined;
  }
  private project(row: Project) {
    return { id: row.id, name: row.name, level: "personal", repositories: [{ repository: row.repository, repositoryId: "101" }] };
  }
  private workspace(row: Workspace) {
    return { id: row.id, name: `${row.number}`, state: row.state, number: row.number, archivedAt: row.archivedAt, archiveReason: row.archiveReason, projectId: row.project };
  }
}
