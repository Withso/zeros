/** Side-effect-free: role probes import this from TypeScript through the tsx
 * hook. Importing the qualification entry point there would load a second
 * instance whose main-module guard starts another qualification. */

/** Closed observations from the fixed kernel status file. Missing, duplicate
 * or nonzero capability evidence is unknown, never an inferred empty set. */
export function cloudEnginePrivilegeStatus(source) {
  const fields = new Map();
  if (typeof source === "string" && source.length <= 65536 && !source.includes("\0")) {
    for (const line of source.split("\n")) {
      const match = /^(CapEff|CapPrm|CapInh|CapBnd|CapAmb|NoNewPrivs|Seccomp):([^\r\n]*)$/.exec(line);
      if (!match) continue;
      fields.set(match[1], fields.has(match[1]) ? null : match[2].trim());
    }
  }
  const observed = (name, expected) => fields.get(name) === String(expected) ? expected : null;
  return { noNewPrivs: observed("NoNewPrivs", 1), seccompMode: observed("Seccomp", 2),
    capabilities: Object.fromEntries(Object.entries({ effective: "CapEff", permitted: "CapPrm", inheritable: "CapInh", bounding: "CapBnd", ambient: "CapAmb" })
      .map(([name, field]) => [name, fields.get(field) === "0000000000000000" ? 0 : null])) };
}
