export function desktopSignInSecondsRemaining(
  expiresAt: number,
  now = Date.now(),
): number {
  if (!Number.isFinite(expiresAt) || !Number.isFinite(now)) return 0;
  return Math.max(0, Math.ceil((expiresAt - now) / 1_000));
}

export function desktopSignInExpiryLabel(secondsRemaining: number): string {
  const bounded = Number.isFinite(secondsRemaining)
    ? Math.max(0, Math.floor(secondsRemaining))
    : 0;
  if (bounded === 0) return "Sign-in window expiring now";
  const minutes = Math.floor(bounded / 60);
  const seconds = String(bounded % 60).padStart(2, "0");
  return `Sign-in window expires in ${minutes}:${seconds}`;
}
