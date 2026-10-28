import { afterEach, describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isSensitiveRepoPath, readWorkspaceFile } from "../read-file";

describe("opt-in Files video previews", () => {
  const roots: string[] = [];
  const fixture = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-file-media-"));
    roots.push(root);
    return root;
  };
  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it.each([false, true])("reads original video bytes for remote=%s without changing legacy reads", remote => {
    const root = fixture();
    const bytes = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]);
    fs.writeFileSync(path.join(root, "clip.MP4"), bytes);
    expect(readWorkspaceFile(root, "clip.MP4", { remote })).toMatchObject({ kind: "binary" });
    expect(readWorkspaceFile(root, "clip.MP4", { remote, includeVideo: true })).toEqual({
      kind: "video", path: "clip.MP4", bytes: bytes.length,
      dataUrl: `data:video/mp4;base64,${bytes.toString("base64")}`,
    });
  });

  it.each([
    ["webm", "video/webm"], ["mov", "video/quicktime"], ["m4v", "video/mp4"],
    ["ogv", "video/ogg"], ["mkv", "video/x-matroska"],
  ])("keeps %s source bytes and MIME for download even if the codec is unsupported", (extension, mime) => {
    const root = fixture();
    fs.writeFileSync(path.join(root, `clip.${extension}`), Buffer.from([0, 1, 2]));
    expect(readWorkspaceFile(root, `clip.${extension}`, { includeVideo: true })).toMatchObject({
      kind: "video", dataUrl: `data:${mime};base64,AAEC`,
    });
  });

  it("refuses oversized media before allocating or reading its payload", () => {
    const root = fixture();
    const file = path.join(root, "large.mp4");
    fs.writeFileSync(file, "");
    fs.truncateSync(file, 5 * 1024 * 1024 + 1);
    const read = vi.spyOn(fs, "readSync");
    expect(readWorkspaceFile(root, "large.mp4", { includeVideo: true })).toEqual({
      kind: "too-large", path: "large.mp4", bytes: 5 * 1024 * 1024 + 1,
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("keeps path and remote-secret authorization for videos", () => {
    const root = fixture(), outside = fixture();
    fs.writeFileSync(path.join(outside, "clip.mp4"), Buffer.from([0, 1, 2]));
    fs.writeFileSync(path.join(root, ".env"), "fixture only");
    fs.symlinkSync(path.join(outside, "clip.mp4"), path.join(root, "outside.mp4"));
    fs.symlinkSync(".env", path.join(root, "secret.mp4"));
    for (const target of ["outside.mp4", "secret.mp4", path.join(outside, "clip.mp4")]) {
      expect(readWorkspaceFile(root, target, { remote: true, includeVideo: true })).toMatchObject({ kind: "error" });
    }
  });
});

describe("isSensitiveRepoPath (remote-boundary secret denylist)", () => {
  it("denies portable Dev infrastructure credentials and allows their example", () => {
    expect(isSensitiveRepoPath("zeros-dev-env.json")).toBe(true);
    expect(isSensitiveRepoPath("config/zeros-dev-env.json")).toBe(true);
    expect(isSensitiveRepoPath("config/ZEROS-DEV-ENV.JSON")).toBe(true);
    expect(isSensitiveRepoPath("zeros-dev-env-example.json")).toBe(false);
  });

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
