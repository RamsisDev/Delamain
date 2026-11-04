import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseDocument } from "yaml";
import { checkAuth, findCli } from "./cli-tools.mjs";

const cli = Object.fromEntries(["codex", "claude"].map(name => [name, findCli(name)]));
for (const [name, tool] of Object.entries(cli)) {
  const authenticated = checkAuth(name, tool.command);
  console.log(`${name}: ${tool.version}; ${authenticated ? "authenticated" : "sign-in needed"}`);
  if (!authenticated) console.log(`Run npm run cli:${name} -- ${name === "codex" ? "login" : "auth login"}`);
}

const path = resolve(".harness/config.yml");
const document = parseDocument(existsSync(path) ? readFileSync(path, "utf8") : "schema_version: 1\n");
if (document.errors.length) throw new Error(`Fix ${path} before setup: ${document.errors.map(e => e.message).join("; ")}`);
const quote = command => `"${command.replaceAll("\\", "/")}"`;
const providers = document.get("providers")?.toJSON() ?? [];
if (!Array.isArray(providers)) throw new Error("providers must be a YAML list; existing configuration was not changed.");
if (!document.has("providers")) document.set("providers", document.createNode([]));
for (const [name, tool] of Object.entries(cli)) {
  if (providers.some(provider => provider.id === name)) continue;
  document.addIn(["providers"], {
    id: name, type: "cli", label: name === "codex" ? "Codex CLI" : "Claude CLI",
    command: `${quote(tool.command)} ${name === "codex" ? "exec --sandbox workspace-write -" : "-p --output-format text --permission-mode acceptEdits"}`,
    prompt_input: "stdin", max_concurrent: 1,
  });
}
const models = document.get("models")?.toJSON() ?? [];
if (!Array.isArray(models)) throw new Error("models must be a YAML list; existing configuration was not changed.");
if (!document.has("models")) document.set("models", document.createNode([]));
for (const name of ["codex", "claude"]) {
  if (models.some(model => model.ref === `${name}/default`)) continue;
  document.addIn(["models"], {
    ref: `${name}/default`, label: name === "codex" ? "Codex CLI" : "Claude CLI", tool_calling: false,
    roles: name === "codex" ? ["orchestrator", "worker", "short-tasks"] : ["orchestrator-fallback", "qa", "reviewer"],
  });
}
for (const [name, command] of Object.entries({ test: "npm test", typecheck: "npm run typecheck" })) {
  if (!document.hasIn(["commands", name])) document.setIn(["commands", name], command);
}
if (!document.hasIn(["defaults", "flow"])) document.setIn(["defaults", "flow"], "single-agent");
if (!document.hasIn(["defaults", "approval"])) document.setIn(["defaults", "approval"], "review");
mkdirSync(resolve(".harness"), { recursive: true });
const next = document.toString();
if (!existsSync(path) || readFileSync(path, "utf8") !== next) writeFileSync(path, next);
console.log(`CLI providers ready in ${path}. Existing settings were preserved.`);
console.log("Open Harness Configuration > Project to test connections. Use npm run cli:codex or npm run cli:claude for interactive terminals.");
