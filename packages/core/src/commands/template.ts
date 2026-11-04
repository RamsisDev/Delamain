import { getPath } from "../flow/expression.ts";

const VARIABLE = /\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}/g;

export class TemplateError extends Error {}

/**
 * Interpolates {{task.worktree}}, {{task.files}}, {{finding.files}}, {{commands.test}}...
 * Lists are joined with spaces and every file path is shell-quoted, so a command can check
 * only what was touched.
 */
export function renderTemplate(template: string, variables: Record<string, unknown>, depth = 0): string {
  if (depth > 5) throw new TemplateError("Templates nest too deeply");
  return template.replace(VARIABLE, (_, name: string) => {
    const value = getPath(variables, name.split("."));
    if (value === undefined || value === null) {
      throw new TemplateError(`Unknown variable {{${name}}}`);
    }
    if (Array.isArray(value)) return value.map((v) => shellQuote(String(v))).join(" ");
    const text = String(value);
    return name.startsWith("commands.") ? renderTemplate(text, variables, depth + 1) : text;
  });
}

export function templateVariables(template: string): string[] {
  return [...template.matchAll(VARIABLE)].map((m) => m[1]!);
}

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
