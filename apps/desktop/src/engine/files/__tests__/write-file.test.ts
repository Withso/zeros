import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeWorkspaceFile } from "../write-file";

describe("writeWorkspaceFile (path-safe single-file write)", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-write-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("writes a new file and reports success + bytes", () => {
    const r = writeWorkspaceFile(root, "a.txt", "hello");
    expect(r.kind).toBe("success");
    expect(r.bytes).toBe(5);
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf-8")).toBe("hello");
  });

  it("overwrites an existing file", () => {
    fs.writeFileSync(path.join(root, "a.txt"), "old");
    const r = writeWorkspaceFile(root, "a.txt", "new content");
    expect(r.kind).toBe("success");
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf-8")).toBe(
      "new content",
    );
  });

  it("preserves the existing file's mode on overwrite (e.g. a +x script)", () => {
    const p = path.join(root, "run.sh");
    fs.writeFileSync(p, "#!/bin/sh\necho old\n");
    fs.chmodSync(p, 0o755);
    const r = writeWorkspaceFile(root, "run.sh", "#!/bin/sh\necho new\n");
    expect(r.kind).toBe("success");
    // The +x bits survive the tmp + rename (would be reset to ~0644 otherwise).
    expect(fs.statSync(p).mode & 0o777).toBe(0o755);
  });

  it("creates parent directories for a nested new file", () => {
    const r = writeWorkspaceFile(root, "src/deep/nested.ts", "export {};\n");
    expect(r.kind).toBe("success");
    expect(fs.readFileSync(path.join(root, "src/deep/nested.ts"), "utf-8")).toBe(
      "export {};\n",
    );
  });

  it("writes empty content (clearing a file)", () => {
    const r = writeWorkspaceFile(root, "empty.txt", "");
    expect(r.kind).toBe("success");
    expect(r.bytes).toBe(0);
    expect(fs.existsSync(path.join(root, "empty.txt"))).toBe(true);
  });

  it("refuses to escape the workspace via ..", () => {
    const r = writeWorkspaceFile(root, "../escape.txt", "x");
    expect(r.kind).toBe("error");
    expect(r.error).toMatch(/outside the workspace/);
    expect(fs.existsSync(path.join(path.dirname(root), "escape.txt"))).toBe(
      false,
    );
  });

  it("refuses content over the 2 MB size cap (and writes nothing)", () => {
    const big = "a".repeat(2_000_001);
    const r = writeWorkspaceFile(root, "big.txt", big);
    expect(r.kind).toBe("too-large");
    expect(fs.existsSync(path.join(root, "big.txt"))).toBe(false);
  });

  it("refuses to clobber a directory", () => {
    fs.mkdirSync(path.join(root, "adir"));
    const r = writeWorkspaceFile(root, "adir", "x");
    expect(r.kind).toBe("error");
    expect(r.error).toMatch(/folder/);
  });

  it("refuses a symlinked dir that escapes the workspace (local AND remote)", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-outside-"));
    try {
      fs.symlinkSync(outside, path.join(root, "link"), "dir");
      const r = writeWorkspaceFile(root, "link/evil.txt", "x", {
        remote: false,
      });
      expect(r.kind).toBe("error");
      expect(r.error).toMatch(/symlink/);
      expect(fs.existsSync(path.join(outside, "evil.txt"))).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("REMOTE: refuses to write a secret file and does not touch disk", () => {
    const r = writeWorkspaceFile(root, ".env", "SECRET=1", { remote: true });
    expect(r.kind).toBe("error");
    expect(r.error).toMatch(/secret\/credential/);
    expect(fs.existsSync(path.join(root, ".env"))).toBe(false);
  });

  it("REMOTE: refuses a secret smuggled past the lexical gate ('.env/.')", () => {
    const r = writeWorkspaceFile(root, ".env/.", "x", { remote: true });
    expect(r.kind).toBe("error");
    expect(r.error).toMatch(/secret\/credential/);
  });

  it("LOCAL: allows writing a secret-named file (owner's own machine)", () => {
    const r = writeWorkspaceFile(root, ".env", "SECRET=1", { remote: false });
    expect(r.kind).toBe("success");
    expect(fs.readFileSync(path.join(root, ".env"), "utf-8")).toBe("SECRET=1");
  });

  it("leaves no .tmp- turds after a successful write", () => {
    writeWorkspaceFile(root, "a.txt", "hello");
    const leftovers = fs.readdirSync(root).filter((f) => f.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });
});
