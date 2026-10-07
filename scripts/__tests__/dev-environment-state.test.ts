import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureWorkspace, workspaceIdentity, acquireWorkspaceLock, readPrivateJson,
  saveWorkspace, systemEnvironment, writePrivateJson,
} from "../dev-environment/state.mjs";

const roots: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-development-"));
  roots.push(root);
  const homeDir = path.join(root, "home"), repositoryRoot = path.join(root, "checkout");
  fs.mkdirSync(homeDir); fs.mkdirSync(repositoryRoot);
  return { homeDir, repositoryRoot, env: {} };
}
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("persistent development workspace ownership", () => {
  it("opens receipts without a retired provider key and preserves historical receipt fields", () => {
    const f = fixture(), workspace = ensureWorkspace(f);
    const receipt = readPrivateJson(workspace.file);
    delete receipt.keys.provider;
    writePrivateJson(workspace.file, receipt);
    expect(ensureWorkspace(f).state.instanceId).toBe(workspace.state.instanceId);

    receipt.keys.provider = "ab".repeat(32);
    writePrivateJson(workspace.file, receipt);
    const historical = ensureWorkspace(f).state;
    expect(historical.instanceId).toBe(workspace.state.instanceId);
    expect(historical.keys.provider).toBe(receipt.keys.provider);
  });

  it("reuses data across restarts and aliases but isolates independent checkouts", () => {
    const f = fixture();
    const a = ensureWorkspace(f);
    const alias = path.join(f.homeDir, "alias"); fs.symlinkSync(f.repositoryRoot, alias);
    expect(ensureWorkspace({ ...f, repositoryRoot: alias }).state).toEqual(a.state);
    const other = path.join(f.homeDir, "other"); fs.mkdirSync(other);
    const b = ensureWorkspace({ ...f, repositoryRoot: other });
    expect(b.state.owner).not.toBe(a.state.owner);
    expect(b.state.database.runtimePassword).not.toBe(a.state.database.runtimePassword);
    expect(fs.statSync(a.file).mode & 0o777).toBe(0o600);
  });

  it("uses the same immutable Conductor owner for the cloud and synced Mac paths", () => {
    const f = fixture();
    const id = "a602a47c-cef0-44b6-bef6-8e81aa700a5c";
    const mac = path.join(f.homeDir, "conductor/remote-workspace-sync/Zeros", id);
    fs.mkdirSync(mac, { recursive: true });
    expect(workspaceIdentity(f.repositoryRoot, { CONDUCTOR_WORKSPACE_ID: id,
      CONDUCTOR_WORKSPACE_PATH: f.repositoryRoot }).owner).toBe(workspaceIdentity(mac, {}).owner);
  });

  it("ignores an inherited Conductor owner from another checkout", () => {
    const f = fixture();
    expect(workspaceIdentity(f.repositoryRoot, { CONDUCTOR_WORKSPACE_ID: "a602a47c-cef0-44b6-bef6-8e81aa700a5c",
      CONDUCTOR_WORKSPACE_PATH: f.homeDir }).owner).toBe(workspaceIdentity(f.repositoryRoot, {}).owner);
  });

  it("shares native Zeros workspace identity across paths and ignores an inherited owner", () => {
    const f = fixture(), id = "11111111-1111-4111-8111-111111111111";
    const other = path.join(f.homeDir, "other"); fs.mkdirSync(other);
    const env = { ZEROS_WORKSPACE_CANONICAL_ID: id, ZEROS_WORKSPACE_ROOT: f.repositoryRoot };
    const first = workspaceIdentity(f.repositoryRoot, env);
    expect(first.identity).toBe(`zeros:${id}`);
    expect(first.owner).toBe(workspaceIdentity(other, { ...env, ZEROS_WORKSPACE_ROOT: other }).owner);
    expect(workspaceIdentity(other, env).owner).toBe(workspaceIdentity(other, {}).owner);
    expect(systemEnvironment(env)).toEqual(env);
  });

  it("never initializes through a symlink to another environment", () => {
    const f = fixture();
    fs.symlinkSync(f.repositoryRoot, path.join(f.homeDir, ".zeros-dev"));
    expect(() => ensureWorkspace(f)).toThrow(/private|directory/i);
  });

  it("serializes launches and refuses to break a live owner's lock", () => {
    const state = ensureWorkspace(fixture());
    const release = acquireWorkspaceLock(state);
    expect(() => acquireWorkspaceLock(state)).toThrow(/already running/i);
    release();
    acquireWorkspaceLock(state)();
  });

  it.each(["run.lock", "mutation.lock"])("retries %s when its owner releases it during acquisition", name => {
    const workspace = ensureWorkspace(fixture());
    const lock = path.join(workspace.directory, name);
    const release = acquireWorkspaceLock(workspace, name);
    const link = fs.linkSync;
    let released = false;
    vi.spyOn(fs, "linkSync").mockImplementation((source, destination) => {
      try { return link(source, destination); }
      catch (error) {
        if (String(destination) === lock && !released) {
          released = true;
          release();
        }
        throw error;
      }
    });
    const successor = acquireWorkspaceLock(workspace, name);
    expect(released).toBe(true);
    expect(() => acquireWorkspaceLock(workspace, name)).toThrow(/already running/i);
    release();
    expect(fs.existsSync(lock)).toBe(true);
    successor();
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("retries a dependency lock released before its private-file validation", () => {
    const workspace = ensureWorkspace(fixture());
    const lock = path.join(workspace.directory, "mutation.lock");
    const release = acquireWorkspaceLock(workspace, "mutation.lock");
    const lstat = fs.lstatSync;
    let released = false;
    vi.spyOn(fs, "lstatSync").mockImplementation((file, options) => {
      if (String(file) === lock && !released) {
        released = true;
        release();
      }
      return lstat(file, options);
    });
    const successor = acquireWorkspaceLock(workspace, "mutation.lock");
    expect(released).toBe(true);
    successor();
  });

  it.each([false, 0, ""])("preserves malformed lock records instead of retrying them (%j)", record => {
    const workspace = ensureWorkspace(fixture());
    const lock = path.join(workspace.directory, "mutation.lock");
    writePrivateJson(lock, record);
    expect(() => acquireWorkspaceLock(workspace, "mutation.lock")).toThrow("Invalid development process lock; existing state was preserved");
    expect(readPrivateJson(lock)).toBe(record);
  });

  it("does not grant two launchers ownership when both recover the same dead process", () => {
    const w = ensureWorkspace(fixture());
    const lock = path.join(w.directory, "run.lock");
    writePrivateJson(lock, { owner: w.state.owner, pid: 2147483647, token: "dead-owner" });
    const unlink = fs.unlinkSync;
    let recovered = false, concurrentOwner = false;
    vi.spyOn(fs, "unlinkSync").mockImplementation(file => {
      if (String(file) === lock && !recovered) {
        recovered = true;
        try { acquireWorkspaceLock(w); concurrentOwner = true; } catch { /* Recovery is already owned. */ }
      }
      unlink(file);
    });
    const release = acquireWorkspaceLock(w);
    expect(concurrentOwner).toBe(false);
    release();
  });

  it("diagnoses incomplete private state without a property-access failure", () => {
    const f = fixture(), w = ensureWorkspace(f);
    const state = readPrivateJson(w.file); delete state.keys;
    writePrivateJson(w.file, state);
    expect(() => ensureWorkspace(f)).toThrow("Invalid development state; existing data was preserved");
  });

  it("preserves an archive fence across retries and refuses mismatched receipts", () => {
    const f = fixture(); const w = ensureWorkspace(f);
    w.state.status = "archiving"; saveWorkspace(w);
    expect(ensureWorkspace(f).state.status).toBe("archiving");
    const document = readPrivateJson(w.file); document.owner = "other";
    fs.writeFileSync(w.file, JSON.stringify(document));
    expect(() => ensureWorkspace(f)).toThrow(/ownership/i);
  });

  it("does not leak malformed private JSON or ambient server credentials", () => {
    const w = ensureWorkspace(fixture());
    fs.writeFileSync(w.file, '{"secret":"credential-sentinel');
    expect(() => readPrivateJson(w.file)).toThrow("Invalid private development JSON");
    const env = systemEnvironment({ PATH: "/bin", HOME: "/home/dev", DATABASE_URL: "private-db",
      WORKOS_API_KEY: "private-key", CLOUDFLARE_API_TOKEN: "cf-key", ZEROS_SHARED_SECRETS_DIR: "/alpha" });
    expect(env).toEqual({ PATH: "/bin", HOME: "/home/dev" });
  });
});

describe("hosted checkout binding", () => {
  it("accepts a synced copy only when the canonical managed workspace UUID proves the same owner", () => {
    const f = fixture(), id = "a602a47c-cef0-44b6-bef6-8e81aa700a5c";
    const cloud = workspaceIdentity(f.repositoryRoot, { CONDUCTOR_WORKSPACE_ID: id, CONDUCTOR_WORKSPACE_PATH: f.repositoryRoot });
    const mac = path.join(f.homeDir, "conductor/remote-workspace-sync/Zeros", id);
    fs.mkdirSync(path.dirname(mac), { recursive: true }); fs.cpSync(f.repositoryRoot, mac, { recursive: true });
    fs.chmodSync(path.join(mac, ".context/zeros-dev"), 0o700);
    expect(workspaceIdentity(mac, {}).owner).toBe(cloud.owner);
  });
  it("retains its owner after moving a checkout and rejects a copied binding", () => {
    const f = fixture();
    const first = workspaceIdentity(f.repositoryRoot, {});
    const moved = path.join(f.homeDir, "moved"); fs.renameSync(f.repositoryRoot, moved);
    expect(workspaceIdentity(moved, {}).owner).toBe(first.owner);
    const copied = path.join(f.homeDir, "copied"); fs.cpSync(moved, copied, { recursive: true });
    expect(() => workspaceIdentity(copied, {})).toThrow(/copied|adopt|binding/);
  });
  it("does not silently switch a pinned owner to a new manager", () => {
    const f = fixture();
    const first = workspaceIdentity(f.repositoryRoot, {});
    expect(() => workspaceIdentity(f.repositoryRoot, { CONDUCTOR_WORKSPACE_ID: "11111111-1111-4111-8111-111111111111", CONDUCTOR_WORKSPACE_PATH: f.repositoryRoot })).toThrow(/adopt/);
    expect(workspaceIdentity(f.repositoryRoot, {}).owner).toBe(first.owner);
  });
});
