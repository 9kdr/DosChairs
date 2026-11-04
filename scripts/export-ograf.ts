/**
 * Dev script: export sample effect specs and the hand-written React example
 * as OGraf titles into a folder Mel can drop into Resolve's
 * `.../Fusion/Templates/Edit/Titles/OGraf/` scan folder.
 *
 * Run via `mise run export-ograf-sample` (bundles with esbuild, then runs).
 * Not part of any package build. The live Muse Spark shader spec is read
 * from /tmp and skipped with a warning when it is not there.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { exportOGraf } from "@chair/effects";
import type { EffectSpec } from "@chair/effects";
import { wrapReactComponent } from "@chair/ograf";

function outDir(): string {
  const flag = process.argv.indexOf("--out");
  const picked = flag >= 0 ? process.argv[flag + 1] : undefined;
  return picked ?? "/tmp/chair-ograf-sample";
}

async function writeBundle(
  dir: string,
  bundle: { id: string; manifest: unknown; js: string },
): Promise<string[]> {
  const manifestPath = join(dir, `${bundle.id}.ograf.json`);
  const jsPath = join(dir, `${bundle.id}.js`);
  await writeFile(manifestPath, JSON.stringify(bundle.manifest, null, 2) + "\n", "utf8");
  await writeFile(jsPath, bundle.js, "utf8");
  return [manifestPath, jsPath];
}

async function main(): Promise<void> {
  const out = outDir();
  await mkdir(out, { recursive: true });
  const root = process.cwd();
  const written: string[] = [];

  // 1. The sample effect spec, rendered by EffectSpecView through the wrapper.
  const spec = JSON.parse(
    readFileSync(join(root, "fixtures/effects/bounce-title.effect.json"), "utf8"),
  ) as EffectSpec;
  written.push(
    ...(await writeBundle(
      out,
      await exportOGraf(spec, {
        entry: join(root, "packages/effects/src/spec-view.tsx"),
      }),
    )),
  );

  // 2. The hand-written React example: dithered kinetic title. Props here
  // become the Inspector controls; keep ids in sync with the component.
  written.push(
    ...(await writeBundle(
      out,
      await wrapReactComponent({
        id: "kinetic-dither",
        name: "Kinetic Dither Title",
        description:
          "Hand-written React OGraf example: dithered kinetic title over an accent field (WebGL2, labelled fallback otherwise).",
        durationSec: 5,
        fps: 30,
        width: 1920,
        height: 1080,
        entry: join(root, "packages/ograf/examples/kinetic-dither/KineticDitherTitle.tsx"),
        props: [
          { id: "title", label: "Title", type: "text", default: "SIGNAL" },
          { id: "accent", label: "Accent", type: "color", default: "#ffb000" },
          { id: "dither", label: "Dither", type: "number", default: 0.6, min: 0, max: 1 },
          { id: "speed", label: "Speed", type: "number", default: 1, min: 0.25, max: 3 },
        ],
      }),
    )),
  );

  // 3. The live Muse Spark shader spec: real stress case, one shader layer
  // with five bound controls. Lands in its own folder, ready to install.
  try {
    const live = JSON.parse(
      readFileSync("/tmp/chair-effect-live/web.effect.json", "utf8"),
    ) as EffectSpec;
    const liquidDir = join(out, "liquid-dither");
    await mkdir(liquidDir, { recursive: true });
    written.push(
      ...(await writeBundle(
        liquidDir,
        await exportOGraf(live, {
          entry: join(root, "packages/effects/src/spec-view.tsx"),
        }),
      )),
    );
  } catch {
    console.warn("skipping liquid-dither: /tmp/chair-effect-live/web.effect.json not found");
  }

  for (const file of written) console.log(file);
}

void main();
