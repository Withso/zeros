// The native check's fixture control plane, on 127.0.0.1 only. It answers the reads the unified-workspaces
// surfaces make, from a state the script switches between checks (Personal's own cloud, retention, Keep), and
// records every request (method, path) so the checks can state what the app asked for. Anything it doesn't
// serve answers 404 with an error body, as the real control plane does for an unknown route.
import http from "node:http";

export const FIXTURE = {
  user: "11111111-1111-4111-8111-111111111111",
  organization: "22222222-2222-4222-8222-222222222222",
  personal: "33333333-3333-4333-8333-333333333333",
  project: "55555555-5555-4555-8555-555555555555",
  email: "fixture@example.test",
};
export const WORKSPACES = {
  several: "66666666-6666-4666-8666-666666666661",
  live: "66666666-6666-4666-8666-666666666662",
  inactive: "66666666-6666-4666-8666-666666666663",
  memberLeft: "66666666-6666-4666-8666-666666666664",
  backupGone: "66666666-6666-4666-8666-666666666665",
  personal: "66666666-6666-4666-8666-666666666666",
};

const day = 86_400_000;
const iso = (offset) => new Date(Date.now() + offset * day).toISOString();
const capabilities = { design: false, browser: false, simulators: false, terminal: true, files: true, git: true, agents: ["codex"] };

function organizationEntry(id, name, extra = {}) {
  return { id, slug: name.toLowerCase().replace(/\W+/g, "-"), name, logo: null, role: "owner", isPersonal: false, defaultTeamId: id,
    workspaceCapabilities: { local: true, cloud: true }, teamCapabilities: { multiple: false, canCreate: false }, seat: "pro", ...extra };
}

export function createFixtureState() {
  return { personalCloud: true, personalSeat: "pro", noProjects: false, retention: true, keep: new Set(), requests: [] };
}

function workspace(state, id, patch) {
  const base = { id, organizationId: FIXTURE.organization, creatorUserId: FIXTURE.user, name: "w", repository: "fixture/app", branch: "zeros/native-check",
    baseBranch: "main", state: "stopped", errorCode: null, archivedAt: null, createdAt: iso(-40), updatedAt: iso(-1), version: 2, capabilities };
  const document = { ...base, ...patch };
  const archived = !!document.archivedAt;
  if (state.retention) Object.assign(document, { keep: !archived && state.keep.has(id), ...(patch.retention ?? {}) });
  delete document.retention;
  return document;
}

function organizationWorkspaces(state) {
  return [
    workspace(state, WORKSPACES.several, { name: "Several repositories", title: "Several repositories", project: { id: FIXTURE.project, name: "Native" },
      checkoutPath: "/home/user/native/app", root: "/home/user/native",
      repositories: [
        { repository: "fixture/app", checkoutPath: "/home/user/native/app", branch: "zeros/native-check", baseBranch: "main" },
        { repository: "fixture/web", checkoutPath: "/home/user/native/web", branch: "zeros/native-check", baseBranch: "main" }] }),
    workspace(state, WORKSPACES.live, { name: "Live", title: "Live" }),
    workspace(state, WORKSPACES.inactive, { name: "Idle", title: "Idle", archivedAt: iso(-2),
      retention: { archiveReason: "inactive", restores: "all", machineExpectedGoneAt: { at: iso(20), estimate: true }, backupRemovalAt: iso(58) } }),
    workspace(state, WORKSPACES.memberLeft, { name: "Former member", title: "Former member", archivedAt: iso(-3),
      retention: { archiveReason: "member_left", restores: "all", machineExpectedGoneAt: { at: iso(9), estimate: true }, backupRemovalAt: iso(51) } }),
    workspace(state, WORKSPACES.backupGone, { name: "Backup gone", title: "Backup gone", archivedAt: iso(-70),
      retention: { archiveReason: "manual", restores: "pushed", machineExpectedGoneAt: { at: iso(-30), estimate: false } } }),
  ];
}

