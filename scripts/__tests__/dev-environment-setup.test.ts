import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { importDevelopmentProfile, inspectDevelopmentProfile } from "../dev-environment/setup-profile.mjs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-setup-")); roots.push(home);
  const root = path.join(home, "main checkout"), source = path.join(home, "transfer.json");
  fs.mkdirSync(root, { mode: 0o700 });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" });
  git("init", "-q");
  fs.copyFileSync(path.resolve(import.meta.dirname, "../../.gitignore"), path.join(root, ".gitignore")); git("add", ".gitignore");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "initial");
  const endpoint = `https://${"a".repeat(32)}.r2.cloudflarestorage.com`;
  const profile = {
    version: 2, mode: "hosted",
    cloudflare: { accountId: "a".repeat(32), zoneId: "b".repeat(32), domain: "example.test", apiToken: "cf-sentinel" },
    railway: { projectId: "11111111-1111-4111-8111-111111111111", serviceId: "22222222-2222-4222-8222-222222222222",
      protectedEnvironmentIds: ["33333333-3333-4333-8333-333333333333"], apiToken: "railway-sentinel" },
    planetscale: { organization: "example", database: "example-alpha", protectedBranch: "main", region: "test", clusterSize: "development", tokenId: "id-sentinel", token: "ps-sentinel" },
    registry: { endpoint, bucket: "zeros-dev-registry", accessKeyId: "registry-access-sentinel", secretAccessKey: "registry-secret-sentinel", encryptionKey: "c".repeat(64) },
    storage: { endpoint, bucket: "zeros-dev-objects", accessKeyId: "objects-access-sentinel", secretAccessKey: "objects-secret-sentinel" },
    workos: { environment: "alpha", webClientId: "client_web", desktopClientId: "client_desktop", apiKey: "workos-private-sentinel" },
    github: { appId: 1, appSlug: "test-app", clientId: "client", clientSecret: "github-sentinel", privateKeyBase64: "key-sentinel" },
    boat: { apiKey: "boat-sentinel", billingOrg: "test", accountScope: "test", baseSnapshot: "base", secondsPerDollar: 100000, builderBudgetHours: 1 },
  };
  const writeSource = () => fs.writeFileSync(source, JSON.stringify(profile, null, 2) + "\n", { mode: 0o644 });
  writeSource();
  return { home, root, source, git, profile, writeSource };
}

describe("secure portable Dev setup", () => {
  it("imports one file into home, main checkout and calling worktree, preserving the registry key", () => {
    const f = fixture(), worktree = path.join(f.home, "linked worktree");
    f.git("worktree", "add", "-qb", "feature", worktree);
    const original = fs.readFileSync(f.source);
    const result = importDevelopmentProfile({ root: worktree, homeDir: f.home, source: f.source });
    const destinations = [path.join(f.home, ".zeros-dev/zeros-dev-env.json"), path.join(f.root, "zeros-dev-env.json"), path.join(worktree, "zeros-dev-env.json")];
    expect(result.files.sort()).toEqual(destinations.sort());
    for (const file of [...destinations, f.source]) {
      expect(fs.readFileSync(file)).toEqual(original);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
    expect(f.git("status", "--porcelain")).toBe("");
    expect(f.git("ls-files", "--others", "--ignored", "--exclude-from", path.resolve(import.meta.dirname, "../../.worktreeinclude"))).toBe("zeros-dev-env.json\n");
    expect(importDevelopmentProfile({ root: worktree, homeDir: f.home, source: f.source }).files).toHaveLength(3);
  });

  it("validates without reading providers or changing permissions in check mode", () => {
    const f = fixture();
    expect(inspectDevelopmentProfile(f.source).issues).toEqual([]);
    expect(fs.statSync(f.source).mode & 0o777).toBe(0o644);
    expect(fs.existsSync(path.join(f.home, ".zeros-dev"))).toBe(false);
  });

  it("secures a transferred file already placed at the canonical checkout path", () => {
    const f = fixture(), source = path.join(f.root, "zeros-dev-env.json");
    fs.renameSync(f.source, source);
    expect(fs.statSync(source).mode & 0o777).toBe(0o644);
    importDevelopmentProfile({ root: f.root, source, homeDir: f.home });
    expect(fs.statSync(source).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(path.join(f.home, ".zeros-dev/zeros-dev-env.json"), "utf8"))).toEqual(f.profile);
  });

  it("rejects template placeholders without including credential values in errors", () => {
    const f = fixture(); f.profile.railway.apiToken = "YOUR_RAILWAY_WORKSPACE_API_TOKEN"; f.writeSource();
    expect(() => importDevelopmentProfile({ ...f, homeDir: f.home })).toThrow(/placeholder/);
    const issues = inspectDevelopmentProfile(f.source).issues.join(" ");
    expect(issues).not.toContain(f.profile.railway.apiToken);
    expect(fs.existsSync(path.join(f.root, "zeros-dev-env.json"))).toBe(false);
  });

  it("rejects an incomplete legacy profile without silently upgrading it", () => {
    const f = fixture(); fs.writeFileSync(f.source, '{"version":1}');
    expect(() => importDevelopmentProfile({ ...f, homeDir: f.home })).toThrow(/version 2/);
    expect(fs.existsSync(path.join(f.root, "zeros-dev-env.json"))).toBe(false);
  });

  it.each(["linked source", "linked destination", "tracked destination", "unignored destination", "changed registry", "different profile"])("preserves credentials on %s", situation => {
    const f = fixture(), destination = path.join(f.root, "zeros-dev-env.json");
    if (situation === "linked source") { fs.renameSync(f.source, f.source + ".original"); fs.symlinkSync(f.source + ".original", f.source); }
    if (situation === "linked destination") fs.symlinkSync(path.join(f.home, "absent"), destination);
    if (situation === "tracked destination") { fs.writeFileSync(destination, "{}"); f.git("add", "-f", "zeros-dev-env.json"); }
    if (situation === "unignored destination") fs.writeFileSync(path.join(f.root, ".gitignore"), "");
    if (situation === "changed registry" || situation === "different profile") {
      const previous = structuredClone(f.profile);
      if (situation === "changed registry") previous.registry.encryptionKey = "d".repeat(64);
      else previous.railway.apiToken = "previous-token-sentinel";
      fs.writeFileSync(destination, JSON.stringify(previous), { mode: 0o600 });
    }
    expect(() => importDevelopmentProfile({ ...f, homeDir: f.home })).toThrow();
    expect(fs.existsSync(path.join(f.home, ".zeros-dev/zeros-dev-env.json"))).toBe(false);
  });

  it("does not hide a conflicting legacy checkout profile", () => {
    const f = fixture(); fs.writeFileSync(path.join(f.root, ".env.zeros-dev.json"), '{"version":1}', { mode: 0o600 });
    expect(() => importDevelopmentProfile({ ...f, homeDir: f.home })).toThrow(/existing profile/);
    expect(fs.existsSync(path.join(f.root, "zeros-dev-env.json"))).toBe(false);
  });

  it("reports malformed JSON and oversized transfers without echoing their contents", () => {
    const f = fixture(); fs.writeFileSync(f.source, '{"private-value-sentinel":');
    const issues = inspectDevelopmentProfile(f.source).issues.join(" ");
    expect(issues).toMatch(/JSON/); expect(issues).not.toContain("private-value-sentinel");
    fs.writeFileSync(f.source, "x".repeat(128 * 1024 + 1));
    expect(inspectDevelopmentProfile(f.source).issues.join(" ")).toMatch(/128/);
  });
});
