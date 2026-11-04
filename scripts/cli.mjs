import spawn from "cross-spawn";
import { findCli } from "./cli-tools.mjs";

try {
  const { command } = findCli(process.argv[2]);
  const child = spawn(command, process.argv.slice(3), { stdio: "inherit" });
  child.on("error", error => { console.error(error.message); process.exitCode = 1; });
  child.on("exit", code => { process.exitCode = code ?? 1; });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
