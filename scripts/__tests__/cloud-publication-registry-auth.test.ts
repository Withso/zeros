import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  restorePublicationRegistryAuth as restore,
  stagePublicationRegistryAuth as stage,
} from "../cloud-workspace-validation/lib/publication-registry-auth";

const roots: string[] = [];
const auth = Buffer.from("publisher:test-only-ephemeral-value").toString(
  "base64",
);
async function fixture(prior?: string) {
  const root = await mkdtemp(path.join(tmpdir(), "zeros-registry-auth-"));
  roots.push(root);
  const options = {
    homeDirectory: path.join(root, "home"),
    stateDirectory: path.join(root, "state"),
    dockerConfigDirectory: path.join(root, "state", "docker"),
  };
  for (const directory of Object.values(options))
    await mkdir(directory, { recursive: true, mode: 0o700 });
  const source = path.join(options.dockerConfigDirectory, "config.json");
  const directory = path.join(options.homeDirectory, ".docker");
  const target = path.join(directory, "config.json");
  const journal = path.join(
    options.stateDirectory,
    "registry-auth-bridge.json",
  );
  await writeFile(
    source,
    JSON.stringify({
      auths: { "ghcr.io": { auth }, "other.invalid": { auth: "unrelated" } },
    }),
    { mode: 0o600 },
  );
  if (prior !== undefined) {
    await mkdir(directory, { mode: 0o700 });
    await writeFile(target, prior, { mode: 0o640 });
  }
  return { ...options, options, source, directory, target, journal, root };
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("publication registry credential bridge", () => {
  it.skipIf(process.platform === "win32")(
    "refuses a FIFO without waiting for a writer",
    async () => {
      const f = await fixture("{}");
      await unlink(f.target);
      execFileSync("mkfifo", [f.target]);
      await expect(stage(f.options)).rejects.toThrow(
        "Unsafe registry credential file",
      );
    },
  );
  it("refuses a writable-by-others default directory", async () => {
    const f = await fixture("{}");
    await chmod(f.directory, 0o777);
    await expect(stage(f.options)).rejects.toThrow(
      "Unsafe registry credential directory",
    );
    expect(await readFile(f.target, "utf8")).toBe("{}");
  });
  it("refuses aliasing the source and default credential store", async () => {
    const f = await fixture("{}");
    await expect(
      stage({ ...f.options, dockerConfigDirectory: f.directory }),
    ).rejects.toThrow("must be distinct");
    expect(await readFile(f.target, "utf8")).toBe("{}");
  });
  it("exposes only GHCR at the pinned action's default path and restores exact bytes and mode", async () => {
    const prior =
      '{\n "auths": {"old.invalid":{"auth":"old"},"ghcr.io":{"auth":"prior"}}, "HttpHeaders":{"custom":"value"}\n}\n';
    const f = await fixture(prior);
    await stage(f.options);
    expect(JSON.parse(await readFile(f.target, "utf8"))).toEqual({
      auths: { "ghcr.io": { auth } },
    });
    expect((await stat(f.target)).mode & 0o777).toBe(0o600);
    expect((await stat(f.journal)).mode & 0o777).toBe(0o600);
    await restore(f.options);
    expect(await readFile(f.target, "utf8")).toBe(prior);
    expect((await stat(f.target)).mode & 0o777).toBe(0o640);
    await expect(lstat(f.journal)).rejects.toMatchObject({ code: "ENOENT" });
    await restore(f.options);
  });
  it("removes a newly created config and its empty owned directory", async () => {
    const f = await fixture();
    await stage(f.options);
    await restore(f.options);
    await expect(lstat(f.directory)).rejects.toMatchObject({ code: "ENOENT" });
    await restore(f.options);
  });
  it("preserves a helper-created directory if another file now uses it", async () => {
    const f = await fixture();
    await stage(f.options);
    await writeFile(path.join(f.directory, "keep"), "keep");
    await restore(f.options);
    expect(await readdir(f.directory)).toEqual(["keep"]);
  });
  it.each([
    "not-json",
    '{"auths":{}}',
    '{"auths":{"ghcr.io":{"auth":"%%%"}}}',
    JSON.stringify({
      auths: {
        "ghcr.io": {
          auth: Buffer.from("missing-separator").toString("base64"),
        },
      },
    }),
  ])(
    "refuses an invalid isolated login before changing the default store: %s",
    async (source) => {
      const f = await fixture("{}");
      await writeFile(f.source, source);
      await expect(stage(f.options)).rejects.toThrow();
      expect(await readFile(f.target, "utf8")).toBe("{}");
      await expect(lstat(f.journal)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
  it("refuses a missing source credential", async () => {
    const f = await fixture();
    await unlink(f.source);
    await expect(stage(f.options)).rejects.toThrow();
    await expect(lstat(f.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each([
    "source",
    "target",
    "directory",
    "dockerConfigDirectory",
    "stateDirectory",
  ] as const)("refuses a symlink at %s", async (key) => {
    const f = await fixture("{}");
    const original = f[key];
    const moved = `${original}-real`;
    const { rename } = await import("node:fs/promises");
    await rename(original, moved);
    await symlink(moved, original);
    await expect(stage(f.options)).rejects.toThrow();
  });
  it("refuses hardlinked or writable-by-others credential files", async () => {
    const f = await fixture("{}");
    await link(f.target, path.join(f.root, "linked"));
    await expect(stage(f.options)).rejects.toThrow();
    await unlink(path.join(f.root, "linked"));
    await chmod(f.target, 0o666);
    await expect(stage(f.options)).rejects.toThrow();
  });
  it("does not overwrite an existing restoration journal", async () => {
    const f = await fixture("{}");
    await stage(f.options);
    const journal = await readFile(f.journal, "utf8");
    await expect(stage(f.options)).rejects.toThrow();
    expect(await readFile(f.journal, "utf8")).toBe(journal);
    await restore(f.options);
  });
  it("retains evidence and refuses to clobber a changed target during restore", async () => {
    const f = await fixture("{}");
    await stage(f.options);
    await writeFile(f.target, '{"changed":true}');
    await expect(restore(f.options)).rejects.toThrow();
    expect(await readFile(f.target, "utf8")).toBe('{"changed":true}');
    expect((await stat(f.journal)).isFile()).toBe(true);
  });
  it("recovers a journal recorded before installation without replacing the prior store", async () => {
    const f = await fixture("{}\n");
    await stage(f.options);
    await writeFile(f.target, "{}\n");
    await chmod(f.target, 0o640);
    await restore(f.options);
    expect(await readFile(f.target, "utf8")).toBe("{}\n");
    await expect(lstat(f.journal)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects a journal targeting another path", async () => {
    const f = await fixture("{}");
    await stage(f.options);
    const journal = JSON.parse(await readFile(f.journal, "utf8"));
    journal.destination = f.source;
    await writeFile(f.journal, JSON.stringify(journal));
    await expect(restore(f.options)).rejects.toThrow();
    expect(
      JSON.parse(await readFile(f.source, "utf8")).auths["ghcr.io"].auth,
    ).toBe(auth);
  });
});
