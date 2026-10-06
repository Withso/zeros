type PowerEvent = "suspend" | "resume" | "lock-screen" | "unlock-screen";

/** DOM focus can survive a macOS screen lock. Main owns the OS availability
 * bit; no input contents, system idle duration or account identity leave here. */
export function desktopUserPresence(power: {
  on(event: PowerEvent, listener: () => void): unknown;
  off(event: PowerEvent, listener: () => void): unknown;
  getSystemIdleState(seconds: number): string;
}, emit: (name: string, payload: { available: boolean }) => void) {
  let suspended = false, locked = false;
  const available = () => !suspended && !locked && power.getSystemIdleState(1) !== "locked";
  const publish = () => emit("desktop-user-presence", { available: available() });
  const listeners: Record<PowerEvent, () => void> = {
    suspend: () => { suspended = true; publish(); },
    resume: () => { suspended = false; publish(); },
    "lock-screen": () => { locked = true; publish(); },
    "unlock-screen": () => { locked = false; publish(); },
  };
  for (const event of Object.keys(listeners) as PowerEvent[]) power.on(event, listeners[event]);
  return { available, close: () => {
    for (const event of Object.keys(listeners) as PowerEvent[]) power.off(event, listeners[event]);
  } };
}
