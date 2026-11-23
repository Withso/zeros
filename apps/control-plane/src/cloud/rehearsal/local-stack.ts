// `--local`: the rehearsal against the Dev stack this checkout runs (`pnpm electron:cloud`): its public origin, its own
// PostgreSQL, the profile's runtime store and Boat account, and the switches the running stack was started with. Read
// from the launcher's own saved state and profile; nothing here calls Railway, PlanetScale or the Alpha origin.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { RehearsalFailure, type Switch } from "./contract.js";
import type { RehearsalTarget } from "./live.js";

/** The switch names a Dev stack records (profile.mjs CLOUD_V2_SWITCHES) and the rehearsal's switch each turns on. */
export const STACK_SWITCHES: Readonly<Record<string, Switch>> = Object.freeze({
  CLOUD_V2_READY_COPIES_ENABLED: "projects", CLOUD_V2_PERSONAL_CLOUD_ENABLED: "personal", CLOUD_V2_RETENTION_ENABLED: "retention",
});

export type LocalStack = {
  target: RehearsalTarget;
  /** The stack's runtime login (reads) and migration login (a clock shift, the Pro operator), on its own PostgreSQL. */
  readUrl: string; ownerUrl: string;
  /** The rehearsal switches the running stack has on, and every cloud v2 switch it was started with (names only). */
  switches: Set<Switch>; started: Record<string, string>;
  storage: { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string };
};

/** The launcher's state as the rehearsal reads it (a subset of scripts/dev-environment/state.mjs's workspace). */
type Workspace = { state: { owner: string; status: string; launcher?: unknown; ports?: { api?: unknown; database?: unknown }; cloudSwitches?: Record<string, string> } };
type Launcher = {
  workspace(): Workspace | null;
  origin(workspace: Workspace): string;
  databaseUrl(workspace: Workspace, port: number, role: "runtime" | "migration"): string;
  storage(): unknown;
};

/** The running stack, or a closed reason it cannot be used (`local_stack not_set_up | not_running | ...`). */
export function localStack(launcher: Launcher): LocalStack {
  const workspace = launcher.workspace();
  if (!workspace) throw new RehearsalFailure("local_stack", "not_set_up");
  const { state } = workspace, ports = state.ports;
  if (state.status !== "active" || !state.launcher || !Number.isInteger(ports?.api) || !Number.isInteger(ports?.database))
    throw new RehearsalFailure("local_stack", "not_running");
  const storage = launcher.storage() as Partial<LocalStack["storage"]> | undefined;
  if (!storage?.endpoint || !storage.bucket || !storage.accessKeyId || !storage.secretAccessKey) throw new RehearsalFailure("local_stack", "profile_storage");
  const started = state.cloudSwitches ?? {};
  const switches = new Set<Switch>(Object.entries(STACK_SWITCHES).filter(([name]) => started[name]?.toLowerCase() === "true").map(([, name]) => name));
  let origin: string;
  try { origin = launcher.origin(workspace); } catch { throw new RehearsalFailure("local_stack", "profile_origin"); }
  if (!/^https:\/\/[a-z0-9.-]+$/.test(origin)) throw new RehearsalFailure("local_stack", "origin");
  // Its own recorded API port, on loopback only.
  const loopback = `http://127.0.0.1:${ports!.api as number}`;
  return { target: { kind: "local", origin, channel: "development", loopback },
    readUrl: launcher.databaseUrl(workspace, ports!.database as number, "runtime"), ownerUrl: launcher.databaseUrl(workspace, ports!.database as number, "migration"),
    switches, started, storage: storage as LocalStack["storage"] };
}

/** The launcher's own modules, read without creating anything: a checkout with no Dev state reads as not set up. */
export async function launcherModules(root: string, env: NodeJS.ProcessEnv): Promise<Launcher> {
  const load = (name: string) => import(pathToFileURL(resolve(root, "scripts/dev-environment", name)).href);
  const [stateModule, postgresModule, profileModule] = await Promise.all([load("state.mjs"), load("postgres.mjs"), load("profile.mjs")]);
  const profile = profileModule.loadProfile(undefined, { root, env });
  return {
    workspace() {
      const identity = stateModule.derivedWorkspaceIdentity(root, env);
      const file = join(stateModule.developmentHome(), "environments", identity.owner, "workspace.json");
      return existsSync(file) ? { state: stateModule.readPrivateJson(file) } : null;
    },
    origin: workspace => profileModule.publicDevProfile(workspace, profile).apiOrigin,
    databaseUrl: (workspace, port, role) => postgresModule.databaseUrl(workspace, port, role),
    storage: () => profile.storage,
  };
}
