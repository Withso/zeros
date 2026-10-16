import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rename, symlink, link, rm, chmod, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentFileStore, canonicalAgentFile } from "../zeros-dev/agent-file.mjs";
import { RunStore } from "../zeros-dev/receipts";
import { parseFixture } from "../zeros-dev/config";
import { createCloudReplicaDeviceCredential } from "../../apps/desktop/src/engine/cloud-replica-device";
import { runCli } from "../zeros-dev/cli";
import { closedError } from "../zeros-dev/errors";
import type { Services } from "../zeros-dev/commands";

const io = vi.hoisted(() => ({
  beforeOpen: undefined as undefined | ((file: string) => Promise<void>),
  afterOpen: undefined as undefined | ((file: string, handle: FileHandle) => Promise<void>),
  content: undefined as undefined | ((services: Services) => Promise<void>),
}));

vi.mock("node:fs/promises", async load => {
  const actual = await load<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      await io.beforeOpen?.(String(args[0]));
      const handle = await actual.open(...args);
      await io.afterOpen?.(String(args[0]), handle);
      return handle;
    },
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      await io.beforeOpen?.(String(args[0]));
      return actual.readFile(...args);
    },
  };
});

vi.mock("../zeros-dev/commands", async load => ({
  ...await load<typeof import("../zeros-dev/commands")>(),
  // Keep the real CLI initializer and its input boundary, without making any
  // product/auth calls in this filesystem-only regression.
  executeCommand: async (_command: unknown, services: Services) => {
    try { await io.content?.(services); return 0; }
    catch (error) { services.write({ schema: "zeros.dev-error/v1", code: closedError(error) }); return 1; }
  },
}));

