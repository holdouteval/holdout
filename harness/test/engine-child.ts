import { readFile } from "node:fs/promises";
import { DATE, TIME, engine, type TestConfig } from "./engine-support.js";

const config = JSON.parse(await readFile(process.argv[2], "utf8")) as TestConfig;
const runtime = engine(config);
try {
  const command = process.argv[3];
  if (command === "resume") await runtime.resume();
  else if (command === "send" || command === "skip") await runtime.review(process.argv[4], command);
  else await runtime.runLane(config.lanes[0], { date: DATE, key: DATE, time: TIME, block: 101 });
  process.send?.({ event: "done" });
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : "child failed") + "\n"); process.exitCode = 1;
} finally { runtime.close(); }
