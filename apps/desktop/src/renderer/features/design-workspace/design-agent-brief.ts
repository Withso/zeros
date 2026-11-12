// PURPOSE: The briefs Design sends to an agent for "Ask agent to sync",
// "Ask agent to fix", "Ask agent to change", Tidy and a component's options. They stay short: the
// procedure lives in the packaged Zeros Design skill, so typing "sync my
// styles" in any chat matches them.

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

/** Free a value a rule forces with !important, so the Style panel can edit
 * it on this layer. */
export function designForcedValueBrief(input: {
  directory: string;
  frame: string;
  layer: string;
  nodeId: string;
  property: string;
  /** The field's name in the panel, for the chat label. */
  label: string;
  /** The value as the person sees it written. */
  value: string;
  rule: string;
  /** Where the rule is written, as the panel names it. */
  source?: string;
}): DesignAgentBrief {
  const where = input.source ? `\`${input.rule}\` in ${input.source}` : `\`${input.rule}\``;
  return {
    label: `Change ${input.label} on ${input.layer}`,
    text: [
      `In the frame "${input.frame}" in the Design directory "${input.directory}", the layer "${input.layer}" (data-oid "${input.nodeId}") shows ${input.property}: ${input.value}, forced by ${where} with !important, so the Style panel cannot edit it.`,
      "Remove the !important, or move the value so this layer's own value can be edited, without changing how other layers look. Tell me what you changed.",
      CODE_RULE,
    ].join("\n"),
  };
}

/** Tidy a frame's changes made by hand: the procedure is in the skill. */
export function designTidyBrief(input: {
  directory: string;
  frame: string;
  changes: readonly {
    oid: string;
    layer: string;
    property: string;
    value: string;
    replaced: { value: string; selector?: string; component?: string };
  }[];
}): DesignAgentBrief {
  const count = input.changes.length;
  const from = (replaced: (typeof input.changes)[number]["replaced"]) =>
    replaced.component ? `the component ${replaced.component}` : (replaced.selector ?? "a rule");
  return {
    label: `Tidy ${count} ${count === 1 ? "change" : "changes"} in ${input.frame}`,
    text: [
      `Tidy the changes made by hand in the frame "${input.frame}"${input.directory ? ` in the Design directory "${input.directory}"` : ""}.`,
      'Follow "Tidy changes made by hand" in the Zeros Design skill. The frame must look the same. Do not stage or commit. Tell me what moved where.',
      CODE_RULE,
      `Changes (value on the layer over the value it replaced):\n${input.changes
        .map((change) => `- ${change.layer} (data-oid "${change.oid}"): ${change.property}: ${change.value} over ${change.replaced.value} from ${from(change.replaced)}`)
        .join("\n")}`,
    ].join("\n"),
  };
}

const where = (directory: string, frame: string, title: string) =>
  `the component "${title}" (${frame})${directory ? ` in the Design directory "${directory}"` : ""}`;

/** "Ask agent to change options": a person only adjusts options; the agent
 * adds, removes or reshapes them. */
export function designComponentOptionsBrief(input: { directory: string; frame: string; title: string }): DesignAgentBrief {
  return {
    label: `Change the options of ${input.title}`,
    text: [
      `I want to change the options of ${where(input.directory, input.frame, input.title)}. Ask me what to change first.`,
      'Follow "Change a component\'s options" in the Zeros Design skill. Do not stage or commit.',
      CODE_RULE,
    ].join("\n"),
  };
}

/** "Ask agent to fix": options that could not be applied. */
export function designComponentOptionsFixBrief(input: {
  directory: string;
  frame: string;
  title: string;
  shows: "last-good" | "defaults";
  problems: readonly { line: number; message: string }[];
}): DesignAgentBrief {
  const shows = input.shows === "last-good" ? "its last good render" : "the component's defaults";
  return {
    label: `Fix the options of ${input.title}`,
    text: [
      `The options of ${where(input.directory, input.frame, input.title)} could not be applied; the frame shows ${shows}.${input.problems.length ? "" : " Run design validate to see why."}`,
      ...(input.problems.length ? ["Problems:", ...input.problems.map((problem) => `- line ${problem.line}: ${problem.message}`)] : []),
      'Follow "Fix a component\'s options" in the Zeros Design skill. Do not stage or commit.',
      CODE_RULE,
    ].join("\n"),
  };
}
