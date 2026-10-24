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
      // Ratchet floors: supported Node 22/24 CI measured 90.39% statements,
      // 85.66% branches, 93.98% functions and 91.80% lines for the #396 quality
      // round (run 40101900171, up from 90.05/85.41/93.76/91.48 for #342).
      // Raise with measured improvements; never lower to admit a regression.
      thresholds: {
        statements: 90.3,
        branches: 85.6,
        functions: 93.9,
        lines: 91.7,
      },
    },
  },
});
