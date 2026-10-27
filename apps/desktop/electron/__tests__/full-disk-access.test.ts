import { constants } from "node:fs";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applicationBundlePath,
  probeFullDiskAccess,
} from "../full-disk-access";

const homes: string[] = [];

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "zeros-disk-access-"));
  homes.push(home);
  const directory = join(home, "Library/Application Support/com.apple.TCC");
  await mkdir(directory, { recursive: true });
  return { home, file: join(directory, "TCC.db") };
}

afterEach(async () => {
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});

describe("Full Disk Access effective-access probe", () => {
  it("opens only the protected file read-only and closes it without reading contents", async () => {
    const close = vi.fn(async () => {});
    const read = vi.fn();
    const open = vi.fn(async () => ({
      stat: async () => ({ isFile: () => true }),
      close,
      read,
    }));
    expect(
      await probeFullDiskAccess({
        platform: "darwin",
        home: "/Users/test",
        open,
      }),
    ).toBe("available");
    expect(open).toHaveBeenCalledExactlyOnceWith(
      "/Users/test/Library/Application Support/com.apple.TCC/TCC.db",
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    expect(close).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
  });

  it.each(["EPERM", "EACCES"])(
    "reports blocked access for %s without returning paths or native errors",
    async (code) => {
      const open = vi.fn(async () => {
        throw Object.assign(new Error("private path"), { code });
      });
      expect(
        await probeFullDiskAccess({
          platform: "darwin",
          home: "/Users/test",
          open,
        }),
      ).toBe("denied");
    },
  );

  it.each(["ENOENT", "EIO", "ELOOP", "EMFILE", undefined])(
    "keeps an inconclusive %s result unknown",
    async (code) => {
      const open = vi.fn(async () => {
        throw Object.assign(new Error("private detail"), { code });
      });
      expect(
        await probeFullDiskAccess({
          platform: "darwin",
          home: "/Users/test",
          open,
        }),
      ).toBe("unknown");
    },
  );

  it("never treats a missing protected file as permission granted", async () => {
    const { home } = await fixture();
    expect(await probeFullDiskAccess({ platform: "darwin", home })).toBe(
      "unknown",
    );
  });

  it("requires a regular file and refuses symlink substitutes", async () => {
    const { home, file } = await fixture();
    const other = join(home, "ordinary.txt");
    await writeFile(other, "fixture, not user data");
    await symlink(other, file);
    expect(await probeFullDiskAccess({ platform: "darwin", home })).toBe(
      "unknown",
    );
    await rm(file);
    await mkdir(file);
    expect(await probeFullDiskAccess({ platform: "darwin", home })).toBe(
      "unknown",
    );
    await rm(file, { recursive: true });
    await writeFile(file, "fixture, not user data");
    expect(await probeFullDiskAccess({ platform: "darwin", home })).toBe(
      "available",
    );
  });

  it("closes the descriptor even if metadata checking fails", async () => {
    const close = vi.fn(async () => {});
    const open = vi.fn(async () => ({
      stat: async () => {
        throw new Error("metadata unavailable");
      },
      close,
    }));
    expect(
      await probeFullDiskAccess({
        platform: "darwin",
        home: "/Users/test",
        open,
      }),
    ).toBe("unknown");
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not claim available if descriptor cleanup fails", async () => {
    const open = vi.fn(async () => ({
      stat: async () => ({ isFile: () => true }),
      close: async () => {
        throw new Error("close failed");
      },
    }));
    expect(
      await probeFullDiskAccess({
        platform: "darwin",
        home: "/Users/test",
        open,
      }),
    ).toBe("unknown");
  });

  it.each(["linux", "win32"] as const)(
    "does no filesystem work on %s",
    async (platform) => {
      const open = vi.fn();
      expect(
        await probeFullDiskAccess({ platform, home: "/Users/test", open }),
      ).toBe("unsupported");
      expect(open).not.toHaveBeenCalled();
    },
  );
});

describe("running app identity", () => {
  it("resolves the actual packaged or checkout-specific bundle, not a guessed installation", () => {
    expect(
      applicationBundlePath(
        "/Applications/Zeros Alpha.app/Contents/MacOS/Zeros Alpha",
      ),
    ).toBe("/Applications/Zeros Alpha.app");
    expect(
      applicationBundlePath(
        "/Users/test/.zeros-local/instances/abc/bundle/Zeros Local — project.app/Contents/MacOS/Zeros",
      ),
    ).toBe(
      "/Users/test/.zeros-local/instances/abc/bundle/Zeros Local — project.app",
    );
  });

  it.each([
    "/usr/bin/node",
    "/tmp/Fake.app/node",
    "/tmp/Fake/Contents/MacOS/node",
    "relative.app/Contents/MacOS/node",
  ])("refuses a non-bundle executable: %s", (executable) => {
    expect(applicationBundlePath(executable)).toBeNull();
  });
});
