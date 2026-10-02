import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeWorkspaceFile } from "../write-file";

describe("expected-content workspace writes", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-guarded-write-"));
    fs.writeFileSync(path.join(root, "file.txt"), "original\r\nbytes");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("replaces only the exact original bytes and retains permissions", () => {
    fs.chmodSync(path.join(root, "file.txt"), 0o755);
    const result = writeWorkspaceFile(root, "file.txt", "resolved\r\nbytes", {
      expectedContent: "original\r\nbytes",
    });
    expect(result.kind).toBe("success");
    expect(fs.readFileSync(path.join(root, "file.txt"), "utf8")).toBe(
      "resolved\r\nbytes",
    );
    expect(fs.statSync(path.join(root, "file.txt")).mode & 0o777).toBe(0o755);
  });

  it("fails closed on a newer edit and keeps its bytes", () => {
    fs.writeFileSync(path.join(root, "file.txt"), "another writer's edit\n");
    const result = writeWorkspaceFile(root, "file.txt", "my resolution", {
      expectedContent: "original\r\nbytes",
    });
    expect(result.kind).toBe("error");
    expect(result.error).toMatch(/changed|refresh/i);
    expect(fs.readFileSync(path.join(root, "file.txt"), "utf8")).toBe(
      "another writer's edit\n",
    );
  });

  it("checks again after preparing the temporary file", () => {
    const write = fs.writeFileSync.bind(fs);
    vi.spyOn(fs, "writeFileSync").mockImplementation(
      (...args: Parameters<typeof fs.writeFileSync>) => {
        write(...args);
        if (String(args[0]).includes(".tmp-")) {
          write(path.join(root, "file.txt"), "edit during save\n");
        }
      },
    );
    const result = writeWorkspaceFile(root, "file.txt", "my resolution", {
      expectedContent: "original\r\nbytes",
    });
    expect(result.kind).toBe("error");
    expect(fs.readFileSync(path.join(root, "file.txt"), "utf8")).toBe(
      "edit during save\n",
    );
    expect(fs.readdirSync(root)).toEqual(["file.txt"]);
  });

  it("does not recreate a concurrently removed file", () => {
    fs.unlinkSync(path.join(root, "file.txt"));
    const result = writeWorkspaceFile(root, "file.txt", "resolved", {
      expectedContent: "original\r\nbytes",
    });
    expect(result.kind).toBe("error");
    expect(fs.existsSync(path.join(root, "file.txt"))).toBe(false);
  });

  it("null expects an absent file, including an empty file appearing meanwhile", () => {
    expect(
      writeWorkspaceFile(root, "new.txt", "restore", { expectedContent: null })
        .kind,
    ).toBe("success");
    fs.writeFileSync(path.join(root, "empty.txt"), "");
    expect(
      writeWorkspaceFile(root, "empty.txt", "restore", {
        expectedContent: null,
      }).kind,
    ).toBe("error");
    expect(fs.readFileSync(path.join(root, "empty.txt"), "utf8")).toBe("");
  });

  it.each([
    "../escape.txt",
    "/absolute.txt",
    "a/../file.txt",
    "a\\file.txt",
    "./file.txt",
    "file.txt\0",
  ])("refuses a non-canonical relative path %s", (candidate) => {
    expect(
      writeWorkspaceFile(root, candidate, "resolved", { expectedContent: null })
        .kind,
    ).toBe("error");
  });

  it("refuses symlink and hardlink aliases instead of replacing a different file", () => {
    fs.symlinkSync("file.txt", path.join(root, "alias.txt"));
    expect(
      writeWorkspaceFile(root, "alias.txt", "resolved", {
        expectedContent: "original\r\nbytes",
      }).kind,
    ).toBe("error");
    fs.linkSync(path.join(root, "file.txt"), path.join(root, "hardlink.txt"));
    expect(
      writeWorkspaceFile(root, "hardlink.txt", "resolved", {
        expectedContent: "original\r\nbytes",
      }).kind,
    ).toBe("error");
    expect(fs.readFileSync(path.join(root, "file.txt"), "utf8")).toBe(
      "original\r\nbytes",
    );
  });
});
