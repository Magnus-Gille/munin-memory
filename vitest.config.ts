import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["node_modules/**", "dist/**", "tmp/**", ".claude/**"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      reporter: ["text-summary", "json-summary"],
      // Ratchet floors: the #342 tests measured 90.12% statements, 85.50%
      // branches, 93.76% functions and 91.53% lines locally on Node 24.
      // Supported Node 22/24 CI must also pass these floors before readiness.
      // Raise with measured improvements; never lower to admit a regression.
      thresholds: {
        statements: 90,
        branches: 85,
        functions: 93,
        lines: 91.5,
      },
    },
  },
});
