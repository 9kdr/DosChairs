/**
 * Command line for the agent service: `node modules-cli.mjs <check|bundle> <entry.tsx> [--out dir]`.
 * Always prints one JSON report on the last stdout line; the exit code is
 * non-zero only when the CLI itself crashed.
 */
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { bundleModule, checkModule, writeBundle } from "./bundle.js";

async function main(): Promise<void> {
  const [command, entryArg, ...rest] = process.argv.slice(2);
  if ((command !== "check" && command !== "bundle") || !entryArg) {
    process.stderr.write("usage: modules-cli <check|bundle> <entry.tsx> [--out dir]\n");
    process.exit(2);
  }
  const entry = resolve(entryArg);
  const flag = rest.indexOf("--out");
  if (command === "check") {
    process.stdout.write(`${JSON.stringify({ report: await checkModule(entry) })}\n`);
    return;
  }
  const outDir = resolve(flag >= 0 && rest[flag + 1] ? rest[flag + 1]! : ".");
  const built = await bundleModule(entry);
  let files: string[] = [];
  let id: string | null = null;
  if (built.bundle) {
    await mkdir(outDir, { recursive: true });
    files = await writeBundle(outDir, built.bundle);
    id = built.bundle.id;
  }
  process.stdout.write(`${JSON.stringify({ report: built.report, id, files })}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
