import { describe, expect, it } from "vitest";
import type { CloudProject } from "../../../platform/cloud-github-levels";
import { cloudProjectGroups } from "../cloud-project-picker";

const project = (name: string, level: "organization" | "personal") => ({ id: name, name, level }) as unknown as CloudProject;

describe("Create's project groups", () => {
  it("lists an organization's projects, then Only you", () => {
    expect(cloudProjectGroups([project("api", "organization"), project("mine", "personal")], "Withso").map(group => group.label)).toEqual(["Withso", "Only you"]);
  });

  it("shows Personal's own cloud as one list", () => {
    const groups = cloudProjectGroups([project("api", "organization"), project("mine", "personal")], "Personal", true);
    expect(groups).toEqual([{ label: "Your projects", rows: [project("api", "organization"), project("mine", "personal")] }]);
    expect(cloudProjectGroups([], "Personal", true)).toEqual([]);
  });
});
