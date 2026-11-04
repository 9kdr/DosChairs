/**
 * Every checked-in reference module must pass the same check a Wonder-made
 * module passes: the static scan, the import allow-list, and the probe's
 * determinism proof (seek away and back renders the identical frame). Runs in
 * `mise run check` via `pnpm --filter @chair/effects test:modules` (#241).
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkModule } from "./bundle.js";
import { effectsPackageDir } from "./catalogue.js";

const entries = readdirSync(join(effectsPackageDir(), "modules"))
  .filter((f) => f.endsWith(".tsx"))
  .sort();

describe("reference modules", () => {
  it("ships at least the expressive mouse and the liquid dither", () => {
    expect(entries).toContain("expressive-mouse.tsx");
    expect(entries).toContain("liquid-dither.tsx");
  });
  for (const file of entries) {
    it(`${file} passes the check and renders deterministically`, async () => {
      const report = await checkModule(join(effectsPackageDir(), "modules", file));
      expect(report.errors).toEqual([]);
      expect(report.warnings).toEqual([]);
      expect(report.ok).toBe(true);
      expect(report.meta).not.toBeNull();
      expect(report.props.length).toBeGreaterThan(0);
      expect(report.checks["deterministic"]).toBe(true);
      expect(report.checks["animates"]).toBe(true);
    }, 120_000);
  }
});
