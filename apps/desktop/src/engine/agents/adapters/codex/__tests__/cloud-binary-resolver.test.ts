import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resolveCloudCodexBinaryFromImage } from "../binary-resolver";
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function image() {
  const root = await mkdtemp(path.join(tmpdir(), "zeros-cloud-codex-"));
  roots.push(root);
  const wrapper = path.join(root, "node_modules/@openai/codex"),
    nativePackage = path.join(root, "node_modules/@openai/codex-linux-x64");
  const runtime = path.join(nativePackage, "vendor/x86_64-unknown-linux-musl"),
    binary = path.join(runtime, "bin/codex");
  await mkdir(wrapper, { recursive: true });
  await mkdir(path.dirname(binary), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ dependencies: { "@openai/codex": "0.154.0" } }),
  );
  await writeFile(
    path.join(wrapper, "package.json"),
    JSON.stringify({ name: "@openai/codex", version: "0.154.0" }),
  );
  await writeFile(
    path.join(nativePackage, "package.json"),
    JSON.stringify({
      name: "@openai/codex-linux-x64",
      version: "0.154.0-linux-x64",
    }),
  );
  await writeFile(binary, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), {
    mode: 0o555,
  });
  return { root, wrapper, nativePackage, runtime, binary };
}
it.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "resolves the pinned native ELF independently of staged overrides and wrapper lookup mode",
  async () => {
    const fixture = await image();
    vi.stubEnv("ZEROS_CODEX_CLI_PATH", "/usr/local/bin/unrelated-codex");
    await expect(
      resolveCloudCodexBinaryFromImage(fixture.root),
    ).resolves.toEqual({
      path: fixture.binary,
      source: "bundled",
      sandboxRuntimeRoot: fixture.runtime,
    });
  },
);
it.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "refuses a platform package that does not match the image pin",
  async () => {
    const f = await image();
    await writeFile(
      path.join(f.nativePackage, "package.json"),
      JSON.stringify({ version: "0.153.0-linux-x64" }),
    );
    await expect(resolveCloudCodexBinaryFromImage(f.root)).rejects.toThrow(
      "pinned native",
    );
  },
);
it.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "refuses a wrapper script at the native binary path",
  async () => {
    const f = await image();
    await rm(f.binary);
    await writeFile(f.binary, "#!/bin/sh\nexec unrelated-codex\n", {
      mode: 0o555,
      flag: "wx",
    });
    await expect(resolveCloudCodexBinaryFromImage(f.root)).rejects.toThrow(
      "pinned native",
    );
  },
);
it.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "refuses a native executable resolving outside the immutable image",
  async () => {
    const f = await image(),
      outside = await image();
    await rm(f.binary);
    await symlink(outside.binary, f.binary);
    await expect(resolveCloudCodexBinaryFromImage(f.root)).rejects.toThrow(
      "pinned native",
    );
  },
);
