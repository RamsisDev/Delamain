import { SCHEMA_VERSION } from "./common.ts";
import type { SchemaKind } from "./json-schema.ts";

export type Migration = (value: Record<string, unknown>) => Record<string, unknown>;

/** MIGRATIONS[kind][n] upgrades a file from version n to n + 1. */
const MIGRATIONS: Partial<Record<SchemaKind, Record<number, Migration>>> = {};

export type MigrationResult =
  | { ok: true; value: Record<string, unknown>; migratedFrom?: number }
  | { ok: false; message: string };

export function migrate(kind: SchemaKind, value: unknown): MigrationResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, message: "The file must contain a YAML mapping." };
  }
  const record = value as Record<string, unknown>;
  const version = record.schema_version;
  if (version === undefined) {
    if (kind === "agent") return { ok: true, value: record };
    return { ok: false, message: `Missing schema_version. Add "schema_version: ${SCHEMA_VERSION}".` };
  }
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    return { ok: false, message: "schema_version must be a positive integer." };
  }
  if (version > SCHEMA_VERSION) {
    return {
      ok: false,
      message: `This file uses schema_version ${version}, but this extension understands up to ${SCHEMA_VERSION}. Update the extension.`,
    };
  }
  if (version === SCHEMA_VERSION) return { ok: true, value: record };
  let current = record;
  for (let v = version; v < SCHEMA_VERSION; v++) {
    const step = MIGRATIONS[kind]?.[v];
    if (!step) return { ok: false, message: `No migration from schema_version ${v}.` };
    current = { ...step(current), schema_version: v + 1 };
  }
  return { ok: true, value: current, migratedFrom: version };
}
