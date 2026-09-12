/** JavaScript injected into the isolated qualification child. Keeping the
 * probe as data makes its missing-root and denied-write behavior unit-testable
 * without weakening the real process boundary. */
export const QUALIFICATION_WRITE_PROBE_SOURCE = String.raw`
function qualificationWriteProbe(fileSystem, pathApi, root, fileName) {
  if (typeof root !== "string" || root.length === 0) return false;
  try {
    fileSystem.mkdirSync(root, { recursive: true });
    const target = pathApi.join(root, fileName);
    const contents = "provider-write\n";
    fileSystem.writeFileSync(target, contents);
    return fileSystem.readFileSync(target, "utf8") === contents;
  } catch {
    return false;
  }
}
`;
