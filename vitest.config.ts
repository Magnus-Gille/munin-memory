import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["node_modules/**", "dist/**", "tmp/**", ".claude/**"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      reporter: ["text-summary", "json-summary"],
      // Ratchet floors, set just below measured coverage (2026-06: 88.5% stmts,
      // 84.0% branches, 91.6% funcs, 89.5% lines). Raise them when coverage
      // rises; never lower them to admit a regression.
      thresholds: {
        statements: 86,
        branches: 81,
        functions: 89,
        lines: 87,
      },
    },
  },
});
