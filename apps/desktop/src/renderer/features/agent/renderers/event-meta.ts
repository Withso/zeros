// ──────────────────────────────────────────────────────────
// event-meta — pure label/meta extractors per event kind
// ──────────────────────────────────────────────────────────
//
// Replaces the per-tool variant headers (tool-read, tool-edit,
// tool-shell, …) with one
// shared extractor. EventRow consumes these to render its
// `[label] [target] [meta] [status]` shape.
//
// Pure — no JSX, no hooks. Just the strings + icons each
// event kind needs. Caller decides how to lay them out.
// ──────────────────────────────────────────────────────────

import {
  Bot,
  Brain,
  FileEdit,
  FileText,
  FolderTree,
  Globe,
  Plug,
  RefreshCw,
  Search as SearchIcon,
  Shield,
  Sparkles,
  Terminal,
  TriangleAlert,
  Wrench,
} from "lucide-react";

import type { ComponentType } from "react";

import type {
  AgentMessage,
  AgentToolMessage,
} from "../use-agent-session";

export interface EventMeta {
  /** Leading icon for the row — a Lucide glyph, or any component taking a
   *  className (e.g. the compaction row's live ZerosSpinner wrapper). */
  Icon: ComponentType<{ className?: string }>;
  /** Optional className applied to the leading icon. */
  iconClassName?: string;
  /** Primary label — usually the tool's display name ("Read 42 lines",
   *  "Read image", "Bash", "Grep", "Edit", "Thinking", "Agent"). */
  label: string;
  /** Optional target — the path / pattern / command preview. Renders
   *  in mono font, truncated. */
  target?: string;
  /** When true, render `target` as a file/image TAG (FileTypeIcon + the
   *  bg1/border3 pill) instead of the plain command pill. */
  targetFile?: boolean;
  /** Tag glyph kind when `targetFile` — file vs folder. */
  targetKind?: "file" | "folder";
  /** Optional trailing meta — line count, +/- diff numbers, duration
   *  hint, etc. Renders in mono font, muted, tabular. */
  trailing?: string;
  /** Whether this event has detail content worth expanding inline.
   *  When false, EventRow renders without a hover +/- affordance. */
  expandable: boolean;
}

// Image extensions a Read can return — drives the "Read image" label (no line
// count) and the image glyph on the tag. Cross-adapter: detected from the path.
const IMAGE_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif", "heic", "heif",
]);

export function isImagePath(p: string | null | undefined): boolean {
  if (!p) return false;
  const ext = p.toLowerCase().split(".").pop() ?? "";
  return IMAGE_EXT.has(ext);
}

function basename(p: string): string {
  const cleaned = p.replace(/\/+$/, "");
  const i = cleaned.lastIndexOf("/");
  return i === -1 ? cleaned : cleaned.slice(i + 1);
}

/** Map any AgentMessage to its EventRow shape. */
export function metaForEvent(message: AgentMessage): EventMeta {
  if (message.kind === "tool") {
    return metaForTool(message as AgentToolMessage);
  }
  if (message.kind === "text" && (message as any).role === "thought") {
    const text = (message as any).text as string;
    const chars = text?.length ?? 0;
    return {
      Icon: Brain,
      label: "Thinking",
      // Glimpse of the thought as the collapsed-row preview:
      // a single-line, whitespace-collapsed snippet so a collapsed Thinking
      // row reads like any other tool row (icon · label · preview) instead of
      // a bare "Thinking". The full thought stays inspectable via expand; the
      // preview pill (event-row.tsx) caps the width so long thoughts ellipsize.
      target: text ? truncate(text.replace(/\s+/g, " ").trim(), 200) : undefined,
      // Char count intentionally omitted from the right edge. The thought text
      // is still inspectable via expand.
      trailing: undefined,
      expandable: chars > 0,
    };
  }
  if (message.kind === "error_notice") {
    // Adapter-level transient notice (retry attempt, transport warning, API
    // rejection) — ONE compact row per event, the same shape as a tool row,
    // so a retry burst reads as a quiet stack of rows instead of prose glued
    // into the agent's answer.
    const m = message as any;
    const text = (m.message as string) ?? "";
    // An api_retry burst reads as "Reconnecting agent", not a warning. While
    // live it renders as a shimmer row (see
    // EventRowRenderer); once settled this is its static record. The
    // technical message stays inspectable via expand.
    if (m.code === "api_retry") {
      return {
        Icon: RefreshCw,
        label: "Reconnecting agent",
        target: undefined,
        trailing: undefined,
        expandable: text.length > 0,
      };
    }
    return {
      Icon: TriangleAlert,
      label: m.severity === "error" ? "Error" : "Warning",
      target: text ? truncate(text.replace(/\s+/g, " ").trim(), 200) : undefined,
      trailing: undefined,
      expandable: text.length > 0,
    };
  }
  // Plan / question / subagent boundary / error — fall through to a
  // generic Wrench icon. These are usually handled by their own
  // renderers above the EventRow path, but if they slip through we
  // surface them rather than dropping silently.
  return {
    Icon: Wrench,
    label: message.kind,
    target: undefined,
    trailing: undefined,
    expandable: false,
  };
}

