import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { jsonSchemaFor, type SchemaKind } from "@delamain/core";

const outDir = process.argv[2] ?? "schemas";
const kinds: SchemaKind[] = ["config", "flow", "agent", "decisions", "spec"];
for (const kind of kinds) {
  writeFileSync(join(outDir, `${kind}.schema.json`), `${JSON.stringify(jsonSchemaFor(kind), null, 2)}\n`);
}
console.log(`Wrote ${kinds.length} schemas to ${outDir}`);
