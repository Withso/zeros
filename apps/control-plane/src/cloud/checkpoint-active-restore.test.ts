import { describe, expect, it } from "vitest";
import { restoreCommand } from "./checkpoint.js";

const input = {
  active: true, checkoutPath: "/home/user/example/project", home: "/home/user", key: Buffer.alloc(32, 7),
  sha256: "a".repeat(64), downloadUrl: "https://storage.example.test/checkpoint",
  githubToken: "synthetic-restore-credential",
};

describe("active restore repository boundary", () => {
  it("accepts GitHub's 100-character repository name with the transport suffix", () => {
    expect(() => restoreCommand({ ...input, repositoryUrl: `https://github.com/example/${"r".repeat(100)}.git` })).not.toThrow();
  });

  it.each([
    "https://github.com/example/../project", "https://github.com.evil.test/example/project",
    "https://credential@github.com/example/project", "http://github.com/example/project",
    "https://github.com/example/project?redirect=1", "https://github.com/example/project\n",
    `https://github.com/example/${"r".repeat(101)}.git`,
  ])("refuses a noncanonical repository URL %s before issuing a command", repositoryUrl => {
    expect(() => restoreCommand({ ...input, repositoryUrl })).toThrow();
  });
});
