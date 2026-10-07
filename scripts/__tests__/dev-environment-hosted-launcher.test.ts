import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const repository = path.resolve(import.meta.dirname, "../..");
const directories: string[] = [];
const moduleUrl = (name: string) => JSON.stringify(pathToFileURL(path.join(repository, "scripts/dev-environment", name)).href);

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

/** Exercise the real CLI with a private in-memory registry and clock. Provider
 * adapters are inert; lock acquisition, expiry, polling and signals stay real. */
function launch(action: string, mode = "remote") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-launcher-restart-"));
  directories.push(root);
  const directory = path.join(root, "scripts/dev-environment");
  fs.mkdirSync(directory, { recursive: true });
  const write = (name: string, source: string) => fs.writeFileSync(path.join(directory, name), source);
  const log = path.join(root, "events.jsonl");
  write("fixture.mjs", `
    import fs from 'node:fs';
    import { newHostedGeneration } from ${moduleUrl("hosted-state.mjs")};
    export const event = (name, value = {}) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ name, ...value }) + '\\n');
    export const mode = ${JSON.stringify(mode)};
    export const identity = { owner: 'a'.repeat(24), identity: 'launcher-test' };
    export let now = 1000;
    export const advance = async ms => {
      now += ms;
      if (mode === 'cancel') process.emit('SIGTERM');
    };
    const state = newHostedGeneration(identity, undefined, now);
    const generation = state.generation;
    state.resources.planetscale = { name: 'existing-dev-branch' };
    if (['remote', 'cancel', 'active'].includes(mode))
      state.lease = { token: 'previous-launch', expiresAt: now + (mode === 'active' ? 600000 : 120000) };
    let current = { state, etag: '1' }, revision = 1;
    export const store = {
      async read() { return structuredClone(current); },
      async write(owner, next, etag) {
        if (etag !== current.etag) throw Object.assign(new Error('conflict'), { code: 'DEV_REGISTRY_CONFLICT' });
        event('write', { at: now });
        current = { state: structuredClone(next), etag: String(++revision) };
        return current.etag;
      },
      close() {
        event('closed', { at: now, sameGeneration: current.state.generation === generation,
          database: current.state.resources.planetscale.name, leaseToken: current.state.lease?.token ?? null });
      }
    };
  `);
  write("state.mjs", `
    import path from 'node:path';
    import { event, identity, mode, now } from './fixture.mjs';
    export const workspaceIdentity = () => identity;
    export const developmentHome = () => ${JSON.stringify(root)};
    export const privateDirectory = (parent, name) => path.join(parent, name);
    export const systemEnvironment = () => ({});
    export const acquireWorkspaceLock = () => {
      if (mode === 'desktop') throw Object.assign(new Error('Zeros Dev is already running for this workspace'), { code: 'DEV_ALREADY_RUNNING' });
      event('desktop-lock');
      return () => event('desktop-unlock');
    };
    export async function withHostedMutation(directory, identity, operation) {
      if (mode === 'local' && now < 5000) throw Object.assign(new Error('previous process stopping'), { code: 'DEV_LOCAL_BUSY' });
      return operation();
    }
  `);
  write("hosted-state.mjs", `
    import { withHostedLease as acquire } from ${moduleUrl("hosted-state.mjs")};
    import { store, identity, now } from './fixture.mjs';
    export const r2Registry = () => store;
    export const resolveHostedOwner = async () => identity;
    export const selectHostedOwner = async () => identity;
    export const bindHostedProfile = () => {};
    export const adoptHostedOwner = () => {};
    export const hostedGcEligibility = () => ({});
    export const withHostedLease = (registry, owner, operation, options) =>
      acquire(registry, owner, operation, { ...options, now: () => now, heartbeat: false });
  `);
  write("provider-http.mjs", `
    import { pollProvider as poll } from ${moduleUrl("provider-http.mjs")};
    import { advance, now } from './fixture.mjs';
    export const pollProvider = (label, check, options) => poll(label, check, { ...options, now: () => now, delay: advance });
  `);
  write("hosted-lifecycle.mjs", `
    import { event, mode, now } from './fixture.mjs';
    export async function startHosted(lease) {
      event('start', { at: now });
      if (mode === 'failure') throw new Error('Provider access failed');
      lease.state.status = 'ready';
      return { reused: true };
    }
    export async function archiveHosted() { event('archive', { at: now }); return { archived: true }; }
  `);
  write("hosted-local.mjs", "export const cleanupHostedLocalState = () => true;");
  write("hosted-profile.mjs", `
    import { event } from './fixture.mjs';
    export const loadHostedProfile = () => { event('profile-read'); return { registry: {} }; };
    export const hostedDesktopEnvironment = () => ({});
    export const hostedPublicProfile = () => ({ apiOrigin: 'https://api.example.test' });
  `);
  write("hosted-services.mjs", "export const hostedServices = () => ({ removeLocalSources() {}, close() {} });");
  write("hosted-agent-monitor.mjs", `
    import { mode } from './fixture.mjs';
    import { refuseRetiredDevNativeCanary } from './native-agent-retirement.mjs';
    export const monitorHostedAgents = async () => { if (mode === 'retired-monitor') refuseRetiredDevNativeCanary(); };
  `);
  write("hosted-reconcile.mjs", "export const reconcileHosted = async () => ({ complete: true });");
  write("hosted-doctor.mjs", "export const hostedDiagnostic = () => ({}); export const inspectHostedLive = async () => ({});");
  write("processes.mjs", `
    import { event } from './fixture.mjs';
    export const run = async (command, args, options) => { event('run', { label: options.label }); };
    export const withDevPortRetry = async operation => operation(0);
  `);
  write("platform.mjs", "Object.defineProperty(process, 'platform', { value: 'darwin' });");
  fs.copyFileSync(path.join(repository, "scripts/dev-environment/native-agent-retirement.mjs"), path.join(directory, "native-agent-retirement.mjs"));
  fs.copyFileSync(path.join(repository, "scripts/dev-environment/hosted-launcher.mjs"), path.join(directory, "hosted-launcher.mjs"));
  const result = spawnSync(process.execPath, ["--import", path.join(directory, "platform.mjs"), path.join(directory, "hosted-launcher.mjs"), action, "--once"],
    { cwd: root, encoding: "utf8", timeout: 5000 });
  const events = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  return { ...result, events };
}

