import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    // Mirror each package's `@/*` tsconfig alias (desktop today) so a test
    // can import the module it covers. Resolved from the invoking package.
    alias: { "@": fileURLToPath(new URL("src/", `file://${process.cwd()}/`)) },
  },
});
