import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** Compatibility only: these are absent from the current SDK's tool inventory.
 * Keep old transcript presentation (and MultiEdit's existing permission rules)
 * without treating a new, unreviewed tool name as a retired one. */
export const retiredClaudeToolNames = {
  LS: "Old Claude directory-list calls still render as list rows.",
  ReadFile: "Older read-call titles still describe their persisted file target.",
  MultiEdit: "Older multi-edit transcripts and saved edit-family permission rules remain readable.",
} as const;

export interface ToolNameSite {
  name: string;
  line: number;
}

export function toolNameSources(directory: URL): URL[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === "__tests__") return [];
    const file = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
    return entry.isDirectory() ? toolNameSources(file) : /\.tsx?$/.test(entry.name) ? [file] : [];
  });
}

export function sourceToolNameSites(file: URL, surface: "claude" | "renderer"): ToolNameSite[] {
  try {
    return toolNameSites(readFileSync(file, "utf8"), surface);
  } catch (error) {
    throw new Error(`${fileURLToPath(file)}: ${String(error)}`);
  }
}

/** These assertions read the actual routing expressions. Importing the Node
 * SDK into the renderer, or normalizing its multi-provider title fallbacks,
 * would change the application boundary/behavior just to expose an inventory.
 * Unknown matcher syntax fails closed so a refactor must update this reader. */
export function toolNameSites(text: string, surface: "claude" | "renderer"): ToolNameSite[] {
  const source = ts.createSourceFile("tool-surface.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const sites: ToolNameSite[] = [];
  const add = (name: string, node: ts.Node) => {
    sites.push({ name, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
  };
  const toolValue = (node: ts.Node): boolean => {
    const value = node.getText(source);
    // A local `name` can also be a context category or a model. Only the
    // translator helpers' named input parameters identify a tool here.
    if (surface === "claude" && value === "name") {
      for (let parent = node.parent; parent; parent = parent.parent)
        if (ts.isFunctionLike(parent) && parent.parameters.some(parameter => parameter.name.getText(source) === "name")) return true;
      return false;
    }
    // This loose-object permission guard destructures `title`; elsewhere a
    // bare title belongs to a chat/document, not a native tool. Its source site
    // is asserted by the renderer contract alongside the direct tool.title sites.
    if (surface === "renderer" && value === "title") {
      for (let parent = node.parent; parent; parent = parent.parent)
        if (ts.isFunctionDeclaration(parent) && parent.name?.text === "isPlanReviewRequest") return true;
      return false;
    }
    return surface === "renderer"
      ? /^(?:tool|tc)\??\.title$/.test(value)
      : value === "toolName" ||
        /^(?:tool|nativeTool|block)\??\.name$/.test(value) ||
        /^this\.toolInputs\.get\(.+\)\??\.name$/.test(value) ||
        /\.(?:toolName|tool_name)$/.test(value);
  };
  const pattern = (node: ts.RegularExpressionLiteral) => {
    const body = node.text.slice(1, node.text.lastIndexOf("/"));
    if (body === "^mcp__") return; // Dynamic MCP namespace, never a built-in.
    // The plan-review fallback permits optional separators in a tool title.
    if (/^[a-z]+(?:\.\?[a-z]+)+$/i.test(body)) {
      add(body.replaceAll(".?", ""), node);
      return;
    }
    const match = /^\^\(([^()]+)\)(?:\$|\\s\+\\S)$/.exec(body) ??
      /^\^([A-Za-z ]+)(?:\$|\\s\+\\S|\(\?:\\s\|\$\)|\\s\+\(\?!files\$\)\\S)?$/.exec(body);
    if (!match) throw new Error(
      `Unreviewed tool-name matcher: ${node.text}. Teach scripts/__tests__/claude-tool-contract.ts this shape, ` +
      "or list another provider's title in its contract test's exceptions.",
    );
    for (const name of match[1].split("|")) add(name.trim(), node);
  };
  const declarationValues = (node: ts.Node) => {
    if (ts.isTypeNode(node)) return;
    if (ts.isStringLiteral(node)) add(node.text, node);
    else if (ts.isRegularExpressionLiteral(node)) pattern(node);
    else if (ts.isPropertyAssignment(node)) {
      // Tool-keyed presentation/dispatch tables must include their keys too.
      if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) add(node.name.text, node.name);
    } else ts.forEachChild(node, declarationValues);
  };
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
        /^(?:EDIT_TOOLS|SUBAGENT_TITLE_PATTERN|CLAUDE_.*TOOL_NAMES?|.*TOOL_(?:NAMES|LABELS|KINDS))$/.test(node.name.text)) {
      declarationValues(node.initializer);
    }
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(node.operatorToken.kind)) {
      if (ts.isStringLiteral(node.left) && toolValue(node.right)) add(node.left.text, node.left);
      if (ts.isStringLiteral(node.right) && toolValue(node.left)) add(node.right.text, node.right);
    }
    if (ts.isSwitchStatement(node) && toolValue(node.expression)) {
      for (const clause of node.caseBlock.clauses)
        if (ts.isCaseClause(clause) && ts.isStringLiteral(clause.expression)) add(clause.expression.text, clause.expression);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "test" && ts.isRegularExpressionLiteral(node.expression.expression) &&
        node.arguments.some(argument => toolValue(argument) ||
          (ts.isBinaryExpression(argument) && argument.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken && toolValue(argument.left)))) {
      pattern(node.expression.expression);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

export function unknownClaudeToolNames(
  sites: readonly ToolNameSite[],
  builtins: readonly string[],
  aliases: Readonly<Record<string, string>>,
  nonToolNames: Readonly<Record<string, string>> = {},
): Array<ToolNameSite & { aliasFor?: string }> {
  const canonical = new Set(builtins.map(name => name.toLowerCase()));
  const legacy = new Map(Object.entries(aliases).map(([name, target]) => [name.toLowerCase(), target]));
  const exceptions = new Set([...Object.keys(retiredClaudeToolNames), ...Object.keys(nonToolNames)].map(name => name.toLowerCase()));
  const handled = new Set(sites.map(site => site.name.toLowerCase()));
  const missing: Array<ToolNameSite & { aliasFor?: string }> = [];
  for (const site of sites) {
    const name = site.name.toLowerCase();
    if (canonical.has(name) || exceptions.has(name)) continue;
    const target = legacy.get(name);
    if (!target) missing.push(site);
    // Merely accepting a legacy key would let a Task-only matcher pass after
    // Task → Agent. The canonical spelling must reach this surface as well.
    else if (!canonical.has(target.toLowerCase()) || !handled.has(target.toLowerCase()))
      missing.push({ ...site, aliasFor: target });
  }
  return missing;
}
