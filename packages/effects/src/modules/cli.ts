/**
 * Command line for the agent service: `node modules-cli.mjs <check|bundle|render> <entry.tsx> [--out dir]`.
 * Always prints one JSON report on the last stdout line; the exit code is
 * non-zero only when the CLI itself crashed.
 */
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { bundleModule, checkModule, writeBundle } from "./bundle.js";
import { renderFrames } from "./render.js";

async function main(): Promise<void> {
  const [command, entryArg, ...rest] = process.argv.slice(2);
  if ((command !== "check" && command !== "bundle" && command !== "render") || !entryArg) {
    process.stderr.write(
      "usage: modules-cli <check|bundle|render> <entry.tsx> [--out dir] [--data json]\n",
    );
    process.exit(2);
  }
  const entry = resolve(entryArg);
  const flag = rest.indexOf("--out");
  const dataFlag = rest.indexOf("--data");
  const raw = dataFlag >= 0 && rest[dataFlag + 1] ? rest[dataFlag + 1]! : undefined;
  const scope = (() => {
    try {
      const parsed = raw ? (JSON.parse(raw) as { scope?: unknown }) : undefined;
      const flags = parsed?.scope as { wantsBackground?: unknown; wantsText?: unknown } | undefined;
      if (!flags) return undefined;
      return {
        wantsBackground: flags.wantsBackground === true,
        wantsText: flags.wantsText === true,
      };
    } catch {
      return undefined;
    }
  })();
  if (command === "check") {
    process.stdout.write(`${JSON.stringify({ report: await checkModule(entry, { scope }) })}\n`);
    return;
  }
  if (command === "render") {
    const outDir = resolve(flag >= 0 && rest[flag + 1] ? rest[flag + 1]! : ".");
    const data = (raw ? JSON.parse(raw) : {}) as {
      width?: number; height?: number; fps?: number; durationSec?: number;
      props?: Record<string, unknown>; keyframes?: Record<string, [number, unknown][]>;
      chromium?: string;
    };
    const outcome = await renderFrames(entry, {
      width: data.width ?? 0,
      height: data.height ?? 0,
      fps: data.fps ?? 0,
      durationSec: data.durationSec ?? 0,
      props: data.props,
      keyframes: data.keyframes,
      outDir,
      chromium: typeof data.chromium === "string" ? data.chromium : undefined,
    });
    process.stdout.write(`${JSON.stringify(outcome)}\n`);
    return;
  }
  const outDir = resolve(flag >= 0 && rest[flag + 1] ? rest[flag + 1]! : ".");
  const data = raw ? JSON.parse(raw) : undefined;
  const built = await bundleModule(entry, { data, scope });
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
