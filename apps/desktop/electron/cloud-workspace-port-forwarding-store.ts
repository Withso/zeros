import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

export type CloudPortForwardingState = { forwardingEnabled: boolean; autoForwardEnabled: boolean };
export type CloudPortForwardingOwner = {
  accountId: string; deviceId: string; organizationId: string; workspaceId: string;
};
export const DEFAULT_CLOUD_PORT_FORWARDING: Readonly<CloudPortForwardingState> = Object.freeze({ forwardingEnabled: false, autoForwardEnabled: true });
const MAX_ENTRIES = 128;
const MAX_BYTES = 64 * 1024;
const entrySchema = z.object({
  accountHash: z.string().regex(/^[a-f0-9]{64}$/), deviceId: z.string().uuid(), organizationId: z.string().uuid(), workspaceId: z.string().uuid(),
  forwardingEnabled: z.boolean(), autoForwardEnabled: z.boolean(),
}).strict();
type Entry = z.infer<typeof entrySchema>;
const accountHash = (accountId: string) => createHash("sha256").update(accountId).digest("hex");
const key = (entry: Pick<Entry, "accountHash" | "deviceId" | "organizationId" | "workspaceId">) =>
  JSON.stringify([entry.accountHash, entry.deviceId, entry.organizationId, entry.workspaceId]);

/** Device-local intent only. No grants, runtime admissions, session IDs, or
 * credentials are persisted. Reading a default never enrolls or writes. */
export class CloudPortForwardingPreferences {
  private entries = new Map<string, Entry>();
  private readonly maxEntries: number;
  constructor(private readonly filePath: string, options: { maxEntries?: number } = {}) {
    this.maxEntries = options.maxEntries ?? MAX_ENTRIES;
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1 || this.maxEntries > MAX_ENTRIES) throw new Error("Invalid forwarding preference bound.");
    try {
      const metadata = lstatSync(filePath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_BYTES || metadata.uid !== process.getuid?.()) return;
      const document = z.object({ version: z.literal(1), entries: z.array(entrySchema).max(this.maxEntries) }).strict().parse(JSON.parse(readFileSync(filePath, "utf8")));
      for (const entry of document.entries) this.entries.set(key(entry), entry);
    } catch { /* Missing or invalid intent always defaults to forwarding off. */ }
  }
  private identity(owner: CloudPortForwardingOwner) {
    if (typeof owner.accountId !== "string" || !owner.accountId || owner.accountId.length > 2048) throw new Error("Invalid forwarding account.");
    return entrySchema.pick({ accountHash: true, deviceId: true, organizationId: true, workspaceId: true }).parse({
      accountHash: accountHash(owner.accountId), deviceId: owner.deviceId, organizationId: owner.organizationId, workspaceId: owner.workspaceId,
    });
  }
  read(owner: CloudPortForwardingOwner): Readonly<CloudPortForwardingState> {
    const entry = this.entries.get(key(this.identity(owner)));
    return entry ? { forwardingEnabled: entry.forwardingEnabled, autoForwardEnabled: entry.autoForwardEnabled } : DEFAULT_CLOUD_PORT_FORWARDING;
  }
  set(owner: CloudPortForwardingOwner, change: Partial<CloudPortForwardingState>): Readonly<CloudPortForwardingState> {
    const parsed = z.object({ forwardingEnabled: z.boolean().optional(), autoForwardEnabled: z.boolean().optional() }).strict().parse(change);
    const identity = this.identity(owner), previous = this.read(owner);
    const state: CloudPortForwardingState = {
      forwardingEnabled: parsed.forwardingEnabled ?? previous.forwardingEnabled,
      autoForwardEnabled: parsed.autoForwardEnabled ?? previous.autoForwardEnabled,
    };
    const next = new Map(this.entries);
    next.delete(key(identity));
    next.set(key(identity), { ...identity, ...state });
    while (next.size > this.maxEntries) next.delete(next.keys().next().value!);
    this.save(next);
    return state;
  }
  removeAccount(accountId: string): void {
    const hash = accountHash(accountId);
    this.prune(entry => entry.accountHash === hash);
  }
  removeWorkspace(target: { organizationId: string; workspaceId: string }): void {
    this.prune(entry => entry.organizationId === target.organizationId && entry.workspaceId === target.workspaceId);
  }
  private prune(matches: (entry: Entry) => boolean): void {
    const next = new Map([...this.entries].filter(([, entry]) => !matches(entry)));
    if (next.size !== this.entries.size) this.save(next);
  }
  private save(next: Map<string, Entry>): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify({ version: 1, entries: [...next.values()] })}\n`, { flag: "wx", mode: 0o600 });
      renameSync(temporary, this.filePath);
      this.entries = next;
    } finally { rmSync(temporary, { force: true }); }
  }
}
