import { createHash } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runCheckedAudit } from "../check-audit.mjs";
import { verifyNodeForgePatch } from "../check-node-forge-patch.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const rootRequire = createRequire(import.meta.url);
const sandboxRequire = createRequire(
  rootRequire.resolve("@anthropic-ai/sandbox-runtime"),
);
const forgeDirectory = dirname(
  sandboxRequire.resolve("node-forge/package.json"),
);
const pin = JSON.parse(
  readFileSync(join(root, "scripts/node-forge-patch.json"), "utf8"),
) as { patch: string; patchSha256: string; tarballIntegrity: string };

describe("Forge advisory exception installed-patch guard", () => {
  let fixtureRoot: string;

  beforeEach(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "zeros-forge-patch-"));
    for (const filename of [
      "pnpm-workspace.yaml",
      "pnpm-lock.yaml",
      "scripts/node-forge-patch.json",
      pin.patch,
    ]) {
      const destination = join(fixtureRoot, filename);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(join(root, filename), destination);
    }
    writeFileSync(join(fixtureRoot, "package.json"), "{}\n");
    const sandboxDirectory = join(
      fixtureRoot,
      "node_modules/@anthropic-ai/sandbox-runtime",
    );
    mkdirSync(sandboxDirectory, { recursive: true });
    writeFileSync(
      join(sandboxDirectory, "package.json"),
      JSON.stringify({
        name: "@anthropic-ai/sandbox-runtime",
        main: "index.js",
      }),
    );
    writeFileSync(join(sandboxDirectory, "index.js"), "module.exports = {};\n");
    cpSync(forgeDirectory, join(fixtureRoot, "node_modules/node-forge"), {
      recursive: true,
    });
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  function replaceFixture(
    filename: string,
    original: string,
    replacement: string,
  ) {
    const path = join(fixtureRoot, filename);
    const contents = readFileSync(path, "utf8");
    expect(contents).toContain(original);
    writeFileSync(path, contents.replaceAll(original, replacement));
  }

  it("checks the real installed dependency, not only lockfile metadata", () => {
    expect(() => verifyNodeForgePatch()).not.toThrow();
    expect(() => verifyNodeForgePatch({ root: fixtureRoot })).not.toThrow();
  });

  it("rejects a changed patch even if the installed verifier is still fixed", () => {
    appendFileSync(join(fixtureRoot, pin.patch), "\n");
    expect(() => verifyNodeForgePatch({ root: fixtureRoot })).toThrow(
      /reviewed patch digest changed/,
    );
  });

  it("rejects a missing exact workspace patch binding", () => {
    replaceFixture(
      "pnpm-workspace.yaml",
      `  "node-forge@1.4.0": ${pin.patch}\n`,
      "",
    );
    expect(() => verifyNodeForgePatch({ root: fixtureRoot })).toThrow(
      /workspace patch binding missing/,
    );
  });

  it.each([
    "unpatched snapshot",
    "different tarball",
    "additional Forge version",
  ])("rejects %s despite the advisory exception", (change) => {
    if (change === "unpatched snapshot") {
      replaceFixture(
        "pnpm-lock.yaml",
        `1.4.0(patch_hash=${pin.patchSha256})`,
        "1.4.0",
      );
    } else if (change === "different tarball") {
      replaceFixture(
        "pnpm-lock.yaml",
        pin.tarballIntegrity,
        "sha512-unreviewed",
      );
    } else {
      replaceFixture(
        "pnpm-lock.yaml",
        "\npackages:\n",
        "\npackages:\n\n  node-forge@1.3.1:\n    resolution: {integrity: unreviewed}\n",
      );
    }
    expect(() => verifyNodeForgePatch({ root: fixtureRoot })).toThrow(
      /unreviewed Forge resolution/,
    );
  });

  it("rejects removal of the installed fix with unchanged patch and lock", () => {
    replaceFixture(
      "node_modules/node-forge/lib/rsa.js",
      " ||\n            obj.value[0].value.length !==\n              (('parameters' in capture) ? 2 : 1)",
      "",
    );
    expect(() => verifyNodeForgePatch({ root: fixtureRoot })).toThrow(
      /installed RSA verifier is not the reviewed backport/,
    );
  });

  it("rejects installed version drift", () => {
    replaceFixture(
      "node_modules/node-forge/package.json",
      '"1.4.0"',
      '"1.3.1"',
    );
    expect(() => verifyNodeForgePatch({ root: fixtureRoot })).toThrow(
      /installed version or license differs/,
    );
  });

  it("blocks audit on vulnerable behavior even if metadata blesses the installed hash", async () => {
    replaceFixture(
      "node_modules/node-forge/lib/rsa.js",
      " ||\n            obj.value[0].value.length !==\n              (('parameters' in capture) ? 2 : 1)",
      "",
    );
    const pinPath = join(fixtureRoot, "scripts/node-forge-patch.json");
    const alteredPin = JSON.parse(readFileSync(pinPath, "utf8"));
    alteredPin.installedRsaSha256 = createHash("sha256")
      .update(
        readFileSync(join(fixtureRoot, "node_modules/node-forge/lib/rsa.js")),
      )
      .digest("hex");
    writeFileSync(pinPath, JSON.stringify(alteredPin));
    const execute = vi.fn().mockResolvedValue({ exitCode: 0, output: "clean" });
    await expect(
      runCheckedAudit({
        verifyPatch: () => verifyNodeForgePatch({ root: fixtureRoot }),
        execute,
      }),
    ).rejects.toThrow(/extra DigestAlgorithm elements accepted/);
    expect(execute).not.toHaveBeenCalled();
  });

  it("blocks the registry audit before execution if the guard fails", async () => {
    appendFileSync(join(fixtureRoot, pin.patch), "\n");
    const execute = vi.fn().mockResolvedValue({ exitCode: 0, output: "clean" });
    await expect(
      runCheckedAudit({
        verifyPatch: () => verifyNodeForgePatch({ root: fixtureRoot }),
        execute,
      }),
    ).rejects.toThrow(/reviewed patch digest changed/);
    expect(execute).not.toHaveBeenCalled();
  });
});
