import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, lstatSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
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
