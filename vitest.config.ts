import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["node_modules/**", "dist/**", "tmp/**", ".claude/**"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      reporter: ["text-summary", "json-summary"],
      // Ratchet floors: supported Node 22/24 CI measured 90.05% statements,
      // 85.41% branches, 93.76% functions and 91.48% lines for #342, unchanged
      // from #389. Local Node 24 lines were 91.53%; use the hosted matrix floor.
      // Raise with measured improvements; never lower to admit a regression.
      thresholds: {
        statements: 90,
        branches: 85,
        functions: 93,
        lines: 91.4,
      },
    },
  },
});
