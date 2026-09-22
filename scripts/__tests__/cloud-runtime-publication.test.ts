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
});
