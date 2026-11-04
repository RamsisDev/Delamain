import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const watch = process.argv.includes("--watch");
const schemasOnly = process.argv.includes("--schemas-only");

async function generateSchemas() {
  const out = join(root, "dist", "generate-schemas.cjs");
  await esbuild.build({
    entryPoints: [join(root, "scripts", "generate-schemas.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile: out,
    logLevel: "warning",
  });
  mkdirSync(join(root, "schemas"), { recursive: true });
  execFileSync(process.execPath, [out, join(root, "schemas")], { stdio: "inherit" });
}

await generateSchemas();
if (!schemasOnly) {
  const options = {
    entryPoints: [join(root, "src", "extension.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile: join(root, "dist", "extension.cjs"),
    external: ["vscode"],
    sourcemap: true,
    logLevel: "info",
  };
  if (watch) {
    const context = await esbuild.context(options);
    await context.watch();
  } else {
    await esbuild.build(options);
  }
}
