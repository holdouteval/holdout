import { mkdir, copyFile } from "node:fs/promises";
const target = new URL("../dist/src/abi/", import.meta.url);
try {
  await mkdir(target, { recursive: true });
  for (const name of ["Lane", "LaneFactory"]) {
    await copyFile(new URL("../src/abi/" + name + ".json", import.meta.url), new URL(name + ".json", target));
  }
} catch {
  console.error("Unable to copy ABI assets");
  process.exitCode = 1;
}
