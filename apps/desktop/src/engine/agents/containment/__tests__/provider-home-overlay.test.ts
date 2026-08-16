import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  prepareProviderHomeOverlay,
  promoteProviderHomeOverlay,
} from "../provider-home-overlay";

describe("provider HOME overlay", () => {
  let root: string;
  let hostHome: string;
  let workspace: string;
  let previousDataDir: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zeros-provider-home-test-"));
    hostHome = path.join(root, "host-home");
    workspace = path.join(root, "workspace");
    await Promise.all([
      mkdir(hostHome, { recursive: true }),
      mkdir(workspace, { recursive: true }),
    ]);
    previousDataDir = process.env.ZEROS_DATA_DIR;
    process.env.ZEROS_DATA_DIR = path.join(root, "engine");
  });

  afterEach(async () => {
    if (previousDataDir === undefined) delete process.env.ZEROS_DATA_DIR;
    else process.env.ZEROS_DATA_DIR = previousDataDir;
    await rm(root, { recursive: true, force: true });
  });

  async function prepare(
    localName: string,
    credentialSeedReader?: () => Promise<
      | { readonly status: "available"; readonly value: string }
      | { readonly status: "absent" }
      | { readonly status: "unavailable" }
    >,
  ) {
    const localHome = path.join(root, localName);
    await mkdir(localHome, { recursive: true });
    return prepareProviderHomeOverlay({
      providerId: "codex",
      workspaceRoot: workspace,
      localHome,
      ambientEnv: { HOME: hostHome },
      credentialSeedReader,
    });
  }

  it("rejects an unsafe host HOME instead of traversing the filesystem root", async () => {
    const localHome = path.join(root, "unsafe-local");
    await mkdir(localHome);
    await expect(
      prepareProviderHomeOverlay({
        providerId: "codex",
        workspaceRoot: workspace,
        localHome,
        ambientEnv: {
          HOME: path.parse(root).root,
          CODEX_HOME: path.parse(root).root,
        },
      }),
    ).rejects.toThrow(/host HOME.*filesystem root/i);
  });

  it("seeds normal provider settings and persists files, type changes, and deletions", async () => {
    await mkdir(path.join(hostHome, ".codex", "plugins", "old"), {
      recursive: true,
    });
    await writeFile(
      path.join(hostHome, ".codex", "config.toml"),
      "model='a'\n",
    );
    await writeFile(path.join(hostHome, ".codex", "plugins", "old", "x"), "x");
    await writeFile(path.join(hostHome, ".codex", "shape"), "file");

    const first = await prepare("local-1");
    expect(
      await readFile(
        path.join(first.localHome, ".codex", "config.toml"),
        "utf8",
      ),
    ).toBe("model='a'\n");
    await rm(path.join(first.localHome, ".codex", "config.toml"));
    await rm(path.join(first.localHome, ".codex", "plugins"), {
      recursive: true,
    });
    await rm(path.join(first.localHome, ".codex", "shape"));
    await mkdir(path.join(first.localHome, ".codex", "shape"));
    await writeFile(
      path.join(first.localHome, ".codex", "shape", "nested"),
      "dir",
    );
    await promoteProviderHomeOverlay(first);

    const second = await prepare("local-2");
    await expect(
      readFile(path.join(second.localHome, ".codex", "config.toml"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      lstat(path.join(second.localHome, ".codex", "plugins")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await readFile(
        path.join(second.localHome, ".codex", "shape", "nested"),
        "utf8",
      ),
    ).toBe("dir");

    await rm(path.join(second.localHome, ".codex", "shape"), {
      recursive: true,
    });
    await writeFile(
      path.join(second.localHome, ".codex", "shape"),
      "file-again",
    );
    await promoteProviderHomeOverlay(second);
    const third = await prepare("local-3");
    expect(
      await readFile(path.join(third.localHome, ".codex", "shape"), "utf8"),
    ).toBe("file-again");
  });

  it("projects keychain auth once and preserves credentials refreshed inside the boundary", async () => {
    const keychain = JSON.stringify({
      tokens: { access_token: "host-access", refresh_token: "host-refresh" },
    });
    const readKeychain = async () => ({
      status: "available" as const,
      value: keychain,
    });

    const first = await prepare("keychain-first", readKeychain);
    const authPath = path.join(first.localHome, ".codex", "auth.json");
    expect(JSON.parse(await readFile(authPath, "utf8"))).toEqual({
      tokens: { access_token: "host-access", refresh_token: "host-refresh" },
    });
    expect((await lstat(authPath)).mode & 0o077).toBe(0);
    const marker = await readFile(
      path.join(first.persistentRoot, "credential-source.json"),
      "utf8",
    );
    expect(
      (await lstat(path.join(first.persistentRoot, "credential-source.json")))
        .mode & 0o077,
    ).toBe(0);
    expect(marker).not.toContain("host-access");
    expect(marker).not.toContain("host-refresh");

    await writeFile(
      authPath,
      JSON.stringify({
        tokens: {
          access_token: "sandbox-access",
          refresh_token: "sandbox-refresh",
        },
      }),
      { mode: 0o600 },
    );
    expect((await promoteProviderHomeOverlay(first)).conflicts).toEqual([]);

    const second = await prepare("keychain-second", readKeychain);
    expect(
      JSON.parse(
        await readFile(
          path.join(second.localHome, ".codex", "auth.json"),
          "utf8",
        ),
      ),
    ).toEqual({
      tokens: {
        access_token: "sandbox-access",
        refresh_token: "sandbox-refresh",
      },
    });
  });

  it("replaces a private credential only when the host keychain changes", async () => {
    let source:
      | { readonly status: "available"; readonly value: string }
      | { readonly status: "absent" }
      | { readonly status: "unavailable" } = {
      status: "available",
      value: JSON.stringify({ token: "host-a" }),
    };
    const readKeychain = async () => source;
    const first = await prepare("keychain-change-a", readKeychain);
    await writeFile(
      path.join(first.localHome, ".codex", "auth.json"),
      JSON.stringify({ token: "refreshed-a" }),
      { mode: 0o600 },
    );
    await promoteProviderHomeOverlay(first);

    source = { status: "unavailable" };
    const transient = await prepare("keychain-transient", readKeychain);
    expect(
      JSON.parse(
        await readFile(
          path.join(transient.localHome, ".codex", "auth.json"),
          "utf8",
        ),
      ),
    ).toEqual({ token: "refreshed-a" });

    source = {
      status: "available",
      value: JSON.stringify({ token: "host-b" }),
    };
    const switched = await prepare("keychain-change-b", readKeychain);
    expect(switched.preparationConflicts).toEqual([]);
    expect(
      JSON.parse(
        await readFile(
          path.join(switched.localHome, ".codex", "auth.json"),
          "utf8",
        ),
      ),
    ).toEqual({ token: "host-b" });

    source = { status: "absent" };
    const signedOut = await prepare("keychain-signed-out", readKeychain);
    await expect(
      readFile(path.join(signedOut.localHome, ".codex", "auth.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects malformed keychain JSON without echoing credential bytes", async () => {
    await expect(
      prepare("keychain-invalid", async () => ({
        status: "available",
        value: "not-json-secret",
      })),
    ).rejects.toThrow("provider keychain credential is not valid JSON");
  });

  it("fails closed when a first keychain read is transiently unavailable", async () => {
    await expect(
      prepare("keychain-unavailable", async () => ({
        status: "unavailable",
      })),
    ).rejects.toThrow(
      "provider keychain credential is temporarily unavailable",
    );
  });

  it("lets a concurrent host account switch win without archiving auth bytes", async () => {
    let source = JSON.stringify({ token: "host-a" });
    const readKeychain = async () => ({
      status: "available" as const,
      value: source,
    });
    const active = await prepare("keychain-race", readKeychain);
    await writeFile(
      path.join(active.localHome, ".codex", "auth.json"),
      JSON.stringify({ token: "sandbox-refresh" }),
      { mode: 0o600 },
    );
    source = JSON.stringify({ token: "host-b" });
    expect((await promoteProviderHomeOverlay(active)).conflicts).toHaveLength(
      1,
    );

    await expect(
      readFile(path.join(active.persistentRoot, "conflicts"), "utf8"),
    ).rejects.toMatchObject({ code: expect.stringMatching(/ENOENT|EISDIR/) });
    const next = await prepare("keychain-race-next", readKeychain);
    expect(
      JSON.parse(
        await readFile(
          path.join(next.localHome, ".codex", "auth.json"),
          "utf8",
        ),
      ),
    ).toEqual({ token: "host-b" });
  });

  it("uses Claude's private credential-file location for a keychain seed", async () => {
    const localHome = path.join(root, "claude-keychain");
    await mkdir(localHome);
    const overlay = await prepareProviderHomeOverlay({
      providerId: "claude",
      workspaceRoot: workspace,
      localHome,
      ambientEnv: { HOME: hostHome },
      credentialSeedReader: async () => ({
        status: "available",
        value: JSON.stringify({ claudeAiOauth: { accessToken: "access" } }),
      }),
    });
    expect(
      JSON.parse(
        await readFile(
          path.join(overlay.localHome, ".claude", ".credentials.json"),
          "utf8",
        ),
      ),
    ).toEqual({ claudeAiOauth: { accessToken: "access" } });
  });

  it("merges disjoint concurrent changes and quarantines same-file races", async () => {
    await mkdir(path.join(hostHome, ".codex"), { recursive: true });
    await writeFile(path.join(hostHome, ".codex", "a"), "base-a");
    await writeFile(path.join(hostHome, ".codex", "b"), "base-b");
    const first = await prepare("concurrent-a");
    const second = await prepare("concurrent-b");
    await writeFile(path.join(first.localHome, ".codex", "a"), "one-a");
    await writeFile(path.join(second.localHome, ".codex", "b"), "two-b");
    await expect(promoteProviderHomeOverlay(first)).resolves.toMatchObject({
      conflicts: [],
    });
    await expect(promoteProviderHomeOverlay(second)).resolves.toMatchObject({
      conflicts: [],
    });

    const raceA = await prepare("race-a");
    const raceB = await prepare("race-b");
    await writeFile(path.join(raceA.localHome, ".codex", "a"), "winner");
    await writeFile(path.join(raceB.localHome, ".codex", "a"), "recover-me");
    expect((await promoteProviderHomeOverlay(raceA)).conflicts).toEqual([]);
    const loser = await promoteProviderHomeOverlay(raceB);
    expect(loser.conflicts).toHaveLength(1);
    const final = await prepare("concurrent-final");
    expect(
      await readFile(path.join(final.localHome, ".codex", "a"), "utf8"),
    ).toBe("winner");
    expect(
      await readFile(path.join(final.localHome, ".codex", "b"), "utf8"),
    ).toBe("two-b");
  });

  it("three-way merges host edits made while a provider session is active", async () => {
    await mkdir(path.join(hostHome, ".codex"), { recursive: true });
    await writeFile(path.join(hostHome, ".codex", "config.toml"), "base\n");
    const active = await prepare("host-race-active");
    await writeFile(
      path.join(active.localHome, ".codex", "config.toml"),
      "agent\n",
    );
    await writeFile(path.join(hostHome, ".codex", "config.toml"), "human\n");

    const promoted = await promoteProviderHomeOverlay(active);
    expect(promoted.conflicts).toHaveLength(1);
    const next = await prepare("host-race-next");
    expect(
      await readFile(
        path.join(next.localHome, ".codex", "config.toml"),
        "utf8",
      ),
    ).toBe("human\n");
  });

  it("does not let an old durable override mask a later human host edit", async () => {
    await mkdir(path.join(hostHome, ".codex"), { recursive: true });
    await writeFile(path.join(hostHome, ".codex", "config.toml"), "base\n");
    const first = await prepare("host-between-a");
    await writeFile(
      path.join(first.localHome, ".codex", "config.toml"),
      "private\n",
    );
    await promoteProviderHomeOverlay(first);
    await writeFile(path.join(hostHome, ".codex", "config.toml"), "human\n");

    const second = await prepare("host-between-b");
    expect(second.preparationConflicts).toHaveLength(1);
    expect(
      await readFile(
        path.join(second.localHome, ".codex", "config.toml"),
        "utf8",
      ),
    ).toBe("human\n");
  });

  it("merges disjoint host and private files without a false directory conflict", async () => {
    await mkdir(path.join(hostHome, ".codex"), { recursive: true });
    await Promise.all([
      writeFile(path.join(hostHome, ".codex", "agent.toml"), "base-a\n"),
      writeFile(path.join(hostHome, ".codex", "human.toml"), "base-h\n"),
    ]);
    const active = await prepare("host-disjoint-a");
    await writeFile(
      path.join(active.localHome, ".codex", "agent.toml"),
      "agent\n",
    );
    await writeFile(path.join(hostHome, ".codex", "human.toml"), "human\n");
    expect((await promoteProviderHomeOverlay(active)).conflicts).toEqual([]);

    const next = await prepare("host-disjoint-b");
    expect(
      await readFile(path.join(next.localHome, ".codex", "agent.toml"), "utf8"),
    ).toBe("agent\n");
    expect(
      await readFile(path.join(next.localHome, ".codex", "human.toml"), "utf8"),
    ).toBe("human\n");
  });

  it("keeps a human-added descendant when a session concurrently deletes its directory", async () => {
    await mkdir(path.join(hostHome, ".codex", "plugins"), { recursive: true });
    await writeFile(
      path.join(hostHome, ".codex", "plugins", "existing"),
      "base",
    );
    const active = await prepare("host-directory-race-a");
    await rm(path.join(active.localHome, ".codex", "plugins"), {
      recursive: true,
    });
    await writeFile(
      path.join(hostHome, ".codex", "plugins", "new-human"),
      "human",
    );
    expect((await promoteProviderHomeOverlay(active)).conflicts).toHaveLength(
      1,
    );

    const next = await prepare("host-directory-race-b");
    expect(
      await readFile(
        path.join(next.localHome, ".codex", "plugins", "existing"),
        "utf8",
      ),
    ).toBe("base");
    expect(
      await readFile(
        path.join(next.localHome, ".codex", "plugins", "new-human"),
        "utf8",
      ),
    ).toBe("human");
  });

  it("never follows a promoted symlink while materializing later descendants", async () => {
    await mkdir(path.join(hostHome, ".codex"), { recursive: true });
    const outside = path.join(root, "outside");
    await mkdir(outside);
    const first = await prepare("symlink-a");
    await symlink(outside, path.join(first.localHome, ".codex", "link"));
    await promoteProviderHomeOverlay(first);
    const second = await prepare("symlink-b");
    expect(await readlink(path.join(second.localHome, ".codex", "link"))).toBe(
      outside,
    );
    expect(
      await lstat(path.join(second.localHome, ".codex", "link")),
    ).toMatchObject({});
    await expect(
      readFile(path.join(outside, "escaped"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("isolates durable state by canonical workspace", async () => {
    await mkdir(path.join(hostHome, ".codex"), { recursive: true });
    const first = await prepare("workspace-a");
    await writeFile(path.join(first.localHome, ".codex", "private"), "one");
    await promoteProviderHomeOverlay(first);

    const otherWorkspace = path.join(root, "other-workspace");
    const otherLocal = path.join(root, "other-local");
    await Promise.all([mkdir(otherWorkspace), mkdir(otherLocal)]);
    const other = await prepareProviderHomeOverlay({
      providerId: "codex",
      workspaceRoot: otherWorkspace,
      localHome: otherLocal,
      ambientEnv: { HOME: hostHome },
    });
    await expect(
      readFile(path.join(other.localHome, ".codex", "private"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("seeds shell compatibility state one-way without promoting edits", async () => {
    await writeFile(path.join(hostHome, ".zshrc"), "export TOOLCHAIN=host\n");
    await mkdir(path.join(hostHome, ".config", "fish", "conf.d"), {
      recursive: true,
    });
    await writeFile(
      path.join(hostHome, ".config", "fish", "conf.d", "tool.fish"),
      "set -gx TOOLCHAIN fish\n",
    );
    await mkdir(path.join(hostHome, ".ssh"), { mode: 0o700 });
    await Promise.all([
      writeFile(
        path.join(hostHome, ".ssh", "config"),
        "Host source-alias\n  HostName example.invalid\n",
        { mode: 0o600 },
      ),
      writeFile(
        path.join(hostHome, ".ssh", "known_hosts"),
        "example.invalid ssh-ed25519 AAAATEST\n",
        { mode: 0o600 },
      ),
      writeFile(
        path.join(hostHome, ".ssh", "id_ed25519"),
        "private-key-must-not-be-copied\n",
        { mode: 0o600 },
      ),
    ]);

    const first = await prepare("compatibility-a");
    expect(await readFile(path.join(first.localHome, ".zshrc"), "utf8")).toBe(
      "export TOOLCHAIN=host\n",
    );
    await writeFile(path.join(first.localHome, ".zshrc"), "agent edit\n");
    await promoteProviderHomeOverlay(first);

    const second = await prepare("compatibility-b");
    expect(await readFile(path.join(second.localHome, ".zshrc"), "utf8")).toBe(
      "export TOOLCHAIN=host\n",
    );
    expect(
      await readFile(
        path.join(second.localHome, ".config", "fish", "conf.d", "tool.fish"),
        "utf8",
      ),
    ).toBe("set -gx TOOLCHAIN fish\n");
    expect(
      await readFile(path.join(second.localHome, ".ssh", "config"), "utf8"),
    ).toContain("Host source-alias");
    expect(
      await readFile(
        path.join(second.localHome, ".ssh", "known_hosts"),
        "utf8",
      ),
    ).toContain("example.invalid ssh-ed25519");
    await expect(
      readFile(path.join(second.localHome, ".ssh", "id_ed25519"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("projects large shell and toolchain stores as read-only host links", async () => {
    await Promise.all([
      mkdir(path.join(hostHome, ".nvm", "versions"), { recursive: true }),
      mkdir(path.join(hostHome, ".oh-my-zsh", "plugins"), {
        recursive: true,
      }),
      mkdir(path.join(hostHome, ".cargo", "bin"), { recursive: true }),
    ]);
    const overlay = await prepare("read-only-links");
    expect(await readlink(path.join(overlay.localHome, ".nvm"))).toBe(
      path.join(hostHome, ".nvm"),
    );
    expect(await readlink(path.join(overlay.localHome, ".oh-my-zsh"))).toBe(
      path.join(hostHome, ".oh-my-zsh"),
    );
    expect(await readlink(path.join(overlay.localHome, ".cargo", "bin"))).toBe(
      path.join(hostHome, ".cargo", "bin"),
    );
    expect(overlay.readOnlyHostRoots).toEqual(
      expect.arrayContaining([
        path.join(hostHome, ".nvm"),
        path.join(hostHome, ".oh-my-zsh"),
        path.join(hostHome, ".cargo", "bin"),
      ]),
    );
  });
});
