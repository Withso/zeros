// File provisioning for a fresh worktree (`runSetupHooks`) — the copy step
// that puts .env and friends into a workspace `git worktree add` just created.
//
// Each case here is a regression:
//   • a seed must NEVER overwrite what the branch checkout already produced,
//   • no write may follow a symlink the branch committed — at the destination
//     itself OR at any PARENT of it, since lstat of the joined path still
//     resolves the parents,
//   • an escaping symlink must be refused at ANY depth, but only FATALLY for
//     the path the caller named — incidental ones inside a copied tree are
//     skipped, or `.venv/bin/python -> /usr/bin/python3` fails the create,
//   • `..` is a path SEGMENT, not a substring — `.env..bak` is a real filename.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  readFile,
  symlink,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { runSetupHooks } from "../setup-hooks";

describe("runSetupHooks — file provisioning", () => {
  let workdir: string;
  let repoRoot: string;
  let worktreePath: string;
  let outside: string;

  const hooks = (extra: {
    copyPaths?: string[];
    seedPaths?: string[];
    symlinkPaths?: string[];
  }) =>
    runSetupHooks({
      workspaceId: "ws_test",
      worktreePath,
      repoRoot,
      baseBranch: "main",
      ...extra,
    });

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "zeros-hooks-"));
    repoRoot = path.join(workdir, "repo");
    worktreePath = path.join(workdir, "wt");
    outside = path.join(workdir, "outside");
    await mkdir(repoRoot, { recursive: true });
    await mkdir(worktreePath, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "secret.txt"), "SECRET-OUTSIDE");
  });
  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it("does NOT clobber a seed path the branch checkout already produced", async () => {
    // A path can be gitignored in main and COMMITTED on the base branch.
    // `git worktree add` materialises the branch's version; overwriting it
    // loses the branch's content AND opens the workspace with a spurious
    // modification an agent can commit.
    await writeFile(path.join(repoRoot, "config.json"), "MAIN-LOCAL");
    await writeFile(path.join(worktreePath, "config.json"), "BRANCH-VERSION");
    await hooks({ seedPaths: ["config.json"] });
    expect(await readFile(path.join(worktreePath, "config.json"), "utf8")).toBe(
      "BRANCH-VERSION",
    );
  });

  it("still seeds a path the checkout did not produce", async () => {
    await writeFile(path.join(repoRoot, ".env"), "A=1");
    await hooks({ seedPaths: [".env"] });
    expect(await readFile(path.join(worktreePath, ".env"), "utf8")).toBe("A=1");
  });

  it("a missing seed source warns and is skipped, never fatal", async () => {
    await writeFile(path.join(repoRoot, ".env"), "A=1");
    await expect(
      hooks({ seedPaths: ["gone.secret", ".env"] }),
    ).resolves.toBeUndefined();
    expect(existsSync(path.join(worktreePath, ".env"))).toBe(true);
  });

  it("an EXPLICIT copyPath is still fatal when its source is missing", async () => {
    // The asymmetry is the point: the caller asked for this one by name.
    await expect(hooks({ copyPaths: ["gone.json"] })).rejects.toThrow(
      /does not exist in repo root/,
    );
  });

  it("SKIPS an escaping symlink nested inside a copied directory, without failing the copy", async () => {
    // The guard used to live only on the TOP-LEVEL branch of copyFromRepo, so
    // one level of nesting re-created a link straight out of the worktree.
    // It must not be FATAL though: a standard virtualenv ships
    // `.venv/bin/python -> /usr/bin/python3`, and copyPaths failure rolls the
    // whole workspace create back — so hardening this broke copying any
    // dependency directory outright.
    await mkdir(path.join(repoRoot, "bundle"), { recursive: true });
    await writeFile(path.join(repoRoot, "bundle", "real.txt"), "INSIDE");
    await symlink(
      path.join(outside, "secret.txt"),
      path.join(repoRoot, "bundle", "abs-link"),
    );
    await expect(hooks({ copyPaths: ["bundle"] })).resolves.toBeUndefined();
    expect(existsSync(path.join(worktreePath, "bundle", "abs-link"))).toBe(
      false,
    );
    // The rest of the tree still arrives.
    expect(
      await readFile(path.join(worktreePath, "bundle", "real.txt"), "utf8"),
    ).toBe("INSIDE");
  });

  it("skips a nested `..` symlink that climbs out of the worktree", async () => {
    await mkdir(path.join(repoRoot, "bundle"), { recursive: true });
    await symlink(
      "../../outside/secret.txt",
      path.join(repoRoot, "bundle", "rel-escape"),
    );
    await hooks({ copyPaths: ["bundle"] });
    expect(existsSync(path.join(worktreePath, "bundle", "rel-escape"))).toBe(
      false,
    );
  });

  it("an escaping symlink at the path the caller NAMED is still fatal", async () => {
    // The asymmetry mirrors the missing-source one: the caller asked for this
    // one by name, so silently not providing it would be worse than failing.
    await symlink(
      path.join(outside, "secret.txt"),
      path.join(repoRoot, "link-out"),
    );
    await expect(hooks({ copyPaths: ["link-out"] })).rejects.toThrow(
      /escaping symlink/,
    );
  });

  it("keeps a nested relative symlink that stays inside the copied tree", async () => {
    // `node_modules/.bin/tsc -> ../typescript/bin/tsc` never leaves the tree.
    // A string check for `..` rejects it — and since copyPaths is FATAL, that
    // failed the whole workspace create for anyone copying a dependency dir.
    await mkdir(path.join(repoRoot, "node_modules", ".bin"), {
      recursive: true,
    });
    await mkdir(path.join(repoRoot, "node_modules", "typescript", "bin"), {
      recursive: true,
    });
    await writeFile(
      path.join(repoRoot, "node_modules", "typescript", "bin", "tsc"),
      "#!/bin/sh",
    );
    await symlink(
      "../typescript/bin/tsc",
      path.join(repoRoot, "node_modules", ".bin", "tsc"),
    );
    await hooks({ copyPaths: ["node_modules"] });
    expect(
      await readFile(
        path.join(worktreePath, "node_modules", ".bin", "tsc"),
        "utf8",
      ),
    ).toBe("#!/bin/sh");
  });

  it("does not write THROUGH a dangling symlink the checkout committed", async () => {
    // existsSync FOLLOWS symlinks, so a dangling one read as "nothing here"
    // and the seed's copyFile (O_CREAT|O_TRUNC) then wrote the main checkout's
    // secret to whatever absolute path the link named — an arbitrary-path
    // overwrite from a committed file on the base branch.
    const victim = path.join(outside, "pwned");
    await writeFile(path.join(repoRoot, ".env"), "SECRET=from-main");
    await symlink(victim, path.join(worktreePath, ".env"));
    await hooks({ seedPaths: [".env"] });
    expect(existsSync(victim)).toBe(false);
  });

  it("refuses an explicit copyPath that would write through a symlink", async () => {
    const victim = path.join(outside, "pwned-explicit");
    await writeFile(path.join(repoRoot, "config.json"), "SECRET");
    await symlink(victim, path.join(worktreePath, "config.json"));
    await expect(hooks({ copyPaths: ["config.json"] })).rejects.toThrow(
      /symlink already at/,
    );
    expect(existsSync(victim)).toBe(false);
  });

  it("does not write through a symlinked PARENT directory", async () => {
    // lstat of the joined path still FOLLOWS the parent components, so a
    // final-component check reads `certs/server.pem` as absent, `mkdir -p`
    // then traverses the link, and the copy lands outside the worktree — a
    // seed leaking the main checkout's key from nothing but a committed link.
    await mkdir(path.join(repoRoot, "certs"), { recursive: true });
    await writeFile(path.join(repoRoot, "certs", "server.pem"), "PRIVATE-KEY");
    await symlink(outside, path.join(worktreePath, "certs"));
    await hooks({ seedPaths: ["certs/server.pem"] });
    expect(existsSync(path.join(outside, "server.pem"))).toBe(false);
  });

  it("does not write through a symlink NESTED in a copied directory", async () => {
    // Naming the parent directory must not be a way around the destination
    // guard: `copyPaths: ["cfg/x"]` was refused while `copyPaths: ["cfg"]`
    // walked in and overwrote the outside file through the link.
    const victim = path.join(outside, "secret.txt");
    await mkdir(path.join(repoRoot, "cfg"), { recursive: true });
    await writeFile(path.join(repoRoot, "cfg", "x"), "FROM-MAIN");
    await mkdir(path.join(worktreePath, "cfg"), { recursive: true });
    await symlink(victim, path.join(worktreePath, "cfg", "x"));
    await expect(hooks({ copyPaths: ["cfg"] })).rejects.toThrow(
      /symlink already at/,
    );
    expect(await readFile(victim, "utf8")).toBe("SECRET-OUTSIDE");
  });

  it("does not create a symlinkPath through a symlinked parent", async () => {
    await mkdir(path.join(repoRoot, "shared", "dep"), { recursive: true });
    await symlink(outside, path.join(worktreePath, "shared"));
    await expect(hooks({ symlinkPaths: ["shared/dep"] })).rejects.toThrow(
      /symlink already at/,
    );
    expect(existsSync(path.join(outside, "dep"))).toBe(false);
  });

  it("keeps a contained relative symlink inside a copied directory", async () => {
    await mkdir(path.join(repoRoot, "bundle"), { recursive: true });
    await writeFile(path.join(repoRoot, "bundle", "real.txt"), "INSIDE");
    await symlink("real.txt", path.join(repoRoot, "bundle", "alias"));
    await hooks({ copyPaths: ["bundle"] });
    expect(
      await readFile(path.join(worktreePath, "bundle", "alias"), "utf8"),
    ).toBe("INSIDE");
  });

  it("copies a filename containing `..` — it is a segment check, not a substring", async () => {
    // `rel.includes("..")` rejected `.env..bak` and `config..json`; as an
    // explicit copyPath that was FATAL and rolled the whole create back.
    for (const name of [".env..bak", "config..json", "..env"]) {
      await writeFile(path.join(repoRoot, name), name);
    }
    await hooks({ copyPaths: [".env..bak", "config..json", "..env"] });
    for (const name of [".env..bak", "config..json", "..env"]) {
      expect(await readFile(path.join(worktreePath, name), "utf8")).toBe(name);
    }
  });

  it("still refuses a real `..` traversal", async () => {
    await expect(
      hooks({ copyPaths: ["../outside/secret.txt"] }),
    ).rejects.toThrow(/must be a relative path within the repo/);
    await expect(hooks({ copyPaths: ["sub/../../outside"] })).rejects.toThrow(
      /must be a relative path within the repo/,
    );
  });
});
