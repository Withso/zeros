import { describe, expect, it } from "vitest";
import {
  acceptCloudComputerV2EditorRevision,
  acceptCloudComputerV2EditorSave,
  acceptCloudComputerV2EditorDiscard,
  cloudComputerV2EditorDirty,
  cloudComputerV2EnvironmentRows,
  editCloudComputerV2Environment,
  newCloudComputerV2Editor,
  reconcileCloudComputerV2Editor,
} from "../cloud-computer-v2-editor";
import {
  computerOperationId,
  computerState,
} from "./cloud-computer-v2-fixtures";

describe("Cloud Computer editor buffers", () => {
  it("discards the submitted buffer while keeping newer script and timeout typing against the confirmed baseline", () => {
    const submitted = newCloudComputerV2Editor(
      computerState({
        revision: 1,
        draft: {
          ...computerState().draft,
          installScript: "echo before discard",
          timeoutSeconds: 600,
        },
      }),
    );
    const current = editCloudComputerV2Environment(
      {
        ...submitted,
        document: {
          ...submitted.document,
          installScript: "echo newer typing",
          timeoutSeconds: 222,
        },
      },
      { op: "set", name: "PENDING", value: "synthetic pending value" },
    );
    const confirmed = computerState({ revision: 2 });
    const discarded = acceptCloudComputerV2EditorDiscard(
      current,
      submitted,
      confirmed,
    );
    expect(discarded.revision).toBe(2);
    expect(discarded.base).toBe(confirmed.draft);
    expect(discarded.document).toEqual({
      repositories: [],
      installScript: "echo newer typing",
      timeoutSeconds: 222,
    });
    expect(cloudComputerV2EditorDirty(discarded)).toBe(true);
    const unchanged = acceptCloudComputerV2EditorDiscard(
      submitted,
      submitted,
      confirmed,
    );
    expect(unchanged).toEqual(newCloudComputerV2Editor(confirmed));
    expect(cloudComputerV2EditorDirty(unchanged)).toBe(false);
  });
  it("keeps an accepted save while its older confirmed GET snapshot revalidates", () => {
    const original = newCloudComputerV2Editor(computerState());
    const typed = {
      ...original,
      document: { ...original.document, installScript: "echo accepted" },
    };
    const saved = acceptCloudComputerV2EditorSave(typed, typed, {
      revision: 1,
      configId: computerOperationId,
    });
    expect(reconcileCloudComputerV2Editor(saved, computerState())).toBe(saved);
    expect(saved.document.installScript).toBe("echo accepted");
  });
  it("adopts a confirmed draft only while clean and keeps typing and the CAS baseline across revalidation", () => {
    const original = newCloudComputerV2Editor(computerState());
    const next = computerState({
      revision: 1,
      draft: { ...computerState().draft, installScript: "echo remote" },
    });
    expect(
      reconcileCloudComputerV2Editor(original, next).document.installScript,
    ).toBe("echo remote");
    const typed = {
      ...original,
      document: { ...original.document, installScript: "echo local" },
    };
    expect(cloudComputerV2EditorDirty(typed)).toBe(true);
    expect(reconcileCloudComputerV2Editor(typed, next)).toBe(typed);
    expect(typed.revision).toBe(0);
  });

  it("advances a dirty buffer after its own confirmed Cancel or Activate without losing edits", () => {
    const initial = computerState();
    const original = newCloudComputerV2Editor(initial);
    const typed = {
      ...original,
      document: { ...original.document, installScript: "echo local" },
    };
    const confirmed = computerState({ revision: 1 });
    const accepted = acceptCloudComputerV2EditorRevision(typed, confirmed, 1);
    expect(accepted.revision).toBe(1);
    expect(accepted.document).toBe(typed.document);
    expect(accepted.base).toBe(typed.base);
    expect(cloudComputerV2EditorDirty(accepted)).toBe(true);
  });

  it("requires Review if a later writer or changed draft follows an accepted action", () => {
    const original = newCloudComputerV2Editor(computerState());
    const typed = {
      ...original,
      document: { ...original.document, installScript: "echo local" },
    };
    expect(
      acceptCloudComputerV2EditorRevision(
        typed,
        computerState({ revision: 2 }),
        1,
      ),
    ).toBe(typed);
    expect(
      acceptCloudComputerV2EditorRevision(
        typed,
        computerState({
          revision: 1,
          draft: { ...original.base, configId: computerOperationId },
        }),
        1,
      ),
    ).toBe(typed);
    expect(acceptCloudComputerV2EditorRevision(typed, computerState(), 0)).toBe(
      typed,
    );
  });

  it("hydrates names and set markers only, preserves existing values by omission, and clears accepted plaintext", () => {
    const original = newCloudComputerV2Editor(
      computerState({
        draft: {
          ...computerState().draft,
          environment: [{ name: "EXAMPLE", set: true }],
        },
      }),
    );
    expect(original.document.environment).toBeUndefined();
    const typed = editCloudComputerV2Environment(original, {
      op: "set",
      name: "EXAMPLE",
      value: "temporary-entry",
    });
    expect(cloudComputerV2EnvironmentRows(typed)).toEqual([
      { name: "EXAMPLE", set: true },
    ]);
    const saved = acceptCloudComputerV2EditorSave(typed, typed, {
      revision: 1,
      configId: computerOperationId,
    });
    expect(saved.document.environment).toBeUndefined();
    expect(JSON.stringify(saved)).not.toContain("temporary-entry");
    expect(cloudComputerV2EditorDirty(saved)).toBe(false);
  });

  it("preserves newer nonsecret typing while an older save completes", () => {
    const submitted = newCloudComputerV2Editor(computerState());
    const current = {
      ...submitted,
      document: { ...submitted.document, installScript: "echo newer typing" },
    };
    const saved = acceptCloudComputerV2EditorSave(current, submitted, {
      revision: 1,
      configId: computerOperationId,
    });
    expect(saved.document.installScript).toBe("echo newer typing");
    expect(saved.base.installScript).toBe("");
    expect(cloudComputerV2EditorDirty(saved)).toBe(true);
  });

  it("removes existing draft bindings without revocation and drops unsaved additions locally", () => {
    const original = newCloudComputerV2Editor(
      computerState({
        draft: {
          ...computerState().draft,
          environment: [{ name: "EXAMPLE", set: true }],
        },
      }),
    );
    const removed = editCloudComputerV2Environment(original, {
      op: "remove",
      name: "EXAMPLE",
    });
    expect(removed.document.environment).toEqual([
      { op: "remove", name: "EXAMPLE" },
    ]);
    expect(cloudComputerV2EnvironmentRows(removed)).toEqual([]);
    const added = editCloudComputerV2Environment(original, {
      op: "set",
      name: "NEW_NAME",
      value: "temporary-entry",
    });
    const cancelled = editCloudComputerV2Environment(added, {
      op: "remove",
      name: "NEW_NAME",
    });
    expect(cancelled.document.environment).toEqual([]);
  });
});
