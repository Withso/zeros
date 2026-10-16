import { createHash } from "node:crypto";
import { z } from "zod";
import { BOAT_RESOURCE_ID_PATTERN, type BoatApiClient } from "./boat-client.js";
import { NAMED_SNAPSHOT_PATTERN } from "./cloud-builder-vm.js";
import { CloudProviderError } from "./provider.js";
import { isComputerTemplateSnapshotName, type ComputerSnapshotChannel } from "./computer-template-name.js";

const snapshotSchema = z.object({
  name: z.string().regex(NAMED_SNAPSHOT_PATTERN), status: z.enum(["saving", "ready", "failed"]),
  sourceSandboxId: z.string().regex(BOAT_RESOURCE_ID_PATTERN),
  snapshotId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/).optional(),
  sizeBytes: z.number().int().positive().safe().optional(),
});
export type ComputerNamedSnapshot = z.infer<typeof snapshotSchema>;
export type ComputerSnapshotIdentity = Pick<ComputerNamedSnapshot, "name" | "sourceSandboxId"> & { snapshotId: string };
export type ComputerSavedTreeProof = {
  schema: "zeros.computer-saved-tree/v1"; snapshotId: string; sourceSandboxId: string; treeSha256: string; entryCount: number;
};
export interface ComputerTemplateSnapshotProvider {
  assertStopped(sandboxId: string): Promise<void>;
  get(name: string): Promise<ComputerNamedSnapshot | null>;
  save(sandboxId: string, name: string): Promise<void>;
  prove(snapshot: ComputerSnapshotIdentity): Promise<ComputerSavedTreeProof>;
  remove(snapshot: ComputerSnapshotIdentity): Promise<boolean>;
}

export function templateCaptureInvalid(): never {
  throw new CloudProviderError("provider_template_capture_invalid", "Computer saved artifact could not be verified", false);
}
const notFound = (error: unknown) => error instanceof CloudProviderError && error.code === "provider_not_found";
// Mirror ComputerBuild.sanitize, including the shared engine/home roots. No
// platform-key exception: a key on a booted clone cannot prove a saved disk.
const privateHome = [".ssh", ".aws", ".azure", ".docker", ".kube", ".cache", ".local/state", ".local/share/keyrings", ".npm/_logs",
  ".config/git/credentials", ".config/gh", ".config/gcloud", ".config/cursor", ".claude", ".codex", ".cursor",
  ".git-credentials", ".netrc", ".npmrc", ".pypirc", ".bash_history", ".zsh_history", ".python_history", ".gitconfig"];
const emptyRoots = ["__system__/srv/zeros/state", "__system__/srv/zeros/home", "__system__/srv/zeros/setup",
  "__system__/srv/zeros/log", "__system__/opt/zeros/sessions", "__system__/var/log", "__system__/run/log/journal",
  "__system__/run/zeros/computer-build", "__system__/srv/zeros/managed-settings",
  // bootstrap.py binds these native /home/user roots onto /srv/zeros. Prove
  // both saved representations; an empty logical mount does not prove its
  // backing tree is sanitized. Keep .zeros-persist/files/repos as source data.
  ".zeros-persist/home", ".zeros-persist/state"];
const emptyFiles = ["__system__/srv/zeros/managed-settings/settings.managed.toml", "__system__/etc/machine-id",
  "__system__/var/lib/systemd/random-seed", "__system__/var/lib/systemd/timesync/clock", "__system__/opt/zeros/disk-epoch",
  "__system__/run/zeros/active-runtime.json"];
// Sanitation retains only repos beneath files. Prove both the logical mount
// and native backing tree, including old private projections beside repos.
const filesRoots = ["__system__/srv/zeros/files", ".zeros-persist/files"];
const below = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

/** Only metadata is read. The closed receipt contains no paths or file bytes.
 * Completeness, normalized paths and directory ancestry prevent an alias from
 * making a credential-bearing saved tree look empty. */
