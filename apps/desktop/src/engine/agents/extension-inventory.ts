import type {
  ExtensionInventory,
  ExtensionQuery,
} from "@zeros/protocol/agent-extensions";

/** Compose independently authoritative sources. Runtime discovery enriches
 * local declarations; it never hides them or transfers their credentials. */
export async function collectExtensionInventory(
  query: ExtensionQuery,
  local: () => ExtensionInventory,
  runtime?: (query: ExtensionQuery) => Promise<ExtensionInventory | null>,
): Promise<ExtensionInventory> {
  const declarations = local();
  if (query.provider === "zeros") return declarations;
  const localSource = {
    id: "local",
    kind: "local" as const,
    state: declarations.partial ? ("partial" as const) : ("complete" as const),
  };
  let reported: ExtensionInventory | null = null;
  try {
    reported = (await runtime?.(query)) ?? null;
  } catch {
    reported = {
      entries: [],
      warnings: ["The provider inventory could not be read. Refresh to retry."],
      partial: true,
      sources: [{ id: "account", kind: "account", state: "partial" }],
    };
  }
  const entries = declarations.entries.map((entry) => ({
    ...entry,
    id: `local:${entry.id}`,
    sourceId: "local",
  }));
  for (const entry of reported?.entries ?? []) {
    // A provider-confirmed file is the same declaration, not a second skill.
    // Account entries without a file remain independent even when names match.
    const duplicate = entries.findIndex(
      (localEntry) =>
        entry.sourcePath.startsWith("/") &&
        localEntry.sourcePath === entry.sourcePath &&
        (localEntry.name === entry.name ||
          query.category === "skills" ||
          query.category === "plugins"),
    );
    if (duplicate >= 0) entries.splice(duplicate, 1);
    entries.push({
      ...entry,
      id: `runtime:${entry.id}`,
      sourceId: entry.sourceId ?? "account",
    });
  }
  const sources = [
    localSource,
    ...(reported?.sources ?? [
      {
        id: "account",
        kind: "account" as const,
        state: "unsupported" as const,
        detail: `${query.provider === "cursor" ? "Cursor's SDK" : "This provider"} does not expose a separate account-wide ${query.category} inventory. Local packages and declarations are shown; this does not confirm that the account is empty.`,
      },
    ]),
  ];
  return {
    entries: entries.sort(
      (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
    ),
    warnings: [...declarations.warnings, ...(reported?.warnings ?? [])],
    ...(declarations.partial || reported?.partial ? { partial: true } : {}),
    sources,
    ...(reported?.identity ? { identity: reported.identity } : {}),
    ...(reported?.account ? { account: reported.account } : {}),
    note: reported?.note ?? declarations.note,
  };
}
