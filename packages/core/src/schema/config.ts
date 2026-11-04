import { z } from "zod";
import { Identifier, schemaVersion } from "./common.ts";
import { FindingsRouting } from "./findings.ts";
import { Limits } from "./limits.ts";
import { FavoriteModel } from "./models.ts";
import { Provider } from "./providers.ts";
import { RouterConfig } from "./router.ts";

export const DiscoveryServer = z.strictObject({
  id: Identifier.describe("Provider id created when this server answers."),
  label: z.string(),
  base_url: z.url(),
});
export type DiscoveryServer = z.infer<typeof DiscoveryServer>;

export const Discovery = z
  .strictObject({
    enabled: z.boolean().optional(),
    timeout_ms: z.int().min(50).max(10_000).optional(),
    refresh_seconds: z.int().min(5).optional().describe("How often loaded models are refreshed."),
    servers: z.array(DiscoveryServer).optional().describe("Known local apps probed at startup."),
  })
  .meta({ id: "Discovery" });
export type Discovery = z.infer<typeof Discovery>;

export const Worktree = z
  .strictObject({
    setup: z
      .string()
      .optional()
      .describe("Command run in every new worktree, for example `uv sync` or `npm ci`."),
  })
  .meta({ id: "Worktree" });

export const Security = z
  .strictObject({
    destructive_patterns: z
      .array(z.string())
      .optional()
      .describe("Regular expressions; matching commands always ask for confirmation."),
  })
  .meta({ id: "Security" });

export const Safeguard = z
  .strictObject({
    line_margin: z
      .int()
      .min(0)
      .optional()
      .describe("Lines around a finding a mechanical fix may touch without being promoted to QA."),
  })
  .meta({ id: "Safeguard" });

export const SessionDefaults = z
  .strictObject({
    flow: z.string().optional().describe("Orchestration used by new conversations."),
    approval: z.enum(["auto", "review"]).optional(),
  })
  .meta({ id: "SessionDefaults" });

export const Commands = z
  .record(z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/), z.string().min(1))
  .describe("Project commands, referenced from flows and findings routing as {{commands.<name>}}.")
  .meta({ id: "Commands" });

export const ConfigFile = z
  .strictObject({
    schema_version: schemaVersion,
    commands: Commands.optional(),
    providers: z.array(Provider).optional(),
    models: z.array(FavoriteModel).optional().describe("Favorite models and their roles."),
    router: RouterConfig.optional(),
    findings_routing: FindingsRouting.optional(),
    limits: Limits.optional(),
    worktree: Worktree.optional(),
    discovery: Discovery.optional(),
    security: Security.optional(),
    safeguard: Safeguard.optional(),
    defaults: SessionDefaults.optional(),
  })
  .meta({ id: "HarnessConfig", title: "Harness configuration" });
export type ConfigFile = z.infer<typeof ConfigFile>;

/** The merged configuration of every layer. */
export type HarnessConfig = Omit<ConfigFile, "schema_version">;
