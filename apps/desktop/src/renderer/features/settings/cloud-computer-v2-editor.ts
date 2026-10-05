import type {
  CloudComputerV2Draft,
  CloudComputerV2DraftInput,
  CloudComputerV2EnvironmentOperation,
  CloudComputerV2State,
} from "@zeros/protocol/cloud-computer-v2";

export type CloudComputerV2Editor = {
  revision: number;
  base: CloudComputerV2Draft;
  document: CloudComputerV2DraftInput;
};
export function newCloudComputerV2Editor(
  snapshot: CloudComputerV2State,
): CloudComputerV2Editor {
  return {
    revision: snapshot.revision,
    base: snapshot.draft,
    document: {
      repositories: snapshot.draft.repositories,
      installScript: snapshot.draft.installScript,
      timeoutSeconds: snapshot.draft.timeoutSeconds,
    },
  };
}
export function cloudComputerV2EditorDirty(
  editor: CloudComputerV2Editor,
): boolean {
  const { repositories, installScript, timeoutSeconds } = editor.base;
  return (
    Boolean(editor.document.environment?.length) ||
    JSON.stringify({ repositories, installScript, timeoutSeconds }) !==
      JSON.stringify({
        repositories: editor.document.repositories,
        installScript: editor.document.installScript,
        timeoutSeconds: editor.document.timeoutSeconds,
      })
  );
}
export function reconcileCloudComputerV2Editor(
  editor: CloudComputerV2Editor,
  snapshot: CloudComputerV2State,
): CloudComputerV2Editor {
  if (
    snapshot.revision <= editor.revision ||
    cloudComputerV2EditorDirty(editor)
  )
    return editor;
  return newCloudComputerV2Editor(snapshot);
}
export function acceptCloudComputerV2EditorRevision(
  editor: CloudComputerV2Editor,
  snapshot: CloudComputerV2State,
  acceptedRevision: number,
): CloudComputerV2Editor {
  // Cancel and Activate can advance the head without replacing the draft.
  // Only the exact receipt's confirmed snapshot may advance a dirty buffer;
  // a concurrent write or a different config still requires explicit Review.
  if (
    snapshot.revision !== acceptedRevision ||
    snapshot.revision <= editor.revision ||
    snapshot.draft.configId !== editor.base.configId
  )
    return editor;
  return { ...editor, revision: snapshot.revision };
}
export function cloudComputerV2EnvironmentRows(editor: CloudComputerV2Editor) {
  const rows = new Map(editor.base.environment.map((row) => [row.name, row]));
  for (const op of editor.document.environment ?? []) {
    if (op.op === "remove") rows.delete(op.name);
    else if (op.op === "set") rows.set(op.name, { name: op.name, set: true });
  }
  return [...rows.values()];
}
export function editCloudComputerV2Environment(
  editor: CloudComputerV2Editor,
  operation: CloudComputerV2EnvironmentOperation,
): CloudComputerV2Editor {
  const existing = (editor.document.environment ?? []).filter(
    (row) => row.name !== operation.name,
  );
  // Removing an unsaved name has no server-side effect. Keeping a saved name
  // untouched needs no operation: omission preserves its exact binding version.
  if (
    operation.op !== "preserve" &&
    (operation.op !== "remove" ||
      editor.base.environment.some((row) => row.name === operation.name))
  )
    existing.push(operation);
  return { ...editor, document: { ...editor.document, environment: existing } };
}
export function acceptCloudComputerV2EditorSave(
  current: CloudComputerV2Editor,
  submitted: CloudComputerV2Editor,
  result: { revision: number; configId: string },
): CloudComputerV2Editor {
  const base: CloudComputerV2Draft = {
    configId: result.configId,
    repositories: submitted.document.repositories,
    installScript: submitted.document.installScript,
    timeoutSeconds: submitted.document.timeoutSeconds,
    environment: cloudComputerV2EnvironmentRows(submitted),
  };
  // Only the submitted fields become the saved baseline. Typing during the
  // request stays local. Accepted plaintext never becomes part of that baseline.
  return {
    revision: result.revision,
    base,
    document: { ...current.document, environment: undefined },
  };
}

export function acceptCloudComputerV2EditorDiscard(
  current: CloudComputerV2Editor,
  submitted: CloudComputerV2Editor,
  snapshot: CloudComputerV2State,
  edits: Partial<
    Pick<CloudComputerV2DraftInput, "installScript" | "timeoutSeconds">
  > = {},
): CloudComputerV2Editor {
  const baseline = newCloudComputerV2Editor(snapshot);
  // Discard applies to the submitted buffer. Editors remain usable while its
  // mutation and replacement read settle; newer typing stays local even when
  // it returns a field to its submitted value.
  return {
    ...baseline,
    document: {
      ...baseline.document,
      installScript:
        edits.installScript ??
        (current.document.installScript === submitted.document.installScript
          ? baseline.document.installScript
          : current.document.installScript),
      timeoutSeconds:
        edits.timeoutSeconds ??
        (current.document.timeoutSeconds === submitted.document.timeoutSeconds
          ? baseline.document.timeoutSeconds
          : current.document.timeoutSeconds),
    },
  };
}
