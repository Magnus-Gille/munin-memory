// Intentionally minimal, bug-focused lint — NOT a style config.
// We enable only a few high-signal, type-aware rules (chiefly dropped-await
// detection across the async DB / embedding / consolidation / OAuth code).
// Formatting and stylistic concerns are deliberately left to convention.
//
// Scope is src/ only: that is the runtime path where a floating Promise
// corrupts state or drops an error. Test files are type-checked separately
// via `npm run typecheck` (tsconfig.test.json).
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "tests/**", "benchmark/**", "scripts/**", "*.config.js"],
  },
  {
    files: ["src/**/*.ts"],
    extends: [tseslint.configs.base],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // A dropped Promise in the worker/DB/OAuth paths is a real corruption/race risk.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
    },
  },
);
