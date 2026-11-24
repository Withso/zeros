// The Alpha check's pure helpers, tested without Electron (scripts/__tests__/native-alpha-check.test.ts).

/** A numbered test user only: never the owner's account, and never 2 or 3, which the rehearsal itself uses on Alpha. */
export function accountNumber(value) {
  const text = String(value ?? "").trim();
  if (!/^(10|[1-9])$/.test(text)) throw new Error("ZEROS_NATIVE_ALPHA_ACCOUNT must be a numbered test user, 1 to 10.");
  const number = Number(text);
  if (number === 2 || number === 3) throw new Error("Test users 2 and 3 belong to the rehearsal on Alpha; choose another (default 9).");
  return number;
}

/** The run id from the rehearsal's first line: "[rehearse] run <uuid> prefix zr-… route …". */
export function rehearsalRunId(output) {
  return /\[rehearse\] run ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) /.exec(String(output ?? ""))?.[1] ?? null;
}

/** The rehearsal's clean-up ended with its inventory clean, and nothing failed. */
export function inventoryClean(output) {
  const text = String(output ?? "");
  return /\[rehearse\] inventory clean\b/.test(text) && !/^failed:|\bfailed\b/m.test(text.replace(/\[rehearse\] inventory [a-zA-Z]+ 0\n/g, ""));
}

/** What only a person can confirm, printed after the table. */
export const PERSON_MUST_LOOK = [
  "The real sign-in: WorkOS in the system browser, the zeros:// handoff from Safari, the keychain prompt, and the session surviving a restart (this check fills the sign-in page in its own headless browser and keeps the session in an isolated profile).",
  "The packaged, signed Alpha build: Gatekeeper, notarization, auto-update and its own URL scheme (this check runs the Dev build from source against Alpha).",
  "Creating a project through the New project dialog: it picks repositories only through a GitHub App connection, which needs GitHub's own sign-in in a browser (this check creates the projects through the API with the app's own session, then checks them in the UI).",
  "How it looks: both themes, density and wording in the real window (the screenshots help, but someone has to look).",
  "Retention for real: an actual 30-day archive, and when the machine and the backup really go.",
];
