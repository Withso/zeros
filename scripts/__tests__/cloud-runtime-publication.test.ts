import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL(
    "../../.github/workflows/cloud-runtime-publication.yml",
    import.meta.url,
  ),
  "utf8",
);
describe("cloud runtime publication authority", () => {
  it("accepts only reviewed main in its protected environment", () => {
    expect(source).toContain("workflow_dispatch:");
    expect(source).not.toMatch(/pull_request|push:\s/);
    expect(source).toContain(
      "github.event.repository.fork == false && github.ref == 'refs/heads/main'",
    );
    expect(source).toContain("environment: cloud-runtime-publication");
    expect(source).toContain("persist-credentials: false");
    expect(source).toContain("cancel-in-progress: false");
  });
  it("publishes with the ephemeral repository token without provider allocations or agent credentials", () => {
    expect(source).toContain("packages: write");
    expect(source).toContain("secrets.GITHUB_TOKEN");
    expect(source).not.toMatch(
      /secrets\.(?!GITHUB_TOKEN)[A-Z_]+|bake-snapshot|provision\.ts|DAYTONA_API_KEY|BOAT_API_KEY/,
    );
    expect(source).toContain("--password-stdin");
    expect(source).toContain("if: always()");
    expect(source).toContain('rm -rf -- "$DOCKER_CONFIG"');
  });
  it("binds evidence to the OCI digest and exact reviewed workflow source", () => {
    expect(source).toContain("$GITHUB_SHA-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT");
    expect(source).toContain(
      "subject-digest: ${{ steps.receipt.outputs.digest }}",
    );
    expect(source).toContain(
      '--source-digest "$GITHUB_SHA" --deny-self-hosted-runners',
    );
    expect(source).toContain('"oci://$PUBLISHED_IMAGE"');
    expect(source).toContain("/publication.json");
    const publisher = readFileSync(
      new URL(
        "../cloud-workspace-validation/publish-vm-image.ts",
        import.meta.url,
      ),
      "utf8",
    );
    expect(publisher).toContain("org.opencontainers.image.source=");
    expect(publisher).toContain("org.opencontainers.image.revision=");
  });
  it("bounds the isolated builder before registry authentication", () => {
    expect(source).toContain("--driver docker-container");
    expect(source).toMatch(/image=moby\/buildkit@sha256:[a-f0-9]{64}/);
    expect(source).toContain("--driver-opt memory=4g");
    expect(source).toContain("--driver-opt memory-swap=4g");
    expect(source).toContain("--driver-opt cpu-quota=200000");
    expect(source).toContain("--driver-opt cpu-period=100000");
    expect(source).toContain("--driver-opt restart-policy=no");
    expect(source).toContain("max-parallelism = 2");
    expect(source.indexOf("--driver docker-container")).toBeLessThan(
      source.indexOf("docker login"),
    );
    expect(source).toContain(
      'ZEROS_CLOUD_VM_MIN_FREE_DISK_BYTES: "2147483648"',
    );
    expect(source).toContain("docker info --format '{{.DockerRootDir}}'");
    expect(source).toContain('"$ZEROS_CLOUD_VM_DOCKER_ROOT"');
  });
  it("makes the isolated registry login readable to the pinned attestation action and restores it before cleanup", () => {
    const stage = source.indexOf("publication-registry-auth.ts stage");
    const attest = source.indexOf("- name: Attest image source provenance");
    const restore = source.indexOf("publication-registry-auth.ts restore");
    expect(stage).toBeGreaterThan(
      source.indexOf("- name: Validate publication receipt"),
    );
    expect(stage).toBeLessThan(attest);
    expect(restore).toBeGreaterThan(attest);
    expect(restore).toBeLessThan(
      source.indexOf("- name: Verify published provenance"),
    );
    const cleanupRestore = source.lastIndexOf(
      "publication-registry-auth.ts restore",
    );
    expect(cleanupRestore).toBeGreaterThan(
      source.indexOf("- name: Remove publication builder"),
    );
    expect(cleanupRestore).toBeLessThan(
      source.indexOf('rm -rf -- "$DOCKER_CONFIG"'),
    );
    expect(source).not.toMatch(/(?:echo|export)\s+["']?HOME=/);
  });
  it("retains only resource diagnostics and removes the owned builder as well as credentials", () => {
    expect(source).toContain(
      "cloud-runtime-resources-${{ github.run_id }}-${{ github.run_attempt }}",
    );
    expect(source).toContain("/resources.log");
    expect(source).toContain("free --bytes");
    expect(source).toContain("df --block-size=1");
    expect(source).toContain("docker stats --no-stream");
    expect(source).toContain('docker buildx rm --force "$BUILDX_BUILDER"');
    expect(source).not.toMatch(/docker inspect(?![^\n]*--format)/);
    expect(source).not.toMatch(/path:\s*\$\{\{[^\n]*\/docker/);
  });
});
