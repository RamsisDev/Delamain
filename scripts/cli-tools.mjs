import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import spawn from "cross-spawn";

export function findCli(name) {
  if (!["codex", "claude"].includes(name)) throw new Error(`Unknown CLI: ${name}`);
  const candidates = [name, join(homedir(), ".local", "bin", `${name}${process.platform === "win32" ? ".exe" : ""}`)];
  if (process.platform === "win32" && process.env.APPDATA) candidates.push(join(process.env.APPDATA, "npm", `${name}.cmd`));
  for (const command of candidates) {
    if (command !== name && !existsSync(command)) continue;
    const result = spawn.sync(command, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 15_000 });
    if (result.status === 0) return { command, version: result.stdout.trim() };
  }
  throw new Error(`${name} is not installed or could not start. Install it, then run npm run setup:cli again.`);
}

export function checkAuth(name, command) {
  const result = spawn.sync(command, name === "codex" ? ["login", "status"] : ["auth", "status"], { encoding: "utf8", windowsHide: true, timeout: 15_000 });
  if (name === "claude") {
    try { return result.status === 0 && JSON.parse(result.stdout).loggedIn === true; } catch { return false; }
  }
  return result.status === 0;
}