export function verifyComputerTemplateSavedTree(value: unknown, snapshot: ComputerSnapshotIdentity): ComputerSavedTreeProof {
  const parsed = z.object({
    ok: z.literal(true), type: z.literal("snapshot.tree"), snapshotId: z.literal(snapshot.snapshotId),
    sandboxId: z.literal(snapshot.sourceSandboxId), treeAvailable: z.literal(true), truncated: z.literal(false),
    entries: z.array(z.object({ path: z.string().min(1).max(4096), kind: z.string().min(1).max(32),
      size: z.number().int().nonnegative().safe().optional() })).min(1).max(500_000),
  }).safeParse(value);
  if (!parsed.success) templateCaptureInvalid();
  const entries = new Map<string, { path: string; kind: string; size?: number | undefined }>();
  for (const entry of parsed.data.entries) {
    // Boat paths are POSIX: backslashes (including systemd's literal \\x2d)
    // are filename characters, never separators or escapes to normalize.
    const parts = entry.path.split("/");
    if (parts.some(part => !part || part === "." || part === "..") || [...entry.path].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || entries.has(entry.path))
      templateCaptureInvalid();
    entries.set(entry.path, entry);
  }
  const protectedPaths = [...emptyRoots, ...emptyFiles, ...filesRoots,
    ...["", "__system__/root/"].flatMap(home => privateHome.map(root => home + root))];
  for (const entry of entries.values()) {
    // An aliased parent can conceal private contents even when the listing
    // contains no child entries underneath that parent.
    if (entry.kind !== "dir" && protectedPaths.some(root => root.startsWith(`${entry.path}/`))) templateCaptureInvalid();
    let parent = entry.path;
    while (parent.includes("/")) {
      parent = parent.slice(0, parent.lastIndexOf("/"));
      const ancestor = entries.get(parent);
      if (ancestor && ancestor.kind !== "dir") templateCaptureInvalid();
    }
    const privatePath = ["", "__system__/root/"].some(home => {
      const relative = entry.path.startsWith(home) ? entry.path.slice(home.length) : null;
      return relative !== null && (privateHome.some(root => below(relative, root)) || /^\.env[^/]*(?:\/|$)/.test(relative));
    });
    const sanitizedFiles = filesRoots.some(root => below(entry.path, root) && !below(entry.path, `${root}/repos`));
    if (privatePath || sanitizedFiles || emptyRoots.some(root => below(entry.path, root)) || emptyFiles.some(root => below(entry.path, root))) {
      if (entry.kind !== "dir" && !(entry.kind === "file" && entry.size === 0)) templateCaptureInvalid();
    }
  }
  const manifest = entries.get("__system__/srv/zeros/computer-template.json");
  if (manifest?.kind !== "file" || !manifest.size) templateCaptureInvalid();
  const hash = createHash("sha256");
  for (const entry of [...entries.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    hash.update(JSON.stringify([entry.path, entry.kind, entry.size ?? null]) + "\n");
  return { schema: "zeros.computer-saved-tree/v1", snapshotId: snapshot.snapshotId,
    sourceSandboxId: snapshot.sourceSandboxId, treeSha256: hash.digest("hex"), entryCount: entries.size };
}

export class BoatComputerTemplateSnapshots implements ComputerTemplateSnapshotProvider {
  constructor(private readonly client: Pick<BoatApiClient, "request">, private readonly billingOrg: string,
    private readonly channel: ComputerSnapshotChannel) {}

  async assertStopped(sandboxId: string): Promise<void> {
    if (!BOAT_RESOURCE_ID_PATTERN.test(sandboxId)) templateCaptureInvalid();
    const reply = await this.client.request(`/sandboxes/${sandboxId}`);
    const parsed = z.object({ id: z.literal(sandboxId), state: z.literal("archived"), monitoring: z.literal(false),
      snapshotAvailable: z.literal(true), lastSnapshotStatus: z.literal("completed"),
      team: z.object({ id: z.string() }),
    }).safeParse(reply.sandbox);
    if (!parsed.success || parsed.data.team.id.toLowerCase() !== this.billingOrg.toLowerCase()) templateCaptureInvalid();
  }

  async get(name: string): Promise<ComputerNamedSnapshot | null> {
    if (!isComputerTemplateSnapshotName(name, this.channel)) templateCaptureInvalid();
    try {
      const reply = await this.client.request(`/named-snapshots/${name}`, { timeoutMs: 30_000 });
      const parsed = snapshotSchema.safeParse(reply.snapshot);
      if (!parsed.success || parsed.data.name !== name) templateCaptureInvalid();
      if (parsed.data.status === "ready" && (!parsed.data.snapshotId || !parsed.data.sizeBytes)) templateCaptureInvalid();
      return parsed.data;
    } catch (error) {
      if (notFound(error)) return null;
      throw error;
    }
  }

  /** Called once after a committed save intent. An ambiguous reply is resolved
   * by get(), never by repeating a POST that could replace the name. */
  async save(sandboxId: string, name: string): Promise<void> {
    if (!BOAT_RESOURCE_ID_PATTERN.test(sandboxId) || !isComputerTemplateSnapshotName(name, this.channel)) templateCaptureInvalid();
    const reply = await this.client.request("/named-snapshots", { method: "POST", body: { sandboxId, name }, timeoutMs: 60_000 });
    const parsed = snapshotSchema.safeParse(reply.snapshot);
    if (!parsed.success || parsed.data.name !== name || parsed.data.sourceSandboxId !== sandboxId || parsed.data.status === "failed")
      templateCaptureInvalid();
  }

  async prove(snapshot: ComputerSnapshotIdentity): Promise<ComputerSavedTreeProof> {
    if (!snapshotSchema.safeParse({ ...snapshot, status: "ready" }).success ||
        !isComputerTemplateSnapshotName(snapshot.name, this.channel)) templateCaptureInvalid();
    const tree = await this.client.request(`/snapshots/${snapshot.snapshotId}/tree`, { timeoutMs: 60_000, maxResponseBytes: 64 * 1024 * 1024 });
    const proof = verifyComputerTemplateSavedTree(tree, snapshot);
    // Re-read the name after proof. A switched alias cannot inherit evidence
    // belonging to the snapshot that used to occupy it.
    const current = await this.get(snapshot.name);
    if (!current || current.status !== "ready" || current.snapshotId !== snapshot.snapshotId ||
        current.sourceSandboxId !== snapshot.sourceSandboxId) templateCaptureInvalid();
    return proof;
  }

  async remove(snapshot: ComputerSnapshotIdentity): Promise<boolean> {
    const current = await this.get(snapshot.name);
    if (!current) return true;
    if (current.sourceSandboxId !== snapshot.sourceSandboxId || current.snapshotId !== snapshot.snapshotId) templateCaptureInvalid();
    if (current.status === "saving") return false;
    try {
      await this.client.request(`/named-snapshots/${snapshot.name}`, { method: "DELETE", confirmDelete: snapshot.name, timeoutMs: 60_000 });
    } catch (error) {
      if (!notFound(error)) throw error;
    }
    return await this.get(snapshot.name) === null;
  }
}