function metaForTool(tool: AgentToolMessage): EventMeta {
  const kind = tool.toolKind;
  const input = (tool.rawInput && typeof tool.rawInput === "object"
    ? (tool.rawInput as Record<string, unknown>)
    : {}) as Record<string, unknown>;

  if (kind === "read") {
    const path = pickString(input.file_path, input.path, input.filePath, input.target_file);
    const image = isImagePath(path);
    const lineCount = image ? null : readLineCount(tool);
    // Count in the LABEL ("Read 403 lines" / "Read image"), filename as the
    // tag. Consistent across all adapters.
    return {
      Icon: FileText,
      label: image
        ? "Read image"
        : lineCount != null
          ? `Read ${lineCount} lines`
          : "Read",
      target: path ? basename(path) : tool.title,
      targetFile: !!path,
      targetKind: "file",
      trailing: undefined,
      // Image reads aren't expandable — the bytes don't reach canonical content,
      // so there's nothing to open (user confirmed: leave it non-expandable).
      expandable: image ? false : hasContent(tool),
    };
  }

  if (kind === "edit") {
    // NOTE: edits route to EditCard (registry), which builds its own row via
    // EventRow. This branch is the defensive EventRow fallback.
    const path = pickString(input.file_path, input.path, input.filePath, input.target_file);
    const diff = editDiffNumbers(tool);
    return {
      Icon: FileEdit,
      label: "Edit",
      target: path ? basename(path) : tool.title,
      targetFile: !!path,
      targetKind: "file",
      trailing: diff ?? undefined,
      expandable: hasContent(tool),
    };
  }

  if (kind === "execute") {
    const cmd = pickString(input.command, input.cmd, input.script) ?? tool.title;
    // When the agent provides a human description (Claude's
    // Bash tool does), THAT is the bright primary label; the raw command is the
    // muted secondary text. Without one, fall back to "Bash". Both truncate in
    // the row (event-row.tsx caps the label + truncates the command).
    const description = pickString(input.description);
    return {
      Icon: Terminal,
      label: description ?? "Bash",
      target: truncate(cmd.replace(/\s+/g, " ").trim(), 300),
      trailing: undefined,
      expandable: hasContent(tool),
    };
  }

  if (kind === "search") {
    const pattern = pickString(input.pattern, input.query, input.regex);
    const matches = searchMatchCount(tool);
    return {
      Icon: SearchIcon,
      label: "Grep",
      target: pattern ? truncate(pattern, 60) : tool.title,
      trailing: matches != null ? `${matches} matches` : undefined,
      expandable: hasContent(tool),
    };
  }

  if (kind === "list") {
    // Directory listing (Codex `ls`/`listFiles`, Claude `LS`). The path is the
    // listed directory; the listing itself is the expandable detail body.
    const path = pickString(input.path, input.dir, input.directory, input.file_path);
    return {
      Icon: FolderTree,
      label: "List",
      target: path ? basename(path) : tool.title,
      targetFile: !!path,
      targetKind: "folder",
      trailing: undefined,
      expandable: hasContent(tool),
    };
  }

  if (kind === "web_search") {
    const query = pickString(input.query, input.q);
    return {
      Icon: Globe,
      label: "Web search",
      target: query ? `"${truncate(query, 60)}"` : tool.title,
      trailing: undefined,
      expandable: hasContent(tool),
    };
  }

  if (kind === "fetch") {
    const url = pickString(input.url, input.URL);
    return {
      Icon: Globe,
      label: "Fetch",
      target: url ? truncate(url, 80) : tool.title,
      trailing: undefined,
      expandable: hasContent(tool),
    };
  }

  if (kind === "subagent") {
    const desc = pickString(input.description, input.prompt, input.task, input.subagent_type);
    return {
      Icon: Bot,
      label: "Agent",
      target: desc ? truncate(desc, 80) : tool.title,
      trailing: undefined,
      expandable: true,
    };
  }

  // Cursor's raw task card normally renders via CursorTaskCard; this is the
  // defensive fall-through (e.g. a persisted task surfaced through EventRow).
  if (kind === "task") {
    const desc = pickString(input.description, input.prompt, input.task, input.subagent_type);
    return {
      Icon: Bot,
      label: "Task",
      target: desc ? truncate(desc, 80) : tool.title,
      trailing: undefined,
      expandable: true,
    };
  }

  if (kind === "mcp") {
    return {
      Icon: Plug,
      label: "MCP",
      target: tool.title,
      trailing: undefined,
      expandable: hasContent(tool),
    };
  }

  if (kind === "skill") {
    // Claude's Skill tool — slash-command execution. Rendered like the
    // command the user would have typed (`/pdf`, `/code-review high`) so a
    // skill invocation reads as intent, not as an opaque tool with JSON args.
    const name = pickString(input.skill, input.command, input.name);
    const args = pickString(input.args);
    return {
      Icon: Sparkles,
      label: "Skill",
      target: name
        ? args
          ? `/${name} ${truncate(args, 60)}`
          : `/${name}`
        : tool.title,
      trailing: undefined,
      expandable: hasContent(tool),
    };
  }

  if (kind === "tool_search") {
    // Claude's ToolSearch — loads a deferred tool's schema before calling it
    // (e.g. `select:ExitPlanMode` right before exiting plan mode). Routine
    // harness mechanics: render a quiet "Loading tool: X" one-liner so it
    // doesn't read as a failure or an opaque JSON blob.
    const query = pickString(input.query) ?? "";
    const selected = query.startsWith("select:")
      ? query
          .slice("select:".length)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : null;
    return {
      Icon: Wrench,
      label: selected
        ? selected.length > 1
          ? "Loading tools"
          : "Loading tool"
        : "Finding tools",
      target: selected
        ? selected.join(", ")
        : query
          ? `"${truncate(query, 60)}"`
          : tool.title,
      trailing: undefined,
      expandable: hasContent(tool),
    };
  }

  if (kind === "switch_mode") {
    return {
      Icon: Shield,
      label: "Switch mode",
      target: tool.title,
      trailing: undefined,
      expandable: hasContent(tool),
    };
  }

  return {
    Icon: Wrench,
    label: tool.title || "Tool",
    target: kind ?? undefined,
    trailing: undefined,
    expandable: hasContent(tool),
  };
}

