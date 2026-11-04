/**
 * Bundle one Chair effect module (a single TSX file) into an OGraf title.
 *
 *   1. scan the source for clocks, randomness, timers, network
 *   2. build a probe (module + react-dom/server) and run it in a locked-down
 *      node process: it reads meta/props and renders frames, seeking away and
 *      back, to prove frames are pure functions of (props, t)
 *   3. wrap the default export with the #234 wrapper: props -> manifest schema
 *      (Inspector controls), history() from the action schedule or a baked table
 *   4. when scope flags are set, re-check the frame in headless chromium
 *      (verify.ts): live fallback text, opaque fills, and canvas alpha coverage
 *
 * Only imports on approved-imports.json resolve; everything is bundled.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import type { Plugin } from "esbuild";
import { wrapReactComponent } from "@chair/ograf";
import type { OgrafBundle, OgrafProp } from "@chair/ograf";
import type { EffectMeta } from "../kit/types.js";
import { effectsPackageDir, isApproved, loadCatalogue } from "./catalogue.js";
import { scanSource, validateMeta, validateProps } from "./validate.js";
import { coverageError, scopeErrors, type ScopeFlags } from "./scope.js";
import { verifyInBrowser } from "./verify.js";

const PROBE_MARK = "@@CHAIR_PROBE@@";
const PROBE_TIMEOUT_MS = 20_000;

export interface ModuleReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
  meta: EffectMeta | null;
  props: OgrafProp[];
  checks: Record<string, boolean | number | string>;
}

export interface ModuleBuild {
  report: ModuleReport;
  /** Present only when the report is ok. */
  bundle: OgrafBundle | null;
}

/** Resolve `@chair/effects` to the kit and only approved bare imports from the module file. */
export function approvedImportsPlugin(entry: string): Plugin {
  const catalogue = loadCatalogue();
  const pkg = effectsPackageDir();
  return {
    name: "chair-approved-imports",
    setup(b) {
      b.onResolve({ filter: /.*/ }, async (args) => {
        if (args.kind === "entry-point" || args.importer !== entry) return undefined;
        if (args.path === "@chair/effects") return { path: join(pkg, "src", "kit", "index.ts") };
        if (args.path.startsWith(".") || args.path.startsWith("/")) {
          return { errors: [{ text: `relative imports are not allowed in a module file: '${args.path}'` }] };
        }
        if (!isApproved(args.path, catalogue)) {
          const names = catalogue.imports.filter((i) => !i.hidden).map((i) => i.name).join(", ");
          return { errors: [{ text: `import '${args.path}' is not approved; use only: ${names}` }] };
        }
        const resolved = await b.resolve(args.path, { resolveDir: pkg, kind: args.kind });
        return resolved.errors.length > 0 ? resolved : { path: resolved.path };
      });
    },
  };
}

/** Same allow-list for the probe build, where the module is reached through an alias. */
export function probeImportsPlugin(entry: string): Plugin {
  const inner = approvedImportsPlugin(entry);
  return {
    name: "chair-probe-imports",
    setup(b) {
      b.onResolve({ filter: /^chair-module-under-test$/ }, () => ({ path: entry }));
      inner.setup(b);
    },
  };
}

interface ProbeOutcome {
  meta: unknown;
  props: unknown;
  errors: string[];
  warnings: string[];
  checks: Record<string, boolean | number>;
  scope?: { covers: string[]; text: string } | null;
}

async function runProbe(entry: string): Promise<ProbeOutcome> {
  const dir = await mkdtemp(join(tmpdir(), "chair-probe-"));
  try {
    const probeSource = join(effectsPackageDir(), "src", "modules", "probe.ts");
    const out = join(dir, "probe.mjs");
    await build({
      entryPoints: [probeSource],
      bundle: true,
      format: "esm",
      platform: "node",
      target: ["node22"],
      jsx: "automatic",
      outfile: out,
      write: true,
      nodePaths: [join(effectsPackageDir(), "node_modules")],
      plugins: [probeImportsPlugin(entry)],
      define: { "process.env.NODE_ENV": '"production"' },
      banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" },
      logLevel: "silent",
    });
    // Probe imports are resolved relative to probe.ts, so its own bare imports
    // (react, react-dom/server) must not hit the module allow-list: the plugin
    // only checks imports whose importer is the module file.
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--permission", `--allow-fs-read=${dir}`, out],
        { env: { PATH: process.env["PATH"] ?? "" }, stdio: ["ignore", "pipe", "pipe"] },
      );
      let text = "";
      let err = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`the module did not finish rendering test frames within ${PROBE_TIMEOUT_MS / 1000}s (infinite loop?)`));
      }, PROBE_TIMEOUT_MS);
      child.stdout.on("data", (d: Buffer) => (text += d.toString()));
      child.stderr.on("data", (d: Buffer) => (err += d.toString()));
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        if (text.includes(PROBE_MARK)) resolve(text);
        else reject(new Error(`probe crashed (exit ${code}): ${err.trim().split("\n").slice(0, 4).join(" | ")}`));
      });
    });
    const line = stdout.split("\n").find((l) => l.startsWith(PROBE_MARK));
    return JSON.parse((line ?? "").slice(PROBE_MARK.length)) as ProbeOutcome;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function emptyReport(errors: string[]): ModuleReport {
  return { ok: false, errors, warnings: [], meta: null, props: [], checks: {} };
}

