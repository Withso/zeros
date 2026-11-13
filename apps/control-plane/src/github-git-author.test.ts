import { describe, expect, it, vi } from "vitest";
import { githubCommitProfile, readGithubGitAuthor } from "./github-git-author.js";
import type { Tx } from "./db.js";

describe("GitHub commit identity", () => {
  it("uses verified account data and never the public or primary email", () => {
    expect(githubCommitProfile({ id: 1234, login: "test-member", name: "Test Member", email: "private@example.test" }))
      .toEqual({ login: "test-member", githubUserId: "1234", gitName: "Test Member" });
  });
  it.each([null, "", "  ", "Bad\nAuthor", "A <B>", "a".repeat(257)])("falls back to the login for unusable names", name => {
    expect(githubCommitProfile({ id: 1234, login: "test-member", name }).gitName).toBe("test-member");
  });
  it.each([{ id: 0, login: "member" }, { id: 1.5, login: "member" }, { login: "member" }, { id: 1, login: "bad\nlogin" }])("rejects an incomplete authenticated profile", value => {
    expect(() => githubCommitProfile(value)).toThrow();
  });
  it("resolves only the requesting member's connected account", async () => {
    const query = vi.fn(async (_sql: string, params: unknown[]) => ({ rows: params[0] === "member-a"
      ? [{ github_user_id: "1234", github_login: "member-a", git_author_name: "Member A" }]
      : [{ github_user_id: "5678", github_login: "member-b", git_author_name: "Member B" }] }));
    const tx = { query } as unknown as Tx;
    expect(await readGithubGitAuthor(tx, "member-a")).toEqual({ name: "Member A", email: "1234+member-a@users.noreply.github.com" });
    expect(await readGithubGitAuthor(tx, "member-b")).toEqual({ name: "Member B", email: "5678+member-b@users.noreply.github.com" });
    expect(query.mock.calls.every(([sql]) => sql.includes("app_variant='github.com'"))).toBe(true);
  });
  it.each([{ rows: [] }, { rows: [{ github_login: "legacy", github_user_id: null }] }])("leaves disconnected and unrefreshed legacy accounts unset", async ({ rows }) => {
    expect(await readGithubGitAuthor({ query: async () => ({ rows }) } as unknown as Tx, "member")).toBeNull();
  });
  it("reuses a stored name only for the selected immutable GitHub identity", async () => {
    const tx = { query: async () => ({ rows: [{ github_user_id: "1234", github_login: "old-login", git_author_name: "Stored Name" }] }) } as unknown as Tx;
    expect(await readGithubGitAuthor(tx, "member", { id: "1234", login: "selected-login" }))
      .toEqual({ name: "Stored Name", email: "1234+selected-login@users.noreply.github.com" });
    expect(await readGithubGitAuthor(tx, "member", { id: "5678", login: "other-account" }))
      .toEqual({ name: "other-account", email: "5678+other-account@users.noreply.github.com" });
  });
  it.each([{ rows: [] }, { rows: [{ github_user_id: null, github_login: "legacy", git_author_name: "Legacy Name" }] }])("uses the selected confirmed login without a matching global profile", async ({ rows }) => {
    const tx = { query: async () => ({ rows }) } as unknown as Tx;
    expect(await readGithubGitAuthor(tx, "member", { id: "5678", login: "selected-login" }))
      .toEqual({ name: "selected-login", email: "5678+selected-login@users.noreply.github.com" });
  });
  it.each([{ id: "0", login: "selected" }, { id: "1234", login: "bad\nlogin" }])("never falls back to another profile for invalid selected metadata", async selected => {
    const tx = { query: async () => ({ rows: [{ github_user_id: "1234", github_login: "global", git_author_name: "Global Name" }] }) } as unknown as Tx;
    expect(await readGithubGitAuthor(tx, "member", selected)).toBeNull();
  });
});
