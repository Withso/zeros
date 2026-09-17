import { toolRecord } from "./native-tool-presentation";

/** Cursor's pinned GrepSuccess union. Unknown envelopes retain the ordinary
 * bounded fallback; missing line text remains a file match, never fake source. */
export function cursorSearchOutput(raw: unknown): string | null {
  const outer = toolRecord(raw);
  const result = toolRecord(outer.result ?? raw);
  const value = toolRecord(
    result.status === "success" ? result.value : result.success,
  );
  if (!("workspaceResults" in value) && !("activeEditorResult" in value))
    return null;
  const workspaces = Object.entries(toolRecord(value.workspaceResults));
  const groups: Array<[string, unknown]> = [...workspaces];
  if (value.activeEditorResult)
    groups.push(["Active editor", value.activeEditorResult]);
  const lines: string[] = [];
  for (const [workspace, record] of groups.slice(0, 64)) {
    const group = toolRecord(record);
    const output = toolRecord(group.output);
    const rows: string[] = [];
    if (group.type === "content" && Array.isArray(output.matches)) {
      let matchCount = 0;
      for (const item of output.matches.slice(0, 500)) {
        const match = toolRecord(item);
        if (typeof match.file !== "string") continue;
        const location = `${match.file}${typeof match.lineNumber === "number" ? `:${match.lineNumber}` : ""}`;
        matchCount += 1;
        const context = (value: unknown) =>
          Array.isArray(value)
            ? value
                .slice(0, 100)
                .filter((line): line is string => typeof line === "string")
                .map((line) => `  ${line}`)
            : [];
        rows.push(
          ...(Array.isArray(match.beforeContext) &&
          match.beforeContext.length > 100
            ? ["Additional context lines not shown."]
            : []),
          ...context(match.beforeContext),
          `${location}${typeof match.line === "string" ? `: ${match.line}` : ""}`,
          ...context(match.afterContext),
          ...(Array.isArray(match.afterContext) &&
          match.afterContext.length > 100
            ? ["Additional context lines not shown."]
            : []),
        );
      }
      const total =
        typeof output.totalMatches === "number"
          ? output.totalMatches
          : output.matches.length;
      if (total > matchCount)
        rows.push(`${total - matchCount} more matches not included.`);
    } else if (group.type === "files" && Array.isArray(output.files)) {
      rows.push(
        ...output.files
          .slice(0, 500)
          .filter((f): f is string => typeof f === "string"),
      );
      const total =
        typeof output.count === "number" ? output.count : output.files.length;
      if (total > rows.length)
        rows.push(`${total - rows.length} more files not included.`);
    } else if (group.type === "count" && Array.isArray(output.counts)) {
      for (const entry of output.counts.slice(0, 500)) {
        const count = toolRecord(entry);
        if (typeof count.file === "string" && typeof count.count === "number")
          rows.push(`${count.file}: ${count.count} matches`);
      }
      if (output.counts.length > 500)
        rows.push(`${output.counts.length - 500} more files not included.`);
    } else return null;
    if (groups.length > 1) lines.push(workspace);
    lines.push(...(rows.length ? rows : ["No matches found."]));
  }
  if (groups.length > 64)
    lines.push(`${groups.length - 64} more workspaces not shown.`);
  const text = lines.join("\n") || "No matches found.";
  return text.length > 20000
    ? `${text.slice(0, 20000)}\nMore results not shown.`
    : text;
}
