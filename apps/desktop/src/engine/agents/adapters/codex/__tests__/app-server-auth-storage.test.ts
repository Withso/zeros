import { describe, expect, it } from "vitest";

import { codexAppServerFeatureArgs } from "../app-server";

describe("codex app-server auth storage", () => {
  it("uses private file stores whenever ZSR owns the process boundary", () => {
    expect(codexAppServerFeatureArgs(true)).toEqual(
      expect.arrayContaining([
        'cli_auth_credentials_store="file"',
        'mcp_oauth_credentials_store="file"',
      ]),
    );
  });

  it("does not change the user's credential-store choice outside ZSR", () => {
    const args = codexAppServerFeatureArgs(false);
    expect(args).not.toContain('cli_auth_credentials_store="file"');
    expect(args).not.toContain('mcp_oauth_credentials_store="file"');
  });
});
