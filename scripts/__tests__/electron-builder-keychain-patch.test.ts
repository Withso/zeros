import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

function macCodeSignRuntime(): string {
  const electronBuilderPackage = require.resolve("electron-builder/package.json");
  const requireFromElectronBuilder = createRequire(electronBuilderPackage);
  const macCodeSignPath = requireFromElectronBuilder.resolve(
    "app-builder-lib/out/codeSign/macCodeSign.js",
  );
  return readFileSync(macCodeSignPath, "utf8");
}

describe("electron-builder macOS keychain patch", () => {
  it("authenticates set-key-partition-list with the temporary keychain password", () => {
    const source = macCodeSignRuntime();

    expect(source).toContain(
      "return await importCerts(keychainFile, certPaths, cscPasswords, keychainPassword);",
    );
    expect(source).toContain(
      '["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", keychainPassword, keychainFile]',
    );
    expect(source).not.toContain(
      '["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", password, keychainFile]',
    );
  });
});