describe("hosted Dev launcher restart", () => {
  it("refuses explicit agents intent before reading a profile, registry or lease", () => {
    const result = launch("agents");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("v3 release worker images are retired; v4 runtime bundles are the supported artifact");
    expect(result.events).toEqual([]);
  });
  it.each(["start", "backend"])("preserves %s when its optional native monitor reports retirement", action => {
    const result = launch(action, "retired-monitor");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("release_worker_images_retired");
    expect(result.stdout).toContain("v3 release worker images are retired; v4 runtime bundles are the supported artifact");
    expect(result.events.filter(event => event.name === "start")).toHaveLength(1);
    expect(result.events.find(event => event.name === "closed")).toMatchObject({ sameGeneration: true, database: "existing-dev-branch", leaseToken: null });
  });
  it.each(["start", "backend"])("%s waits for an interrupted launch's lease without replacing its generation", action => {
    const result = launch(action);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/waiting.*previous.*dev/i);
    expect(result.events.find(event => event.name === "write").at).toBeGreaterThanOrEqual(121000);
    expect(result.events.filter(event => event.name === "start")).toEqual([{ name: "start", at: 121000 }]);
    expect(result.events.find(event => event.name === "closed")).toMatchObject({ sameGeneration: true, database: "existing-dev-branch", leaseToken: null });
    if (action === "start") expect(result.events.filter(event => event.name === "desktop-lock")).toHaveLength(1);
  });

  it("waits for the previous local process to release its mutation lock", () => {
    const result = launch("start", "local");
    expect(result.status, result.stderr).toBe(0);
    expect(result.events.find(event => event.name === "start").at).toBe(5000);
  });

  it("cancels a waiting restart without changing the previous lease", () => {
    const result = launch("start", "cancel");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("interrupted");
    expect(result.events.some(event => ["write", "start", "run"].includes(event.name))).toBe(false);
    expect(result.events.find(event => event.name === "closed").leaseToken).toBe("previous-launch");
    expect(result.events.filter(event => event.name === "desktop-unlock")).toHaveLength(1);
  });

  it("bounds the wait without taking over an active lease", () => {
    const result = launch("start", "active");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("has not completed");
    expect(result.events.some(event => ["write", "start"].includes(event.name))).toBe(false);
    expect(result.events.find(event => event.name === "closed")).toMatchObject({ at: 181000, leaseToken: "previous-launch" });
  });

  it("keeps archive's existing wait for an interrupted lease", () => {
    const result = launch("archive");
    expect(result.status, result.stderr).toBe(0);
    expect(result.events.filter(event => event.name === "archive")).toEqual([{ name: "archive", at: 121000 }]);
  });

  it("does not replace a desktop that is still running", () => {
    const result = launch("start", "desktop");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("already running");
    expect(result.events.some(event => ["write", "start", "run"].includes(event.name))).toBe(false);
  });

  it("does not retry a provider failure after acquiring the lease", () => {
    const result = launch("start", "failure");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Provider access failed");
    expect(result.events.filter(event => event.name === "start")).toHaveLength(1);
    expect(result.events.find(event => event.name === "closed").leaseToken).toBeNull();
  });
});
