import { HarnessFailure } from "./assertions";
import { FIXTURE_REQUEST_ROUTES, type FixtureRequestDelay } from "./fixture-control-plane/request-observations";

/** Explicit opt-in only. CURRENT measurements remain invalid-auth fixtures
 * until real response turns are separately authorized and implemented. */
export function selectMeasurementOptions(args: readonly string[], credentials: string) {
  const value = (name: string, fallback: string) => {
    const indices = args.flatMap((arg, index) => arg === name ? [index] : []);
    if (indices.length > 1) throw new HarnessFailure("operator_input_invalid");
    return indices.length ? args[indices[0]! + 1] ?? "" : fallback;
  };
  const measurement = value("--measurement", "none");
  const delay = value("--cp-request-delay-ms", "0");
  if (!["none", "current", "boot-owner"].includes(measurement) || !/^\d{1,4}$/.test(delay)) throw new HarnessFailure("operator_input_invalid");
  const requestDelayMs = Number(delay);
  if (requestDelayMs > 5000 || measurement !== "none" && credentials !== "invalid" ||
      measurement === "none" && args.includes("--cp-request-delay-ms")) throw new HarnessFailure("operator_input_invalid");
  const requestDelay: readonly FixtureRequestDelay[] = requestDelayMs
    ? FIXTURE_REQUEST_ROUTES.map(route => ({ route, delayMs: requestDelayMs })) : [];
  return { measurement: measurement as "none" | "current" | "boot-owner", requestDelayMs, requestDelay };
}
