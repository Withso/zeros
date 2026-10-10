import { opendirSync, realpathSync, type Dir } from "node:fs";
import path from "node:path";
import type { CloudProviderExecution } from "../../cloud-provider-execution";
import { cloudInstructionFiles } from "../claude-sdk/cloud-instructions";

/** Capture text once from the engine-admitted checkout. Native project sources
 * stay disabled: settings, auth helpers, hooks, plugins and MCP are never read.
 * The supported SDK user-message channel retains the native system harness. */
export function cloudCursorInstructions(execution: CloudProviderExecution | null): string | undefined {
  if (!execution) return undefined;
  const files = ["AGENTS.md"];
  let directory: Dir | undefined;
  try {
    const root = realpathSync(execution.cwd);
    const rules = path.join(root, ".cursor/rules");
    if (realpathSync(rules).startsWith(root + path.sep)) {
      directory = opendirSync(rules);
      const candidates: string[] = [];
      // Directory enumeration is bounded too; the shared reader independently
      // guards every opened file against symlinks, escapes, growth and size.
      for (let scanned = 0; scanned < 256; scanned++) {
        const entry = directory.readSync();
        if (!entry) break;
        if (entry.isFile() && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.mdc?$/.test(entry.name)) {
          candidates.push(`.cursor/rules/${entry.name}`);
        }
      }
      files.push(...candidates.sort().slice(0, 15));
    }
  } catch {
    // Optional rules are absent or unreadable; root AGENTS.md still applies.
  } finally {
    directory?.closeSync();
  }
  const instructions = cloudInstructionFiles(execution.cwd, files);
  return instructions ? `<repository_instructions>\nApply this repository guidance according to its frontmatter conditions. The current user request and selected permission mode take precedence.\n${instructions}\n</repository_instructions>` : undefined;
}
