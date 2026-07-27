import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// H3: read_file now anchors the renderer-supplied cwd to the engine's
// currentRoot() (the open project / a worktree) so it can't read arbitrary host
// paths. In production the Files-tab cwd is always that root; here we simulate
// it by pointing currentRoot() at the per-test temp dir.
const sidecarMock = vi.hoisted(() => ({ root: null as string | null }));
vi.mock("../../../sidecar", () => ({ currentRoot: () => sidecarMock.root }));

import { readFile, type ReadFileResult } from "../files";

// CommandHandler is (args, event) — we only use args here. read_file never
// throws; it always returns a ReadFileResult (errors use kind:"error").
const call = (args: Record<string, unknown>): ReadFileResult =>
  (readFile as unknown as (a: Record<string, unknown>) => ReadFileResult)(args);

describe("read_file", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "zeros-files-"));
    sidecarMock.root = dir; // engine "rooted" at the test dir → reads are in-workspace
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    sidecarMock.root = null;
  });

  it("reads a text file", () => {
    writeFileSync(path.join(dir, "hello.ts"), "const a = 1;\nconst b = 2;\n");
    const res = call({ cwd: dir, path: "hello.ts" });
    expect(res.kind).toBe("text");
    expect(res.content).toContain("const a = 1;");
    expect(res.bytes).toBeGreaterThan(0);
  });

  it("reads a secret-NAMED file that lives inside the workspace (local = full access)", () => {
    // Regression: the local read path must NOT apply the remote secret denylist.
    // A committed `.npmrc` / `.env` inside the owner's own project is readable in
    // the Files tab — the same as the "Local main" trunk and the file tree show.
    // The secret/credential denylist is the REMOTE boundary only; forcing
    // remote:true here produced a misleading "refusing … over a remote connection"
    // error on a purely local worktree read.
    writeFileSync(
      path.join(dir, ".npmrc"),
      "//registry.npmjs.org/:_authToken=secret\n",
    );
    const npmrc = call({ cwd: dir, path: ".npmrc" });
    expect(npmrc.kind).toBe("text");
    expect(npmrc.content).toContain("_authToken");

    writeFileSync(path.join(dir, ".env"), "API_KEY=abc123\n");
    const env = call({ cwd: dir, path: ".env" });
    expect(env.kind).toBe("text");
    expect(env.content).toContain("API_KEY");
  });

  it("reports missing cwd / path as a clear error (never throws)", () => {
    const noCwd = call({ path: "x" });
    expect(noCwd.kind).toBe("error");
    expect(noCwd.error).toMatch(/workspace/);
    expect(call({ cwd: dir }).error).toMatch(/missing path/);
  });

  it("refuses a relative path that escapes the workspace", () => {
    // A real file just outside cwd, so the gate (not a missing-file error)
    // is what rejects it.
    const escape = path.join(path.dirname(dir), "zeros-escape-test.ts");
    writeFileSync(escape, "secret");
    try {
      const res = call({ cwd: dir, path: "../zeros-escape-test.ts" });
      expect(res.kind).toBe("error");
      expect(res.error).toMatch(/outside the workspace/);
    } finally {
      unlinkSync(escape);
    }
  });

  it("refuses an absolute path outside the workspace", () => {
    const res = call({ cwd: dir, path: "/etc/hosts" });
    expect(res.kind).toBe("error");
    expect(res.error).toMatch(/outside the workspace/);
  });

  it("reports a missing file with a clear reason", () => {
    const res = call({ cwd: dir, path: "does-not-exist.ts" });
    expect(res.kind).toBe("error");
    expect(res.error).toMatch(/no longer exists/);
  });

  it("reports a directory as not a file", () => {
    mkdirSync(path.join(dir, "subdir"));
    const res = call({ cwd: dir, path: "subdir" });
    expect(res.kind).toBe("error");
    expect(res.error).toMatch(/folder/);
  });

  it("reports binary files instead of decoding them", () => {
    writeFileSync(path.join(dir, "blob.dat"), Buffer.from([0x68, 0x00, 0x69]));
    const res = call({ cwd: dir, path: "blob.dat" });
    expect(res.kind).toBe("binary");
    expect(res.content).toBeUndefined();
  });

  it("reports files over the size cap as too-large", () => {
    writeFileSync(path.join(dir, "big.txt"), "a".repeat(2_100_000));
    const res = call({ cwd: dir, path: "big.txt" });
    expect(res.kind).toBe("too-large");
    expect(res.bytes).toBeGreaterThan(2_000_000);
  });

  it("returns images as a data URL", () => {
    writeFileSync(
      path.join(dir, "pic.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
    const res = call({ cwd: dir, path: "pic.png" });
    expect(res.kind).toBe("image");
    expect(res.dataUrl).toMatch(/^data:image\/png;base64,/);
  });
});
