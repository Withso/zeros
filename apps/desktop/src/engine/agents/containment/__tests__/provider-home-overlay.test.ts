import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  armProviderHomeRecovery,
  prepareProviderHomeOverlay,
  prewarmProviderHomeOverlay,
  promoteProviderHomeOverlay,
  recoverProviderHomeOverlays,
  refillParkedProviderWorlds,
  sweepProviderHomeStorage,
} from "../provider-home-overlay";

describe("provider HOME overlay", () => {
  let root: string;
  let hostHome: string;
  let workspace: string;
  let previousDataDir: string | undefined;

  beforeEach(async () => {
    root = await realpath(
      await mkdtemp(path.join(tmpdir(), "zeros-provider-home-test-")),
    );
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
    vi.useRealTimers();
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
    providerResumeId?: string,
  ) {
    const localHome = path.join(root, localName);
    await mkdir(localHome, { recursive: true });
    return prepareProviderHomeOverlay({
      providerId: "codex",
      workspaceRoot: workspace,
      localHome,
      ambientEnv: { HOME: hostHome },
      credentialSeedReader,
      ...(providerResumeId ? { providerResumeId } : {}),
    });
  }

  const CODEX_TRANSCRIPT = ["sessions", "2026", "08", "16"] as const;

  it("projects every managed root when the roots are walked concurrently", async () => {
    // The copy pass overlaps managed roots, which is only safe because
    // providerManagedPaths returns mutually disjoint relatives. This projects a
    // provider whose roots are BOTH top-level and nested under shared parents
    // (.config/opencode, .local/share/opencode, .local/state/opencode all need
    // an ancestor that two walks may create at once) and asserts every root
    // arrives complete, with its digests recorded and its host mode preserved.
    const roots = [
      [".agents", "agents.md"],
      [".config/opencode", "config.json"],
      [".local/share/opencode", "share.json"],
      [".local/state/opencode", "state.json"],
    ] as const;
    for (const [relative, file] of roots) {
      const directory = path.join(hostHome, relative);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, file), `${relative}\n`);
      // A nested file per root, so each walk has real depth to overlap on.
      await mkdir(path.join(directory, "nested"), { recursive: true });
      await writeFile(
        path.join(directory, "nested", "deep.txt"),
        `${relative}/nested\n`,
      );
    }
    const localHome = path.join(root, "concurrent-roots");
    await mkdir(localHome, { recursive: true });
    const overlay = await prepareProviderHomeOverlay({
      providerId: "opencode",
      workspaceRoot: workspace,
      localHome,
      ambientEnv: { HOME: hostHome },
    });
    for (const [relative, file] of roots) {
      await expect(
        readFile(path.join(localHome, relative, file), "utf8"),
      ).resolves.toBe(`${relative}\n`);
      await expect(
        readFile(path.join(localHome, relative, "nested", "deep.txt"), "utf8"),
      ).resolves.toBe(`${relative}/nested\n`);
      expect(overlay.baselineLocal.has(path.join(relative, file))).toBe(true);
    }
    // Concurrency must not lose the durable copy either: a second projection
    // reads from the durable store rather than the host, and must be identical.
    const secondHome = path.join(root, "concurrent-roots-2");
    await mkdir(secondHome, { recursive: true });
    await prepareProviderHomeOverlay({
      providerId: "opencode",
      workspaceRoot: workspace,
      localHome: secondHome,
      ambientEnv: { HOME: hostHome },
    });
    for (const [relative, file] of roots) {
      await expect(
        readFile(path.join(secondHome, relative, file), "utf8"),
      ).resolves.toBe(`${relative}\n`);
      await expect(
        readFile(path.join(secondHome, relative, "nested", "deep.txt"), "utf8"),
      ).resolves.toBe(`${relative}/nested\n`);
    }
  });

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

  it("materializes a symlinked provider root instead of exposing the host through it", async () => {
    const physicalCodexHome = path.join(root, "physical-codex-home");
    await mkdir(physicalCodexHome);
    await writeFile(
      path.join(physicalCodexHome, "config.toml"),
      "model='safe'\n",
    );
    await symlink(physicalCodexHome, path.join(hostHome, ".codex"));
    const localHome = path.join(root, "symlinked-provider-root");
    await mkdir(localHome);

    const overlay = await prepareProviderHomeOverlay({
      providerId: "codex",
      workspaceRoot: workspace,
      localHome,
      ambientEnv: { HOME: hostHome },
    });

    const localRoot = await lstat(path.join(overlay.localHome, ".codex"));
    expect(localRoot.isDirectory()).toBe(true);
    expect(localRoot.isSymbolicLink()).toBe(false);
    await writeFile(
      path.join(overlay.localHome, ".codex", "config.toml"),
      "model='private'\n",
    );
    expect(
      await readFile(path.join(physicalCodexHome, "config.toml"), "utf8"),
    ).toBe("model='safe'\n");
  });

  it("shares one durable projection across throwaway roots pinned to a state scope", async () => {
    const workspaceB = path.join(root, "workspace-b");
    const localA = path.join(root, "scoped-local-a");
    const localB = path.join(root, "scoped-local-b");
    const localC = path.join(root, "unscoped-local-c");
    await Promise.all([
      mkdir(workspaceB, { recursive: true }),
      mkdir(localA),
      mkdir(localB),
      mkdir(localC),
    ]);

    const scoped = await prepareProviderHomeOverlay({
      providerId: "codex",
      workspaceRoot: workspace,
      stateScope: "zeros-provider-probe\0codex",
      localHome: localA,
      ambientEnv: { HOME: hostHome },
    });
    await mkdir(path.join(scoped.localHome, ".codex"), { recursive: true });
    await writeFile(
      path.join(scoped.localHome, ".codex", "probe-state.json"),
      '{"warm":true}',
    );
    await promoteProviderHomeOverlay(scoped);

    // A different throwaway working root with the SAME scope reuses the
    // durable projection instead of minting (and orphaning) a fresh copy.
    const rescoped = await prepareProviderHomeOverlay({
      providerId: "codex",
      workspaceRoot: workspaceB,
      stateScope: "zeros-provider-probe\0codex",
      localHome: localB,
      ambientEnv: { HOME: hostHome },
    });
    expect(
      await readFile(
        path.join(rescoped.localHome, ".codex", "probe-state.json"),
        "utf8",
      ),
    ).toBe('{"warm":true}');

    // Without the scope the same root keys its own durable projection.
    const unscoped = await prepareProviderHomeOverlay({
      providerId: "codex",
      workspaceRoot: workspaceB,
      localHome: localC,
      ambientEnv: { HOME: hostHome },
    });
    await expect(
      readFile(
        path.join(unscoped.localHome, ".codex", "probe-state.json"),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("materializes host-seeded provider symlinks instead of retaining writable aliases", async () => {
    const sharedConfig = path.join(root, "shared-config.toml");
    await writeFile(sharedConfig, "model='host'\n");
    await mkdir(path.join(hostHome, ".codex"));
    await symlink(sharedConfig, path.join(hostHome, ".codex", "config.toml"));

    const overlay = await prepare("materialized-provider-symlink");
    const projected = path.join(overlay.localHome, ".codex", "config.toml");
    expect((await lstat(projected)).isSymbolicLink()).toBe(false);
    expect(await readFile(projected, "utf8")).toBe("model='host'\n");
    await writeFile(projected, "model='private'\n");
    expect(await readFile(sharedConfig, "utf8")).toBe("model='host'\n");
    await writeFile(sharedConfig, "model='host-new'\n");
    const promotion = await promoteProviderHomeOverlay(overlay);
    expect(promotion.conflicts).toHaveLength(1);
    expect(await readFile(sharedConfig, "utf8")).toBe("model='host-new'\n");
  });

  it("does not clone reconstructible Codex runtime stores into a provider boundary", async () => {
    await Promise.all([
      mkdir(path.join(hostHome, ".codex", "worktrees", "old"), {
        recursive: true,
      }),
      mkdir(path.join(hostHome, ".codex", "plugins", ".plugin-appserver"), {
        recursive: true,
      }),
      mkdir(path.join(hostHome, ".codex", "plugins", "cache", "example"), {
        recursive: true,
      }),
    ]);
    await Promise.all([
      writeFile(path.join(hostHome, ".codex", "config.toml"), "model='a'\n"),
      writeFile(path.join(hostHome, ".codex", "models_cache.json"), "{}\n"),
      writeFile(path.join(hostHome, ".codex", "logs_2.sqlite"), ""),
      writeFile(
        path.join(hostHome, ".codex", "worktrees", "old", "checkout"),
        "",
      ),
      writeFile(
        path.join(hostHome, ".codex", "plugins", ".plugin-appserver", "codex"),
        "",
      ),
      writeFile(
        path.join(
          hostHome,
          ".codex",
          "plugins",
          "cache",
          "example",
          "plugin.json",
        ),
        "{}\n",
      ),
    ]);
    // Each sparse fixture individually exceeds the per-file quota. Admission
    // must ignore these reconstructible/runtime-owned stores before quota
    // accounting, not merely raise the cap and copy gigabytes per command.
    await Promise.all([
      truncate(
        path.join(hostHome, ".codex", "logs_2.sqlite"),
        129 * 1024 * 1024,
      ),
      truncate(
        path.join(hostHome, ".codex", "worktrees", "old", "checkout"),
        129 * 1024 * 1024,
      ),
      truncate(
        path.join(hostHome, ".codex", "plugins", ".plugin-appserver", "codex"),
        129 * 1024 * 1024,
      ),
    ]);

    const overlay = await prepare("codex-runtime-stores");
    expect(
      await readFile(
        path.join(overlay.localHome, ".codex", "config.toml"),
        "utf8",
      ),
    ).toBe("model='a'\n");
    expect(
      await readFile(
        path.join(
          overlay.localHome,
          ".codex",
          "plugins",
          "cache",
          "example",
          "plugin.json",
        ),
        "utf8",
      ),
    ).toBe("{}\n");
    for (const relative of [
      path.join(".codex", "logs_2.sqlite"),
      path.join(".codex", "models_cache.json"),
      path.join(".codex", "worktrees", "old", "checkout"),
      path.join(".codex", "plugins", ".plugin-appserver", "codex"),
    ]) {
      await expect(
        lstat(path.join(overlay.localHome, relative)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("does not clone Cursor IDE installations and unrelated project history", async () => {
    await Promise.all([
      mkdir(path.join(hostHome, ".cursor", "extensions", "large"), {
        recursive: true,
      }),
      mkdir(path.join(hostHome, ".cursor", "projects", "other-project"), {
        recursive: true,
      }),
    ]);
    await Promise.all([
      writeFile(
        path.join(hostHome, ".cursor", "cli-config.json"),
        '{"permissions":{}}\n',
      ),
      writeFile(
        path.join(hostHome, ".cursor", "extensions", "large", "binary"),
        "",
      ),
      writeFile(
        path.join(
          hostHome,
          ".cursor",
          "projects",
          "other-project",
          "history.jsonl",
        ),
        "",
      ),
    ]);
    await Promise.all([
      truncate(
        path.join(hostHome, ".cursor", "extensions", "large", "binary"),
        129 * 1024 * 1024,
      ),
      truncate(
        path.join(
          hostHome,
          ".cursor",
          "projects",
          "other-project",
          "history.jsonl",
        ),
        129 * 1024 * 1024,
      ),
    ]);
    const localHome = path.join(root, "cursor-runtime-stores");
    await mkdir(localHome);

    const overlay = await prepareProviderHomeOverlay({
      providerId: "cursor",
      workspaceRoot: workspace,
      localHome,
      ambientEnv: { HOME: hostHome },
    });
    expect(
      await readFile(
        path.join(overlay.localHome, ".cursor", "cli-config.json"),
        "utf8",
      ),
    ).toBe('{"permissions":{}}\n');
    await expect(
      lstat(path.join(overlay.localHome, ".cursor", "extensions")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      lstat(path.join(overlay.localHome, ".cursor", "projects")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("bounds provider-state directory depth before session admission", async () => {
    let nested = path.join(hostHome, ".codex");
    for (let depth = 0; depth < 130; depth += 1) {
      nested = path.join(nested, "d");
    }
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(nested, "leaf"), "state");
    const localHome = path.join(root, "deep-provider-tree");
    await mkdir(localHome);

    await expect(
      prepareProviderHomeOverlay({
        providerId: "codex",
        workspaceRoot: workspace,
        localHome,
        ambientEnv: { HOME: hostHome },
      }),
    ).rejects.toThrow(/directory depth/i);
  });

  it("imports only the exact Codex rollout requested for a legacy resume", async () => {
    const targetId = "11111111-1111-4111-8111-111111111111";
    const historyBaseId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const unrelatedId = "22222222-2222-4222-8222-222222222222";
    const sessionRoot = path.join(
      hostHome,
      ".codex",
      "sessions",
      "2026",
      "08",
      "16",
    );
    await mkdir(sessionRoot, { recursive: true });
    const target = path.join(sessionRoot, `rollout-now-${targetId}.jsonl`);
    const historyBase = path.join(
      sessionRoot,
      `rollout-parent-${historyBaseId}.jsonl`,
    );
    const unrelated = path.join(
      sessionRoot,
      `rollout-before-${unrelatedId}.jsonl`,
    );
    await Promise.all([
      writeFile(
        target,
        `${JSON.stringify({
          type: "session_meta",
          payload: {
            id: targetId,
            history_base: { thread_id: historyBaseId },
          },
        })}\n`,
      ),
      writeFile(
        historyBase,
        `${JSON.stringify({
          type: "session_meta",
          payload: { id: historyBaseId },
        })}\n`,
      ),
      writeFile(unrelated, ""),
    ]);
    await truncate(unrelated, 129 * 1024 * 1024);
    const localHome = path.join(root, "codex-exact-resume");
    await mkdir(localHome);

    const overlay = await prepareProviderHomeOverlay({
      providerId: "codex",
      providerResumeId: targetId,
      workspaceRoot: workspace,
      localHome,
      ambientEnv: { HOME: hostHome },
    });

    expect(
      await readFile(
        path.join(
          overlay.localHome,
          ".codex",
          "sessions",
          "2026",
          "08",
          "16",
          `rollout-now-${targetId}.jsonl`,
        ),
        "utf8",
      ),
    ).toContain(targetId);
    expect(
      await readFile(
        path.join(
          overlay.localHome,
          ".codex",
          "sessions",
          "2026",
          "08",
          "16",
          `rollout-parent-${historyBaseId}.jsonl`,
        ),
        "utf8",
      ),
    ).toContain(historyBaseId);
    await expect(
      lstat(
        path.join(
          overlay.localHome,
          ".codex",
          "sessions",
          "2026",
          "08",
          "16",
          `rollout-before-${unrelatedId}.jsonl`,
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not import a Codex rollout whose filename only contains the resume id", async () => {
    const targetId = "short-id";
    const unrelatedId = `unrelated-${targetId}-suffix`;
    const sessionRoot = path.join(hostHome, ".codex", "sessions", "2026");
    await mkdir(sessionRoot, { recursive: true });
    const unrelated = path.join(
      sessionRoot,
      `rollout-now-${unrelatedId}.jsonl`,
    );
    await writeFile(
      unrelated,
      `${JSON.stringify({
        type: "session_meta",
        payload: { id: unrelatedId },
      })}\n`,
    );
    const localHome = path.join(root, "codex-no-substring-resume");
    await mkdir(localHome);

    const overlay = await prepareProviderHomeOverlay({
      providerId: "codex",
      providerResumeId: targetId,
      workspaceRoot: workspace,
      localHome,
      ambientEnv: { HOME: hostHome },
    });

    await expect(
      lstat(
        path.join(
          overlay.localHome,
          ".codex",
          "sessions",
          "2026",
          `rollout-now-${unrelatedId}.jsonl`,
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("bounds duplicate Codex resume artifacts before copying them", async () => {
    const targetId = "55555555-5555-4555-8555-555555555555";
    const sessionRoot = path.join(hostHome, ".codex", "sessions", "2026");
    await mkdir(sessionRoot, { recursive: true });
    await Promise.all(
      Array.from({ length: 65 }, (_, index) =>
        writeFile(
          path.join(sessionRoot, `rollout-${index}-${targetId}.jsonl`),
          "",
        ),
      ),
    );
    const localHome = path.join(root, "codex-duplicate-resume");
    await mkdir(localHome);

    await expect(
      prepareProviderHomeOverlay({
        providerId: "codex",
        providerResumeId: targetId,
        workspaceRoot: workspace,
        localHome,
        ambientEnv: { HOME: hostHome },
      }),
    ).rejects.toThrow("provider resume history exceeds its bounded file quota");
  });

  it("keeps sessions created inside ZSR private and durable", async () => {
    const first = await prepare("private-session-1");
    const transcript = path.join(
      ".codex",
      ...CODEX_TRANSCRIPT,
      "rollout-private.jsonl",
    );
    const session = path.join(first.localHome, transcript);
    await mkdir(path.dirname(session), { recursive: true });
    await writeFile(session, "private session\n");
    await promoteProviderHomeOverlay(first);

    expect(
      await readFile(path.join(first.contentRoot, transcript), "utf8"),
    ).toBe("private session\n");
    await expect(lstat(session)).resolves.toBeDefined();
  });

  it("projects a durable transcript only into the session resuming it", async () => {
    const first = await prepare("scoped-history-1");
    const transcript = path.join(
      ".codex",
      ...CODEX_TRANSCRIPT,
      "rollout-private.jsonl",
    );
    await mkdir(path.dirname(path.join(first.localHome, transcript)), {
      recursive: true,
    });
    await writeFile(
      path.join(first.localHome, transcript),
      "private session\n",
    );
    await promoteProviderHomeOverlay(first);

    // A brand-new conversation must not pay to copy — or hash — every
    // transcript the workspace has ever accumulated.
    const fresh = await prepare("scoped-history-2");
    await expect(
      lstat(path.join(fresh.localHome, transcript)),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const resumed = await prepare("scoped-history-3", undefined, "private");
    expect(
      await readFile(path.join(resumed.localHome, transcript), "utf8"),
    ).toBe("private session\n");
    await expect(
      lstat(path.join(resumed.contentRoot, transcript)),
    ).resolves.toBeDefined();
  });

  it("projects only the resumed Claude transcript out of a durable store", async () => {
    const resumed = "55555555-5555-4555-8555-555555555555";
    const unrelated = "66666666-6666-4666-8666-666666666666";
    const project = path.join(".claude", "projects", "-workspace");
    const first = path.join(root, "claude-durable-1");
    await mkdir(first, { recursive: true });
    const seeded = await prepareProviderHomeOverlay({
      providerId: "claude",
      workspaceRoot: workspace,
      localHome: first,
      ambientEnv: { HOME: hostHome },
    });
    await mkdir(path.join(first, project), { recursive: true });
    await Promise.all([
      writeFile(path.join(first, project, `${resumed}.jsonl`), "resumed\n"),
      writeFile(path.join(first, project, `${unrelated}.jsonl`), "unrelated\n"),
    ]);
    await promoteProviderHomeOverlay(seeded);

    const next = path.join(root, "claude-durable-2");
    await mkdir(next, { recursive: true });
    const overlay = await prepareProviderHomeOverlay({
      providerId: "claude",
      providerResumeId: resumed,
      workspaceRoot: workspace,
      localHome: next,
      ambientEnv: { HOME: hostHome },
    });
    expect(
      await readFile(path.join(next, project, `${resumed}.jsonl`), "utf8"),
    ).toBe("resumed\n");
    await expect(
      lstat(path.join(next, project, `${unrelated}.jsonl`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    // The transcript that was not projected is still durable for its own chat.
    expect(
      await readFile(
        path.join(overlay.contentRoot, project, `${unrelated}.jsonl`),
        "utf8",
      ),
    ).toBe("unrelated\n");
  });

  it("still finds a durable rollout whose filename does not carry its id", async () => {
    const threadId = "77777777-7777-4777-8777-777777777777";
    const transcript = path.join(
      ".codex",
      ...CODEX_TRANSCRIPT,
      "imported-rollout.jsonl",
    );
    const first = await prepare("durable-metadata-1");
    await mkdir(path.dirname(path.join(first.localHome, transcript)), {
      recursive: true,
    });
    await writeFile(
      path.join(first.localHome, transcript),
      `${JSON.stringify({
        type: "session_meta",
        payload: { id: threadId },
      })}\nturn\n`,
    );
    await promoteProviderHomeOverlay(first);

    // Scoped projection must not turn "the name does not match" into silent
    // history loss — that is what surfaces as "found no rollout; auto-starting
    // a fresh thread".
    const resumed = await prepare("durable-metadata-2", undefined, threadId);
    await expect(
      readFile(path.join(resumed.localHome, transcript), "utf8"),
    ).resolves.toContain("turn");
  });

  it("keeps an unaddressable provider history projected in full", async () => {
    const localHome = path.join(root, "cursor-history");
    await mkdir(localHome, { recursive: true });
    const first = await prepareProviderHomeOverlay({
      providerId: "cursor",
      workspaceRoot: workspace,
      localHome,
      ambientEnv: { HOME: hostHome },
    });
    // Cursor's project state cannot be addressed by a resume id, so — unlike
    // Claude/Codex transcripts — it stays projected in full.
    const project = path.join(
      ".cursor",
      "projects",
      "slug",
      "agent-transcripts",
      "a.jsonl",
    );
    await mkdir(path.dirname(path.join(localHome, project)), {
      recursive: true,
    });
    await writeFile(path.join(localHome, project), "step\n");
    await promoteProviderHomeOverlay(first);

    const next = path.join(root, "cursor-history-2");
    await mkdir(next, { recursive: true });
    const second = await prepareProviderHomeOverlay({
      providerId: "cursor",
      workspaceRoot: workspace,
      localHome: next,
      ambientEnv: { HOME: hostHome },
    });
    expect(await readFile(path.join(second.localHome, project), "utf8")).toBe(
      "step\n",
    );
  });

  it("does not carry the cursor-agent CLI's chat history into a session", async () => {
    const localHome = path.join(root, "cursor-cli-history");
    await mkdir(localHome, { recursive: true });
    const first = await prepareProviderHomeOverlay({
      providerId: "cursor",
      workspaceRoot: workspace,
      localHome,
      ambientEnv: { HOME: hostHome },
    });
    // No Zeros path reads these: Cursor SDK conversations live in the private
    // JSONL store and resume by agent id. Projecting the accumulated store was
    // the largest per-admission Cursor cost, so it is excluded both ways.
    const chat = path.join(".cursor", "chats", "chat-1.json");
    const acp = path.join(".cursor", "acp-sessions", "s-1.json");
    for (const relative of [chat, acp]) {
      await mkdir(path.dirname(path.join(localHome, relative)), {
        recursive: true,
      });
      await writeFile(path.join(localHome, relative), "cli\n");
    }
    await promoteProviderHomeOverlay(first);

    const next = path.join(root, "cursor-cli-history-2");
    await mkdir(next, { recursive: true });
    const second = await prepareProviderHomeOverlay({
      providerId: "cursor",
      workspaceRoot: workspace,
      localHome: next,
      ambientEnv: { HOME: hostHome },
    });
    for (const relative of [chat, acp]) {
      await expect(
        readFile(path.join(second.localHome, relative), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("never projects or promotes the Cursor SDK's own stored login", async () => {
    const localHome = path.join(root, "cursor-sdk-auth");
    await mkdir(localHome, { recursive: true });
    // A host-side login must not be copied into a session…
    const hostAuth = path.join(hostHome, ".cursor", "sdk", "auth.json");
    await mkdir(path.dirname(hostAuth), { recursive: true });
    await writeFile(hostAuth, '{"version":1,"apiKey":"host-key"}\n');
    const first = await prepareProviderHomeOverlay({
      providerId: "cursor",
      workspaceRoot: workspace,
      localHome,
      ambientEnv: { HOME: hostHome },
    });
    const projected = path.join(localHome, ".cursor", "sdk", "auth.json");
    await expect(readFile(projected, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    // …and a login minted INSIDE a session must not reach the durable store.
    await mkdir(path.dirname(projected), { recursive: true });
    await writeFile(projected, '{"version":1,"apiKey":"session-key"}\n');
    await promoteProviderHomeOverlay(first);
    await expect(
      readFile(
        path.join(first.contentRoot, ".cursor", "sdk", "auth.json"),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("promotes an unclosed provider HOME after an engine crash", async () => {
    const sessionRoot = path.join(
      process.env.ZEROS_DATA_DIR!,
      "sessions",
      "crashed",
    );
    const generationRoot = path.join(sessionRoot, "boundary", "generation");
    const localHome = path.join(generationRoot, "home");
    await mkdir(localHome, { recursive: true });
    const crashed = await prepareProviderHomeOverlay({
      providerId: "codex",
      workspaceRoot: workspace,
      localHome,
      ambientEnv: { HOME: hostHome },
    });
    await armProviderHomeRecovery(crashed);
    const transcript = path.join(
      localHome,
      ".codex",
      "sessions",
      "2026",
      "08",
      "16",
      "rollout-crashed.jsonl",
    );
    await mkdir(path.dirname(transcript), { recursive: true });
    await writeFile(transcript, "survived\n");

    await expect(
      recoverProviderHomeOverlays({
        sessionsRoot: path.join(process.env.ZEROS_DATA_DIR!, "sessions"),
      }),
    ).resolves.toEqual({
      discovered: 1,
      recovered: 1,
      preserved: 0,
      conflicts: 0,
    });

    const resumed = await prepare("post-crash", undefined, "crashed");
    expect(
      await readFile(
        path.join(
          resumed.localHome,
          ".codex",
          ...CODEX_TRANSCRIPT,
          "rollout-crashed.jsonl",
        ),
        "utf8",
      ),
    ).toBe("survived\n");
    await expect(
      lstat(path.join(generationRoot, ".provider-home-recovery.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains malformed crash state instead of granting session GC deletion authority", async () => {
    const sessionRoot = path.join(
      process.env.ZEROS_DATA_DIR!,
      "sessions",
      "malformed",
    );
    const generationRoot = path.join(sessionRoot, "boundary", "generation");
    const localHome = path.join(generationRoot, "home");
    await mkdir(localHome, { recursive: true });
    const crashed = await prepareProviderHomeOverlay({
      providerId: "codex",
      workspaceRoot: workspace,
      localHome,
      ambientEnv: { HOME: hostHome },
    });
    await armProviderHomeRecovery(crashed);
    const marker = path.join(generationRoot, ".provider-home-recovery.json");
    await writeFile(marker, "{truncated", { mode: 0o600 });

    await expect(
      recoverProviderHomeOverlays({
        sessionsRoot: path.join(process.env.ZEROS_DATA_DIR!, "sessions"),
      }),
    ).resolves.toEqual({
      discovered: 1,
      recovered: 0,
      preserved: 1,
      conflicts: 0,
    });
    await expect(lstat(marker)).resolves.toBeDefined();
    await expect(lstat(localHome)).resolves.toBeDefined();
  });

  it("retains a hard-linked crash marker instead of trusting mutable alias state", async () => {
    const generationRoot = path.join(
      process.env.ZEROS_DATA_DIR!,
      "sessions",
      "aliased-marker",
      "boundary",
      "generation",
    );
    const localHome = path.join(generationRoot, "home");
    await mkdir(localHome, { recursive: true });
    const crashed = await prepareProviderHomeOverlay({
      providerId: "codex",
      workspaceRoot: workspace,
      localHome,
      ambientEnv: { HOME: hostHome },
    });
    await armProviderHomeRecovery(crashed);
    const marker = path.join(generationRoot, ".provider-home-recovery.json");
    await link(marker, path.join(root, "marker-alias"));

    await expect(
      recoverProviderHomeOverlays({
        sessionsRoot: path.join(process.env.ZEROS_DATA_DIR!, "sessions"),
      }),
    ).resolves.toEqual({
      discovered: 1,
      recovered: 0,
      preserved: 1,
      conflicts: 0,
    });
    await expect(lstat(marker)).resolves.toBeDefined();
    await expect(lstat(localHome)).resolves.toBeDefined();
  });

  it("retains a valid crash marker and source when automatic promotion hits a transient storage failure", async () => {
    const generationRoot = path.join(
      process.env.ZEROS_DATA_DIR!,
      "sessions",
      "retryable-crash",
      "boundary",
      "generation",
    );
    const localHome = path.join(generationRoot, "home");
    await mkdir(localHome, { recursive: true });
    const crashed = await prepareProviderHomeOverlay({
      providerId: "codex",
      workspaceRoot: workspace,
      localHome,
      ambientEnv: { HOME: hostHome },
    });
    await armProviderHomeRecovery(crashed);
    const privateState = path.join(localHome, ".codex", "retry-me");
    await mkdir(path.dirname(privateState), { recursive: true });
    await writeFile(privateState, "private state\n");
    // Simulate a durable-state read fault that an operator/storage repair can
    // fix before the next boot. Archiving and clearing the marker here would
    // make this state manual-only instead of retryable.
    await writeFile(path.join(crashed.persistentRoot, "state.json"), "{bad");
    const marker = path.join(generationRoot, ".provider-home-recovery.json");

    await expect(
      recoverProviderHomeOverlays({
        sessionsRoot: path.join(process.env.ZEROS_DATA_DIR!, "sessions"),
      }),
    ).resolves.toEqual({
      discovered: 1,
      recovered: 0,
      preserved: 1,
      conflicts: 0,
    });

    await expect(lstat(marker)).resolves.toBeDefined();
    await expect(readFile(privateState, "utf8")).resolves.toBe(
      "private state\n",
    );
  });

  it("replays the keychain merge baseline without persisting a raw host secret in the marker", async () => {
    const keychain = JSON.stringify({
      tokens: { access_token: "host-access", refresh_token: "host-refresh" },
    });
    const credentialSeedReader = async () => ({
      status: "available" as const,
      value: keychain,
    });
    const generationRoot = path.join(
      process.env.ZEROS_DATA_DIR!,
      "sessions",
      "credential-crash",
      "boundary",
      "generation",
    );
    const localHome = path.join(generationRoot, "home");
    await mkdir(localHome, { recursive: true });
    const crashed = await prepareProviderHomeOverlay({
      providerId: "codex",
      workspaceRoot: workspace,
      localHome,
      ambientEnv: { HOME: hostHome },
      credentialSeedReader,
    });
    await armProviderHomeRecovery(crashed);
    const marker = path.join(generationRoot, ".provider-home-recovery.json");
    const markerText = await readFile(marker, "utf8");
    expect(markerText).not.toContain("host-access");
    expect(markerText).not.toContain("host-refresh");
    await writeFile(
      path.join(localHome, ".codex", "auth.json"),
      JSON.stringify({
        tokens: {
          access_token: "sandbox-access",
          refresh_token: "sandbox-refresh",
        },
      }),
      { mode: 0o600 },
    );

    await recoverProviderHomeOverlays({
      sessionsRoot: path.join(process.env.ZEROS_DATA_DIR!, "sessions"),
    });
    const resumed = await prepare(
      "credential-post-crash",
      credentialSeedReader,
    );
    expect(
      JSON.parse(
        await readFile(
          path.join(resumed.localHome, ".codex", "auth.json"),
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

  it("imports only the exact Claude project transcript requested for resume", async () => {
    const targetId = "33333333-3333-4333-8333-333333333333";
    const unrelatedId = "44444444-4444-4444-8444-444444444444";
    const projectRoot = path.join(
      hostHome,
      ".claude",
      "projects",
      "-workspace",
    );
    await mkdir(projectRoot, { recursive: true });
    await Promise.all([
      writeFile(path.join(projectRoot, `${targetId}.jsonl`), "target\n"),
      writeFile(path.join(projectRoot, `${unrelatedId}.jsonl`), ""),
    ]);
    await truncate(
      path.join(projectRoot, `${unrelatedId}.jsonl`),
      129 * 1024 * 1024,
    );
    const localHome = path.join(root, "claude-exact-resume");
    await mkdir(localHome);

    const overlay = await prepareProviderHomeOverlay({
      providerId: "claude",
      providerResumeId: targetId,
      workspaceRoot: workspace,
      localHome,
      ambientEnv: { HOME: hostHome },
    });

    expect(
      await readFile(
        path.join(
          overlay.localHome,
          ".claude",
          "projects",
          "-workspace",
          `${targetId}.jsonl`,
        ),
        "utf8",
      ),
    ).toBe("target\n");
    await expect(
      lstat(
        path.join(
          overlay.localHome,
          ".claude",
          "projects",
          "-workspace",
          `${unrelatedId}.jsonl`,
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
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

  it("restores a keychain credential after a private deletion was tombstoned", async () => {
    const readKeychain = async () => ({
      status: "available" as const,
      value: JSON.stringify({ token: "host-login" }),
    });
    const first = await prepare("keychain-delete", readKeychain);
    const authPath = path.join(first.localHome, ".codex", "auth.json");
    await rm(authPath);
    await promoteProviderHomeOverlay(first);

    const restored = await prepare("keychain-restore", readKeychain);
    expect(
      JSON.parse(
        await readFile(
          path.join(restored.localHome, ".codex", "auth.json"),
          "utf8",
        ),
      ),
    ).toEqual({ token: "host-login" });
  });

  it("does not project an unrelated CLI credential into an explicit API-key session", async () => {
    const readKeychain = async () => ({
      status: "available" as const,
      value: JSON.stringify({ token: "cli-login" }),
    });
    const cli = await prepare("cli-before-api-key", readKeychain);
    await writeFile(
      path.join(cli.localHome, ".codex", "auth.json"),
      JSON.stringify({ token: "cli-refreshed" }),
      { mode: 0o600 },
    );
    await promoteProviderHomeOverlay(cli);

    const apiKeyHome = path.join(root, "explicit-api-key");
    await mkdir(apiKeyHome);
    const apiKey = await prepareProviderHomeOverlay({
      providerId: "codex",
      workspaceRoot: workspace,
      localHome: apiKeyHome,
      ambientEnv: {
        HOME: hostHome,
        OPENAI_API_KEY: "explicit-session-key",
      },
    });
    await expect(
      lstat(path.join(apiKey.localHome, ".codex", "auth.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await mkdir(path.join(apiKey.localHome, ".codex"), { recursive: true });
    await writeFile(
      path.join(apiKey.localHome, ".codex", "auth.json"),
      JSON.stringify({ token: "must-not-cross-auth-modes" }),
      { mode: 0o600 },
    );
    await promoteProviderHomeOverlay(apiKey);

    const cliAgain = await prepare("cli-after-api-key", readKeychain);
    expect(
      JSON.parse(
        await readFile(
          path.join(cliAgain.localHome, ".codex", "auth.json"),
          "utf8",
        ),
      ),
    ).toEqual({ token: "cli-refreshed" });
  });

  it("does not let hard-crash recovery from an explicit API-key session poison CLI auth", async () => {
    const readKeychain = async () => ({
      status: "available" as const,
      value: JSON.stringify({ token: "cli-login" }),
    });
    const cli = await prepare("cli-before-explicit-crash", readKeychain);
    await writeFile(
      path.join(cli.localHome, ".codex", "auth.json"),
      JSON.stringify({ token: "cli-refreshed" }),
      { mode: 0o600 },
    );
    await promoteProviderHomeOverlay(cli);

    const generationRoot = path.join(
      process.env.ZEROS_DATA_DIR!,
      "sessions",
      "explicit-auth-crash",
      "boundary",
      "generation",
    );
    const localHome = path.join(generationRoot, "home");
    await mkdir(localHome, { recursive: true });
    const explicit = await prepareProviderHomeOverlay({
      providerId: "codex",
      workspaceRoot: workspace,
      localHome,
      ambientEnv: {
        HOME: hostHome,
        OPENAI_API_KEY: "explicit-session-key",
      },
    });
    await armProviderHomeRecovery(explicit);
    await mkdir(path.join(localHome, ".codex"), { recursive: true });
    await writeFile(
      path.join(localHome, ".codex", "auth.json"),
      JSON.stringify({ token: "must-not-cross-after-crash" }),
      { mode: 0o600 },
    );

    await expect(
      recoverProviderHomeOverlays({
        sessionsRoot: path.join(process.env.ZEROS_DATA_DIR!, "sessions"),
      }),
    ).resolves.toMatchObject({ recovered: 1, preserved: 0 });

    const cliAgain = await prepare("cli-after-explicit-crash", readKeychain);
    expect(
      JSON.parse(
        await readFile(
          path.join(cliAgain.localHome, ".codex", "auth.json"),
          "utf8",
        ),
      ),
    ).toEqual({ token: "cli-refreshed" });
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
        value: JSON.stringify({
          claudeAiOauth: {
            accessToken: "access",
            refreshToken: "host-only-refresh",
          },
        }),
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

  it("does not conflict when a human adds a file beside a session's own", async () => {
    await mkdir(path.join(hostHome, ".codex", "plugins"), { recursive: true });
    await writeFile(
      path.join(hostHome, ".codex", "plugins", "existing"),
      "base",
    );
    const active = await prepare("shared-directory-a");
    await writeFile(
      path.join(active.localHome, ".codex", "plugins", "agent"),
      "agent\n",
    );
    await writeFile(
      path.join(hostHome, ".codex", "plugins", "human"),
      "human\n",
    );

    expect((await promoteProviderHomeOverlay(active)).conflicts).toEqual([]);
    const next = await prepare("shared-directory-b");
    for (const [name, body] of [
      ["agent", "agent\n"],
      ["human", "human\n"],
      ["existing", "base"],
    ] as const) {
      expect(
        await readFile(
          path.join(next.localHome, ".codex", "plugins", name),
          "utf8",
        ),
      ).toBe(body);
    }
  });

  it("does not re-archive private state each time the host directory changes", async () => {
    const active = await prepare("directory-churn-a");
    // The session creates a directory the host does not have yet.
    await mkdir(path.join(active.localHome, ".codex", "plugins"), {
      recursive: true,
    });
    await writeFile(
      path.join(active.localHome, ".codex", "plugins", "agent"),
      "agent\n",
    );
    await promoteProviderHomeOverlay(active);

    // A human (or another tool) then works inside the same directory on the
    // host between every session. That must not be read as a conflict over
    // the directory itself, admission after admission.
    for (const round of ["first", "second"]) {
      await mkdir(path.join(hostHome, ".codex", "plugins"), {
        recursive: true,
      });
      await writeFile(
        path.join(hostHome, ".codex", "plugins", round),
        `${round}\n`,
      );
      const next = await prepare(`directory-churn-${round}`);
      expect(next.preparationConflicts).toEqual([]);
      expect(
        await readFile(
          path.join(next.localHome, ".codex", "plugins", "agent"),
          "utf8",
        ),
      ).toBe("agent\n");
      await promoteProviderHomeOverlay(next);
    }
    await expect(
      readdir(path.join(active.persistentRoot, "conflicts")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never conflicts over a SQLite sidecar the provider deletes on close", async () => {
    // The measured cycle, reproduced end to end: the host holds an open
    // database's `-wal`/`-shm`, the session's provider closes the database and
    // SQLite removes them, promotion would record a tombstone, and the next
    // admission would find host != recorded base with a durable tombstone —
    // a conflict, an archive and a private reset on every admission, forever.
    // 92% of every conflict this engine has archived on the Mac was this.
    await mkdir(path.join(hostHome, ".codex"), { recursive: true });
    await Promise.all([
      writeFile(path.join(hostHome, ".codex", "config.toml"), "model='a'\n"),
      writeFile(path.join(hostHome, ".codex", "goals_1.sqlite"), "db\n"),
      writeFile(path.join(hostHome, ".codex", "goals_1.sqlite-wal"), "wal-1\n"),
      writeFile(path.join(hostHome, ".codex", "goals_1.sqlite-shm"), "shm-1\n"),
    ]);

    const active = await prepare("sqlite-sidecar-a");
    // The database itself is real state and is still projected.
    expect(
      await readFile(
        path.join(active.localHome, ".codex", "goals_1.sqlite"),
        "utf8",
      ),
    ).toBe("db\n");
    for (const sidecar of ["goals_1.sqlite-wal", "goals_1.sqlite-shm"]) {
      await expect(
        lstat(path.join(active.localHome, ".codex", sidecar)),
      ).rejects.toMatchObject({ code: "ENOENT" });
      // What SQLite does on a clean close: checkpoint, then remove both
      // sidecars. This is the step that used to leave a durable tombstone for a
      // path the host still holds.
      await rm(path.join(active.localHome, ".codex", sidecar), { force: true });
    }
    expect((await promoteProviderHomeOverlay(active)).conflicts).toEqual([]);

    // The host's own Codex keeps writing, so both sidecars move under us.
    await Promise.all([
      writeFile(path.join(hostHome, ".codex", "goals_1.sqlite-wal"), "wal-2\n"),
      writeFile(path.join(hostHome, ".codex", "goals_1.sqlite-shm"), "shm-2\n"),
    ]);

    for (const round of ["first", "second"]) {
      const next = await prepare(`sqlite-sidecar-${round}`);
      expect(next.preparationConflicts).toEqual([]);
      expect(
        await readFile(
          path.join(next.localHome, ".codex", "config.toml"),
          "utf8",
        ),
      ).toBe("model='a'\n");
      expect((await promoteProviderHomeOverlay(next)).conflicts).toEqual([]);
    }
    await expect(
      readdir(path.join(active.persistentRoot, "conflicts")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    // Nothing about the sidecars reached the durable store either, so there is
    // no tombstone left to conflict with a later host write.
    expect(
      JSON.parse(
        await readFile(path.join(active.persistentRoot, "state.json"), "utf8"),
      ),
    ).toMatchObject({ tombstones: [] });
  });

  it("still merges a database whose name only resembles a sidecar", async () => {
    // The pattern is anchored to a database extension so an ordinary file that
    // happens to end in `-journal` keeps its normal three-way merge.
    await mkdir(path.join(hostHome, ".codex"), { recursive: true });
    await writeFile(path.join(hostHome, ".codex", "notes-journal"), "host\n");

    const active = await prepare("sidecar-lookalike");
    expect(
      await readFile(
        path.join(active.localHome, ".codex", "notes-journal"),
        "utf8",
      ),
    ).toBe("host\n");
    await writeFile(
      path.join(active.localHome, ".codex", "notes-journal"),
      "session\n",
    );
    expect((await promoteProviderHomeOverlay(active)).conflicts).toEqual([]);

    const next = await prepare("sidecar-lookalike-next");
    expect(
      await readFile(
        path.join(next.localHome, ".codex", "notes-journal"),
        "utf8",
      ),
    ).toBe("session\n");
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

  it("carries the MCP OAuth token store in and promotes refreshed tokens back", async () => {
    // Without this, a remote MCP server finds no tokens in the contained HOME,
    // starts a browser authorization flow that a headless session can never
    // complete, and is killed when the provider's MCP connect budget expires —
    // 60s of the user's first message, every session. Promotion is what makes
    // authorizing once on the host stick instead of being discarded at teardown.
    const tokens = path.join(
      ".mcp-auth",
      "mcp-remote-0.1.38",
      "abc_tokens.json",
    );
    await mkdir(path.dirname(path.join(hostHome, tokens)), { recursive: true });
    await writeFile(path.join(hostHome, tokens), '{"access_token":"host"}');

    const overlay = await prepare("mcp-auth");
    expect(
      (await lstat(path.join(overlay.localHome, ".mcp-auth"))).isSymbolicLink(),
    ).toBe(false);
    expect(await readFile(path.join(overlay.localHome, tokens), "utf8")).toBe(
      '{"access_token":"host"}',
    );

    // A refresh inside the session must survive teardown, or every session
    // re-authenticates no matter how often the user authorizes on the host.
    await writeFile(
      path.join(overlay.localHome, tokens),
      '{"access_token":"refreshed"}',
    );
    await promoteProviderHomeOverlay(overlay);
    expect(await readFile(path.join(overlay.contentRoot, tokens), "utf8")).toBe(
      '{"access_token":"refreshed"}',
    );
  });

  it("links npm's caches so an npx MCP server resolves without re-downloading", async () => {
    // An `npx <package>` MCP server is spawned while the user's first message
    // waits. Without these two links the projected HOME has no npm cache, so
    // npx re-downloads from the registry every session and overruns the
    // provider's MCP startup budget. `.npm` itself must stay a real writable
    // directory — npm writes `_logs` there.
    await Promise.all([
      mkdir(path.join(hostHome, ".npm", "_npx"), { recursive: true }),
      mkdir(path.join(hostHome, ".npm", "_cacache"), { recursive: true }),
    ]);
    const overlay = await prepare("npm-cache-links");
    expect(await readlink(path.join(overlay.localHome, ".npm", "_npx"))).toBe(
      path.join(hostHome, ".npm", "_npx"),
    );
    expect(
      await readlink(path.join(overlay.localHome, ".npm", "_cacache")),
    ).toBe(path.join(hostHome, ".npm", "_cacache"));
    expect(
      (await lstat(path.join(overlay.localHome, ".npm"))).isSymbolicLink(),
    ).toBe(false);
    expect(overlay.readOnlyHostRoots).toEqual(
      expect.arrayContaining([
        path.join(hostHome, ".npm", "_npx"),
        path.join(hostHome, ".npm", "_cacache"),
      ]),
    );
  });

  it("reuses a proven digest instead of re-reading unchanged provider state", async () => {
    await mkdir(path.join(hostHome, ".codex"), { recursive: true });
    await writeFile(
      path.join(hostHome, ".codex", "config.toml"),
      "model='host'\n",
    );
    // Provider state has to be older than the settle window before its digest
    // may be remembered, so advance the clock instead of sleeping through it.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_000);
    const first = await prepare("digest-manifest-1");
    const manifestPath = path.join(
      first.persistentRoot,
      "digest-manifest.json",
    );
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      entries: Record<string, string>;
    };
    expect(Object.keys(manifest.entries).length).toBeGreaterThan(0);
    expect((await lstat(manifestPath)).mode & 0o077).toBe(0);

    // Every remembered digest is replaced with a marker no hashing pass could
    // produce: a second admission that still reports it never re-read a byte.
    const marker = "b".repeat(64);
    await writeFile(
      manifestPath,
      JSON.stringify({
        version: 1,
        entries: Object.fromEntries(
          Object.keys(manifest.entries).map((identity) => [identity, marker]),
        ),
      }),
    );

    const second = await prepare("digest-manifest-2");
    const config = path.join(".codex", "config.toml");
    expect(second.baselineHost.get(config)).toMatchObject({
      kind: "file",
      digest: marker,
    });
    // The private HOME's merge baseline is derived from that same proof rather
    // than a second full hashing pass over bytes this process just wrote.
    expect(second.baselineLocal.get(config)).toMatchObject({
      kind: "file",
      digest: marker,
    });
  });

  it("keys a remembered digest on nanoseconds, and on ctime the child cannot rewind", async () => {
    await mkdir(path.join(hostHome, ".codex"), { recursive: true });
    const config = path.join(hostHome, ".codex", "config.toml");
    await writeFile(config, "model='host'\n");
    // A whole-second mtime, chosen here rather than taken from the clock, so
    // restoring it below is exact: a `BigIntStats.mtime` Date is rounded from
    // nanoseconds while `mtimeMs` is truncated from them, and the two disagree
    // by a millisecond often enough to make a round trip through `utimes` flaky.
    const restored = 1_700_000_000;
    await utimes(config, restored, restored);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_000);
    const first = await prepare("digest-identity-1");
    const manifest = JSON.parse(
      await readFile(
        path.join(first.persistentRoot, "digest-manifest.json"),
        "utf8",
      ),
    ) as { entries: Record<string, string> };

    // A reused projection trusts its recorded identities across time rather
    // than for the few milliseconds between one copy and the snapshot that
    // follows it, so the key has to be able to separate two writes inside one
    // clock tick. Millisecond fields cannot.
    const exact = await lstat(config, { bigint: true });
    const keys = Object.keys(manifest.entries);
    expect(keys).toContain(
      [
        "v2",
        exact.dev,
        exact.ino,
        exact.size,
        exact.mtimeNs,
        exact.ctimeNs,
        exact.mode,
      ].join(":"),
    );

    // And ctime is in the key because a contained child can move mtime
    // backwards but cannot move ctime at all: restoring the old mtime over new
    // bytes of the SAME LENGTH leaves ctime as the only field that moved, and
    // that still has to read as a change.
    await writeFile(config, "model='edit'\n");
    await utimes(config, restored, restored);
    const rewritten = await lstat(config, { bigint: true });
    expect(rewritten.mtimeNs).toBe(exact.mtimeNs);
    expect(rewritten.size).toBe(exact.size);
    expect(rewritten.ctimeNs).not.toBe(exact.ctimeNs);
    const relative = path.join(".codex", "config.toml");
    const second = await prepare("digest-identity-2");
    expect(second.baselineHost.get(relative)).not.toEqual(
      first.baselineHost.get(relative),
    );
    expect(await readFile(path.join(second.localHome, relative), "utf8")).toBe(
      "model='edit'\n",
    );
  });

  it("still detects a host edit that arrives after a remembered digest", async () => {
    await mkdir(path.join(hostHome, ".codex"), { recursive: true });
    await writeFile(
      path.join(hostHome, ".codex", "config.toml"),
      "model='host'\n",
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_000);
    const first = await prepare("digest-change-1");
    const before = first.baselineHost.get(path.join(".codex", "config.toml"));

    await writeFile(
      path.join(hostHome, ".codex", "config.toml"),
      "model='edited'\n",
    );
    const second = await prepare("digest-change-2");
    expect(
      second.baselineHost.get(path.join(".codex", "config.toml")),
    ).not.toEqual(before);
    expect(
      await readFile(
        path.join(second.localHome, ".codex", "config.toml"),
        "utf8",
      ),
    ).toBe("model='edited'\n");
  });

  it("admits a session through an unusable change-detection manifest", async () => {
    await mkdir(path.join(hostHome, ".codex"), { recursive: true });
    await writeFile(
      path.join(hostHome, ".codex", "config.toml"),
      "model='host'\n",
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_000);
    const config = path.join(".codex", "config.toml");
    const first = await prepare("digest-corrupt-1");
    const truth = first.baselineHost.get(config);
    const manifestPath = path.join(
      first.persistentRoot,
      "digest-manifest.json",
    );

    await writeFile(manifestPath, "{ not json");
    const second = await prepare("digest-corrupt-2");
    expect(second.baselineHost.get(config)).toEqual(truth);

    // A manifest another account could have rewritten is discarded outright
    // rather than consulted for even one entry.
    await chmod(manifestPath, 0o644);
    const third = await prepare("digest-corrupt-3");
    expect(third.baselineHost.get(config)).toEqual(truth);
    expect((await lstat(manifestPath)).mode & 0o077).toBe(0);
  });

  describe("parked provider worlds", () => {
    /** Where `prewarmProviderHomeOverlay` publishes, so a test can inspect and
     * corrupt what an admission is about to adopt. */
    function parkRoot(providerId = "codex") {
      return path.join(
        process.env.ZEROS_DATA_DIR!,
        "provider-home-parked",
        providerId,
      );
    }

    async function parkedKeys(providerId = "codex") {
      try {
        return (await readdir(parkRoot(providerId))).sort();
      } catch {
        return [];
      }
    }

    async function parkedCurrent(providerId = "codex") {
      const keys = await parkedKeys(providerId);
      expect(keys).toHaveLength(1);
      return path.join(parkRoot(providerId), keys[0]!, "current");
    }

    function prewarm() {
      return prewarmProviderHomeOverlay({
        providerId: "codex",
        workspaceRoot: workspace,
        ambientEnv: { HOME: hostHome },
      });
    }

    async function seedHost() {
      await mkdir(path.join(hostHome, ".codex", "prompts"), {
        recursive: true,
      });
      await Promise.all([
        writeFile(path.join(hostHome, ".codex", "config.toml"), "model='a'\n"),
        writeFile(
          path.join(hostHome, ".codex", "prompts", "one.md"),
          "prompt\n",
        ),
      ]);
    }

    /** Everything an admission's merge is answerable for, plus the bytes. Two
     * projections that agree here are indistinguishable to every later stage. */
    async function projection(overlay: {
      readonly localHome: string;
      readonly baselineLocal: ReadonlyMap<string, unknown>;
    }) {
      const files: Array<readonly [string, string]> = [];
      const walk = async (absolute: string, relative: string) => {
        for (const entry of (
          await readdir(absolute, { withFileTypes: true })
        ).sort((left, right) => left.name.localeCompare(right.name))) {
          const child = path.join(absolute, entry.name);
          const key = relative ? path.join(relative, entry.name) : entry.name;
          if (entry.isSymbolicLink()) {
            files.push([key, `symlink:${await readlink(child)}`]);
          } else if (entry.isDirectory()) {
            files.push([key, "dir"]);
            await walk(child, key);
          } else {
            const stat = await lstat(child);
            files.push([
              key,
              `${(stat.mode & 0o777).toString(8)}:${await readFile(child, "utf8")}`,
            ]);
          }
        }
      };
      await walk(overlay.localHome, "");
      return {
        files,
        baseline: [...overlay.baselineLocal].sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      };
    }

    it("adopts a prewarmed world that is byte-identical to a fresh build", async () => {
      await seedHost();
      // A session's own promoted state has to survive the reuse too, not just
      // the host seed, so give the durable store something of its own first.
      const first = await prepare("park-lossless-seed");
      await writeFile(
        path.join(first.localHome, ".codex", "private.json"),
        '{"kept":true}\n',
      );
      await promoteProviderHomeOverlay(first);

      const reference = await prepare("park-lossless-reference");
      expect(reference.parked).toBe("miss");
      const expected = await projection(reference);

      expect(await prewarm()).toBe(true);
      const parkedInode = (
        await lstat(path.join(await parkedCurrent(), "world"))
      ).ino;
      const adopting = await prepare("park-lossless-adopting");
      expect(adopting.parked).toBe("hit");
      expect(await projection(adopting)).toEqual(expected);
      // The whole point: adoption is a rename, not a copy. Same inode means no
      // byte and no directory entry of that tree was walked again.
      expect((await lstat(adopting.localHome)).ino).toBe(parkedInode);
      // Byte-identical includes the private state, not just the host seed.
      expect(
        await readFile(
          path.join(adopting.localHome, ".codex", "private.json"),
          "utf8",
        ),
      ).toBe('{"kept":true}\n');
      // Consumed exactly once: the second admission finds nothing to claim.
      const after = await prepare("park-lossless-after");
      expect(after.parked).toBe("miss");
      expect(await projection(after)).toEqual(expected);
    });

    it("never carries what a session wrote into the next admission", async () => {
      await seedHost();
      expect(await prewarm()).toBe(true);
      const session = await prepare("park-leak-session");
      expect(session.parked).toBe("hit");
      // Exactly what a hostile or careless child does inside its private HOME.
      await writeFile(
        path.join(session.localHome, ".codex", "secret.txt"),
        "session-secret\n",
      );
      await mkdir(path.join(session.localHome, ".codex", "scratch"), {
        recursive: true,
      });
      await writeFile(
        path.join(session.localHome, ".codex", "scratch", "leak"),
        "leak\n",
      );
      // No promotion: nothing here was ever meant to become durable.

      expect(await prewarm()).toBe(true);
      const next = await prepare("park-leak-next");
      expect(next.parked).toBe("hit");
      for (const relative of [
        path.join(".codex", "secret.txt"),
        path.join(".codex", "scratch"),
      ]) {
        await expect(
          lstat(path.join(next.localHome, relative)),
        ).rejects.toMatchObject({ code: "ENOENT" });
      }
    });

    it("misses rather than reusing a world when the host tree moved", async () => {
      await seedHost();
      expect(await prewarm()).toBe(true);
      await writeFile(
        path.join(hostHome, ".codex", "config.toml"),
        "model='b'\n",
      );

      const next = await prepare("park-host-moved");
      expect(next.parked).toBe("miss");
      expect(
        await readFile(
          path.join(next.localHome, ".codex", "config.toml"),
          "utf8",
        ),
      ).toBe("model='b'\n");
    });

    it("misses rather than reusing a world when the host deleted a file", async () => {
      await seedHost();
      expect(await prewarm()).toBe(true);
      await rm(path.join(hostHome, ".codex", "prompts", "one.md"));

      const next = await prepare("park-host-deleted");
      expect(next.parked).toBe("miss");
      await expect(
        lstat(path.join(next.localHome, ".codex", "prompts", "one.md")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("misses rather than reusing a world built for another provider-state scope", async () => {
      await seedHost();
      expect(await prewarm()).toBe(true);
      // §20.4 #6: CODEX_HOME is part of what shapes the projection, so a scope
      // change has to be a miss and never a silent reuse.
      const scoped = path.join(root, "other-codex-home");
      await mkdir(scoped, { recursive: true });
      await writeFile(path.join(scoped, "config.toml"), "model='scoped'\n");
      const localHome = path.join(root, "park-env-scope");
      await mkdir(localHome, { recursive: true });
      const next = await prepareProviderHomeOverlay({
        providerId: "codex",
        workspaceRoot: workspace,
        localHome,
        ambientEnv: { HOME: hostHome, CODEX_HOME: scoped },
      });
      expect(next.parked).toBe("miss");
      expect(
        await readFile(
          path.join(next.localHome, ".codex", "config.toml"),
          "utf8",
        ),
      ).toBe("model='scoped'\n");
    });

    it("misses rather than reusing a world built by another build of the engine", async () => {
      await seedHost();
      expect(await prewarm()).toBe(true);
      const current = await parkedCurrent();
      const manifestPath = path.join(current, "park.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        stamp: string;
      };
      // The stamp folds in this module's on-disk identity, so a rebuilt engine
      // presents a different one. Forge that by rewriting the recorded stamp.
      await writeFile(
        manifestPath,
        JSON.stringify({ ...manifest, stamp: "c".repeat(64) }),
        { mode: 0o600 },
      );

      const next = await prepare("park-build-changed");
      expect(next.parked).toBe("miss");
      expect(
        await readFile(
          path.join(next.localHome, ".codex", "config.toml"),
          "utf8",
        ),
      ).toBe("model='a'\n");
      // And the rejected world is destroyed rather than left to be retried.
      await expect(lstat(current)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("discards a world whose build was interrupted instead of adopting it", async () => {
      await seedHost();
      expect(await prewarm()).toBe(true);
      const current = await parkedCurrent();
      // A crash between materializing the tree and publishing its manifest.
      await rm(path.join(current, "park.json"));

      const next = await prepare("park-partial");
      expect(next.parked).toBe("miss");
      expect(
        await readFile(
          path.join(next.localHome, ".codex", "config.toml"),
          "utf8",
        ),
      ).toBe("model='a'\n");
      await expect(lstat(current)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("refuses a parked manifest another account could have rewritten", async () => {
      await seedHost();
      expect(await prewarm()).toBe(true);
      const current = await parkedCurrent();
      await chmod(path.join(current, "park.json"), 0o644);

      const next = await prepare("park-world-readable");
      expect(next.parked).toBe("miss");
    });

    it("keeps a conversation's resume seeds out of the world it parks", async () => {
      // §20.4 #4: a resume seed belongs to one conversation, so it must be
      // applied after adoption and never baked into a shared artifact.
      const transcript = path.join(
        hostHome,
        ".codex",
        ...CODEX_TRANSCRIPT,
        "rollout-2026-08-16T00-00-00-11111111-1111-4111-8111-111111111111.jsonl",
      );
      await mkdir(path.dirname(transcript), { recursive: true });
      await writeFile(transcript, '{"id":"one"}\n');
      await seedHost();
      expect(await prewarm()).toBe(true);

      const current = await parkedCurrent();
      await expect(
        lstat(path.join(current, "world", ".codex", "sessions")),
      ).rejects.toMatchObject({ code: "ENOENT" });

      const localHome = path.join(root, "park-resume");
      await mkdir(localHome, { recursive: true });
      const resumed = await prepareProviderHomeOverlay({
        providerId: "codex",
        workspaceRoot: workspace,
        localHome,
        ambientEnv: { HOME: hostHome },
        providerResumeId: "11111111-1111-4111-8111-111111111111",
      });
      expect(resumed.parked).toBe("hit");
      expect(
        await readFile(
          path.join(
            resumed.localHome,
            ".codex",
            ...CODEX_TRANSCRIPT,
            path.basename(transcript),
          ),
          "utf8",
        ),
      ).toBe('{"id":"one"}\n');
    });

    it("reclaims crash debris and worlds nothing adopted", async () => {
      await seedHost();
      expect(await prewarm()).toBe(true);
      const keys = await parkedKeys();
      const keyRoot = path.join(parkRoot(), keys[0]!);
      // A minute on, so `current` is past the (1 s) projection retention while a
      // build started "now" is still far inside the (1 h) debris window.
      const now = Date.now() + 60_000;
      const stale = new Date(now - 2 * 60 * 60 * 1000);
      for (const name of ["building-abc", "claimed-def", "stale-ghi"]) {
        await mkdir(path.join(keyRoot, name, "world"), { recursive: true });
        await utimes(path.join(keyRoot, name), stale, stale);
      }
      // A live build is protected by being newer, not by being listed.
      await mkdir(path.join(keyRoot, "building-live", "world"), {
        recursive: true,
      });

      await expect(
        sweepProviderHomeStorage({ now, unusedProjectionRetentionMs: 1_000 }),
      ).resolves.toMatchObject({ parkedWorldsReclaimed: 4 });
      for (const name of ["building-abc", "claimed-def", "stale-ghi"]) {
        await expect(lstat(path.join(keyRoot, name))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
      await expect(
        lstat(path.join(keyRoot, "building-live")),
      ).resolves.toBeDefined();
      await expect(lstat(path.join(keyRoot, "current"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });

    it("refills the most recently used worlds at boot, newest first and bounded", async () => {
      await seedHost();
      // Three keys that have each been through a real prewarm, so each recorded
      // its own inputs. Recency decides which a bounded boot refill rebuilds.
      const scopes = ["scope-old", "scope-mid", "scope-new"];
      for (const stateScope of scopes) {
        expect(
          await prewarmProviderHomeOverlay({
            providerId: "codex",
            workspaceRoot: workspace,
            stateScope,
            providerStateEnv: { HOME: hostHome },
          }),
        ).toBe(true);
      }
      const keys = await parkedKeys();
      expect(keys).toHaveLength(3);
      // Age the recorded inputs apart, then drop every parked world so a refill
      // has something to do and its choice is observable.
      const inputs = keys.map((key) =>
        path.join(parkRoot(), key, "warm-inputs.json"),
      );
      const scopeOf = new Map<string, string>();
      for (const file of inputs) {
        const recorded = JSON.parse(await readFile(file, "utf8")) as {
          stateScope: string;
        };
        scopeOf.set(path.dirname(file), recorded.stateScope);
      }
      const ordered = [...scopeOf].sort(
        ([, left], [, right]) => scopes.indexOf(left) - scopes.indexOf(right),
      );
      for (const [index, [keyRoot]] of ordered.entries()) {
        await rm(path.join(keyRoot, "current"), {
          recursive: true,
          force: true,
        });
        const at = new Date(Date.now() - (ordered.length - index) * 60_000);
        await utimes(path.join(keyRoot, "warm-inputs.json"), at, at);
      }

      expect(await refillParkedProviderWorlds({ limit: 2 })).toBe(2);
      // The two newest keys are ready again; the oldest is deliberately not.
      const readied = await Promise.all(
        ordered.map(async ([keyRoot]) => {
          try {
            await lstat(path.join(keyRoot, "current", "park.json"));
            return true;
          } catch {
            return false;
          }
        }),
      );
      expect(readied).toEqual([false, true, true]);

      // And the refilled world is adoptable by a real admission for its scope.
      const localHome = path.join(root, "park-refill-adopt");
      await mkdir(localHome, { recursive: true });
      const adopting = await prepareProviderHomeOverlay({
        providerId: "codex",
        workspaceRoot: workspace,
        stateScope: "scope-new",
        localHome,
        ambientEnv: { HOME: hostHome },
      });
      expect(adopting.parked).toBe("hit");
    });

    it("refuses recorded prewarm inputs another account could have rewritten", async () => {
      await seedHost();
      expect(
        await prewarmProviderHomeOverlay({
          providerId: "codex",
          workspaceRoot: workspace,
          providerStateEnv: { HOME: hostHome },
        }),
      ).toBe(true);
      const keys = await parkedKeys();
      const file = path.join(parkRoot(), keys[0]!, "warm-inputs.json");
      await rm(path.join(parkRoot(), keys[0]!, "current"), {
        recursive: true,
        force: true,
      });
      await chmod(file, 0o666);

      expect(await refillParkedProviderWorlds({ limit: 4 })).toBe(0);
    });

    it("still adopts when the boundary's own per-generation denied roots differ", async () => {
      // The 2026-08-18 00:33 log reported `parked=miss` on EVERY admission right
      // after "prewarmed 4 provider world(s)". Cause: `denyRead` carries
      // `paths.policy`, `paths.commands` and `paths.networkRuntime`, two of them
      // under `sessions/<executionId>/boundary/<generation>/` and one under
      // `/private/tmp/zeros-zn-<generation>/`, so a stamp containing them changes
      // on every admission and nothing is ever reusable.
      await seedHost();
      const generationRoots = (generation: string) => [
        path.join(root, "sessions", generation, "boundary", "policy.json"),
        path.join(root, "sessions", generation, "boundary", "commands"),
        path.join(root, "tmp", `zeros-zn-${generation}`, "runtime"),
      ];
      const stable = [path.join(root, "stable-denied")];

      expect(
        await prewarmProviderHomeOverlay({
          providerId: "codex",
          workspaceRoot: workspace,
          providerStateEnv: { HOME: hostHome },
          deniedSourceRoots: [...stable, ...generationRoots("gen-a")],
          generationScopedDeniedRoots: generationRoots("gen-a"),
        }),
      ).toBe(true);

      const localHome = path.join(root, "park-generation-denied");
      await mkdir(localHome, { recursive: true });
      const adopting = await prepareProviderHomeOverlay({
        providerId: "codex",
        workspaceRoot: workspace,
        localHome,
        ambientEnv: { HOME: hostHome },
        deniedSourceRoots: [...stable, ...generationRoots("gen-b")],
        generationScopedDeniedRoots: generationRoots("gen-b"),
      });
      expect(adopting.parked).toBe("hit");

      // A denied root that is NOT generation-scoped still has to move the stamp,
      // because it is a real difference in what the projection would refuse.
      expect(
        await prewarmProviderHomeOverlay({
          providerId: "codex",
          workspaceRoot: workspace,
          providerStateEnv: { HOME: hostHome },
          deniedSourceRoots: [...stable, ...generationRoots("gen-c")],
          generationScopedDeniedRoots: generationRoots("gen-c"),
        }),
      ).toBe(true);
      const other = path.join(root, "park-other-denied");
      await mkdir(other, { recursive: true });
      const changed = await prepareProviderHomeOverlay({
        providerId: "codex",
        workspaceRoot: workspace,
        localHome: other,
        ambientEnv: { HOME: hostHome },
        deniedSourceRoots: [
          path.join(root, "different-stable-denied"),
          ...generationRoots("gen-d"),
        ],
        generationScopedDeniedRoots: generationRoots("gen-d"),
      });
      expect(changed.parked).toBe("miss");
    });

    it("keeps a denied root that another denied root already covers out of the stamp", async () => {
      // Reducing the set to minimal covering roots leaves the containment
      // predicate exactly as strict, so it must not be observable as a miss.
      await seedHost();
      const parent = path.join(root, "denied-parent");
      expect(
        await prewarmProviderHomeOverlay({
          providerId: "codex",
          workspaceRoot: workspace,
          providerStateEnv: { HOME: hostHome },
          deniedSourceRoots: [parent],
        }),
      ).toBe(true);
      const localHome = path.join(root, "park-covered-denied");
      await mkdir(localHome, { recursive: true });
      const adopting = await prepareProviderHomeOverlay({
        providerId: "codex",
        workspaceRoot: workspace,
        localHome,
        ambientEnv: { HOME: hostHome },
        deniedSourceRoots: [parent, path.join(parent, "child", "deeper")],
      });
      expect(adopting.parked).toBe("hit");
    });

    it("declines to park at all when parking is disabled", async () => {
      await seedHost();
      process.env.ZEROS_ZSR_DISABLE_PARKED_PROVIDER_HOME = "1";
      try {
        expect(await prewarm()).toBe(false);
        const next = await prepare("park-disabled");
        expect(next.parked).toBe("miss");
        expect(await parkedKeys()).toEqual([]);
      } finally {
        delete process.env.ZEROS_ZSR_DISABLE_PARKED_PROVIDER_HOME;
      }
    });
  });

  it("prunes expired provider state archives and keeps recent ones", async () => {
    const overlay = await prepare("archive-retention");
    const conflicts = path.join(overlay.persistentRoot, "conflicts");
    const recovery = path.join(overlay.persistentRoot, "recovery");
    const now = Date.now();
    const stale = new Date(now - 30 * 24 * 60 * 60 * 1000);
    for (const [directory, name, at] of [
      [conflicts, "fresh", new Date(now)],
      [conflicts, "expired", stale],
      [recovery, "expired", stale],
    ] as const) {
      await mkdir(path.join(directory, name), { recursive: true });
      await writeFile(path.join(directory, name, "entry"), "archived\n");
      await utimes(path.join(directory, name), at, at);
    }

    await expect(sweepProviderHomeStorage({ now })).resolves.toMatchObject({
      archivesRemoved: 2,
      projectionsReclaimed: 0,
    });
    await expect(lstat(path.join(conflicts, "fresh"))).resolves.toBeDefined();
    await expect(lstat(path.join(conflicts, "expired"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(lstat(path.join(recovery, "expired"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reclaims an unused projection that holds no private state", async () => {
    await mkdir(path.join(hostHome, ".codex"), { recursive: true });
    await writeFile(
      path.join(hostHome, ".codex", "config.toml"),
      "model='host'\n",
    );
    // A probe's lifecycle: a full admission that promotes nothing of its own.
    const orphan = await prepare("probe-orphan");
    await promoteProviderHomeOverlay(orphan);
    const owned = await prepareProviderHomeOverlay({
      providerId: "codex",
      workspaceRoot: workspace,
      stateScope: "owned-scope",
      localHome: await mkdir(path.join(root, "owned"), {
        recursive: true,
      }).then(() => path.join(root, "owned")),
      ambientEnv: { HOME: hostHome },
    });
    await writeFile(
      path.join(owned.localHome, ".codex", "config.toml"),
      "model='private'\n",
    );
    await promoteProviderHomeOverlay(owned);

    await expect(
      sweepProviderHomeStorage({
        now: Date.now() + 60_000,
        unusedProjectionRetentionMs: 1_000,
      }),
    ).resolves.toMatchObject({ projectionsReclaimed: 1, retained: 0 });
    await expect(lstat(orphan.persistentRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      await readFile(
        path.join(owned.contentRoot, ".codex", "config.toml"),
        "utf8",
      ),
    ).toBe("model='private'\n");
  });

  it("projects two sibling aliases of one directory without calling it a cycle", async () => {
    // Cycle detection used to be a single Set mutated on the way down and
    // cleaned up on the way out — equivalent to an ancestor chain only while
    // siblings are walked strictly one at a time. With siblings overlapping,
    // two aliases of the SAME directory (entirely legal: two plugin links into
    // one shared pack) would see each other in that set and be reported as a
    // cycle that does not exist. The chain is per-branch for this reason.
    const shared = path.join(root, "shared-pack");
    await mkdir(path.join(shared, "src"), { recursive: true });
    await writeFile(path.join(shared, "src", "tool.json"), '{"ok":true}\n');
    const codexHome = path.join(hostHome, ".codex");
    await mkdir(path.join(codexHome, "plugins"), { recursive: true });
    await symlink(shared, path.join(codexHome, "plugins", "alpha"), "dir");
    await symlink(shared, path.join(codexHome, "plugins", "beta"), "dir");

    const overlay = await prepare("sibling-aliases");

    for (const alias of ["alpha", "beta"]) {
      await expect(
        readFile(
          path.join(
            overlay.localHome,
            ".codex",
            "plugins",
            alias,
            "src",
            "tool.json",
          ),
          "utf8",
        ),
      ).resolves.toBe('{"ok":true}\n');
    }
  });

  it("still refuses a provider state tree that genuinely loops", async () => {
    // The guard above must not have been weakened into uselessness: a real
    // ancestor repeat is still a cycle and still fails closed.
    const codexHome = path.join(hostHome, ".codex");
    const loop = path.join(codexHome, "plugins", "loop");
    await mkdir(loop, { recursive: true });
    await symlink(loop, path.join(loop, "self"), "dir");

    await expect(prepare("looping-state")).rejects.toThrow(/cycle/i);
  });

  it("keeps an unused projection that is still holding an archive", async () => {
    const overlay = await prepare("archived-projection");
    const archive = path.join(overlay.persistentRoot, "conflicts", "kept");
    await mkdir(archive, { recursive: true });
    await writeFile(path.join(archive, "entry"), "archived\n");

    await expect(
      sweepProviderHomeStorage({
        now: Date.now() + 60_000,
        unusedProjectionRetentionMs: 1_000,
      }),
    ).resolves.toMatchObject({ projectionsReclaimed: 0 });
    await expect(lstat(overlay.persistentRoot)).resolves.toBeDefined();
  });
});
