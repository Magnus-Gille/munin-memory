import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["node_modules/**", "dist/**", "tmp/**", ".claude/**"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      reporter: ["text-summary", "json-summary"],
      // Ratchet floors, set a safe notch BELOW CI-measured coverage (CI 2026-06-29,
      // Node 20+22: 88.97% stmts, 83.78% branches, 91.94% funcs, 90.08% lines — after
      // M1-M5 health fixes). Floors sit below CI (not flush against a local reading) so
      // cross-env instrumentation variance can't red the gate. Still a ratchet up from
      // the pre-health baseline (86/81/89/87). Raise when coverage rises; never lower
      // to admit a regression.
      thresholds: {
        statements: 88.5,
        branches: 83,
        functions: 91,
        lines: 89.5,
      },
    },
  },
});
