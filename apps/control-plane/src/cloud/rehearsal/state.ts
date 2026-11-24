// The rehearsal's state file: one per run, mode 0600 in a 0700 directory outside the repository. It holds only ids,
// booleans, counts and closed codes, so a later stage or `--cleanup` resumes from it.
import { chmod, mkdir, open, readFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { RehearsalFailure, type OwnerKind, type RehearsalState } from "./contract.js";
import { runPrefix } from "./guard.js";

const Uuid = z.string().uuid();
const Grant = z.object({ enabled: z.boolean(), validFrom: z.string().datetime({ offset: true }), validUntil: z.string().datetime({ offset: true }).nullable() }).strict();
const Created = z.object({
  projects: z.array(Uuid), workspaces: z.array(Uuid), machines: z.array(z.string().max(128)),
  branches: z.array(z.object({ repository: z.string().max(201), name: z.string().max(255) })),
  pulls: z.array(z.object({ repository: z.string().max(201), number: z.number().int().positive() })),
  environments: z.array(z.object({ repository: z.string().max(201), repositoryId: z.string().regex(/^[1-9][0-9]{0,15}$/) })),
  pro: z.object({ before: Grant.nullable(), operations: z.array(Uuid).max(16) }).optional(),
  githubSignIns: z.array(Uuid).max(4),
  computerBuild: Uuid.optional(),
  computerRebuilds: z.array(Uuid).max(8).optional(),
  bases: z.array(Uuid).max(8).optional(),
  installScript: z.boolean().optional(),
  staffGrant: z.object({ userId: Uuid, email: z.string().email(), organizationId: Uuid,
    previousRole: z.enum(["platform_owner", "developer", "support_admin"]).nullable(), madeOrganization: z.boolean().optional() }).strict().optional(),
  agentLogins: z.array(z.object({ organizationId: Uuid, provider: z.enum(["claude", "codex", "cursor"]), credentialId: Uuid }).strict()).max(8).optional(),
  isolationOrg: z.object({ organizationId: Uuid, projects: z.array(Uuid).max(8), workspaces: z.array(Uuid).max(8),
    environments: z.array(z.object({ repository: z.string(), repositoryId: z.string() }).strict()).max(4), signIn: z.boolean() }).strict().optional(),
});
const Schema = z.object({
  version: z.literal(1), runId: Uuid, prefix: z.string().regex(/^zr-[0-9a-f]{8}-$/), startedAt: z.string(), target: z.enum(["alpha", "local"]).optional(),
  owner: z.enum(["personal", "organization"]), organizationId: Uuid, organizations: z.array(Uuid).max(4),
  created: Created,
  stages: z.record(z.string(), z.object({ ok: z.boolean(), step: z.string().optional(), code: z.string().optional(), skipped: z.string().optional(),
    counts: z.record(z.string(), z.number()).optional(), notes: z.array(z.string().regex(/^[a-z0-9_:.-]{1,80}$/)).max(16).optional() })),
  shifts: z.number().int().nonnegative(), machineStarts: z.number().int().nonnegative(),
  waiting: z.object({ organizationId: Uuid, created: Created }).strict().optional(),
}).strict();

export const stateDirectory = (base = homedir()) => join(base, ".zeros-rehearsal");

export function newState(runId: string, organizationId: string, startedAt: Date, owner: OwnerKind = "personal", target: "alpha" | "local" = "alpha"): RehearsalState {
  return { version: 1, runId, prefix: runPrefix(runId.replace(/-/g, "")), startedAt: startedAt.toISOString(), target, owner, organizationId,
    organizations: [organizationId], created: { projects: [], workspaces: [], machines: [], branches: [], pulls: [], environments: [], githubSignIns: [] }, stages: {}, shifts: 0, machineStarts: 0 };
}

/** A run's target: a state file from before --local is Alpha's. */
export const stateTarget = (state: Pick<RehearsalState, "target">) => state.target ?? "alpha";

export async function loadState(runId: string, directory = stateDirectory()): Promise<RehearsalState> {
  if (!Uuid.safeParse(runId).success) throw new RehearsalFailure("state", "invalid_run");
  let raw: string;
  try { raw = await readFile(join(directory, `${runId}.json`), "utf8"); } catch { throw new RehearsalFailure("state", "missing"); }
  const parsed = Schema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new RehearsalFailure("state", "invalid");
  return parsed.data as RehearsalState;
}

/** Written whole, then renamed: never a half state. The directory 0700, the file 0600. */
export async function saveState(state: RehearsalState, directory = stateDirectory()): Promise<void> {
  if (!Schema.safeParse(state).success) throw new RehearsalFailure("state", "invalid");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = join(directory, `.${state.runId}.${process.pid}.tmp`);
  const file = await open(temporary, "w", 0o600);
  try { await file.writeFile(JSON.stringify(state)); await file.sync(); } finally { await file.close(); }
  await chmod(temporary, 0o600);
  await rename(temporary, join(directory, `${state.runId}.json`));
}
