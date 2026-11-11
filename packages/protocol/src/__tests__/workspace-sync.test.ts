import { describe, expect, it } from "vitest";
import { CloudV2ControlFrameSchema } from "../cloud-v2-relay";
import { SYNC_PASSIVE_OPS, SyncBootstrapReplySchema, SyncBootstrapRequestSchema, SyncBundleReadRequestSchema, SyncGrantReplySchema, SyncReadRequestSchema, SyncRenewFrameSchema, SyncSnapshotReplySchema, SyncSnapshotRequestSchema, isSyncLinkTarget, isSyncPath } from "../workspace-sync";

const epoch = "6b0c0a2e-1f3a-4b5c-8d6e-7f8091a2b3c4", sha = "a".repeat(64);
const entry = { path: "src/app.ts", size: 3, mode: 0o644, mtimeMs: 1, sha256: sha };

describe("Order 3 sync wire", () => {
  it("accepts only checkout-relative paths, never .git, .zeros-sync, traversal or absolute", () => {
    for (const ok of ["a", "src/app.ts", ".github/workflows/ci.yml", "dir/.gitignore", "é/ü.txt"]) expect(isSyncPath(ok), ok).toBe(true);
    for (const bad of ["", "/etc/passwd", "../x", "a/../b", "a//b", "./a", "a/.", ".git/config", "sub/.git/HEAD", ".zeros-sync/state.json", "a\0b", "a\\b", "x".repeat(4097)])
      expect(isSyncPath(bad), JSON.stringify(bad).slice(0, 30)).toBe(false);
  });
  it("bounds snapshot requests and replies: either a full page or changes, paging only a full inventory", () => {
    expect(SyncSnapshotRequestSchema.safeParse({ epoch, seq: 3 }).success).toBe(true);
    expect(SyncSnapshotRequestSchema.safeParse({ epoch, seq: -1 }).success).toBe(false);
    expect(SyncSnapshotRequestSchema.safeParse({ path: "x" }).success).toBe(false);
    expect(SyncSnapshotReplySchema.safeParse({ epoch, seq: 0, full: [entry], nextPage: "t:1" }).success).toBe(true);
    expect(SyncSnapshotReplySchema.safeParse({ epoch, seq: 1, changes: [entry], deletes: ["old.ts"] }).success).toBe(true);
    expect(SyncSnapshotReplySchema.safeParse({ epoch, seq: 1, full: [entry], changes: [entry] }).success).toBe(false);
    expect(SyncSnapshotReplySchema.safeParse({ epoch, seq: 1, changes: [entry], nextPage: "t:1" }).success).toBe(false);
    expect(SyncSnapshotReplySchema.safeParse({ epoch, seq: 1, changes: [{ ...entry, size: 100 * 1024 * 1024 + 1 }] }).success).toBe(false);
    expect(SyncSnapshotReplySchema.safeParse({ epoch, seq: 1, changes: [{ ...entry, mode: 0o4755 }] }).success).toBe(false);
    expect(SyncSnapshotReplySchema.safeParse({ epoch, seq: 0, stopped: "too_many_files" }).success).toBe(true);
  });
  it("reads at most 4 MiB, bound to a sha256", () => {
    expect(SyncReadRequestSchema.safeParse({ path: "a", sha256: sha, offset: 0, length: 4 * 1024 * 1024 }).success).toBe(true);
    expect(SyncReadRequestSchema.safeParse({ path: "a", sha256: sha, offset: 0, length: 4 * 1024 * 1024 + 1 }).success).toBe(false);
    expect(SyncReadRequestSchema.safeParse({ path: "a", sha256: "short", offset: 0, length: 1 }).success).toBe(false);
  });
  it("shapes the direct path: a grant reply for an https route base, the renew frame, and exactly four passive ops", () => {
    const reply = { url: "https://route.example.test/", portAuth: "p".repeat(16), grant: "v1.abc.def", expiresAt: "2026-11-11T00:00:00Z" };
    expect(SyncGrantReplySchema.parse(reply)).toEqual(reply);
    for (const url of ["http://route.example.test/", "https://route.example.test/path", "https://u:p@route.example.test/", "https://route.example.test/?q=1"])
      expect(SyncGrantReplySchema.safeParse({ ...reply, url }).success, url).toBe(false);
    expect(SyncGrantReplySchema.safeParse({ ...reply, grant: "bearer x" }).success).toBe(false);
    expect(SyncRenewFrameSchema.safeParse({ t: "renew", grant: "v1.abc.def" }).success).toBe(true);
    expect(SyncRenewFrameSchema.safeParse({ t: "renew", grant: "v1.abc.def", dev: "x" }).success).toBe(false);
    expect([...SYNC_PASSIVE_OPS]).toEqual(["sync.snapshot", "sync.read", "sync.bootstrap", "sync.bundleRead"]);
  });
  it("carries the cloud HEAD in a snapshot and bounds the bootstrap and bundle reads", () => {
    const head = { branch: "workspace/fix-login", sha: "a".repeat(40) };
    expect(SyncSnapshotReplySchema.safeParse({ epoch, seq: 0, full: [], head }).success).toBe(true);
    for (const branch of ["-x", "a..b", "a b", "x.lock", "a/", "@{u}"]) expect(SyncSnapshotReplySchema.safeParse({ epoch, seq: 0, full: [], head: { ...head, branch } }).success, branch).toBe(false);
    expect(SyncBootstrapRequestSchema.safeParse({ have: "b".repeat(40) }).success).toBe(true);
    expect(SyncBootstrapRequestSchema.safeParse({ have: "HEAD~1" }).success).toBe(false);
    const bundle = { id: epoch, size: 10, sha256: sha, full: true };
    expect(SyncBootstrapReplySchema.safeParse({ branch: "main", head: head.sha, remoteUrl: null, bundle }).success).toBe(true);
    expect(SyncBootstrapReplySchema.safeParse({ branch: "main", head: head.sha, remoteUrl: null }).success).toBe(true);
    expect(SyncBundleReadRequestSchema.safeParse({ id: epoch, offset: 0, length: 4 * 1024 * 1024 + 1 }).success).toBe(false);
  });
  it("mirrors a link only inside the root, never to the root itself, .git or .zeros-sync", () => {
    expect(isSyncLinkTarget("a/b/link", "../c")).toBe(true);
    for (const [link, target] of [["a/link", "../../x"], ["link", "/etc"], ["a/link", "../.git/config"], ["a/link", ".."], ["link", "."], ["link", ".zeros-sync/state.json"]])
      expect(isSyncLinkTarget(link!, target!), `${link} -> ${target}`).toBe(false);
  });
  it("marks a passive open as an optional literal, so older control planes' frames still parse", () => {
    const clientId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    expect(CloudV2ControlFrameSchema.safeParse({ t: "open", clientId }).success).toBe(true);
    expect(CloudV2ControlFrameSchema.safeParse({ t: "open", clientId, passive: true }).success).toBe(true);
    expect(CloudV2ControlFrameSchema.safeParse({ t: "open", clientId, passive: false }).success).toBe(false);
  });
});

