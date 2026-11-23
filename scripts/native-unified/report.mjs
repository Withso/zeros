// The native check's output: one row per named check (pass, fail or n/a, and the measured fact), then what a
// person still has to look at. Pure, so it is tested without Electron (scripts/__tests__/native-unified-report.test.ts).

/** Loopback only: anything else the app reaches or listens on fails N12. */
export function isLoopbackAddress(address) {
  const host = String(address ?? "").replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1" || /^127(?:\.\d{1,3}){3}$/.test(host) || host === "::ffff:127.0.0.1";
}

/** A URL the app may load: its own loopback servers, and schemes that never leave the machine. */
export function isLocalUrl(value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  if (["data:", "blob:", "file:", "devtools:", "chrome:", "chrome-extension:", "about:"].includes(url.protocol)) return true;
  return ["http:", "https:", "ws:", "wss:"].includes(url.protocol) && isLoopbackAddress(url.hostname);
}

const clip = (value, width) => (value.length > width ? `${value.slice(0, width - 1)}…` : value);

/** Never print a path outside the run's own folder: it is replaced by <tmp>, and home by ~. */
export function scrub(text, { root, home } = {}) {
  let out = String(text);
  if (root) out = out.split(root).join("<tmp>");
  if (home && home !== "/") out = out.split(home).join("~");
  return out.replace(/synthetic-native-check/g, "synthetic");
}

export function table(rows, options = {}) {
  const width = Math.max(5, ...rows.map(row => row.check.length));
  const lines = [`${"check".padEnd(width)} | result | fact`, `${"-".repeat(width)}-|--------|${"-".repeat(40)}`];
  for (const row of rows) lines.push(`${row.check.padEnd(width)} | ${row.result.padEnd(6)} | ${clip(scrub(row.fact, options), 400)}`);
  const failed = rows.filter(row => row.result === "fail").length, passed = rows.filter(row => row.result === "pass").length;
  const skipped = rows.filter(row => row.result === "n/a").length;
  lines.push("", `${passed} passed, ${failed} failed${skipped ? `, ${skipped} not applicable` : ""} of ${rows.length}`);
  return { text: lines.join("\n"), failed };
}

/** What only a person can confirm, printed after the table. */
export const PERSON_MUST_LOOK = [
  "Real sign-in: WorkOS in the browser, the keychain prompt, and the session surviving a restart.",
  "The packaged, signed Alpha build: Gatekeeper, notarization, auto-update, and zeros:// links opened from Safari.",
  "Live cloud: a real Boat VM, the worker's own submodule fetch and its push sentence, terminals, agent turns, and Changes/Files on live worker data.",
  "How it looks: both themes, density and wording in the real window (the screenshots help, but someone has to look).",
  "Retention for real: an actual 30-day archive, and when the machine and the backup really go.",
];