const roots: string[] = [];
afterEach(async () => {
  io.beforeOpen = undefined; io.afterOpen = undefined; io.content = undefined;
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function repository() {
  const root = await mkdtemp(path.join(tmpdir(), "zeros-dev-files-")); roots.push(root);
  const secret = path.join(root, ".env.agent");
  await mkdir(path.join(root, ".git"), { mode: 0o700 });
  await writeFile(secret, "ZEROS_DEV_REFRESH_TOKEN=synthetic-original\n", { mode: 0o600 });
  return { root, secret };
}

async function linkedRepository() {
  const f = await repository(), checkout = path.join(f.root, "linked"), gitdir = path.join(f.root, ".git", "worktrees", "linked");
  await mkdir(checkout); await mkdir(gitdir, { recursive: true });
  const marker = path.join(checkout, ".git"), common = path.join(gitdir, "commondir");
  await writeFile(marker, `gitdir: ${gitdir}\n`, { mode: 0o600 });
  await writeFile(common, "../..\n", { mode: 0o600 });
  return { ...f, checkout, marker, common };
}

function replaceBeforeOpen(target: string, replacement: string) {
  io.beforeOpen = async file => {
    if (file !== target) return;
    io.beforeOpen = undefined;
    await rename(replacement, target);
  };
}

describe("zeros-dev validates the opened file, not an earlier pathname observation", () => {
  it("keeps ordinary Git shared-group markers compatible without relaxing private credentials", async () => {
    const f = await linkedRepository();
    await chmod(f.marker, 0o664); await chmod(f.common, 0o664);
    expect(await canonicalAgentFile(f.checkout)).toBe(f.secret);
    await chmod(f.secret, 0o660);
    await expect(new AgentFileStore(f.secret).read()).rejects.toThrow("zeros_dev_credentials_unsafe");
  });

  it.each([0o666, 0o777])("refuses unsafe Git metadata mode %s", async mode => {
    const f = await linkedRepository(); await chmod(f.marker, mode);
    await expect(canonicalAgentFile(f.checkout)).rejects.toThrow("zeros_dev_credentials_unsafe");
  });

  it("refuses a gitdir marker replaced with an alias immediately before its read", async () => {
    const f = await linkedRepository();
    io.beforeOpen = async file => {
      if (file !== f.marker) return;
      io.beforeOpen = undefined;
      const other = `${f.marker}.original`;
      await rename(f.marker, other); await symlink(other, f.marker);
    };
    await expect(canonicalAgentFile(f.checkout)).rejects.toThrow("zeros_dev_credentials_unsafe");
  });

  it("refuses a symlinked commondir even when its text points to the right repository", async () => {
    const f = await linkedRepository(), other = `${f.common}.original`;
    await rename(f.common, other); await symlink(other, f.common);
    await expect(canonicalAgentFile(f.checkout)).rejects.toThrow("zeros_dev_credentials_unsafe");
  });

  it("reads a safe atomic credential rotation that finished before open", async () => {
    const f = await repository(), replacement = `${f.secret}.next`;
    await writeFile(replacement, "ZEROS_DEV_REFRESH_TOKEN=synthetic-rotated\n", { mode: 0o600 });
    replaceBeforeOpen(f.secret, replacement);
    const result = await new AgentFileStore(f.secret).read();
    expect(result.values.ZEROS_DEV_REFRESH_TOKEN).toBe("synthetic-rotated");
  });

  it("still refuses credentials replaced after their descriptor was opened", async () => {
    const f = await repository(), replacement = `${f.secret}.next`;
    await writeFile(replacement, "ZEROS_DEV_REFRESH_TOKEN=synthetic-rotated\n", { mode: 0o600 });
    io.afterOpen = async file => {
      if (file === f.secret) { io.afterOpen = undefined; await rename(replacement, f.secret); }
    };
    await expect(new AgentFileStore(f.secret).read()).rejects.toThrow("zeros_dev_credentials_unsafe");
  });

  it("accepts only a valid signed receipt when atomic replacement finished before open", async () => {
    const f = await repository(), id = randomUUID();
    const fixture = parseFixture({ ZEROS_DEV_WORKOS_SUBJECT: "user_fixture", ZEROS_DEV_ACCOUNT_ID: randomUUID(),
      ZEROS_DEV_EMAIL: "fixture@example.test", ZEROS_DEV_ORGANIZATION_ID: randomUUID(), ZEROS_DEV_REPOSITORY: "test-owner/test-repo",
      ZEROS_DEV_REPOSITORY_ID: "1234", ZEROS_DEV_GITHUB_INSTALLATION_ID: randomUUID() });
    const credential = { ...createCloudReplicaDeviceCredential(fixture.accountId), deviceId: randomUUID() };
    const store = new RunStore(path.join(f.root, "runs"), fixture, credential);
    await store.withRun(id, { revision: "a".repeat(40), dirty: false }, async handle => handle.save());
    const file = path.join(f.root, "runs", `${id}.json`), replacement = `${file}.next`;
    await writeFile(replacement, await readFile(file), { mode: 0o600 });
    replaceBeforeOpen(file, replacement);
    await expect(store.read(id)).resolves.toMatchObject({ runId: id, deviceId: credential.deviceId });
    await writeFile(replacement, "invalid signature\n", { mode: 0o600 });
    replaceBeforeOpen(file, replacement);
    await expect(store.read(id)).rejects.toThrow("zeros_dev_receipt_invalid");
  });
});

describe.runIf(process.platform === "linux")("real Linux CLI input boundary", () => {
  async function inputFixture() {
    const f = await repository(), target = path.join(f.root, "prompt.txt"), rows: unknown[] = [];
    await writeFile(target, "synthetic prompt", { mode: 0o600 });
    let read = "";
    io.content = async services => { read = await services.content("prompt.txt", 1024); };
    return { ...f, target, rows, read: () => read, run: () => runCli(["whoami"], { cwd: f.root, write: row => rows.push(row) }) };
  }

  it("reads an ordinary owned prompt through the real service initializer", async () => {
    const f = await inputFixture();
    expect(await f.run()).toBe(0); expect(f.read()).toBe("synthetic prompt");
  });

  it("accepts an owned absolute script outside the checkout but refuses group-write permission",async()=>{
    const f=await inputFixture(),outside=await mkdtemp(path.join(tmpdir(),"zeros-dev-absolute-input-"));roots.push(outside);
    const script=path.join(outside,"check.sh");await writeFile(script,"printf synthetic-check",{mode:0o600});
    let read=false;io.content=async services=>{expect(await services.content(script,2048)).toBe("printf synthetic-check");read=true;};
    expect(await f.run()).toBe(0);expect(read).toBe(true);
    await chmod(script,0o664);read=false;
    expect(await f.run()).toBe(1);expect(read).toBe(false);
    expect(f.rows).toEqual([{schema:"zeros.dev-error/v1",code:"invalid_request"}]);
  });

  it.each(["canonical", "ancestor alias"])("refuses %s credential input across atomic rotation", async kind => {
    const f = await inputFixture(), replacement = `${f.secret}.next`;
    await writeFile(replacement, "ZEROS_DEV_REFRESH_TOKEN=synthetic-rotated\n", { mode: 0o600 });
    const alias = path.join(f.root, "credential-parent");
    if (kind === "ancestor alias") await symlink(f.root, alias);
    const input = kind === "canonical" ? f.secret : path.join(alias, ".env.agent");
    let returned = false, opens = 0;
    io.content = async services => { await services.content(input, 1024); returned = true; };
    io.beforeOpen = async file => {
      // The initializer and exclusion sample read credentials first. A normal
      // refresh replaces them immediately before the requested input is opened.
      if (file === f.secret) opens++;
      if ((kind === "canonical" && opens === 3) || file === path.join(alias, ".env.agent")) {
        io.beforeOpen = undefined;
        await rename(replacement, f.secret);
      }
    };
    expect(await f.run()).toBe(1); expect(returned).toBe(false);
    expect(f.rows).toEqual([{ schema: "zeros.dev-error/v1", code: "invalid_request" }]);
    expect(JSON.stringify(f.rows)).not.toContain("synthetic-rotated");
  });

  it("refuses an ancestor redirected to credentials immediately before input open", async () => {
    const f = await inputFixture(), safe = path.join(f.root, "safe"), alias = path.join(f.root, "input-parent");
    await mkdir(safe); await writeFile(path.join(safe, ".env.agent"), "ordinary input", { mode: 0o600 });
    await symlink(safe, alias);
    const input = path.join(alias, ".env.agent"), replacement = `${f.secret}.next`;
    await writeFile(replacement, "ZEROS_DEV_REFRESH_TOKEN=synthetic-rotated\n", { mode: 0o600 });
    let returned = false;
    io.content = async services => { await services.content(input, 1024); returned = true; };
    io.beforeOpen = async file => {
      if (file !== input) return;
      io.beforeOpen = undefined;
      await rename(replacement, f.secret); await rm(alias); await symlink(f.root, alias);
    };
    expect(await f.run()).toBe(1); expect(returned).toBe(false);
    expect(f.rows).toEqual([{ schema: "zeros.dev-error/v1", code: "invalid_request" }]);
  });

  it("refuses a hard-link alias created after the credential exclusion sample", async () => {
    const f = await inputFixture();
    io.beforeOpen = async file => {
      if (file !== f.target) return;
      io.beforeOpen = undefined;
      await rm(f.target); await link(f.secret, f.target);
    };
    expect(await f.run()).toBe(1); expect(f.read()).toBe("");
    expect(JSON.stringify(f.rows)).not.toContain("synthetic-original");
  });

  it("refuses a prompt made writable after open, before descriptor validation", async () => {
    const f = await inputFixture();
    io.afterOpen = async file => { if (file === f.target) await chmod(f.target, 0o666); };
    expect(await f.run()).toBe(1); expect(f.read()).toBe("");
    expect(f.rows).toEqual([{ schema: "zeros.dev-error/v1", code: "invalid_request" }]);
  });

  it("refuses replacement of the opened prompt before its read completes", async () => {
    const f = await inputFixture(), replacement = `${f.target}.next`;
    await writeFile(replacement, "different prompt", { mode: 0o600 });
    io.afterOpen = async file => {
      if (file === f.target) { io.afterOpen = undefined; await rename(replacement, f.target); }
    };
    expect(await f.run()).toBe(1); expect(f.read()).toBe("");
  });

  it.each(["alias", "credentials", "directory"])("refuses a %s input without printing its bytes", async kind => {
    const f = await inputFixture();
    await rm(f.target);
    if (kind === "alias") await symlink(f.secret, f.target);
    else if (kind === "directory") await mkdir(f.target);
    else io.content = async services => { await services.content(".env.agent", 1024); };
    expect(await f.run()).toBe(1);
    expect(JSON.stringify(f.rows)).not.toContain("synthetic-original");
  });
});
