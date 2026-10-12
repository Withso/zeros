import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const runtime = process.env.ZEROS_RUNTIME_SYSTEM_ASSETS_TEST_DIR;
const probe = (name: string) => JSON.parse(execFileSync("python3", ["-B",
  "scripts/__tests__/fixtures/runtime-system-assets/check-lfs-security.py", path.join(runtime!, "bin/git-lfs"), name],
{ encoding: "utf8", env: { PATH: "/usr/bin:/bin" }, timeout: 20_000 }));

describe.runIf(process.platform === "linux" && !!runtime)("staged Git LFS security fixes", () => {
  it("rejects CVE-2024-53263 credential-protocol injection before consulting another host's helper", () => {
    expect(probe("credential-control")).toMatchObject({ helperCalled: true, foreignHostRequested: false, authorizationSent: false, requests: 1 });
    expect(probe("credential-injection")).toMatchObject({ foreignHostRequested: false, authorizationSent: false });
  });
  it.each(["directory-symlink", "file-symlink", "hardlink"])("prevents CVE-2025-26625 checkout writes through a %s outside the worktree", name => {
    expect(probe("ordinary")).toMatchObject({ outsideUnchanged: true, worktreeHydrated: true, exitCode: 0 });
    expect(probe(name)).toMatchObject({ outsideUnchanged: true });
  });
});
