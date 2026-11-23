import { describe, expect, it } from "vitest";
import { READY_COPY_FAILURE_CODES, readyCopyFailureCopy } from "../ready-copy-copy";

describe("ready copy failures in plain words", () => {
  it("names a copy whose checkout or saved disk could not be confirmed, never with the generic line", () => {
    const generic = readyCopyFailureCopy("ready_copy_failed");
    for (const code of ["ready_copy_checkout_missing", "ready_copy_archive_incomplete"]) {
      expect(READY_COPY_FAILURE_CODES).toContain(code);
      expect(readyCopyFailureCopy(code)).not.toEqual(generic);
      expect(readyCopyFailureCopy(code).change).toMatch(/^Build again/);
    }
  });
});
