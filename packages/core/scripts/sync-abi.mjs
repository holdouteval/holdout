import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const destination = fileURLToPath(new URL("../src/abi/", import.meta.url));
try {
  await mkdir(destination, { recursive: true });
  for (const name of ["LaneFactory", "Lane"]) {
    let artifact;
    try { artifact = JSON.parse(await readFile(resolve(root, "contracts/out", name + ".sol", name + ".json"), "utf8")); }
    catch { throw new Error("contract ABI artifact unavailable"); }
    if (!Array.isArray(artifact.abi)) throw new Error("contract ABI is missing");
    const expected = JSON.stringify(artifact.abi, null, 2) + "\n";
    const path = resolve(destination, name + ".json");
    if (process.argv.includes("--check")) {
      let actual;
      try { actual = await readFile(path, "utf8"); } catch { throw new Error("generated ABI unavailable"); }
      if (actual !== expected) throw new Error("generated ABI differs: " + name);
    } else {
      await writeFile(path, expected);
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "ABI synchronization failed");
  process.exitCode = 1;
}