function personalWorkspaces(state) {
  return state.personalCloud ? [workspace(state, WORKSPACES.personal, { organizationId: FIXTURE.personal, name: "Personal cloud", title: "Personal cloud" })] : [];
}

/** As the control plane answers with Personal's own cloud on (C3): the Personal row says cloud, with the owner's seat. */
function me(state) {
  const personal = { ...organizationEntry(FIXTURE.personal, "Personal", { isPersonal: true }), defaultTeamId: null,
    workspaceCapabilities: { local: true, cloud: state.personalCloud }, ...(state.personalCloud ? { seat: state.personalSeat } : { seat: undefined }) };
  const organizations = [personal, organizationEntry(FIXTURE.organization, "Native Org")];
  return {
    user: { id: FIXTURE.user, email: FIXTURE.email, displayName: "Fixture", staffRole: null },
    capabilities: { createOrganization: true, pro: true },
    organizations, teams: organizations,
  };
}

function projects(state, organizationId) {
  const repository = (name, position) => ({ repository: `fixture/${name}`, repositoryId: String(900 + position), connectionId: null, defaultBranch: "main",
    setup: null, setupScript: null, fetchSubmodules: position === 0, position });
  return { projects: organizationId === FIXTURE.organization && !state.noProjects ? [{ id: FIXTURE.project, name: "Native", level: "organization", ownerUserId: null,
    canEdit: true, canShare: false, repositories: [repository("app", 0), repository("web", 1)], readyCopy: "ready" }] : [],
  personalAllowed: true, canCreateOrganization: true, limits: { personal: 20, repositories: 10 } };
}

export async function startFixtureControlPlane(state, port) {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    let body = "";
    for await (const chunk of request) body += chunk;
    state.requests.push({ method: request.method, path: url.pathname, query: url.search, at: Date.now() });
    const send = (status, value) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    const path = url.pathname, method = request.method ?? "GET";
    if (method === "OPTIONS") { response.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" }); response.end(); return; }
    response.setHeader("access-control-allow-origin", "*");
    if (path === "/v1/me") return send(200, me(state));
    if (path === "/v1/cloud-v2/workspaces" && method === "GET") {
      const organizationId = url.searchParams.get("organizationId");
      const workspaces = organizationId === FIXTURE.organization ? organizationWorkspaces(state) : organizationId === FIXTURE.personal ? personalWorkspaces(state) : [];
      return send(200, { workspaces, ...(state.retention ? { retention: true } : {}) });
    }
    const keep = /^\/v1\/cloud-v2\/workspaces\/([0-9a-f-]{36})\/keep$/.exec(path);
    if (keep && (method === "PUT" || method === "DELETE")) {
      if (!state.retention) return send(404, { error: { code: "not_found", message: "Not found" } });
      if (method === "PUT") state.keep.add(keep[1]); else state.keep.delete(keep[1]);
      const found = [...organizationWorkspaces(state), ...personalWorkspaces(state)].find(row => row.id === keep[1]);
      return found ? send(200, { workspace: found }) : send(404, { error: { code: "not_found", message: "Cloud workspace not found" } });
    }
    const one = /^\/v1\/cloud-v2\/workspaces\/([0-9a-f-]{36})$/.exec(path);
    if (one && method === "GET") {
      const found = [...organizationWorkspaces(state), ...personalWorkspaces(state)].find(row => row.id === one[1]);
      return found ? send(200, { workspace: found }) : send(404, { error: { code: "not_found", message: "Cloud workspace not found" } });
    }
    const listProjects = /^\/v1\/cloud-v2\/organizations\/([0-9a-f-]{36})\/cloud-projects$/.exec(path);
    if (listProjects && method === "GET") return send(200, projects(state, listProjects[1]));
    send(404, { error: { code: "not_found", message: "Not served by the native check's fixture control plane" } });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise(resolve => server.close(() => resolve())) };
}
