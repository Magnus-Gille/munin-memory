import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["node_modules/**", "dist/**", "tmp/**", ".claude/**"],
    // Several suites build 200–4,096-row fixtures or spawn the quickstart CLI.
    // They finish quickly on an idle machine but exceeded the 5 s default on a
    // loaded developer host (load 26–46 on 10 cores, #415): 5–16 spurious
    // timeouts per full run, none reproducible in isolation. A higher ceiling
    // only changes when a hung test is reported; assertions and tighter
    // per-test timeouts are unchanged.
    testTimeout: 20_000,
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
