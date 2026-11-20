import { build } from "esbuild";
import { mkdir, copyFile, chmod, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { safeError } from "@holdout/core";

const root = fileURLToPath(new URL(".", import.meta.url));
const output = join(root, "dist");
function configuredBase(name) {
  if (process.env[name] === undefined) return null;
  try {
    const url = new URL(process.env[name]);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw 0;
    return url.href.replace(/\/+$/, "");
  } catch { throw new Error(name + " must be an https base URL"); }
}
try {
const defaults = { data: configuredBase("HOLDOUT_DATA_BASE"), site: configuredBase("HOLDOUT_SITE_BASE") };
await rm(output, { recursive: true, force: true });
await mkdir(join(output, "abi"), { recursive: true });
await build({ entryPoints: [join(root, "src/cli.ts")], outfile: join(output, "holdout-mcp.js"),
  bundle: true, format: "esm", platform: "node", target: "node22.13", sourcemap: false,
  banner: { js: "#!/usr/bin/env node" }, external: ["@modelcontextprotocol/sdk", "zod", "viem", "viem/*"],
  define: { HOLDOUT_BUILD_DATA: JSON.stringify(defaults.data), HOLDOUT_BUILD_SITE: JSON.stringify(defaults.site) },
});
await writeFile(join(output, "defaults.json"), JSON.stringify(defaults, null, 2) + "\n");
for (const name of ["Lane", "LaneFactory"]) {
  await copyFile(new URL(`../packages/core/src/abi/${name}.json`, import.meta.url), join(output, "abi", name + ".json"));
}
await chmod(join(output, "holdout-mcp.js"), 0o755);
} catch (error) { console.error(safeError(error)); process.exitCode = 1; }
