import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, lstatSync, fstatSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const manifestRace = vi.hoisted(() => ({ file: "", replacement: "", descriptor: undefined as number | undefined, vanish: "", foreignConfig: "" }));
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  const replace = () => { actual.renameSync(manifestRace.replacement, manifestRace.file); manifestRace.file = ""; };
  return { ...actual,
    lstatSync: (file: string) => {
      // Git removes a transient lock between the directory read and this stat.
      if (manifestRace.vanish && file.endsWith(manifestRace.vanish)) { actual.rmSync(file); manifestRace.vanish = ""; }
      const stat = actual.lstatSync(file);
      if (file === manifestRace.file) replace();
      return stat;
    },
    fstatSync: (descriptor: number) => {
      const stat = actual.fstatSync(descriptor);
      if (manifestRace.foreignConfig) {
        const config = actual.lstatSync(manifestRace.foreignConfig);
        // Explicit fake descriptor ownership: the template check saw the
        // admitted owner, but the file opened for sanitation changed owner.
        if (stat.dev === config.dev && stat.ino === config.ino) stat.uid++;
      }
      if (manifestRace.file) {
        const target = actual.lstatSync(manifestRace.file);
        if (stat.dev === target.dev && stat.ino === target.ino) {
          manifestRace.descriptor = descriptor;
          replace();
        }
      }
      return stat;
    },
  };
});
import {
  checkoutCloudComputerPrimary,
  createCloudComputerWorkspaceAdmission,
  readCloudComputerWorkspaceAdmission,
  cloudComputerHostRepository,
  parseCloudComputerSetup,
  verifyCloudComputerTemplate,
  verifyCloudComputerRepositoryOrigin,
} from "../cloud-workspace-validation/sandbox/cloud-computer-checkout.mjs";

const buildId = "11111111-1111-4111-8111-111111111111";
const configId = "22222222-2222-4222-8222-222222222222";
const token = "fixture-transient-read-token";
const directories: string[] = [];
afterEach(() => {
  manifestRace.file = "";
  manifestRace.descriptor = undefined;
  manifestRace.vanish = "";
  manifestRace.foreignConfig = "";
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "zeros-v2-test-checkout-"));
  directories.push(root);
  const filesRoot = path.join(root, "files"), reposRoot = path.join(filesRoot, "repos");
  const target = path.join(filesRoot, "workspace");
  mkdirSync(reposRoot, { recursive: true });
  const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd,
    env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" },
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const repositories = ["primary", "secondary"].map((name, index) => {
    const directory = path.join(reposRoot, "fixture", name);
    mkdirSync(directory, { recursive: true });
    git(directory, ["init", "--quiet"]);
    writeFileSync(path.join(directory, "source.txt"), name);
    git(directory, ["add", "."]);
    git(directory, ["commit", "--quiet", "-m", "Fixture"]);
    git(directory, ["remote", "add", "origin", `https://github.com/fixture/${name}.git`]);
    return { id: String(index + 123), owner: "fixture", name, sha: git(directory, ["rev-parse", "HEAD"]) };
  });
  const template = { schema: "zeros.computer-template/v1", buildId, configId, baseImageId: "zeros-v2-test-base",
    runtimeId: `r1-${"a".repeat(64)}`, baseCompatibilityId: `bc1-${"b".repeat(64)}`,
    protectedContractDigest: "c".repeat(64), repositoryManifest: repositories };
  const templateFile = path.join(root, "computer-template.json");
  writeFileSync(templateFile, JSON.stringify(template), { mode: 0o444 });
  const computer = { template, primaryRepositoryId: "123", requestedRevision: "feature/workspace" };
  const repository = { forge: "github.com", owner: "fixture", name: "primary", revision: repositories[0]!.sha,
    cloneUrl: "https://github.com/fixture/primary.git", credential: { token, username: "x-access-token", expiresAtMs: Date.now() + 3_600_000 } };
  const source = path.join(reposRoot, "fixture/primary");
  const options = { filesRoot, templateFile, rootUid: process.getuid!(), workerUid: process.getuid!(), workerGid: process.getgid!(),
    readMountInfo: () => "" };
  return { root, filesRoot, reposRoot, templateFile, source, target, template, computer, repository, options, git };
}

