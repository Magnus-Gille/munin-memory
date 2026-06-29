import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["node_modules/**", "dist/**", "tmp/**", ".claude/**"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      reporter: ["text-summary", "json-summary"],
      // Ratchet floors, set just below measured coverage (2026-06-29: 89.06% stmts,
      // 83.95% branches, 91.94% funcs, 90.13% lines — raised after M1-M5 health fixes).
      // Raise them when coverage rises; never lower them to admit a regression.
      thresholds: {
        statements: 89,
        branches: 83,
        functions: 91,
        lines: 90,
      },
    },
  },
});
