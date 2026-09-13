import {
  appendFile,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readClaudeConnectorCredential } from "../../src/engine/agents/adapters/claude-sdk/connector-membership";
import { readClaudeUsageToken } from "../provider-usage-readers";

const hooks = vi.hoisted(() => ({
  afterInspect: undefined as ((file: string) => Promise<void>) | undefined,
  handles: [] as { fd: number }[],
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    // Mutate the real file after inspection, whether the caller inspects a
    // pathname or an already-open descriptor.
    stat: async (file: string) => {
      const info = await actual.stat(file);
      await hooks.afterInspect?.(file);
      return info;
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      hooks.handles.push(handle);
      const inspect = handle.stat.bind(handle);
      vi.spyOn(handle, "stat").mockImplementation(async () => {
        const info = await inspect();
        await hooks.afterInspect?.(String(args[0]));
        return info;
      });
      return handle;
    },
  };
});

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  // Exercise the file fallback on macOS without accessing a real Keychain.
  execFile: vi.fn((...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error) => void;
    callback(Object.assign(new Error("Missing fixture item."), { code: 44 }));
  }),
}));

vi.mock(
  "../../src/engine/agents/containment/claude-oauth-authority",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../src/engine/agents/containment/claude-oauth-authority")
    >()),
    defaultMacClaudeOAuthAuthority: vi.fn().mockReturnValue(null),
  }),
);

const readers = [
  { name: "usage", read: readClaudeUsageToken },
  {
    name: "connectors",
    read: (configDir: string, signal: AbortSignal) =>
      readClaudeConnectorCredential({ CLAUDE_CONFIG_DIR: configDir }, signal),
  },
];

function credential(token = "fixture-selected-token"): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: token,
      scopes: ["user:mcp_servers"],
      expiresAt: Date.now() + 60_000,
    },
  });
}

describe.each(readers)("Claude $name credential file", ({ read }) => {
  let directory: string;
  let file: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "zeros-credential-read-"));
    file = path.join(directory, ".credentials.json");
    await writeFile(file, credential());
  });
  afterEach(async () => {
    hooks.afterInspect = undefined;
    const handles = hooks.handles.splice(0);
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
    expect(handles.every((handle) => handle.fd === -1)).toBe(true);
  });

  it("keeps reading the inspected file when its pathname is replaced", async () => {
    hooks.afterInspect = async (inspected) => {
      if (inspected !== file) return;
      hooks.afterInspect = undefined;
      await rename(file, `${file}.previous`);
      await writeFile(file, credential("fixture-replacement-token"));
    };

    expect(await read(directory, new AbortController().signal)).toBe(
      "fixture-selected-token",
    );
  });

  it("rejects a file that grows after inspection", async () => {
    hooks.afterInspect = async (inspected) => {
      if (inspected !== file) return;
      hooks.afterInspect = undefined;
      await appendFile(file, " ");
    };

    expect(await read(directory, new AbortController().signal)).toBeNull();
  });

  it("rejects a file that shrinks after inspection", async () => {
    hooks.afterInspect = async (inspected) => {
      if (inspected !== file) return;
      hooks.afterInspect = undefined;
      await writeFile(file, credential("fixture-short"));
    };

    expect(await read(directory, new AbortController().signal)).toBeNull();
  });

  it("accepts the byte limit and rejects larger credential files", async () => {
    const raw = credential();
    await writeFile(file, raw.padEnd(64 * 1024, " "));
    expect(await read(directory, new AbortController().signal)).toBe(
      "fixture-selected-token",
    );
    await appendFile(file, " ");
    expect(await read(directory, new AbortController().signal)).toBeNull();
  });

  it("preserves support for symlinked credential files", async () => {
    await rename(file, `${file}.target`);
    await symlink(`${file}.target`, file);
    expect(await read(directory, new AbortController().signal)).toBe(
      "fixture-selected-token",
    );
  });

  it("honors cancellation before reading a credential", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(read(directory, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});

it("closes the credential descriptor when a connector read is cancelled after inspection", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "zeros-credential-abort-"),
  );
  const controller = new AbortController();
  try {
    await writeFile(path.join(directory, ".credentials.json"), credential());
    hooks.afterInspect = async () => {
      controller.abort();
    };
    await expect(
      readClaudeConnectorCredential(
        { CLAUDE_CONFIG_DIR: directory },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(hooks.handles).toHaveLength(1);
    expect(hooks.handles[0].fd).toBe(-1);
  } finally {
    hooks.afterInspect = undefined;
    hooks.handles.length = 0;
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  }
});
