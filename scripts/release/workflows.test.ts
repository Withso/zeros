import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
const workflow = (name: string) => readFileSync(`.github/workflows/${name}.yml`, "utf8");
function job(text: string, name: string) {
  return text.split(`\n  ${name}:\n`)[1]?.split(/\n {2}[a-z][a-z_-]+:\n/)[0] ?? "";
}
describe("release dependency and authority contracts", () => {
  it.each(["release-alpha", "release-beta", "release"])("gates %s mutations on exact-source required CI without delaying the build", name => {
    const text = workflow(name), ci = job(text, "ci");
    expect(ci).toContain("actions: read");
    expect(ci).toContain("contents: read");
    expect(ci).not.toContain("secrets:");
    expect(ci).toContain("ref: ${{ github.sha }}");
    expect(ci).toContain("RELEASE_SHA: ${{ github.sha }}");
    expect(ci).toContain("pnpm exec tsx scripts/release/ci-cli.ts --wait");
    expect(job(text, "hosted")).toContain("needs: ci");
    expect(job(text, "build")).not.toMatch(/^    needs:/m);
    expect(job(text, "test")).toBe("");
    expect(text).not.toMatch(/pnpm (?:typecheck|lint|test:git)\b/);
    expect(text).not.toContain("scripts/release/vitest.config.ts");
  });
  it("rechecks required CI inside the callable hosted workflow", () => {
    expect(job(workflow("hosted-promotion"), "guard")).toContain("pnpm exec tsx scripts/release/ci-cli.ts --verify");
  });
  it.each(["preflight", "codeql"])("runs %s push checks on main and every release branch", name => {
    expect(workflow(name)).toContain('branches: [main, "release/**"]');
  });
  it("runs services and WorkOS verification before worker qualification, then finalizes the selected tuple", () => {
    const text = workflow("hosted-promotion"), services = job(text, "services"), worker = job(text, "worker"), promote = job(text, "promote");
    expect(services).toContain("needs: guard");
    expect(services).toContain("cli.ts --services");
    expect(services).toContain("name: hosted-services-");
    expect(worker).toContain("needs: [guard, services]");
    expect(promote).toContain("needs: [guard, services, worker]");
    expect(promote).toContain("cli.ts --finalize");
  });
  it("takes the worker decision from qualified input comparison rather than the switch alone", () => {
    const guard = job(workflow("hosted-promotion"), "guard");
    expect(guard).toContain("worker_enabled: ${{ steps.guard.outputs.worker_enabled }}");
    expect(guard).toContain("ZEROS_WORKER_PROMOTION: ${{ vars.ZEROS_WORKER_PROMOTION }}");
    expect(guard).not.toContain("if [ \"$WORKER_SWITCH\" = enabled ]");
  });
  it.each([["release-alpha", "alpha"], ["release-beta", "beta"], ["release", "production"]])("publishes and anonymously verifies the cumulative ledger in %s", (name, channel) => {
    const text = job(workflow(name), "publish");
    expect(text).toContain("scripts/release/release-ledger-cli.ts --build");
    expect(text).toContain("scripts/release/release-ledger-cli.ts --verify");
    const asset = name === "release" ? "release/release-ledger.json" : `release/${channel}-release-ledger.json`;
    expect(text).toContain(`"${asset}"`);
    expect(text.indexOf("release-ledger-cli.ts --verify")).toBeGreaterThan(text.indexOf('gh release create "$TAG"'));
  });
  it("includes the release controller source in normal Git discovery", () => {
    expect(spawnSync("git", ["check-ignore", "--no-index", "--quiet", "scripts/release/cli.ts"]).status).toBe(1);
  });
  it.each([["release-alpha", "alpha"], ["release-beta", "beta"], ["release", "production"]])("publishes %s only after CI, parallel signing, and hosted success", (name, channel) => {
    const text = workflow(name);
    expect(text).toContain(`group: release-${channel}\n  cancel-in-progress: false`);
    const hosted = job(text, "hosted");
    expect(hosted).toContain("needs: ci"); expect(hosted).toContain("uses: ./.github/workflows/hosted-promotion.yml");
    expect(hosted).toContain("source_sha: ${{ github.sha }}");
    expect(hosted).not.toContain("needs: build");
    const build = job(text, "build"), publish = job(text, "publish");
    expect(build).toContain(`environment: ${channel}`);
    expect(build).toContain("contents: read");
    expect(build).not.toMatch(/^    needs:/m);
    expect(build).toContain("if: github.event.repository.fork == false");
    expect(publish).toContain(channel === "production" ? "needs: [ci, build, hosted, notarize]" : "needs: [ci, build, hosted]");
    expect(publish).toContain("contents: write");
    expect(publish).toContain("actions: read");
    expect(publish).toContain("ref: ${{ github.sha }}");
    expect(publish).toContain("VERSION: ${{ needs.build.outputs.version }}");
    expect(publish).not.toContain("always()");
    expect(build).not.toContain("contents: write");
    expect(build.replace(/^\s*#.*$/gm, "")).not.toMatch(/(?:gh release|gh api|notarytool|scripts\/release\/(?:cli|publication-cli|release-ledger-cli)\.ts)/);
    const buildSecrets = [...build.matchAll(/secrets\.([A-Z_]+)/g)].map(match => match[1]);
    expect(buildSecrets.length).toBeGreaterThan(0);
    expect(buildSecrets.every(secret => ["CSC_LINK", "CSC_KEY_PASSWORD", "VITE_APP_BASE_URL", "VITE_CONTROL_PLANE_URL", "VITE_POSTHOG_KEY_PROD", "VITE_POSTHOG_HOST"].includes(secret))).toBe(true);
    expect(text.replace(`\n  build:\n${build}`, "")).not.toContain("secrets.CSC_");
  });
  it.each(["release-alpha", "release-beta", "release"])("retains release-only packaged checks and a retryable signed artifact in %s", name => {
    const build = job(workflow(name), "build");
    for (const command of ["pnpm check:zsr", "pnpm smoke:engine", "pnpm smoke:packaged-pty", "scripts/verify-macos-release-artifacts.mjs"])
      expect(build).toContain(command);
    expect(build).toContain("--publish never");
    expect(build).toContain("version: ${{ steps.version.outputs.version }}");
    expect(build).toContain("uses: actions/upload-artifact@");
    expect(build).toContain("overwrite: true");
    expect(build).toContain("if-no-files-found: error");
    expect(build).toContain(".zip.blockmap");
    expect(build).not.toContain("release/notarization-submission-id.txt");
    expect(job(workflow(name), "publish")).toContain("uses: actions/download-artifact@");
  });
  it.each(["release-alpha", "release-beta", "release"])("binds %s publication to the cloud capability its build baked in", name => {
    const text = workflow(name), build = job(text, "build"), publish = job(text, "publish");
    expect(build).toContain("cloud_enabled: ${{ steps.capability.outputs.cloud_enabled }}");
    expect(build).toContain("id: capability");
    expect(publish).toContain("BUILD_CLOUD_ENABLED: ${{ needs.build.outputs.cloud_enabled }}");
  });
  it("submits to Apple only after CI and signing, preserving a submission for cheap notarization retries", () => {
    const text = workflow("release"), submit = job(text, "submit"), notarize = job(text, "notarize");
    expect(submit).toContain("needs: [ci, build]");
    expect(submit).toContain("scripts/release/ci-cli.ts --verify");
    expect(submit).toContain("scripts/release/ci-cli.ts --verify --beta");
    expect(submit).toContain("ZEROS_HOSTED_PROMOTION: ${{ vars.ZEROS_HOSTED_PROMOTION }}");
    expect(submit).toContain("notarytool submit");
    expect(submit).toContain("secrets.APPLE_");
    expect(submit).toContain("release/notarization-submission-id.txt");
    expect(submit).toContain("uses: actions/upload-artifact@");
    expect(notarize).toContain("needs: [ci, build, submit]");
    expect(notarize).toContain("notarytool info");
    expect(notarize).not.toContain("notarytool submit");
    expect(notarize).not.toContain("contents: write");
    expect(notarize).toContain("uses: actions/upload-artifact@");
    expect(notarize).toContain("scripts/release/ci-cli.ts --verify");
  });
  it("reports Apple's reason for a refused submission and retries only transient failures", () => {
    const step = job(workflow("release"), "submit").split("- name: Submit to Apple notary (--no-wait, no poll)\n")[1]?.split(/\n {6}- /)[0] ?? "";
    const script = step.split("run: |\n")[1]?.replace(/^ {10}/gm, "") ?? "";
    expect(script).toContain("notarytool submit");
    const submit = (mode: string, appleId = "person@example.invalid") => {
      const dir = mkdtempSync(path.join(tmpdir(), "zeros-notary-"));
      mkdirSync(path.join(dir, "bin")); mkdirSync(path.join(dir, "release"));
      writeFileSync(path.join(dir, "release", "Zeros-9.9.9-arm64.dmg"), "");
      writeFileSync(path.join(dir, "bin", "sleep"), "#!/bin/sh\n", { mode: 0o755 });
      writeFileSync(path.join(dir, "bin", "xcrun"), `#!/bin/bash
n=$(( $(cat attempts 2>/dev/null || echo 0) + 1 )); echo "$n" > attempts
case "$MODE" in
  ok) echo '{"id":"submission-1"}' ;;
  refused) echo "Error: HTTP status code: 401. Invalid credentials for $APPLE_ID." >&2; exit 69 ;;
  transient) if [ "$n" -lt 3 ]; then echo "Error: HTTP status code: 500." >&2; exit 1; fi; echo '{"id":"submission-3"}' ;;
  long) printf 'Error: HTTP status code: 401. Unable to authenticate.%0700d\n' 0 >&2; exit 69 ;;
  informational) echo '{"message":"Submission upload starting"}'; echo "Error: HTTP status code: 403. A required agreement is missing or has expired." >&2; exit 1 ;;
  membership) echo "Error: Your team's Apple Developer Program membership has expired." >&2; exit 1 ;;
  stdout) echo "Error: notary service unavailable"; exit 1 ;;
  session) if [ "$n" -lt 2 ]; then echo "Error: HTTP status code: 408. Upload session expired. Retry the upload." >&2; exit 1; fi; echo '{"id":"submission-2"}' ;;
  echoed) if [ "$n" -lt 2 ]; then echo "Error: HTTP status code: 500. Request for $APPLE_ID failed." >&2; exit 1; fi; echo '{"id":"submission-2"}' ;;
esac
`, { mode: 0o755 });
      // Stubs go first after any shell startup that edits PATH.
      const result = spawnSync("bash", ["-e", "-c", `PATH="$STUBS:$PATH"\n${script}`], { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH, STUBS: path.join(dir, "bin"), MODE: mode,
        APPLE_ID: appleId, APPLE_APP_SPECIFIC_PASSWORD: "fake-app-password", APPLE_TEAM_ID: "FAKETEAM" } });
      const read = (file: string) => { try { return readFileSync(path.join(dir, file), "utf8").trim(); } catch { return ""; } };
      const outcome = { status: result.status, output: `${result.stdout}${result.stderr}`, attempts: read("attempts"), id: read("release/notarization-submission-id.txt") };
      rmSync(dir, { recursive: true, force: true });
      return outcome;
    };
    expect(submit("ok")).toMatchObject({ status: 0, attempts: "1", id: "submission-1" });
    const refused = submit("refused");
    expect(refused).toMatchObject({ status: 1, attempts: "1", id: "" });
    expect(refused.output).toContain("HTTP status code: 401. Invalid credentials for [redacted].");
    expect(refused.output).not.toMatch(/person@example\.invalid|fake-app-password|FAKETEAM/);
    expect(submit("transient")).toMatchObject({ status: 0, attempts: "3", id: "submission-3" });
    // Classification reads the whole response; only the logged excerpt is capped.
    for (const mode of ["long", "informational", "membership"]) expect(submit(mode)).toMatchObject({ status: 1, attempts: "1", id: "" });
    expect(submit("informational").output).toContain("A required agreement is missing or has expired.");
    const stdout = submit("stdout");
    expect(stdout).toMatchObject({ status: 1, attempts: "3" });
    expect(stdout.output).toContain("notary service unavailable");
    // Transport and server errors retry even when their text mentions expiry,
    // and a credential value echoed back is never read as a refusal.
    expect(submit("session")).toMatchObject({ status: 0, attempts: "2", id: "submission-2" });
    expect(submit("echoed", "locked-person@example.invalid")).toMatchObject({ status: 0, attempts: "2", id: "submission-2" });
  });
  it("inherits the exact-source Preflight coverage instead of repeating its secret-free quality checks", () => {
    const preflight = workflow("preflight");
    for (const command of ["typecheck:app", "typecheck:electron", "typecheck:packages", "lint", "test:git", "models:verify --strict", "check:cursor-asar", "check:licenses", "check:audit", "check:packaging-paths", "check:vite-env", "check:codex-pin", "check:electron-hardening", "check:deep-link-schemes"])
      expect(preflight).toContain(`pnpm ${command}`);
    expect(preflight).toContain("scripts/release/tsconfig.json");
    expect(preflight).toContain("scripts/release/vitest.config.ts");
  });
  it("has a non-cancelling mutation lock, exact checkout, and success-only receipt", () => {
    const text = workflow("hosted-promotion"), promote = job(text, "promote");
    expect(text).toContain("workflow_call:");
    expect(job(text, "guard")).toContain("GH_TOKEN: ${{ github.token }}");
    expect(promote).toContain("needs.guard.outputs.enabled == 'true'");
    expect(promote).toContain("group: hosted-mutation-${{ inputs.channel }}\n      cancel-in-progress: false");
    expect(promote).toContain("ref: ${{ inputs.source_sha }}");
    expect(job(text, "services")).toContain("cli.ts --plan\n          pnpm exec tsx scripts/release/cli.ts --services");
    expect(promote).toContain("cli.ts --finalize");
    expect(promote.split("- name: Save success receipt")[1]).not.toContain("always()");
    expect(promote).toContain("include-hidden-files: true");
  });
  it("overwrites this run's hosted receipt artifacts on a whole-workflow retry without accepting another run's proof", () => {
    for (const name of ["services", "promote"]) {
      const producer = job(workflow("hosted-promotion"), name);
      expect(producer).toContain("overwrite: true");
      expect(producer).toContain("if-no-files-found: error");
    }
  });
  it("separates worker plans from verified success and shares the mutation lock", () => {
    const text = workflow("cloud-worker-promotion");
    expect(text).toContain("workflow_dispatch:"); expect(text).toContain("workflow_call:");
    expect(text).toContain("group: hosted-mutation-${{ inputs.channel }}");
    expect(text).toContain("name: worker-plan-"); expect(text).toContain("name: worker-promotion-");
    expect(text).toContain("success() && steps.promote.outputs.receipt_issued == 'true'");
    expect(text).toContain("ZEROS_WORKER_PROMOTION: ${{ vars.ZEROS_WORKER_PROMOTION }}");
  });
  it("V6: revalidates publication in all desktop writers, including notarization-only retries", () => {
    for (const [name, publish] of [["release-alpha", 'Publish rolling "alpha" prerelease'], ["release-beta", 'Publish rolling "beta" prerelease'], ["release", "Publish GitHub release"]]) {
      const text = job(workflow(name), "publish"), step = text.split(`- name: ${publish}`)[1]?.split(/\n {6}- name:/)[0] ?? "";
      expect(step).toContain("pnpm exec tsx scripts/release/publication-cli.ts");
      expect(text).toContain("actions: read");
    }
    expect(job(workflow("release"), "notarize")).toContain("ref: ${{ github.sha }}");
    expect(job(workflow("hosted-promotion"), "guard")).toContain("fetch-tags: true");
  });
  it("V6: advances rolling Git tag refs after their assets are published", () => {
    for (const name of ["release-alpha", "release-beta"]) {
      const text = workflow(name);
      expect(text).toContain('git/refs/tags/$TAG');
      expect(text.indexOf('git/refs/tags/$TAG')).toBeGreaterThan(text.indexOf('gh release upload "$TAG"'));
    }
  });
});
