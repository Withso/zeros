export function isValidCloudWorkspaceWorkerId(value: string): boolean {
  if (value.length < 1 || value.length > 255) return false;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}
