import { describe, it, expect } from "vitest";
import { isSensitiveRepoPath } from "../read-file";

describe("isSensitiveRepoPath (remote-boundary secret denylist)", () => {
  it("denies dotenv files (but allows public templates)", () => {
    expect(isSensitiveRepoPath(".env")).toBe(true);
    expect(isSensitiveRepoPath(".env.local")).toBe(true);
    expect(isSensitiveRepoPath(".env.production")).toBe(true);
    expect(isSensitiveRepoPath("config/.env.staging")).toBe(true);
    // Suffix-style env files were leaking to remote clients before the fix:
    // only `.env`/`.env.*` matched, so `prod.env` / `local.env` / `.flaskenv`
    // were served + enumerated.
    expect(isSensitiveRepoPath("prod.env")).toBe(true);
    expect(isSensitiveRepoPath("config/local.env")).toBe(true);
    expect(isSensitiveRepoPath(".flaskenv")).toBe(true);
    expect(isSensitiveRepoPath(".env.example")).toBe(false);
    expect(isSensitiveRepoPath(".env.sample")).toBe(false);
    expect(isSensitiveRepoPath(".env.template")).toBe(false);
    expect(isSensitiveRepoPath("prod.env.example")).toBe(false);
  });

  it("denies private keys + credential files by basename/extension", () => {
    expect(isSensitiveRepoPath("id_rsa")).toBe(true);
    expect(isSensitiveRepoPath("deploy/id_ed25519")).toBe(true);
    expect(isSensitiveRepoPath("server.key")).toBe(true);
    expect(isSensitiveRepoPath("certs/site.pem")).toBe(true);
    expect(isSensitiveRepoPath("app.p12")).toBe(true);
    expect(isSensitiveRepoPath(".npmrc")).toBe(true);
    expect(isSensitiveRepoPath(".netrc")).toBe(true);
    expect(isSensitiveRepoPath("terraform.tfstate")).toBe(true);
    expect(isSensitiveRepoPath("credentials")).toBe(true);
  });

  it("denies anything inside a sensitive directory (.git, .ssh, .aws)", () => {
    expect(isSensitiveRepoPath(".git/config")).toBe(true);
    expect(isSensitiveRepoPath(".ssh/known_hosts")).toBe(true);
    expect(isSensitiveRepoPath(".aws/credentials")).toBe(true);
    expect(isSensitiveRepoPath("nested/.gnupg/secring.gpg")).toBe(true);
  });

  it("allows ordinary source + public keys", () => {
    expect(isSensitiveRepoPath("src/index.ts")).toBe(false);
    expect(isSensitiveRepoPath("README.md")).toBe(false);
    expect(isSensitiveRepoPath("id_ed25519.pub")).toBe(false); // public key is fine
    expect(isSensitiveRepoPath("certs/site.crt")).toBe(false);
    expect(isSensitiveRepoPath("package.json")).toBe(false);
    expect(isSensitiveRepoPath("")).toBe(false);
  });

  it("normalizes backslash separators (defense in depth)", () => {
    expect(isSensitiveRepoPath(".git\\config")).toBe(true);
    expect(isSensitiveRepoPath("config\\.env.local")).toBe(true);
  });

  it("collapses '.'/'..'/redundant separators BEFORE the check (no smuggling)", () => {
    // path.resolve collapses these before opening the file; the denylist must
    // see the SAME canonical path or the secret leaks.
    expect(isSensitiveRepoPath(".env/.")).toBe(true);
    expect(isSensitiveRepoPath(".env/x/..")).toBe(true);
    expect(isSensitiveRepoPath("./.env")).toBe(true);
    expect(isSensitiveRepoPath("a/../id_rsa")).toBe(true);
    expect(isSensitiveRepoPath("certs/./site.pem")).toBe(true);
    expect(isSensitiveRepoPath("nested//.ssh//id_rsa")).toBe(true);
  });

  it("denies additional high-value credential files", () => {
    expect(isSensitiveRepoPath("service-account.json")).toBe(true);
    expect(isSensitiveRepoPath("config/gcp-key.json")).toBe(true);
    expect(isSensitiveRepoPath("firebase-adminsdk-abc.json")).toBe(true);
    expect(isSensitiveRepoPath("my-credentials.yaml")).toBe(true);
    expect(isSensitiveRepoPath(".git-credentials")).toBe(true);
    expect(isSensitiveRepoPath(".pypirc")).toBe(true);
    expect(isSensitiveRepoPath(".kube/config")).toBe(true);
    expect(isSensitiveRepoPath("vpn.ovpn")).toBe(true);
    expect(isSensitiveRepoPath("client.cert")).toBe(true);
  });

  it("does not over-block ordinary json/yaml config", () => {
    expect(isSensitiveRepoPath("package.json")).toBe(false);
    expect(isSensitiveRepoPath("tsconfig.json")).toBe(false);
    expect(isSensitiveRepoPath("config/app.yaml")).toBe(false);
    expect(isSensitiveRepoPath("docker-compose.yml")).toBe(false);
  });

  it("allows public credential TEMPLATES but still blocks the real file", () => {
    expect(isSensitiveRepoPath("credentials.example.json")).toBe(false);
    expect(isSensitiveRepoPath("service-account.sample.yaml")).toBe(false);
    expect(isSensitiveRepoPath("secret.template.json")).toBe(false);
    expect(isSensitiveRepoPath("credentials.json")).toBe(true);
    expect(isSensitiveRepoPath("service-account.json")).toBe(true);
  });
});
