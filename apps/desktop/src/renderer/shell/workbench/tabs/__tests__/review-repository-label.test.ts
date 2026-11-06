import { expect, it } from "vitest";
import { reviewRepositoryLabel } from "../review-repository-label";

it("shows the repository name while keeping cloud workspace identity out of the header", () => {
  const slug = "cloud-11111111-1111-4111-8111-111111111111:github.com:example/project";
  expect(reviewRepositoryLabel("cloud://organization/workspace", slug)).toBe("example/project");
  expect(reviewRepositoryLabel("cloud://organization/workspace", null)).toBeNull();
  for (const workspace of ["personal-workspace", "organization-local-workspace"]) {
    expect(reviewRepositoryLabel(workspace, "example/project")).toBe("example/project");
    expect(reviewRepositoryLabel(workspace, slug)).toBe(slug);
  }
});
