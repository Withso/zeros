import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const runFile = vi.hoisted(() => vi.fn());
vi.mock("../../git/git-exec", () => ({ runFile }));
import {
  createAttachmentTemporaryDirectory,
  MACOS_ATTACHMENT_TEMP_SCRIPT,
} from "../attachment-temporary-directory";

let root: string;
let workspace: string;
let privateData: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "zeros-private-temp-test-"));
  workspace = path.join(root, "workspace with 'quotes' and spaces");
  privateData = path.join(root, "app-data");
  await fs.mkdir(workspace);
  await fs.mkdir(privateData);
  vi.stubEnv("ZEROS_DATA_DIR", privateData);
  runFile.mockReset();
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

it("allocates independent owner-only directories outside the workspace and removes them", async () => {
  const [first, second] = await Promise.all([
    createAttachmentTemporaryDirectory(workspace),
    createAttachmentTemporaryDirectory(workspace),
  ]);
  try {
    expect(first.path).not.toBe(second.path);
    expect((await fs.stat(first.path)).mode & 0o777).toBe(0o700);
    expect(await fs.readdir(workspace)).toEqual([]);
    await fs.writeFile(path.join(first.path, "contents"), "temporary bytes");
    await first.dispose();
    expect((await fs.stat(second.path)).isDirectory()).toBe(true);
  } finally {
    await first.dispose();
    await second.dispose();
  }
  await expect(fs.stat(first.path)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(fs.stat(second.path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(runFile).not.toHaveBeenCalled();
});

it("ignores a TMPDIR symlink into the repository and preserves existing files", async () => {
  const alias = path.join(root, "temp-alias");
  await fs.symlink(workspace, alias);
  await fs.writeFile(path.join(workspace, "notes.txt"), "user contents");
  vi.spyOn(os, "tmpdir").mockReturnValue(alias);
  const temporary = await createAttachmentTemporaryDirectory(workspace);
  expect(temporary.path.startsWith(privateData + path.sep)).toBe(true);
  await temporary.dispose();
  expect(await fs.readdir(workspace)).toEqual(["notes.txt"]);
  expect(await fs.readFile(path.join(workspace, "notes.txt"), "utf8")).toBe(
    "user contents",
  );
});

async function externalVolume() {
  const replacement = path.join(root, "replacement");
  await fs.mkdir(replacement);
  vi.stubGlobal(
    "process",
    Object.create(process, { platform: { value: "darwin" } }),
  );
  const stat = fs.stat.bind(fs);
  vi.spyOn(fs, "stat").mockImplementation((async (target) => {
    const result = await stat(target);
    const candidate = String(target);
    if (
      candidate === workspace ||
      candidate === replacement ||
      candidate.startsWith(replacement + path.sep)
    )
      result.dev += 1;
    return result;
  }) as typeof fs.stat);
  runFile.mockResolvedValue({
    stdout: JSON.stringify(replacement),
    stderr: "",
  });
  return replacement;
}

it("asks macOS for destination-volume storage using argv and cleans its replacement directory", async () => {
  const replacement = await externalVolume();
  const temporary = await createAttachmentTemporaryDirectory(workspace);
  expect(temporary.path.startsWith(replacement + path.sep)).toBe(true);
  expect(runFile).toHaveBeenCalledExactlyOnceWith(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", MACOS_ATTACHMENT_TEMP_SCRIPT, workspace],
    { timeoutMs: 10_000, maxBufferBytes: 16 * 1024 },
  );
  expect(MACOS_ATTACHMENT_TEMP_SCRIPT).not.toContain(workspace);
  await temporary.dispose();
  await expect(fs.stat(replacement)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readdir(workspace)).toEqual([]);
});

it.each(["workspace", "other-device"])(
  "refuses an unsafe macOS result (%s) without touching existing contents",
  async (location) => {
    await externalVolume();
    const unsuitable = location === "workspace" ? workspace : privateData;
    await fs.writeFile(path.join(unsuitable, "keep.txt"), "user contents");
    runFile.mockResolvedValue({
      stdout: JSON.stringify(unsuitable),
      stderr: "",
    });
    await expect(createAttachmentTemporaryDirectory(workspace)).rejects.toThrow(
      /outside the workspace on the same filesystem/,
    );
    expect(await fs.readFile(path.join(unsuitable, "keep.txt"), "utf8")).toBe(
      "user contents",
    );
  },
);

it("reports a native resolver failure without falling back to repository storage", async () => {
  await externalVolume();
  runFile.mockRejectedValue(new Error("volume disconnected"));
  await expect(createAttachmentTemporaryDirectory(workspace)).rejects.toThrow(
    "volume disconnected",
  );
  expect(await fs.readdir(workspace)).toEqual([]);
});
