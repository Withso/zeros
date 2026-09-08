import { z } from "zod";

/** App preferences only. Navigation, chats, credentials, caches, and native
 * provider settings have separate owners and never enter this table. */
export const personalPreferencesSchema = z
  .object({
    appearance: z.object({
      mode: z.enum(["system", "light", "dark", "orka-black"]),
      codeThemes: z
        .object({ dark: z.string().optional(), light: z.string().optional() })
        .default({}),
    }),
    experimental: z.record(z.string(), z.boolean()),
    internal: z.record(z.string(), z.boolean()),
    enabled_agents: z.object({ ids: z.array(z.string()).max(128) }),
    terminal_agents: z
      .array(
        z
          .object({
            id: z.string(),
            name: z.string(),
            binary: z.string(),
            launchCommand: z.string(),
          })
          .passthrough(),
      )
      .max(128),
    default_terminal_agent: z.string(),
    removed_terminal_agents: z.array(z.string()).max(256),
    analytics_opt_out: z.boolean(),
    analytics_notice_seen: z.boolean(),
  })
  .partial();
export type PersonalPreferences = z.infer<typeof personalPreferencesSchema>;
export type PersonalPreferenceKey = keyof PersonalPreferences;
/** Existing storage names are synchronous caches and migration inputs. */
export const PERSONAL_PREFERENCE_STORAGE: Readonly<
  Record<PersonalPreferenceKey, string>
> = {
  appearance: "zeros.appearance.v2",
  experimental: "zeros.experimentalFeatures",
  internal: "zeros.internalFeatures",
  enabled_agents: "zeros.agent.enabledAgents",
  terminal_agents: "zeros-terminal-agents:catalog",
  default_terminal_agent: "zeros-terminal-agents:default",
  removed_terminal_agents: "zeros-terminal-agents:removed",
  analytics_opt_out: "zeros-analytics:opt-out",
  analytics_notice_seen: "zeros-analytics:notice-seen",
};