describe("Git and sync metadata names on case-insensitive volumes (APFS, HFS+, NTFS)", () => {
  it("refuses every spelling of .git and .zeros-sync that such a volume or Git itself treats as the same name", () => {
    for (const path of [".GIT/x", ".Git/config", "a/.Git/x", "a/.GIT/hooks/pre-commit", ".g‌it/x", ".gi﻿t/hooks/x", ".git‏/x", "GIT~1/x",
      ".git./x", ".git /x", ".ZEROS-SYNC/x", ".Zeros-Sync/state.json", ".zeros‌-sync/x", ".context/x/.GIT/config", ".git\u202A/x", ".GIT\u206F/x"])
      expect(isSyncPath(path), JSON.stringify(path)).toBe(false);
    // Ordinary names that only look alike stay allowed.
    for (const path of ["a/.gitignore", ".github/x", "git/x", "a/.gitkeep", "zeros-sync/x", "a/.zeros-sync/x", ".context/notes.md"]) expect(isSyncPath(path), path).toBe(true);
  });
  it("refuses a link whose target resolves into any spelling of .git or the root's .zeros-sync", () => {
    for (const [link, target] of [["dir/a", "../.GIT/hooks"], ["a", ".Git/config"], ["dir/a", "../.g‌it"], ["a", ".ZEROS-SYNC/state.json"], ["a", "GIT~1/hooks"]])
      expect(isSyncLinkTarget(link!, target!), `${link} -> ${target}`).toBe(false);
    expect(isSyncLinkTarget("dir/a", "../.github/workflows")).toBe(true);
  });
});

describe("the remote URL a bootstrap names", () => {
  it("accepts only credential-free https, ssh with an optional git user, and scp-like git@host:path", async () => {
    const { isSafeRemoteUrl, SyncBootstrapReplySchema: schema } = await import("../workspace-sync");
    for (const url of ["https://github.com/o/r.git", "https://git.example.test:8443/group/sub/r", "ssh://git@github.com/o/r.git", "ssh://github.com:2222/o/r", "git@github.com:o/r.git"])
      expect(isSafeRemoteUrl(url), url).toBe(true);
    for (const url of ["ext::sh -c touch% /tmp/pwned", "file:///etc", "fd::3", "http://github.com/o/r", "https://x-access-token:t@github.com/o/r", "https://user@github.com/o/r",
      "https://github.com/o/r?x=1", "https://github.com/o/r#y", "https://-github.com/o/r", "https://github.com/o r", "https://github.com/o/r\n", "ssh://root@github.com/o/r",
      "root@github.com:o/r", "git@github.com:-o/r", "git@-github.com:o/r", "--upload-pack=x", "https://github.com", ""])
      expect(isSafeRemoteUrl(url), JSON.stringify(url)).toBe(false);
    // Unsafe in a reply becomes null (origin left unset), never a string the Mac would write.
    const reply = (remoteUrl: unknown) => schema.parse({ branch: "main", head: "a".repeat(40), remoteUrl });
    expect(reply("ext::sh -c x").remoteUrl).toBeNull();
    expect(reply("https://github.com/o/r.git").remoteUrl).toBe("https://github.com/o/r.git");
  });
});
