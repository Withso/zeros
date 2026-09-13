import { create } from "zustand";
import { isRunSessionId } from "@zeros/protocol/run-actions";

/** Presentation only: Run icon names keep the settings registry's fallback. */
export function terminalTabIconName(
  terminalId: string | undefined,
  runIcon?: string,
): string {
  if (terminalId === "setup") return "settings";
  if (terminalId === "run:add" || isRunSessionId(terminalId ?? ""))
    return runIcon || "play";
  return "terminal";
}

export interface TerminalTabIndicator {
  running: boolean;
  exited: boolean;
  dot: "running" | "passed" | "failed" | "stopped" | null;
  icon?: string;
}
export type TerminalTabIndicators = Readonly<
  Record<string, TerminalTabIndicator>
>;
const EMPTY: TerminalTabIndicators = Object.freeze({});
const MAX_FOLDERS = 128;

/** Shared presentation of the controller's confirmed snapshot. Primary tabs
 * consume this aggregate without adding per-tab status requests. */
const useIndicators = create<{
  byFolder: Record<string, TerminalTabIndicators>;
}>(() => ({ byFolder: {} }));

export function publishTerminalTabIndicators(
  folder: string,
  indicators: TerminalTabIndicators,
): void {
  useIndicators.setState((state) => {
    const previous = state.byFolder[folder] ?? EMPTY;
    const keys = Object.keys(indicators);
    if (
      keys.length === Object.keys(previous).length &&
      keys.every(
        (id) =>
          previous[id]?.running === indicators[id].running &&
          previous[id]?.exited === indicators[id].exited &&
          previous[id]?.dot === indicators[id].dot &&
          previous[id]?.icon === indicators[id].icon,
      )
    )
      return state;
    const byFolder = { ...state.byFolder };
    delete byFolder[folder];
    byFolder[folder] = indicators;
    for (const key of Object.keys(byFolder).slice(0, -MAX_FOLDERS))
      delete byFolder[key];
    return { byFolder };
  });
}

export function clearTerminalTabIndicators(
  matches: (folder: string) => boolean,
): void {
  useIndicators.setState((state) => ({
    byFolder: Object.fromEntries(
      Object.entries(state.byFolder).filter(([folder]) => !matches(folder)),
    ),
  }));
}

export function useTerminalTabIndicators(
  folder: string,
): TerminalTabIndicators {
  return useIndicators((state) => state.byFolder[folder] ?? EMPTY);
}

export function peekTerminalTabIndicators(
  folder: string,
): TerminalTabIndicators {
  return useIndicators.getState().byFolder[folder] ?? EMPTY;
}
