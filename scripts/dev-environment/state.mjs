import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const HEX_SECRET = /^[a-f0-9]{64}$/;
export const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/** A branch name is display metadata. Conductor's cloud and synced Mac copies
 * share a UUID; standalone checkouts use their canonical filesystem identity. */
export function workspaceIdentity(repositoryRoot, env = process.env) {
  const root = fs.realpathSync(repositoryRoot);
  if (UUID.test(env.ZEROS_WORKSPACE_CANONICAL_ID ?? "") && env.ZEROS_WORKSPACE_ROOT) {
    try {
      if (fs.realpathSync(env.ZEROS_WORKSPACE_ROOT) === root) {
        const identity = `zeros:${env.ZEROS_WORKSPACE_CANONICAL_ID.toLowerCase()}`;
        return { owner: sha256(identity).slice(0, 24), identity, repositoryRoot: root };
      }
    } catch { /* A parent app's workspace cannot identify a nested checkout. */ }
  }
  let conductorId;
  if (UUID.test(env.CONDUCTOR_WORKSPACE_ID ?? "") && env.CONDUCTOR_WORKSPACE_PATH) {
    try {
      if (fs.realpathSync(env.CONDUCTOR_WORKSPACE_PATH) === root) conductorId = env.CONDUCTOR_WORKSPACE_ID;
    } catch { /* An inherited terminal identity does not identify this checkout. */ }
  }
  if (!conductorId && UUID.test(path.basename(root)) &&
      path.basename(path.dirname(path.dirname(root))) === "remote-workspace-sync") {
    conductorId = path.basename(root);
  }
  const identity = conductorId ? `conductor:${conductorId.toLowerCase()}` : `checkout:${root}`;
  return { owner: sha256(identity).slice(0, 24), identity, repositoryRoot: root };
}

function assertEntry(file, directory, root = false) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
      (stat.mode & (root ? 0o022 : 0o077)) !== 0) {
    throw new Error("Development state requires private, user-owned files and directories");
  }
  return stat;
}

export function privateDirectory(parent, name, root = false) {
  if (path.basename(name) !== name || name === "." || name === "..") throw new Error("Invalid development directory");
  const directory = path.join(parent, name);
  try { fs.mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  assertEntry(directory, true, root);
  return directory;
}

export function developmentHome(homeDir = os.homedir()) {
  return privateDirectory(fs.realpathSync(homeDir), ".zeros-dev", true);
}

export function readPrivateJson(file) {
  assertEntry(file, false);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 128 * 1024 || (stat.mode & 0o077) !== 0 ||
        (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
      throw new Error("Invalid private development file");
    }
    try { return JSON.parse(fs.readFileSync(fd, "utf8")); }
    catch { throw new Error("Invalid private development JSON"); }
  } finally { fs.closeSync(fd); }
}

export function writePrivateFile(file, value, { create = false } = {}) {
  assertEntry(path.dirname(file), true, true);
  if (fs.existsSync(file)) assertEntry(file, false);
  const temporary = path.join(path.dirname(file), `.${randomUUID()}.tmp`);
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(fd, value); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    if (create) {
      try { fs.linkSync(temporary, file); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
    } else fs.renameSync(temporary, file);
    const parent = fs.openSync(path.dirname(file), "r");
    try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
  } finally { fs.rmSync(temporary, { force: true }); }
}

export function writePrivateJson(file, value, options) {
  writePrivateFile(file, JSON.stringify(value, null, 2) + "\n", options);
}

function validateState(state, identity) {
  if (state?.version !== 1 || state.owner !== identity.owner || state.identity !== identity.identity) {
    throw new Error("Development state ownership mismatch; existing data was preserved");
  }
  if (!UUID.test(state.instanceId ?? "") || !["active", "archiving", "archived"].includes(state.status) ||
      state.database?.name !== `zeros_dev_${identity.owner}` || state.database.major !== 18 ||
      ![state.database.adminPassword, state.database.migrationPassword, state.database.runtimePassword,
        state.keys?.cookie, state.keys?.settings, state.keys?.objects, state.keys?.provider, state.keys?.agent].every(v => HEX_SECRET.test(v ?? "")) ||
      !/^[A-Za-z0-9+/]{43}=$/.test(state.tunnel?.secret ?? "") ||
      state.tunnel.name !== `zeros-dev-${state.owner}-${state.instanceId.slice(0, 8)}`) {
    throw new Error("Invalid development state; existing data was preserved");
  }
  return state;
}

