import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildTokens, MARKETING_TOKENS_FILE } from "./build-tokens.mjs";
import { renderZstackFiles, ZSTACK_SKILLS_DIR } from "../zstack/render.mjs";
import { TOKENS_FILE } from "./token-palette.mjs";

export const UI_BRIEF_FILE = "agents/skills/zeros-ui.md";
const WORKSPACE_BRIEF_FILE = "agents/skills/zeros-workspaces.md";
const GENERATOR = "scripts/design-system/build-design-docs.mjs";

export function agentBrief(root) {
  return readFileSync(join(root, UI_BRIEF_FILE), "utf8").trim();
}

const SKILL_DESCRIPTION =
  "Zeros design system for renderer UI: use when building or changing UI under apps/desktop/src/renderer or styles/, or designing Zeros screens in Zeros - Design/ — components, tokens, colors, spacing, typography, contrast, and the checks that gate them.";

export function renderAgentFiles(root) {
  const brief = agentBrief(root);
  const notice = `<!-- GENERATED from ${UI_BRIEF_FILE} by ${GENERATOR}. Edit the agent brief there, then run \`pnpm design:docs\`. -->`;
  // JSON string syntax is valid YAML and quotes the description's colon.
  const description = JSON.stringify(SKILL_DESCRIPTION);
  const skill = `---\nname: zeros-ui\ndescription: ${description}\n---\n\n${notice}\n\n${brief}\n`;
  return {
    ".claude/skills/zeros-ui/SKILL.md": skill,
    ".agents/skills/zeros-ui/SKILL.md": skill,
    ".cursor/rules/zeros-ui.mdc": `---\ndescription: ${description}\nglobs: apps/desktop/src/renderer/**,styles/**\nalwaysApply: false\n---\n\n${notice}\n\n${brief}\n`,
  };
}

export function workspaceBrief(root) {
  return readFileSync(join(root, WORKSPACE_BRIEF_FILE), "utf8").trim();
}

const WORKSPACE_SKILL_DESCRIPTION =
  "Zeros Local and cloud workspaces: use for any change touching workspaces, the engine, bridge, Git/GitHub, agents, Design, terminals, previews, files, settings or their UI — every change must handle Local and organization owners, local and cloud placements, and switching between them.";

export function renderWorkspaceAgentFiles(root) {
  const brief = workspaceBrief(root);
  const notice = `<!-- GENERATED from ${WORKSPACE_BRIEF_FILE} by ${GENERATOR}. Edit the workspace brief there, then run \`pnpm design:docs\`. -->`;
  const description = JSON.stringify(WORKSPACE_SKILL_DESCRIPTION);
  const skill = `---\nname: zeros-workspaces\ndescription: ${description}\n---\n\n${notice}\n\n${brief}\n`;
  return {
    ".claude/skills/zeros-workspaces/SKILL.md": skill,
    ".agents/skills/zeros-workspaces/SKILL.md": skill,
    ".cursor/rules/zeros-workspaces.mdc": `---\ndescription: ${description}\nglobs: apps/**,packages/**,scripts/**\nalwaysApply: false\n---\n\n${notice}\n\n${brief}\n`,
  };
}

export function generatedFiles(root) {
  return {
    ...renderAgentFiles(root),
    ...renderWorkspaceAgentFiles(root),
    ...renderZstackFiles(root),
  };
}

/** check:ui hook — one violation per stale or missing generated file. */
export function checkGeneratedDocs(root) {
  const violations = [];
  for (const [rel, content] of Object.entries(generatedFiles(root))) {
    const path = join(root, rel);
    if (!existsSync(path) || readFileSync(path, "utf8") !== content) {
      violations.push({
        file: rel,
        line: 1,
        message: `Generated agent file is stale — run \`pnpm design:docs\` (source: ${rel.includes("zstack") ? ZSTACK_SKILLS_DIR : rel.includes("zeros-workspaces") ? WORKSPACE_BRIEF_FILE : UI_BRIEF_FILE}).`,
      });
    }
  }
  return violations;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = process.cwd();
  buildTokens(root);
  console.log(`wrote ${TOKENS_FILE}`);
  console.log(`wrote ${MARKETING_TOKENS_FILE}`);
  for (const [rel, content] of Object.entries(generatedFiles(root))) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    console.log(`wrote ${rel}`);
  }
}
