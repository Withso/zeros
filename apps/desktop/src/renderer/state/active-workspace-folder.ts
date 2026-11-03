// The store supplies the reader so bridge imports cannot initialize navigation.
let readFolder: (() => string | null) | undefined;

export function bindActiveWorkspaceFolder(reader: () => string | null): void {
  readFolder = reader;
}

export function getActiveWorkspaceFolder(): string | null {
  return readFolder?.() ?? null;
}
