import { spawn, type ChildProcess } from "node:child_process";

/** Stop the process and its descendants, including Windows command shims. */
export function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.on("error", () => child.kill("SIGKILL"));
    killer.on("exit", (code) => { if (code !== 0) child.kill("SIGKILL"); });
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}
