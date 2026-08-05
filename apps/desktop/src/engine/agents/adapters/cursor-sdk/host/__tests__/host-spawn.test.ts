// Regression for the "Cursor committed in the wrong repo" bug (2026-06-20).
//
// The Cursor host is ONE shared Node subprocess for every session/worktree, so
// its process.cwd() can't be any session's dir. @cursor/sdk's local executor
// roots shells at `local.cwd ?? process.cwd()` — so if the host inherited the
// ENGINE's cwd (the default with no `cwd` on spawn), a missing per-agent cwd
// would run `git commit` inside Zeros' OWN repo. These tests pin that the host
// is anchored at a neutral, non-repo dir instead, so that fallback is harmless.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import { fileURLToPath } from "node:url";

const { spawnSpy } = vi.hoisted(() => ({ spawnSpy: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnSpy }));

import { resolveHostCwd, spawnSubprocessTransport } from "../host-client";

/** Minimal ChildProcess stand-in: only the members touched right after spawn. */
function fakeChild() {
  const stream = () => ({ setEncoding: vi.fn(), on: vi.fn() });
  return {
    stdout: stream(),
    stderr: stream(),
    stdin: { write: vi.fn(), end: vi.fn(), destroyed: false },
    on: vi.fn(),
    kill: vi.fn(),
    killed: false,
  };
}

describe("resolveHostCwd", () => {
  const saved = process.env.ZEROS_CURSOR_HOST_CWD;
  afterEach(() => {
    if (saved === undefined) delete process.env.ZEROS_CURSOR_HOST_CWD;
    else process.env.ZEROS_CURSOR_HOST_CWD = saved;
  });

  it("defaults to a neutral temp dir, never the engine's process.cwd()", () => {
    delete process.env.ZEROS_CURSOR_HOST_CWD;
    const dir = resolveHostCwd();
    expect(dir).toBe(os.tmpdir());
    expect(dir).not.toBe(process.cwd());
  });

  it("honours a ZEROS_CURSOR_HOST_CWD override", () => {
    process.env.ZEROS_CURSOR_HOST_CWD = "/some/neutral/dir";
    expect(resolveHostCwd()).toBe("/some/neutral/dir");
  });
});

describe("spawnSubprocessTransport — host cwd safety", () => {
  const savedScript = process.env.ZEROS_CURSOR_HOST_SCRIPT;
  const savedCwd = process.env.ZEROS_CURSOR_HOST_CWD;

  beforeEach(() => {
    spawnSpy.mockReset().mockImplementation(() => fakeChild());
    delete process.env.ZEROS_CURSOR_HOST_CWD;
    // resolveHostScript() needs an existing file; the script isn't executed
    // because spawn is mocked, so point it at this test file.
    process.env.ZEROS_CURSOR_HOST_SCRIPT = fileURLToPath(import.meta.url);
  });
  afterEach(() => {
    if (savedScript === undefined) delete process.env.ZEROS_CURSOR_HOST_SCRIPT;
    else process.env.ZEROS_CURSOR_HOST_SCRIPT = savedScript;
    if (savedCwd === undefined) delete process.env.ZEROS_CURSOR_HOST_CWD;
    else process.env.ZEROS_CURSOR_HOST_CWD = savedCwd;
  });

  it("spawns the host in the neutral cwd, NOT the engine's process.cwd()", () => {
    spawnSubprocessTransport();

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const opts = spawnSpy.mock.calls[0][2] as { cwd?: string };
    expect(opts.cwd).toBe(resolveHostCwd());
    // The exact regression: the host must not inherit the engine repo root.
    expect(opts.cwd).not.toBe(process.cwd());
  });
});
