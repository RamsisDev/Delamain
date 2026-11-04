import { z } from "zod";
import { FavoriteRole, ModelRefString } from "./common.ts";

export const Pricing = z
  .strictObject({
    input_per_mtok: z.number().min(0).describe("USD per million input tokens."),
    output_per_mtok: z.number().min(0).describe("USD per million output tokens."),
    cached_per_mtok: z.number().min(0).optional().describe("USD per million cached input tokens."),
  })
  .meta({ id: "Pricing" });
export type Pricing = z.infer<typeof Pricing>;

export const FavoriteModel = z
  .strictObject({
    ref: ModelRefString,
    label: z.string().optional(),
    roles: z.array(FavoriteRole).optional().describe("Roles the router can resolve to this model."),
    context_window: z.int().positive().optional().describe("Overrides the detected context window."),
    tool_calling: z.boolean().optional().describe("Overrides the detected tool-calling support."),
    max_output_tokens: z.int().positive().optional(),
    pricing: Pricing.optional(),
  })
  .meta({ id: "FavoriteModel" });
export type FavoriteModel = z.infer<typeof FavoriteModel>;

export interface ModelRef {
  provider: string;
  model: string;
  profile?: string;
}

/** Parses `<provider>/<model-id>[@<profile>]`. Model ids may contain `/` and `:`. */
export function parseModelRef(ref: string): ModelRef {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) {
    throw new Error(`Invalid model ref "${ref}". Use <provider>/<model-id>[@<profile>].`);
  }
  const provider = ref.slice(0, slash);
  let model = ref.slice(slash + 1);
  let profile: string | undefined;
  const at = model.lastIndexOf("@");
  if (at > 0 && !model.slice(at + 1).includes("/")) {
    profile = model.slice(at + 1);
    model = model.slice(0, at);
  }
  return profile ? { provider, model, profile } : { provider, model };
}

export function formatModelRef(ref: ModelRef): string {
  return `${ref.provider}/${ref.model}${ref.profile ? `@${ref.profile}` : ""}`;
}

/** The ref without its profile suffix: the same model billed anywhere. */
export function baseModelRef(ref: string): string {
  const parsed = parseModelRef(ref);
  return `${parsed.provider}/${parsed.model}`;
}
