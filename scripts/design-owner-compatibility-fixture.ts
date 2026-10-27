/** Disposable Personal/retained-organization Local data, never an auth grant.
 * New organization-owned Local creation remains prohibited by the product.
 * This seed models an existing database from before that creation policy. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeZerosDb, openZerosDb, setZerosDbPathForTesting } from "../apps/desktop/src/engine/db/database";
import { ensureReposFromWorkspaces } from "../apps/desktop/src/engine/db/projects";
import { initializeDesignDocument, createDesignFrame } from "../apps/desktop/src/engine/design/document";
import { designDirectoryNameFor } from "../apps/desktop/src/engine/design/directory-registry";
import { generateWorkspaceId } from "../apps/desktop/src/engine/git/naming";
import { insertWorkspace } from "../apps/desktop/src/engine/git/state";
import type { Workspace } from "../apps/desktop/src/engine/git/types";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

async function authoredSources(root: string) {
  const rows: { file: string; sha256: string }[] = [];
  const visit = async (directory: string) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if ([".git", ".zeros", "node_modules"].includes(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) rows.push({ file: path.relative(root, file), sha256: createHash("sha256").update(await fs.readFile(file)).digest("hex") });
    }
  };
  await visit(root);
  return rows.sort((a, b) => a.file.localeCompare(b.file));
}

export async function prepareOwnerCompatibilityFixture(options: { output: string; organizationId?: string }) {
  const organizationId = options.organizationId ?? randomUUID();
  assert(uuid.test(organizationId), "Supply a valid organization UUID; no authentication is inferred from it.");
  const requested = path.resolve(options.output);
  const parent = await fs.realpath(path.dirname(requested));
  const root = path.join(parent, path.basename(requested));
  // Refuse every existing destination, including symlinks and real profiles.
  await fs.mkdir(root, { mode: 0o700 });
  const profile = path.join(root, "profile");
  await fs.mkdir(profile, { mode: 0o700 });
  const previousDataDir = process.env.ZEROS_DATA_DIR;
  process.env.ZEROS_DATA_DIR = profile;
  setZerosDbPathForTesting(path.join(profile, "zeros.db"));
  const workspaces: (Workspace & { fixtureOwner: string; marker: string; designDirectory: string; frames: string[]; sources: { file: string; sha256: string }[] })[] = [];
  try {
    for (const owner of ["personal", "organization-local"] as const) {
      const folder = path.join(root, owner);
      await fs.mkdir(folder, { mode: 0o700 });
      execFileSync("git", ["init", "-q", "--initial-branch=main", folder]);
      await initializeDesignDocument(folder);
      const directory = designDirectoryNameFor(folder);
      const marker = owner === "personal" ? "Personal Local compatibility fixture" : "Retained organization Local compatibility fixture";
      const frame = await createDesignFrame(folder, { title: marker, geometry: { x: 0, y: 0, w: 560, h: 360, z: 0 } });
      await fs.writeFile(path.join(folder, directory, frame.file), `<!doctype html><html><head><style>body{margin:0;padding:24px;background:#fafafa;color:#222;font:18px system-ui}h1{font-size:24px}</style></head><body><main data-oid="owner-scene" data-zeros-frame-root><h1 data-oid="owner-marker">${marker}</h1><p data-oid="owner-detail">Authored fixture content must survive owner switches, captures and restarts.</p></main></body></html>`);
      const text = await createDesignFrame(folder, { title: `${marker} text`,
        seed: { kind: "text", nodeId: "owner-text", text: marker, fixedSize: true },
        geometry: { x: 640, y: 0, w: 560, h: 360, z: 1 } });
      const workspace: Workspace = { id: generateWorkspaceId(`fixture-${owner}`), canonicalId: randomUUID(),
        viewMode: "design", kind: "design", organizationId: owner === "personal" ? null : organizationId,
        placement: "local", repoSlug: `owner-fixture-${owner}`, repoRoot: folder, path: folder,
        branch: "main", baseBranch: "main", status: "in-progress", createdAt: Date.now(), archivedAt: null,
        stashRef: null, prNumber: null, prState: null, prUrl: null, agentId: null, lastActiveAt: null };
      insertWorkspace(workspace);
      workspaces.push({ ...workspace, fixtureOwner: owner, marker, designDirectory: directory,
        frames: [frame.file, text.file], sources: await authoredSources(folder) });
    }
    ensureReposFromWorkspaces(workspaces);
    openZerosDb().pragma("wal_checkpoint(TRUNCATE)");
    closeZerosDb();
    const manifest = { version: 1, preparedAt: new Date().toISOString(), root, profile,
      organizationId, syntheticOrganizationId: options.organizationId === undefined,
      authorization: "Fixture ownership is data only. Native owner selection requires normal full-Dev sign-in and confirmed membership; this fixture does not grant it.",
      method: "Fresh checkouts and a fresh engine database seeded through current migrations and the retained-row persistence path. No existing profile is opened, and nothing is staged or committed.",
      workspaces };
    await fs.writeFile(path.join(root, "fixture.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    return manifest;
  } finally {
    closeZerosDb(); setZerosDbPathForTesting(null);
    if (previousDataDir === undefined) delete process.env.ZEROS_DATA_DIR;
    else process.env.ZEROS_DATA_DIR = previousDataDir;
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log("bun scripts/design-owner-compatibility-fixture.ts --output NEW_DIRECTORY [--organization-id MEMBER_ORGANIZATION_UUID]");
    return;
  }
  let output: string | undefined, organizationId: string | undefined;
  while (args.length) {
    const name = args.shift(), value = args.shift();
    if (!value || value.startsWith("--")) throw new Error("Each fixture option requires a value.");
    if (name === "--output") output = value;
    else if (name === "--organization-id") organizationId = value;
    else throw new Error("Unknown fixture option. Use --help.");
  }
  if (!output) throw new Error("Supply a new --output directory.");
  const fixture = await prepareOwnerCompatibilityFixture({ output, organizationId });
  console.log(JSON.stringify({ fixture: path.join(fixture.root, "fixture.json"), profile: fixture.profile,
    workspaces: fixture.workspaces.map(({ id, fixtureOwner, placement }) => ({ id, fixtureOwner, placement })),
    syntheticOrganizationId: fixture.syntheticOrganizationId, nativeQualified: false }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
