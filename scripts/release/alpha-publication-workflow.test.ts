import { readFileSync } from "node:fs";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

const workflow = (name: string): any => load(readFileSync(`.github/workflows/${name}.yml`, "utf8"));
const commands = (job: any) => job.steps?.map((step: any) => step.run ?? "").join("\n") ?? "";

describe("concurrent Alpha preparation and serialized publication", () => {
  it("starts both exact-source builds independently of CI and any publication lock", () => {
    const parent = workflow("release-alpha");
    expect(parent.name).toBe("Release (alpha)");
    expect(parent.on).toEqual({ push: { branches: ["main"] } });
    expect(parent.concurrency).toBeUndefined();
    for (const id of ["metadata", "build", "runtime-build"]) {
      expect(parent.jobs[id].needs).toBe(id === "build" ? "metadata" : undefined);
      expect(parent.jobs[id].concurrency).toBeUndefined();
      expect(parent.jobs[id].permissions).toEqual({ contents: "read" });
    }
    expect(parent.jobs.build.environment).toBe("alpha");
    expect(parent.jobs["release-slot"]).toBeUndefined();
    expect(parent.permissions).toEqual({ contents: "read" });
  });
  it("keeps gate -> hosted overlap while one reusable call holds the entire transaction lock", () => {
    const parent = workflow("release-alpha"), publication = parent.jobs.publication, called = workflow("alpha-publication");
    expect(publication.needs).toEqual(["ci", "metadata"]);
    expect(publication.with.alpha_prepared_version).toBe("${{ needs.metadata.outputs.version }}");
    expect(publication.if).toBe("github.event.repository.fork == false && needs.ci.outputs.ready == 'true'");
    expect(publication.uses).toBe("./.github/workflows/alpha-publication.yml");
    expect(publication.name).toBe("Alpha publication");
    expect(publication.concurrency).toEqual({ group: "release-alpha", "cancel-in-progress": false });
    expect(publication.permissions).toEqual({ contents: "write", actions: "read", "id-token": "write" });
    expect(called.on).toHaveProperty("workflow_call");
    expect(called.on.workflow_dispatch).toBeUndefined();
    expect(called.concurrency).toBeUndefined();
    expect(Object.keys(called.jobs).sort()).toEqual(["entry", "hosted", "publish", "runtime-publish"]);
    expect(called.jobs.hosted.needs).toBe("entry");
    expect(called.jobs.hosted.uses).toBe("./.github/workflows/hosted-promotion.yml");
    for (const id of ["publish", "runtime-publish"]) expect(called.jobs[id].needs).toEqual(["entry", "hosted"]);
    expect(Object.keys(parent.jobs).sort()).toEqual(["build", "ci", "metadata", "publication", "runtime-build"]);
  });
  it("freezes the original computed full version outside the lock and passes it to signing and every mutation checkpoint", () => {
    const parent = workflow("release-alpha"), metadata = parent.jobs.metadata, called = workflow("alpha-publication");
    expect(metadata.name).toBe("Prepare Alpha version");
    expect(metadata.outputs.version).toBe("${{ steps.version.outputs.version }}");
    expect(metadata.environment).toBeUndefined();
    expect(commands(metadata)).toContain("node scripts/compute-version.mjs");
    expect(commands(metadata)).toContain('${BASE}-alpha.${RUN_NUMBER}');
    expect(metadata.steps.find((step: any) => step.id === "version").env.RUN_NUMBER).toBe("${{ github.run_number }}");
    expect(metadata.steps.find((step: any) => step.uses?.startsWith("actions/checkout@")).with).toMatchObject({
      ref: "${{ github.sha }}", "fetch-depth": 0, "fetch-tags": true, "persist-credentials": false,
    });
    expect(parent.jobs.build.env.ALPHA_PREPARED_VERSION).toBe("${{ needs.metadata.outputs.version }}");
    expect(commands(parent.jobs.build)).not.toContain("node scripts/compute-version.mjs");
    expect(called.on.workflow_call.inputs.alpha_prepared_version).toEqual({ required: true, type: "string" });
    expect(called.jobs.hosted.with.alpha_prepared_version).toBe("${{ inputs.alpha_prepared_version }}");
    for (const id of ["entry", "publish", "runtime-publish"]) expect(called.jobs[id].env.ALPHA_PREPARED_VERSION).toBe("${{ inputs.alpha_prepared_version }}");
    const hosted = workflow("hosted-promotion"), worker = workflow("cloud-worker-promotion");
    expect(hosted.on.workflow_call.inputs.alpha_prepared_version).toMatchObject({ default: "", type: "string" });
    for (const id of ["guard", "services", "promote"]) expect(hosted.jobs[id].env.ALPHA_PREPARED_VERSION).toBe("${{ inputs.alpha_prepared_version }}");
    expect(hosted.jobs.worker.with.alpha_prepared_version).toBe("${{ inputs.alpha_prepared_version }}");
    expect(worker.on.workflow_call.inputs.alpha_prepared_version).toMatchObject({ default: "", type: "string" });
    expect(worker.on.workflow_dispatch.inputs.alpha_prepared_version).toBeUndefined();
    expect(worker.jobs.worker.env.ALPHA_PREPARED_VERSION).toBe("${{ inputs.alpha_prepared_version }}");
    expect(JSON.stringify(called)).not.toContain("scripts/compute-version.mjs");
  });
  it("revalidates source, CI, admission and publication order inside the lock before provider access", () => {
    const called = workflow("alpha-publication"), entry = called.jobs.entry;
    expect(entry.needs).toBeUndefined();
    expect(entry.permissions).toEqual({ contents: "read", actions: "read" });
    expect(commands(entry)).toContain("scripts/release/alpha-transaction-cli.ts");
    expect(commands(entry)).not.toMatch(/alpha-build-cli|gh release|runtime-bundle\/publish|cli\.ts --services/);
    expect(entry.env.RELEASE_SHA).toBe("${{ github.sha }}");
    expect(entry.env.GH_TOKEN).toBe("${{ github.token }}");
    expect(JSON.stringify(entry)).not.toContain("secrets.");
    expect(workflow("release-alpha").jobs.ci.outputs.ready).toBe("${{ steps.barrier.outputs.ready }}");
    expect(commands(workflow("release-alpha").jobs.ci)).toContain("ci-cli.ts --wait");
  });
  it.each([["publish", "desktop", "zeros-alpha-arm64-build"], ["runtime-publish", "runtime", "zeros-alpha-runtime-build"]])(
    "waits for the same-run %s producer after hosted success and before its artifact download", (id, kind, artifact) => {
      const publisher = workflow("alpha-publication").jobs[id], steps = publisher.steps;
      const wait = steps.findIndex((step: any) => step.run?.includes(`alpha-build-cli.ts --wait ${kind}`));
      const download = steps.findIndex((step: any) => step.uses?.startsWith("actions/download-artifact@"));
      expect(wait).toBeGreaterThanOrEqual(0);
      expect(download).toBeGreaterThan(wait);
      expect(steps[wait].id).toBe("producer");
      expect(steps[download].with["artifact-ids"]).toBe("${{ steps.producer.outputs.artifact_id }}");
      expect(steps[download].with["run-id"]).toBe("${{ github.run_id }}");
      expect(steps[download].with["merge-multiple"]).toBe(true);
      expect(steps[download].with.name).toBeUndefined();
      expect(workflow("release-alpha").jobs[kind === "desktop" ? "build" : "runtime-build"].steps.find((step: any) => step.uses?.startsWith("actions/upload-artifact@")).with.name).toBe(`${artifact}-\${{ github.sha }}`);
      expect(publisher.environment).toBe("alpha");
      expect(publisher.permissions.actions).toBe("read");
    });
  it("revalidates runtime producer, artifact ID and current attempt after download and before OIDC publication", () => {
    const publisher = workflow("alpha-publication").jobs["runtime-publish"], steps = publisher.steps;
    const download = steps.findIndex((step: any) => step.uses?.startsWith("actions/download-artifact@"));
    const verification = steps.findIndex((step: any) => step.run?.includes("alpha-build-cli.ts --verify-producer runtime"));
    expect(verification).toBeGreaterThan(download);
    const publish = commands(publisher);
    expect(publish.indexOf("--verify-producer runtime")).toBeLessThan(publish.indexOf("ci-cli.ts --verify"));
    expect(publish.indexOf("ci-cli.ts --verify")).toBeLessThan(publish.indexOf("runtime-bundle/publish.ts"));
  });
  it("uses protected signed metadata for version and baked capability without broadening signing permissions", () => {
    const parent = workflow("release-alpha"), build = parent.jobs.build, publish = workflow("alpha-publication").jobs.publish;
    const metadata = build.steps.find((step: any) => step.name === "Write signed Alpha build metadata");
    expect(metadata.env.VERSION).toBe("${{ steps.version.outputs.version }}");
    expect(metadata.env.BUILD_CLOUD_ENABLED).toBe("${{ steps.capability.outputs.cloud_enabled }}");
    const upload = build.steps.find((step: any) => step.name === "Save signed Alpha artifacts");
    expect(upload.with.path).toContain("release/alpha-build-metadata.json");
    expect(upload.with.overwrite).toBe(true);
    const validate = publish.steps.find((step: any) => step.id === "metadata");
    expect(validate.run).toContain("alpha-build-cli.ts --verify-metadata");
    const writer = publish.steps.find((step: any) => step.name === 'Publish rolling "alpha" prerelease');
    expect(writer.env.VERSION).toBe("${{ steps.metadata.outputs.version }}");
    expect(writer.env.BUILD_CLOUD_ENABLED).toBe("${{ steps.metadata.outputs.cloud_enabled }}");
    expect(publish.permissions).toEqual({ contents: "write", actions: "read" });
    expect(workflow("alpha-publication").jobs["runtime-publish"].permissions).toEqual({ "id-token": "write", contents: "read", actions: "read" });
  });
  it.each([["release-beta", "beta"], ["release", "production"]])("retains %s channel locking and full CI", (name, channel) => {
    const parsed = workflow(name);
    expect(parsed.concurrency).toEqual({ group: `release-${channel}`, "cancel-in-progress": false });
    expect(parsed.jobs.publication).toBeUndefined();
    expect(parsed.jobs.hosted.uses).toBe("./.github/workflows/hosted-promotion.yml");
    expect(parsed.jobs.ci.env.RELEASE_CHANNEL).toBe(channel);
    expect(parsed.jobs.ci.env.ZEROS_ALPHA_CI_FAST_PATH).toBeUndefined();
    expect(parsed.jobs.ci.env.ZEROS_ALPHA_FORWARD_ONLY).toBeUndefined();
    if (channel === "production") {
      expect(parsed.jobs.approve.environment).toBe("production-approval");
      expect(parsed.jobs.build.needs).toBe("approve");
      expect(commands(parsed.jobs.submit)).toContain("notarytool submit");
      expect(parsed.jobs.publish.needs).toEqual(["approve", "ci", "build", "hosted", "notarize"]);
    }
  });
});
