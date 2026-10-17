// PURPOSE: The briefs Design sends to an agent for "Ask agent to sync" and
// "Ask agent to fix". They stay short: the procedure lives in the packaged
// Zeros Design skill, so typing "sync my styles" in any chat matches them.

import type { DesignStyleSourceWire } from "../../platform/git";

export interface DesignAgentBrief {
  /** What the person sees in the chat, marked as sent by Zeros. */
  label: string;
  /** What the agent receives. */
  text: string;
}

const SKILL_PROCEDURE = 'Follow "Sync the application\'s styles" in the Zeros Design skill';
/** The engine's App fonts source, built from the canvas `fonts` list. */
const FONTS_SOURCE_ID = "@fonts";
const CODE_RULE = "Ask before changing application code.";

function sourceLine(source: DesignStyleSourceWire): string {
  const problems = source.messages
    .filter((message) => message.level !== "info")
    .map((message) => message.text);
  return `- ${source.id} (${source.kind}, ${source.path}): ${source.status}${problems.length ? ` — ${problems.join(" ")}` : ""}`;
}

/** Set up syncing, or change it, for a whole Design directory. */
export function designSyncBrief(
  directory: string,
  sources: readonly DesignStyleSourceWire[],
): DesignAgentBrief {
  return {
    label: sources.length ? "Update style syncing" : "Set up style syncing",
    text: [
      `Set up style syncing for the Design directory "${directory}".`,
      `${SKILL_PROCEDURE}: find this repository's stylesheets, tokens, themes and fonts, declare them in "${directory}/meta/canvas.json", check them with \`zeros-engine design styles\`, and tell me what you set up and anything I need to decide.`,
      CODE_RULE,
      sources.length
        ? `Current style sources:\n${sources.map(sourceLine).join("\n")}`
        : "The directory declares no style sources yet.",
    ].join("\n"),
  };
}

/** Fix one source whose declaration no longer matches the repository. */
export function designSourceFixBrief(
  directory: string,
  source: DesignStyleSourceWire,
): DesignAgentBrief {
  return {
    label: `Fix style source ${source.title}`,
    text: [
      source.id === FONTS_SOURCE_ID
        ? `The App fonts (the \`fonts\` list) in the Design directory "${directory}" need fixing:`
        : `The style source "${source.id}" in the Design directory "${directory}" needs fixing:`,
      sourceLine(source),
      `${SKILL_PROCEDURE} to correct its declaration in "${directory}/meta/canvas.json", check it with \`zeros-engine design styles\`, and tell me what changed.`,
      CODE_RULE,
    ].join("\n"),
  };
}
