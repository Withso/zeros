import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const runFile = vi.hoisted(() => vi.fn());
vi.mock("../../git/git-exec", () => ({ runFile }));
import {
  createAttachmentTemporaryDirectory,
  MACOS_ATTACHMENT_TEMP_SCRIPT,
  pruneAttachmentTemporaryDirectories,
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

it.each(["TMPDIR", "TMPDIR symlink", "app data"])(
  "rejects %s inside a folder enclosing the workspace",
  async (location) => {
    const enclosing = path.join(root, "enclosing");
    const nestedWorkspace = path.join(enclosing, "workspace");
    const candidate = path.join(enclosing, "tmp");
    await fs.mkdir(nestedWorkspace, { recursive: true });
    await fs.mkdir(candidate);
    if (location === "app data") {
      // Model a Design marker without creating or modifying Design files.
      const lstat = fs.lstat.bind(fs);
      vi.spyOn(fs, "lstat").mockImplementation(
        (async (target) =>
          String(target) === path.join(enclosing, "design.toml")
            ? lstat(enclosing)
            : lstat(target)) as typeof fs.lstat,
      );
      vi.spyOn(os, "tmpdir").mockReturnValue(nestedWorkspace);
      vi.stubEnv("ZEROS_DATA_DIR", candidate);
    } else if (location === "TMPDIR symlink") {
      await fs.writeFile(path.join(enclosing, ".git"), "gitdir: elsewhere\n");
      const alias = path.join(root, "temp-alias");
      await fs.symlink(candidate, alias);
      vi.spyOn(os, "tmpdir").mockReturnValue(alias);
    } else {
      await fs.mkdir(path.join(enclosing, ".git"));
      vi.spyOn(os, "tmpdir").mockReturnValue(candidate);
    }
    const temporary =
      await createAttachmentTemporaryDirectory(nestedWorkspace);
    try {
      expect(temporary.path.startsWith(enclosing + path.sep)).toBe(false);
      expect(
        (await fs.readdir(candidate)).filter((entry) =>
          entry.startsWith("zeros-attachment-"),
        ),
      ).toEqual([]);
    } finally {
      await temporary.dispose();
    }
  },
);

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

it.each(["workspace", "other-device", "enclosing-repository"])(
  "refuses an unsafe macOS result (%s) without touching existing contents",
  async (location) => {
    const replacement = await externalVolume();
    const unsuitable =
      location === "workspace"
        ? workspace
        : location === "enclosing-repository"
          ? replacement
          : privateData;
    if (location === "enclosing-repository")
      await fs.mkdir(path.join(root, ".git"));
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

it("uses a private sibling on a Linux workspace volume when ordinary temp storage is elsewhere", async () => {
  const stat = fs.stat.bind(fs);
  vi.spyOn(fs, "stat").mockImplementation((async (target) => {
    const result = await stat(target);
    if (
      String(target) === root ||
      String(target) === workspace ||
      String(target).startsWith(path.join(root, "zeros-attachment-"))
    )
      result.dev += 1;
    return result;
  }) as typeof fs.stat);
  const temporary = await createAttachmentTemporaryDirectory(workspace);
  try {
    expect(path.dirname(temporary.path)).toBe(root);
    expect(await fs.readdir(workspace)).toEqual([]);
  } finally {
    await temporary.dispose();
  }
});

it("never puts sibling fallback storage inside an enclosing repository", async () => {
  await fs.mkdir(path.join(root, ".git"));
  const stat = fs.stat.bind(fs);
  vi.spyOn(fs, "stat").mockImplementation((async (target) => {
    const result = await stat(target);
    if (
      String(target) === root ||
      String(target) === workspace ||
      String(target).startsWith(path.join(root, "zeros-attachment-"))
    )
      result.dev += 1;
    return result;
  }) as typeof fs.stat);
  await expect(createAttachmentTemporaryDirectory(workspace)).rejects.toThrow(
    /temporary storage/,
  );
  expect((await fs.readdir(root)).sort()).toEqual([
    ".git",
    "app-data",
    path.basename(workspace),
  ]);
});

it("reclaims only recorded directories from dead processes and leaves active or replaced directories intact", async () => {
  const dead = await createAttachmentTemporaryDirectory(workspace);
  const active = await createAttachmentTemporaryDirectory(workspace);
  const replaced = await createAttachmentTemporaryDirectory(workspace);
  const registry = path.join(privateData, "attachment-temporaries");
  const entries = await fs.readdir(registry);
  for (const entry of entries) {
    const recordPath = path.join(registry, entry);
    const record = JSON.parse(await fs.readFile(recordPath, "utf8"));
    record.createdAt = Date.now() - 2 * 86_400_000;
    if (record.path !== active.path) record.pid = 999_999_999;
    if (record.path === replaced.path) record.ino += 1;
    await fs.writeFile(recordPath, JSON.stringify(record));
  }
  await fs.writeFile(path.join(dead.path, "contents"), "partial copy");
  await fs.writeFile(path.join(replaced.path, "keep.txt"), "user contents");
  try {
    await pruneAttachmentTemporaryDirectories();
    await expect(fs.stat(dead.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.stat(active.path)).isDirectory()).toBe(true);
    expect(
      await fs.readFile(path.join(replaced.path, "keep.txt"), "utf8"),
    ).toBe("user contents");
  } finally {
    await dead.dispose();
    await active.dispose();
    await replaced.dispose();
  }
});
