import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

interface KeychainOptions {
  tmpDir: object;
  currentDir: string;
  cscLink: string;
  cscKeyPassword: string;
  cscILink?: string;
  cscIKeyPassword?: string;
}

interface SigningModule {
  createKeychain(options: KeychainOptions): Promise<{ keychainFile: string }>;
}

/** Execute the installed signing dependency with a strict OS-command model.
 * No certificate, real keychain, signing credential, or filesystem is modified. */
function signingHarness() {
  const rootRequire = createRequire(import.meta.url);
  const builderRequire = createRequire(rootRequire.resolve("electron-builder"));
  const filename = builderRequire.resolve(
    "app-builder-lib/out/codeSign/macCodeSign.js",
  );
  const commands: string[][] = [];
  let keychainPassword = "";
  const module = { exports: {} as SigningModule };
  const exec = async (executable: string, args: string[]) => {
    expect(executable).toBe("/usr/bin/security");
    commands.push([...args]);
    if (args[0] === "create-keychain") keychainPassword = args[2];
    if (
      (args[0] === "unlock-keychain" && args[2] !== keychainPassword) ||
      (args[0] === "set-key-partition-list" &&
        args[args.indexOf("-k") + 1] !== keychainPassword)
    ) {
      throw new Error("Temporary signing keychain rejected its password");
    }
    return args[0] === "list-keychains" && !args.includes("-s")
      ? '"/fixture/login.keychain"\n'
      : "";
  };
  const replacements: Record<string, unknown> = {
    "builder-util": {
      exec,
      copyFile: async () => undefined,
      unlinkIfExists: async () => undefined,
      isEmptyOrSpaces: (value?: string) => !value?.trim(),
      log: { warn: () => undefined },
    },
    "fs/promises": { rename: async () => undefined },
    os: { homedir: () => "/fixture/home", tmpdir: () => "/fixture/tmp" },
    "temp-file": { getTempName: () => "root-certs.keychain" },
    "./codesign": {
      importCertificate: async (link: string) => `/fixture/${link}.p12`,
    },
    "@electron/osx-sign": {},
    "@electron/osx-sign/dist/cjs/util-identities": {},
    "../util/flags": {},
  };
  /** Fail on unmodeled imports so an upstream refactor cannot accidentally
   * reach real filesystem or keychain commands through the test harness. */
  const loadDependency = (name: string) => {
    if (Object.hasOwn(replacements, name)) return replacements[name];
    if (["crypto", "path", "lazy-val"].includes(name)) return builderRequire(name);
    throw new Error(`Unmodeled signing dependency: ${name}`);
  };
  const evaluate = runInNewContext(
    `(function(exports, require, module, __filename, __dirname) {\n${readFileSync(filename, "utf8")}\n})`,
    { process: { env: {}, platform: "darwin" } },
  );
  evaluate(
    module.exports,
    loadDependency,
    module,
    filename,
    path.dirname(filename),
  );
  return { signing: module.exports, commands };
}

describe("macOS signing keychain credentials", () => {
  it.each([
    { application: "application-certificate", installer: undefined },
    { application: "application-certificate", installer: "installer-certificate" },
    { application: "", installer: undefined },
  ])(
    "unlocks the temporary keychain independently of P12 passwords (%j)",
    async ({ application, installer }) => {
      const { signing, commands } = signingHarness();
      const result = await signing.createKeychain({
        tmpDir: {},
        currentDir: "/fixture/repo",
        cscLink: "application",
        cscKeyPassword: application,
        ...(installer === undefined
          ? {}
          : { cscILink: "installer", cscIKeyPassword: installer }),
      });
      const created = commands.find(([action]) => action === "create-keychain")!;
      const imports = commands.filter(([action]) => action === "import");
      const partitions = commands.filter(
        ([action]) => action === "set-key-partition-list",
      );
      expect(created[2]).toBeTruthy();
      expect([application, installer]).not.toContain(created[2]);
      expect(imports.map((args) => args[args.indexOf("-P") + 1])).toEqual(
        installer === undefined ? [application] : [application, installer],
      );
      expect(partitions).toHaveLength(imports.length);
      for (const args of partitions) {
        expect(args[args.indexOf("-k") + 1]).toBe(created[2]);
        expect(args[args.indexOf("-S") + 1]).toBe("apple-tool:,apple:");
        expect(args.at(-1)).toBe(result.keychainFile);
      }
    },
  );
});
