// Frames registered as components: the `component` field on a frame's record
// in meta/canvas.json names the tag other frames use, <zd-<name>>. The record
// carries it, so a rename keeps it and a delete removes it. Older builds keep
// the field as an unknown frame-record key (canvas frames pass through).

import type { CanvasDocument } from "./document-model";

/** Tag names Zeros keeps for its own elements. */
const RESERVED = new Set(["option", "derive", "variant", "if", "for"]);
const COMPONENT_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export interface DesignComponentRegistryProblem {
  file: string;
  name: string;
  message: string;
}

export interface DesignComponentRegistry {
  /** Component name to the frame source that defines it. */
  files: ReadonlyMap<string, string>;
  problems: readonly DesignComponentRegistryProblem[];
}

export function designComponentNameProblem(name: string): string | null {
  if (name.length > 63 || !COMPONENT_NAME.test(name))
    return `The component name ${JSON.stringify(name)} must be 1 to 63 lowercase letters, digits and single hyphens, starting with a letter.`;
  if (RESERVED.has(name)) return `zd-${name} is kept for Zeros; choose another component name.`;
  return null;
}

const registries = new WeakMap<object, DesignComponentRegistry>();
const EMPTY: DesignComponentRegistry = { files: new Map(), problems: [] };

/** The canvas's registered components. A name registered twice is a problem
 * on each frame that registers it, and resolves to neither. */
export function designComponentRegistry(canvas: Pick<CanvasDocument, "frame_info"> | null | undefined): DesignComponentRegistry {
  if (!canvas) return EMPTY;
  const known = registries.get(canvas);
  if (known) return known;
  const byName = new Map<string, string[]>();
  const problems: DesignComponentRegistryProblem[] = [];
  for (const [file, info] of Object.entries(canvas.frame_info ?? {})) {
    const name = (info as { component?: unknown } | undefined)?.component;
    if (name === undefined) continue;
    if (typeof name !== "string") {
      problems.push({ file, name: String(name), message: 'A frame record\'s "component" must be a name such as "chat-composer".' });
      continue;
    }
    const problem = designComponentNameProblem(name);
    if (problem) {
      problems.push({ file, name, message: problem });
      continue;
    }
    byName.set(name, [...(byName.get(name) ?? []), file]);
  }
  const files = new Map<string, string>();
  for (const [name, sources] of byName) {
    if (sources.length === 1) files.set(name, sources[0]!);
    else for (const file of sources)
      problems.push({ file, name, message: `zd-${name} is registered by ${sources.length} frames (${sources.join(", ")}); each component needs its own name.` });
  }
  const registry = { files, problems };
  if (Object.isFrozen(canvas)) registries.set(canvas, registry);
  return registry;
}
