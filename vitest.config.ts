import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["node_modules/**", "dist/**", "tmp/**", ".claude/**"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      reporter: ["text-summary", "json-summary"],
      // Ratchet floors, set just below measured coverage (2026-06-29: 88.69% stmts,
      // 83.7% branches, 91.74% funcs, 89.78% lines). Raise them when coverage
      // rises; never lower them to admit a regression.
      thresholds: {
        statements: 87,
        branches: 82,
        functions: 90,
        lines: 88,
      },
    },
  },
});
