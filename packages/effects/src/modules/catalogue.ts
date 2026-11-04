/** The approved-imports catalogue: the single file both the bundler and the model prompt read. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface ApprovedImport {
  name: string;
  summary: string;
  api: string[];
  hidden?: boolean;
  /** Also allow `<name>/...` subpaths (three/examples/jsm/...). */
  prefix?: boolean;
}

export interface Catalogue {
  version: number;
  imports: ApprovedImport[];
}

/** The effects package folder: where approved libraries resolve from. */
export function effectsPackageDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/modules/ in source, build/ when bundled into the CLI.
  for (const up of [join(here, "..", ".."), join(here, "..")]) {
    try {
      readFileSync(join(up, "approved-imports.json"));
      return up;
    } catch {
      /* try next */
    }
  }
  throw new Error("approved-imports.json not found next to the effects package");
}

export function loadCatalogue(): Catalogue {
  return JSON.parse(readFileSync(join(effectsPackageDir(), "approved-imports.json"), "utf8")) as Catalogue;
}

/** True when a bare import specifier is on the list (exact name, or a prefix entry's subpath). */
export function isApproved(specifier: string, catalogue: Catalogue = loadCatalogue()): boolean {
  return catalogue.imports.some(
    (entry) => entry.name === specifier || (entry.prefix === true && specifier.startsWith(`${entry.name}/`)),
  );
}