describe("Cloud Computer fork checkout", () => {
  it("fetches source and target ancestry from a shallow template so their merge-base exists", async () => {
    const f = fixture();
    f.git(f.source, ["branch", "-M", "main"]);
    const base = f.git(f.source, ["rev-parse", "HEAD"]);
    f.git(f.source, ["checkout", "-b", "feature/topic"]);
    for (let i = 0; i < 4; i++) f.git(f.source, ["commit", "--allow-empty", "-m", `Feature ${i}`]);
    const head = f.git(f.source, ["rev-parse", "HEAD"]);
    f.git(f.source, ["checkout", "main"]);
    for (let i = 0; i < 3; i++) f.git(f.source, ["commit", "--allow-empty", "-m", `Main ${i}`]);
    const target = f.git(f.source, ["rev-parse", "HEAD"]);
    const remote = path.join(f.root, "remote.git");
    f.git(f.root, ["clone", "--bare", "--no-hardlinks", f.source, remote]);
    rmSync(f.source, { recursive: true });
    f.git(f.root, ["clone", "--depth=1", "--branch=main", `file://${remote}`, f.source]);
    f.git(f.source, ["remote", "set-url", "origin", f.repository.cloneUrl]);
    f.template.repositoryManifest[0]!.sha = target;
    rmSync(f.templateFile);
    writeFileSync(f.templateFile, JSON.stringify(f.template), { mode: 0o444 });
    const repository = { ...f.repository, revision: head };
    const computer = { ...f.computer, requestedRevision: "feature/topic", checkoutSource: {
      kind: "branch", revision: head, headBranch: "feature/topic", targetBranch: "main", pullRequest: null,
    } };
    const git = vi.fn(async (directory: string, args: string[]) => f.git(directory,
      args[0] === "fetch" ? args.map(arg => arg === "origin" ? `file://${remote}` : arg) : args));
    await checkoutCloudComputerPrimary(computer, repository, { ...f.options, git, verifyOrigin: async () => {} });
    expect(f.git(f.source, ["rev-parse", "--is-shallow-repository"])).toBe("false");
    expect(f.git(f.source, ["rev-parse", "origin/main"])).toBe(target);
    expect(f.git(f.source, ["merge-base", "HEAD", "origin/main"])).toBe(base);
    expect(Number(f.git(f.source, ["rev-list", "--count", "HEAD", "origin/main"]))).toBe(8);
    expect(git.mock.calls.find(([, args]) => args[0] === "fetch")?.[1]).not.toContain("--depth=1");
  });

  it.each(["time", "size"])("falls back to bounded history after the %s guard, leaving an observable shallow checkout", async limit => {
    const f = fixture();
    let fetches = 0;
    const git = vi.fn(async (directory: string, args: string[], _token?: string, options?: { signal: AbortSignal }) => {
      if (args[0] !== "fetch") return f.git(directory, args);
      fetches++;
      if (fetches === 1) {
        if (limit === "size") writeFileSync(path.join(f.source, ".git/objects/pack/tmp_pack_fixture"), Buffer.alloc(2048));
        await new Promise((_resolve, reject) => options?.signal.addEventListener("abort", () => {
          rmSync(path.join(f.source, ".git/objects/pack/tmp_pack_fixture"), { force: true });
          reject(new Error("fetch interrupted"));
        }, { once: true }));
      }
      writeFileSync(path.join(f.source, ".git/shallow"), `${f.repository.revision}\n`);
      return "";
    });
    await checkoutCloudComputerPrimary(f.computer, f.repository, { ...f.options, git, verifyOrigin: async () => {},
      historyBudget: { timeoutMs: limit === "time" ? 25 : 1000, maxBytes: 1024, pollIntervalMs: 5 } });
    expect(fetches).toBe(2);
    expect(git.mock.calls.filter(([, args]) => args[0] === "fetch")[1]?.[1]).toContain("--depth=128");
    expect(f.git(f.source, ["rev-parse", "--is-shallow-repository"])).toBe("true");
  });

  it("does not disguise an ordinary Git authentication failure as a history fallback", async () => {
    const f = fixture();
    const git = vi.fn(async (directory: string, args: string[]) => {
      if (args[0] === "fetch") throw new Error("repository_temporarily_unavailable");
      return f.git(directory, args);
    });
    await expect(checkoutCloudComputerPrimary(f.computer, f.repository, { ...f.options, git, verifyOrigin: async () => {} }))
      .rejects.toThrow("repository_temporarily_unavailable");
    expect(git.mock.calls.filter(([, args]) => args[0] === "fetch")).toHaveLength(1);
  });

  it("bounds the fallback too and stops after two resource-limited attempts", async () => {
    const f = fixture();
    let fetches = 0;
    const git = async (directory: string, args: string[], _token?: string, options?: { signal: AbortSignal }) => {
      if (args[0] !== "fetch") return f.git(directory, args);
      fetches++;
      return new Promise((_resolve, reject) => options?.signal.addEventListener("abort", () => reject(new Error("interrupted")), { once: true }));
    };
    await expect(checkoutCloudComputerPrimary(f.computer, f.repository, { ...f.options, git, verifyOrigin: async () => {},
      historyBudget: { timeoutMs: 5, maxBytes: 1024, pollIntervalMs: 5 } })).rejects.toMatchObject({ code: "repository_history_limit" });
    expect(fetches).toBe(2);
  });

  it.each(["default", "pull_request"])("carries accepted %s source metadata into engine registration", async kind => {
    const f = fixture();
    const checkoutSource = { kind, revision: f.repository.revision, headBranch: kind === "default" ? "main" : "feature/topic",
      targetBranch: kind === "default" ? "main" : "release/stable",
      pullRequest: kind === "default" ? null : { number: 42, url: "https://github.com/fixture/primary/pull/42", state: "ready" } };
    const computer = { ...f.computer, requestedRevision: kind === "default" ? "main" : "refs/pull/42/head", checkoutSource };
    const git = async (directory: string, args: string[]) => args[0] === "fetch" ? "" : f.git(directory, args);
    await checkoutCloudComputerPrimary(computer, f.repository, { ...f.options, git, verifyOrigin: async () => {} });
    expect(f.git(f.source, ["branch", "--show-current"])).toBe(kind === "default" ? "" : "feature/topic");
    expect(JSON.parse(f.git(f.source, ["config", "--local", "--get", "zeros.cloud-source"]))).toEqual(checkoutSource);
    expect(readFileSync(path.join(f.source, ".git/config"), "utf8").includes(token)).toBe(false);
    expect(() => parseCloudComputerSetup({ ...computer, checkoutSource: { ...checkoutSource, targetBranch: f.repository.revision } }, f.repository)).toThrow();
    expect(() => parseCloudComputerSetup({ ...computer, checkoutSource: { ...checkoutSource, revision: "f".repeat(40) } }, f.repository)).toThrow();
  });

  it("reads the verified manifest inode when its pathname is replaced after the metadata check", () => {
    const f = fixture();
    rmSync(f.templateFile);
    writeFileSync(f.templateFile, JSON.stringify({ ...f.template, buildId: configId }), { mode: 0o444 });
    manifestRace.replacement = path.join(f.root, "replacement.json");
    writeFileSync(manifestRace.replacement, JSON.stringify(f.template), { mode: 0o600 });
    // Both the former path-stat and the new descriptor-stat reach the same
    // race. Reopening the pathname would accept unverified replacement bytes.
    manifestRace.file = f.templateFile;
    expect(() => verifyCloudComputerTemplate(f.computer, f.repository, f.options)).toThrow("image_contract_invalid");
    expect(manifestRace.descriptor).toBeTypeOf("number");
    expect(() => fstatSync(manifestRace.descriptor!)).toThrow(expect.objectContaining({ code: "EBADF" }));
  });

  it("checks out the existing primary without a host mount or move and keeps secondary/build outputs in place", async () => {
    const f = fixture();
    writeFileSync(path.join(f.source, "installed-tool"), "template build output");
    const before = lstatSync(f.source).ino;
    const parsed = parseCloudComputerSetup(f.computer, f.repository);
    expect(verifyCloudComputerTemplate(parsed, f.repository, f.options)).toBe(f.source);
    const runGit = vi.fn(async (directory: string, args: string[], credential?: string) => {
      if (args[0] === "fetch") { expect(credential === token).toBe(true); return ""; }
      return f.git(directory, args);
    });
    const checkOrigin = vi.fn(async () => {});
    const commit = await checkoutCloudComputerPrimary(parsed, f.repository, { ...f.options, git: runGit, verifyOrigin: checkOrigin });
    expect(commit).toBe(f.repository.revision);
    expect(f.git(f.source, ["branch", "--show-current"])).toBe("feature/workspace");
    expect(lstatSync(f.source).ino).toBe(before);
    expect(readFileSync(path.join(f.source, "installed-tool"), "utf8")).toBe("template build output");
    expect(f.git(path.join(f.reposRoot, "fixture/secondary"), ["rev-parse", "HEAD"])).toBe(f.template.repositoryManifest[1]!.sha);
    expect(runGit.mock.calls.every(([, args]) => !JSON.stringify(args).includes(token))).toBe(true);
    expect(readFileSync(path.join(f.source, ".git/config"), "utf8").includes(token)).toBe(false);
    expect(f.git(f.source, ["remote", "get-url", "origin"])).toBe(f.repository.cloneUrl);
  });

  it("tolerates Git metadata that Git removes while the metadata is checked", async () => {
    const f = fixture();
    // Detached automatic maintenance after commit/fetch holds this lock briefly.
    writeFileSync(path.join(f.source, ".git/objects/maintenance.lock"), "");
    manifestRace.vanish = path.join(".git", "objects", "maintenance.lock");
    const git = async (directory: string, args: string[]) => args[0] === "fetch" ? "" : f.git(directory, args);
    await expect(checkoutCloudComputerPrimary(f.computer, f.repository, { ...f.options, git, verifyOrigin: async () => {} }))
      .resolves.toBe(f.repository.revision);
    expect(manifestRace.vanish).toBe("");
  });

  it("refuses a config whose opened owner differs from the admitted post-adoption worker", async () => {
    const f = fixture();
    const config = path.join(f.source, ".git/config"), before = readFileSync(config, "utf8");
    manifestRace.foreignConfig = config;
    const git = vi.fn(async (directory: string, args: string[]) => args[0] === "fetch" ? "" : f.git(directory, args));
    const verifyOrigin = vi.fn(async () => {});
    await expect(checkoutCloudComputerPrimary(f.computer, f.repository, { ...f.options, git, verifyOrigin }))
      .rejects.toThrow("image_contract_invalid");
    expect(verifyOrigin).not.toHaveBeenCalled();
    expect(git.mock.calls.some(([, args]) => args[0] === "fetch")).toBe(false);
    expect(readFileSync(config, "utf8")).toBe(before);
  });

  it("refuses a checkout whose HEAD differs from the accepted commit", async () => {
    const f = fixture();
    const parsed = parseCloudComputerSetup(f.computer, f.repository);
    let checkedOut = false;
    const runGit = vi.fn(async (directory: string, args: string[]) => {
      if (args[0] === "checkout") checkedOut = true;
      if (args[0] === "fetch" || args[0] === "checkout") return "";
      if (checkedOut && args[0] === "rev-parse" && args.includes("HEAD^{commit}")) return "f".repeat(40);
      return f.git(directory, args);
    });
    await expect(checkoutCloudComputerPrimary(parsed, f.repository, { ...f.options, git: runGit, verifyOrigin: async () => {} }))
      .rejects.toThrow("repository_revision_invalid");
  });

  it("retries an interrupted exact-commit checkout without resetting a different user HEAD", async () => {
    const f = fixture();
    const buildSha = f.repository.revision;
    writeFileSync(path.join(f.source, "new.txt"), "accepted revision");
    f.git(f.source, ["add", "."]);
    f.git(f.source, ["commit", "--quiet", "-m", "Accepted"]);
    f.repository.revision = f.git(f.source, ["rev-parse", "HEAD"]);
    f.git(f.source, ["checkout", "--quiet", "--detach", buildSha]);
    const git = async (directory: string, args: string[]) => args[0] === "fetch" ? "" : f.git(directory, args);
    const options = { ...f.options, git, verifyOrigin: async () => {} };
    await checkoutCloudComputerPrimary(f.computer, f.repository, options);
    await expect(checkoutCloudComputerPrimary(f.computer, f.repository, options)).resolves.toBe(f.repository.revision);
    writeFileSync(path.join(f.source, "user.txt"), "user edit");
    f.git(f.source, ["add", "."]);
    f.git(f.source, ["commit", "--quiet", "-m", "User commit"]);
    await expect(checkoutCloudComputerPrimary(f.computer, f.repository, options)).rejects.toThrow("repository_revision_invalid");
  });

  it.each(["../escape", "..", ".", "owner/name", "x\\escape"])("rejects a repository path component %s", name => {
    const f = fixture();
    f.computer.template.repositoryManifest[0]!.name = name;
    expect(() => parseCloudComputerSetup(f.computer, f.repository)).toThrow();
  });

  it.each(["owner-link", "checkout-link", "git-link", "alternates", "commondir", "git-object-link", "nested-mount", "workspace-mount"])("refuses %s before fetch or projection", async kind => {
    const f = fixture();
    const external = path.join(f.root, "outside");
    mkdirSync(external);
    if (kind.endsWith("link")) {
      const location = kind === "owner-link" ? path.dirname(f.source) : kind === "checkout-link" ? f.source :
        kind === "git-link" ? path.join(f.source, ".git") : path.join(f.source, ".git/objects/escape");
      rmSync(location, { recursive: true, force: true });
      symlinkSync(external, location);
    } else if (kind === "alternates") writeFileSync(path.join(f.source, ".git/objects/info/alternates"), external);
    else if (kind === "commondir") writeFileSync(path.join(f.source, ".git/commondir"), external);
    expect(() => verifyCloudComputerTemplate(f.computer, f.repository, { ...f.options,
      ...(kind === "nested-mount" || kind === "workspace-mount" ? { readMountInfo: () =>
        `1 0 1:1 / ${kind === "nested-mount" ? `${f.source}/.git` : f.target} rw - ext4 /dev/test rw\n` } : {}) })).toThrow();
  });

  it("publishes credential-free source metadata tied to the current boot, runtime, and engine identity", () => {
    const f = fixture();
    const runtime = { profile: "v4", runtimeId: f.template.runtimeId, manifestSha256: "d".repeat(64),
      baseCompatibilityId: f.template.baseCompatibilityId, bootId: buildId, supervisorSessionId: configId };
    const execution = { workspaceId: buildId, organizationId: configId, setupRunId: buildId, generation: 1, executionFence: 2 };
    const material = { computer: f.computer, repository: f.repository, execution, engine: { instanceId: configId } };
    const document = createCloudComputerWorkspaceAdmission(material, runtime);
    expect(JSON.stringify(document).includes(token)).toBe(false);
    expect(document.repository).not.toHaveProperty("credential");
    const admissionFile = path.join(f.root, "admitted-computer.json");
    writeFileSync(admissionFile, JSON.stringify(document), { mode: 0o600 });
    const options = { ...f.options, admissionFile };
    expect(readCloudComputerWorkspaceAdmission(runtime, options)).toMatchObject({ repositoryDirectory: f.source });
    expect(cloudComputerHostRepository(runtime, options)).toBe(f.source);
    expect(readCloudComputerWorkspaceAdmission(runtime, { ...options,
      engineIdentity: { execution, engine: { instanceId: configId } } })).toBeDefined();
    expect(() => readCloudComputerWorkspaceAdmission(runtime, { ...options,
      engineIdentity: { execution: { ...execution, generation: 2 }, engine: { instanceId: configId } } })).toThrow();
    expect(() => readCloudComputerWorkspaceAdmission(runtime, { ...options, engineIdentity: null })).toThrow();
    for (const change of [{ bootId: configId }, { supervisorSessionId: buildId }, { runtimeId: `r1-${"f".repeat(64)}` }])
      expect(() => readCloudComputerWorkspaceAdmission({ ...runtime, ...change }, options)).toThrow();
    rmSync(admissionFile);
    expect(() => readCloudComputerWorkspaceAdmission(runtime, options)).toThrow();
    rmSync(f.templateFile);
    expect(readCloudComputerWorkspaceAdmission(runtime, options)).toBeNull();
    expect(cloudComputerHostRepository(runtime, options)).toBe("/srv/zeros/files/workspace");
  });

  it("refuses the wrong template manifest or origin, and a moved Git directory", async () => {
    const f = fixture();
    expect(() => verifyCloudComputerTemplate({ ...f.computer, template: { ...f.template, buildId: configId } }, f.repository, f.options)).toThrow();
    f.git(f.source, ["remote", "set-url", "origin", "https://github.com/fixture/other.git"]);
    const runGit = async (directory: string, args: string[]) => f.git(directory, args);
    await expect(checkoutCloudComputerPrimary(f.computer, f.repository, { ...f.options, git: runGit, verifyOrigin: async () => {} })).rejects.toThrow();
    f.git(f.source, ["remote", "set-url", "origin", f.repository.cloneUrl]);
    const changedGitDir = async (directory: string, args: string[]) => args.includes("--absolute-git-dir") ? f.root : f.git(directory, args);
    await expect(checkoutCloudComputerPrimary(f.computer, f.repository, { ...f.options, git: changedGitDir, verifyOrigin: async () => {} })).rejects.toThrow();
  });

  it("checks the immutable origin repository ID with a transient HTTP grant", async () => {
    const f = fixture();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(Response.json({ id: 123, full_name: "fixture/primary" }));
    await verifyCloudComputerRepositoryOrigin(f.repository, "123", fetch);
    expect(fetch.mock.calls[0]?.[0]).toBe("https://api.github.com/repos/fixture/primary");
    expect(fetch.mock.calls[0]?.[1]?.redirect).toBe("error");
    fetch.mockResolvedValueOnce(Response.json({ id: 999, full_name: "fixture/primary" }));
    await expect(verifyCloudComputerRepositoryOrigin(f.repository, "123", fetch)).rejects.toThrow("repository_revision_invalid");
  });
});