export function statusTone(
  status: AgentToolMessage["status"],
): "ok" | "fail" | "run" | "pending" {
  if (status === "completed") return "ok";
  if (status === "failed") return "fail";
  if (status === "in_progress") return "run";
  return "pending";
}

// ── helpers ──────────────────────────────────────────────

function pickString(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function hasContent(tool: AgentToolMessage): boolean {
  return Boolean(tool.content && tool.content.length > 0);
}

function readLineCount(tool: AgentToolMessage): number | null {
  if (!tool.content) return null;
  // Count the lines of the read's text body. Strip a single trailing newline so
  // a file ending in "\n" doesn't over-count by one. (For Claude's cat-n output
  // each line is still one row, so the count is the line count read.)
  for (const block of tool.content) {
    if (block.type === "content" && (block as any).content?.type === "text") {
      const text = (block as any).content.text as string;
      if (typeof text === "string") {
        const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
        return trimmed.length === 0 ? 0 : trimmed.split(/\r?\n/).length;
      }
    }
  }
  return null;
}

function editDiffNumbers(tool: AgentToolMessage): string | null {
  // Try the translator's metadata first (added/removed counts).
  const meta = (tool as any).meta ?? (tool as any).diff ?? null;
  if (meta && typeof meta === "object") {
    const added = (meta as any).added ?? (meta as any).addedLines;
    const removed = (meta as any).removed ?? (meta as any).removedLines;
    if (typeof added === "number" && typeof removed === "number") {
      return `+${added} −${removed}`;
    }
  }
  // Fall back: walk content for diff blocks.
  if (tool.content) {
    let added = 0;
    let removed = 0;
    for (const block of tool.content) {
      if (block.type === "diff") {
        const a = (block as any).added ?? 0;
        const r = (block as any).removed ?? 0;
        added += typeof a === "number" ? a : 0;
        removed += typeof r === "number" ? r : 0;
      }
    }
    if (added + removed > 0) return `+${added} −${removed}`;
  }
  return null;
}

function searchMatchCount(tool: AgentToolMessage): number | null {
  if (!tool.content) return null;
  for (const block of tool.content) {
    if (block.type === "content" && (block as any).content?.type === "text") {
      const text = (block as any).content.text as string;
      if (typeof text === "string") {
        // "47 matches across 12 files" or "No matches found"
        const m = text.match(/(\d+)\s+match/i);
        if (m) return parseInt(m[1], 10);
        if (/no matches/i.test(text)) return 0;
      }
    }
  }
  return null;
}
