// Resolve .js specifiers to .ts siblings so node runs the repo's effects
// sources directly (rig.ts, bake.ts) with no build step. Used only by the
// demo check's bake call: `node --import ./ts-register.mjs ./bake-rig.ts`.
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

registerHooks({
  resolve(specifier, context, next) {
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      specifier.endsWith(".js")
    ) {
      const parent = dirname(fileURLToPath(context.parentURL));
      const sibling = resolvePath(parent, specifier.slice(0, -3) + ".ts");
      if (existsSync(sibling)) return next(pathToFileURL(sibling).href, context);
    }
    return next(specifier, context);
  },
});
