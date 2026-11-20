import { withLaneLock } from "../src/journal.js";

const [directory, lane] = process.argv.slice(2);
process.send?.({ event: "waiting", at: Date.now() });
try {
  await withLaneLock(directory, lane, async () => {
    process.send?.({ event: "acquired", at: Date.now() });
    await new Promise<void>(resolve => {
      process.on("message", message => { if (message === "release") resolve(); });
    });
  });
  process.send?.({ event: "released", at: Date.now() });
  process.disconnect?.();
} catch (error) {
  process.send?.({ event: "failed", error: error instanceof Error ? error.message : "lock failed", at: Date.now() });
  process.exitCode = 1;
  process.disconnect?.();
}
