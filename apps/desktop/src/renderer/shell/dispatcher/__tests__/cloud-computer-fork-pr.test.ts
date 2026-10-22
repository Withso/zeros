import { describe, expect, it } from "vitest";
import { computerPrSupported } from "../cloud-computer-source";

const repository = { owner: "Withso", name: "zeros" };
describe("cloud pull request sources", () => {
  it("accepts the installed repository's own pull requests, case-insensitively", () => {
    expect(computerPrSupported({ headRepository: "Withso/zeros" }, repository)).toBe(true);
    expect(computerPrSupported({ headRepository: "withso/ZEROS" }, repository)).toBe(true);
  });
  it("refuses fork, deleted-head and unknown-head pull requests until forks are supported", () => {
    expect(computerPrSupported({ headRepository: "someone/zeros" }, repository)).toBe(false);
    expect(computerPrSupported({ headRepository: null }, repository)).toBe(false);
    expect(computerPrSupported({}, repository)).toBe(false);
  });
});
