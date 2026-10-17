import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ root: "", local: true }));
vi.mock("../secret-store", () => ({
  secretsFilePath: () =>
    path.join(state.root, "com.zeros.local", "secrets.json"),
}));
vi.mock("../runtime-mode", () => ({
  get IS_LOCAL_DEVELOPMENT() {
    return state.local;
  },
}));
import {
  createProviderAccountProfile,
  isOwnedProviderProfileDirectory,
  providerProfileDirectory,
} from "../provider-profile-directory";

afterEach(() => {
  if (state.root) rmSync(state.root, { recursive: true, force: true });
});
describe("stable provider profile ownership", () => {
  it("uses macOS Keychain for new Codex accounts without replacing an existing native storage choice", () => {
    state.root = mkdtempSync(path.join(tmpdir(), "zeros-profile-storage-"));
    const id = "00000000-0000-4000-8000-000000000001";
    const directory = createProviderAccountProfile("codex", id, "darwin");
    const config = path.join(directory, "config.toml");
    expect(readFileSync(config, "utf8")).toContain(
      'cli_auth_credentials_store = "keyring"',
    );
    writeFileSync(config, 'cli_auth_credentials_store = "file"\n');
    createProviderAccountProfile("codex", id, "darwin");
    expect(readFileSync(config, "utf8")).toBe(
      'cli_auth_credentials_store = "file"\n',
    );
    const linux = createProviderAccountProfile(
      "codex",
      "00000000-0000-4000-8000-000000000002",
      "linux",
    );
    expect(existsSync(path.join(linux, "config.toml"))).toBe(false);
  });

  it("retains migrated Local Keychain namespaces without permitting another channel or arbitrary directory", () => {
    state.root = mkdtempSync(path.join(tmpdir(), "zeros-profile-ownership-"));
    state.local = true;
    const id = "00000000-0000-4000-8000-000000000001";
    const legacy = path.join(
      state.root,
      "com.zeros.local.0123456789abcdef",
      "provider-accounts",
      "claude",
      id,
    );
    expect(isOwnedProviderProfileDirectory("claude", id, legacy)).toBe(true);
    expect(
      isOwnedProviderProfileDirectory(
        "claude",
        id,
        providerProfileDirectory("claude", id),
      ),
    ).toBe(true);
    for (const directory of [
      legacy.replace("local", "dev"),
      legacy.replace("claude", "codex"),
      path.join(state.root, "untrusted", id),
    ])
      expect(isOwnedProviderProfileDirectory("claude", id, directory)).toBe(
        false,
      );
    state.local = false;
    expect(isOwnedProviderProfileDirectory("claude", id, legacy)).toBe(false);
  });
});
