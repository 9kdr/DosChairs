/**
 * Every gold library module must pass the same check a Wonder-made module
 * passes (static scan, import allow-list, probe determinism with zero
 * warnings), and library/index.json must describe exactly what is on disk:
 * ids, adapter sources, licences, tags, and typed props. Runs in
 * `mise run check` via `pnpm --filter @chair/effects test:modules`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkModule } from "./bundle.js";
import { effectsPackageDir } from "./catalogue.js";

const libraryDir = join(effectsPackageDir(), "library");
const entries = readdirSync(libraryDir)
  .filter((f) => f.endsWith(".tsx"))
  .sort();

interface IndexProp {
  id: string;
  type: string;
}
interface IndexEntry {
  id: string;
  tags: string[];
  summary: string;
  props: IndexProp[];
  source: string;
  libraries: { name: string; license: string }[];
  license: string;
  path: string;
}

const index = JSON.parse(readFileSync(join(libraryDir, "index.json"), "utf8")) as {
  adapters: Record<string, string>;
  entries: IndexEntry[];
};

describe("gold library modules", () => {
  it("ships the six gold modules", () => {
    for (const id of ["liquid-boxes", "dither-reveal", "lower-third", "physics-letters", "morph-icon", "mesh-gradient"]) {
      expect(entries).toContain(`${id}.tsx`);
    }
  });
  for (const file of entries) {
    it(`${file} passes the check and renders deterministically`, async () => {
      const report = await checkModule(join(libraryDir, file));
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

describe("library/index.json", () => {
  it("describes exactly the modules on disk", () => {
    const files = new Set(entries);
    expect(index.entries.length).toBe(entries.length);
    for (const entry of index.entries) {
      expect(entry.id, "id").toMatch(/^[a-z0-9-]+$/);
      expect(entry.tags.length, `${entry.id} tags`).toBeGreaterThan(0);
      expect(entry.summary.length, `${entry.id} summary`).toBeGreaterThan(20);
      expect(entry.source, `${entry.id} source`).toMatch(/^[a-z]+$/);
      expect(index.adapters[entry.source], `${entry.id} adapter`).toBeTruthy();
      expect(entry.license.length, `${entry.id} license`).toBeGreaterThan(0);
      for (const lib of entry.libraries) {
        expect(lib.name.length, `${entry.id} library name`).toBeGreaterThan(0);
        expect(lib.license.length, `${entry.id} library license`).toBeGreaterThan(0);
      }
      expect(files.has(entry.path.split("/").pop()!), `${entry.id} path exists`).toBe(true);
      expect(existsSync(join(effectsPackageDir(), entry.path)), entry.path).toBe(true);
    }
  });

  it("props match the modules' typed exports", async () => {
    for (const entry of index.entries) {
      const report = await checkModule(join(effectsPackageDir(), entry.path));
      expect(report.ok, entry.id).toBe(true);
      const actual = (report.props as { id: string; type: string }[]).map((p) => ({
        id: p.id,
        type: p.type === "text" ? "string" : p.type === "bool" ? "boolean" : p.type,
      }));
      expect(actual, `${entry.id} props`).toEqual(entry.props);
    }
  }, 180_000);
});
