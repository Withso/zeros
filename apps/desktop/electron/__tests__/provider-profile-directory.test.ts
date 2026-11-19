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

  // Phase 2 finding 15: an isolated v2 instance's migrated profile keeps its
  // `com.zeros.local/instances/<id>` path, so it must stay removable.
  it("retains a migrated v2 instance profile, and nothing beside it", () => {
    state.root = mkdtempSync(path.join(tmpdir(), "zeros-profile-ownership-"));
    state.local = true;
    const id = "00000000-0000-4000-8000-000000000001";
    const v2 = (instance: string, provider = "claude") =>
      path.join(state.root, "com.zeros.local", "instances", instance, "provider-accounts", provider, id);
    expect(isOwnedProviderProfileDirectory("claude", id, v2("0123456789abcdef"))).toBe(true);
    for (const directory of [
      v2("design-qual-0011aabb"),
      v2("alpha"),
      v2("default"),
      v2("Not_Valid"),
      v2("0123456789abcdef", "codex"),
      v2("0123456789abcdef").replace("com.zeros.local", "com.zeros.dev"),
      path.join(state.root, "com.zeros.local", "instances", "a", "b", "provider-accounts", "claude", id),
      `${state.root}/com.zeros.local/instances/../provider-accounts/claude/${id}`,
    ])
      expect(isOwnedProviderProfileDirectory("claude", id, directory), directory).toBe(false);
    state.local = false;
    expect(isOwnedProviderProfileDirectory("claude", id, v2("0123456789abcdef"))).toBe(false);
  });
});