export function ensureWorkspace({ repositoryRoot, homeDir = os.homedir(), env = process.env }) {
  const identity = workspaceIdentity(repositoryRoot, env);
  const directory = privateDirectory(privateDirectory(developmentHome(homeDir), "environments"), identity.owner);
  const file = path.join(directory, "workspace.json");
  if (!fs.existsSync(file)) {
    const secret = () => randomBytes(32).toString("hex");
    const instanceId = randomUUID();
    writePrivateJson(file, {
      version: 1, ...identity, instanceId, status: "active", createdAt: new Date().toISOString(),
      database: { name: `zeros_dev_${identity.owner}`, major: 18,
        adminPassword: secret(), migrationPassword: secret(), runtimePassword: secret() },
      keys: { cookie: secret(), settings: secret(), objects: secret(), provider: secret(), agent: secret() },
      tunnel: { name: `zeros-dev-${identity.owner}-${instanceId.slice(0, 8)}`,
        secret: randomBytes(32).toString("base64"), id: null, dns: [] },
    }, { create: true });
  }
  return { file, directory, state: validateState(readPrivateJson(file), identity) };
}

export function saveWorkspace(workspace) {
  validateState(workspace.state, workspace.state);
  const current = readPrivateJson(workspace.file);
  if (current.owner !== workspace.state.owner || current.instanceId !== workspace.state.instanceId) {
    throw new Error("Development receipt ownership changed");
  }
  writePrivateJson(workspace.file, workspace.state);
}

/** Atomic publication avoids partially written lock records. Stale locks are
 * recovered only for an exited PID; malformed locks require manual inspection. */
export function acquireWorkspaceLock(workspace) {
  const file = path.join(workspace.directory, "run.lock");
  const token = randomUUID();
  const record = { pid: process.pid, token, owner: workspace.state.owner };
  for (let attempt = 0; attempt < 3; attempt++) {
    writePrivateJson(file, record, { create: true });
    const current = readPrivateJson(file);
    if (current.token === token) return () => {
      if (fs.existsSync(file) && readPrivateJson(file).token === token) fs.unlinkSync(file);
    };
    if (!Number.isInteger(current.pid) || current.pid < 1 || current.owner !== workspace.state.owner) {
      throw new Error("Invalid development process lock; existing state was preserved");
    }
    try { process.kill(current.pid, 0); }
    catch (error) {
      if (error.code === "ESRCH") {
        // Checking again is insufficient: two recoverers can both observe the
        // dead owner, then one unlinks the other's newly published live lock.
        // Only one process may retire a particular abandoned generation.
        const recovery = path.join(workspace.directory, `recovery-${sha256(String(current.token))}.lock`);
        let fd;
        try { fd = fs.openSync(recovery, "wx", 0o600); }
        catch { throw new Error("Development lock recovery is already in progress; retry after it completes"); }
        try {
          if (fs.existsSync(file) && readPrivateJson(file).token === current.token) fs.unlinkSync(file);
        } finally { fs.closeSync(fd); fs.unlinkSync(recovery); }
        continue;
      }
    }
    throw Object.assign(new Error("Zeros Dev is already running for this workspace"), { code: "DEV_ALREADY_RUNNING" });
  }
  throw new Error("Could not acquire the development workspace lock");
}

/** Do not inherit an Alpha DSN, migration authority or provider credential into
 * any Dev child. Server secrets are supplied separately to the API only. */
export function systemEnvironment(source = process.env) {
  const keys = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL",
    "TERM", "COLORTERM", "DISPLAY", "XDG_RUNTIME_DIR", "SSH_AUTH_SOCK", "PNPM_HOME", "NVM_BIN", "COREPACK_HOME",
    "CONDUCTOR_WORKSPACE_ID", "CONDUCTOR_WORKSPACE_PATH", "CONDUCTOR_ROOT_PATH", "CONDUCTOR_IS_LOCAL", "CONDUCTOR_PORT",
    "ZEROS_WORKSPACE_CANONICAL_ID", "ZEROS_WORKSPACE_ROOT"];
  return Object.fromEntries(keys.filter(key => source[key] !== undefined).map(key => [key, source[key]]));
}