export interface CheckOptions {
  /** When set, full-frame fills and visible text fail unless asked for. */
  scope?: ScopeFlags | null | undefined;
}

/**
 * Check one module file: static scan, import allow-list, then the probe. The
 * report says exactly what failed, in words fit to hand back to the model.
 */
export async function checkModule(entry: string, opts: CheckOptions = {}): Promise<ModuleReport> {
  const source = await readFile(entry, "utf8");
  const banned = scanSource(source);
  if (banned.length > 0) {
    return emptyReport(banned.map((b) => `forbidden API at ${b}`));
  }
  let outcome: ProbeOutcome;
  try {
    outcome = await runProbe(entry);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return emptyReport([message]);
  }
  const errors = [...outcome.errors];
  const warnings = [...outcome.warnings];
  const checks: Record<string, boolean | number | string> = { ...outcome.checks };
  const meta = validateMeta(outcome.meta);
  const props = validateProps(outcome.props);
  errors.unshift(...meta.errors, ...props.errors);
  const scope = opts.scope ?? null;
  errors.push(...scopeErrors(outcome.scope?.covers ?? [], outcome.scope?.text ?? "", scope));
  if (scope) {
    // The SSR probe cannot see client-only state (a ShaderPass compile
    // fallback) or canvas paint (a semi-transparent wash), so re-check the
    // same rules against a real browser frame when one is available.
    try {
      const seen = await verifyInBrowser(entry, { plugin: probeImportsPlugin(entry), scope });
      if (seen.skipped) {
        warnings.push(
          `browser verification skipped: ${seen.reason} (shader-compile and pixel-coverage rules not enforced)`,
        );
      } else {
        checks["browserVerified"] = true;
        if (typeof seen.paintCoverage === "number") checks["paintCoverage"] = seen.paintCoverage;
        if (typeof seen.shadersStatus === "string") checks["shadersStatus"] = seen.shadersStatus;
        errors.push(...scopeErrors(seen.covers ?? [], seen.text ?? "", scope, seen.shaderLog ?? null));
        const wash = coverageError(seen.paintCoverage ?? null, scope.wantsBackground);
        if (wash) errors.push(wash);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`browser verification failed: ${message}`);
    }
  }
  warnings.unshift(...meta.warnings, ...props.warnings);
  // The browser step re-checks the same scope rules against live data, so an
  // identical finding would otherwise reach the model twice.
  const unique = [...new Set(errors)];
  return {
    ok: unique.length === 0 && meta.value !== null && props.value !== null,
    errors: unique,
    warnings,
    meta: meta.value,
    props: props.value ?? [],
    checks,
  };
}

/** Check, then wrap into an OGraf title. A failed check yields a report and no bundle. */
export async function bundleModule(entry: string, opts: { data?: unknown } = {}): Promise<ModuleBuild> {
  const report = await checkModule(entry);
  if (!report.ok || !report.meta) return { report, bundle: null };
  const meta = report.meta;
  try {
    const bundle = await wrapReactComponent({
      id: meta.id,
      name: meta.name,
      description: `Chair effect module "${meta.name}" (${meta.kind}).`,
      durationSec: meta.durationSec,
      fps: meta.fps,
      width: meta.width,
      height: meta.height,
      entry,
      props: report.props,
      plugins: [approvedImportsPlugin(entry)],
      nodePaths: [join(effectsPackageDir(), "node_modules")],
      data: opts.data,
    });
    return { report, bundle };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { report: { ...report, ok: false, errors: [...report.errors, `bundling failed: ${message}`] }, bundle: null };
  }
}

/** Write `<id>.ograf.json` + `<id>.js` into `dir`; returns the two paths. */
export async function writeBundle(dir: string, bundle: OgrafBundle): Promise<string[]> {
  const manifest = join(dir, `${bundle.id}.ograf.json`);
  const js = join(dir, `${bundle.id}.js`);
  await writeFile(manifest, JSON.stringify(bundle.manifest, null, 2) + "\n", "utf8");
  await writeFile(js, bundle.js, "utf8");
  return [manifest, js];
}

