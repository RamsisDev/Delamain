import { z } from "zod";
import { AgentFrontmatter } from "./agent.ts";
import { ConfigFile } from "./config.ts";
import { DecisionsFile } from "./escalation.ts";
import { Flow } from "./flow.ts";
import { Spec } from "./spec.ts";

export type SchemaKind = "config" | "flow" | "agent" | "decisions" | "spec";

const SCHEMAS: Record<SchemaKind, z.ZodType> = {
  config: ConfigFile,
  flow: Flow,
  agent: AgentFrontmatter,
  decisions: DecisionsFile,
  spec: Spec,
};

/** JSON Schema (draft-07) of a file kind, for the yamlValidation contribution point. */
export function jsonSchemaFor(kind: SchemaKind): Record<string, unknown> {
  const schema = z.toJSONSchema(SCHEMAS[kind], {
    target: "draft-7",
    io: "input",
    unrepresentable: "any",
  }) as Record<string, unknown>;
  return { $id: `https://delamain.dev/schemas/${kind}.schema.json`, ...schema };
}

export function zodSchemaFor(kind: SchemaKind): z.ZodType {
  return SCHEMAS[kind];
}

/** Webviews forbid eval under their CSP; zod then validates without compiling schemas. */
export function disableSchemaCompilation(): void {
  z.config({ jitless: true });
}
