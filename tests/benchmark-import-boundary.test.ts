/**
 * Load-bearing import boundary test (updated for issue #59).
 *
 * The benchmark runner imports the reranker pipeline from the dedicated
 * module `src/internal/reranker.ts` (extracted in issue #59). This test
 * enforces two constraints:
 *
 * 1. benchmark/ must NOT import any of the curated reranker names from
 *    `src/tools.ts` — they now live in `src/internal/reranker.ts`.
 * 2. benchmark/ may import from `src/internal/reranker.ts`, but only the
 *    curated surface defined below.
 *
 * Update the allow-lists if the reranker surface changes, and keep the
 * wildcard-import rejection in place.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const BENCHMARK_DIR = resolve(__dirname, "..", "benchmark");

/**
 * Names the benchmark surface is allowed to import from
 * src/internal/reranker.js (the dedicated module extracted in issue #59).
 * Anything else is a lint failure — either remove the new dependency or
 * add the name to the reranker's public surface and update this list.
 */
const ALLOWED_RERANKER_IMPORTS = new Set<string>([
  "buildRelaxedLexicalQuery",
  "QUERY_RERANK_OVERFETCH_MULTIPLIER",
  "DEFAULT_SEARCH_RECENCY_WEIGHT",
  "shouldApplyDefaultQuerySuppression",
  "getTrackedStatusAssessments",
  "injectCanonicalQueryEntries",
  "injectAttentionQueryEntries",
  "rerankQueryResults",
]);

function walkTypeScriptFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const st = statSync(path);
    if (st.isDirectory()) {
      // Skip generated and downloaded data — they don't host source.
      if (entry === "node_modules" || entry === "data" || entry === "generated" || entry === "fixtures" || entry === "reports") {
        continue;
      }
      walkTypeScriptFiles(path, out);
    } else if (entry.endsWith(".ts")) {
      out.push(path);
    }
  }
  return out;
}

interface ImportRecord {
  from: string;
  /** Named imports — empty for star/default. */
  names: string[];
  /** Star (`import * as x`) and default (`import x from`) imports are
   * sweeping aliases: they implicitly pull every export off the target
   * module, so even one of them on `src/tools.js` blows the curated
   * surface wide open. Flag separately so the assertion can reject
   * them outright instead of relying on the named-import allow-list. */
  wildcard: boolean;
}

/**
 * Parse import statements out of a TypeScript source string.
 *
 * Handles named imports, namespace (`import * as ...`) imports, and
 * default imports. Mixed forms like `import def, { a, b } from "..."`
 * are reported as both — the named names are collected and `wildcard`
 * is set (the default binding counts as a sweeping alias).
 *
 * Naive but sufficient for this allow-list: we only care about imports
 * from a specific module, and `prettier` formats benchmark/ enough that
 * we never have to worry about adversarial whitespace.
 */
function extractImports(source: string): ImportRecord[] {
  const out: ImportRecord[] = [];

  // Named or mixed default+named:  import [Foo,] { a, b as c } from "x";
  // Captures optional default binding before the braced list.
  const named = /import\s+(?:type\s+)?(?:([A-Za-z_$][\w$]*)\s*,\s*)?\{\s*([^}]+)\s*\}\s+from\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = named.exec(source)) !== null) {
    const names = m[2]
      .split(",")
      .map((s) => s.trim())
      .map((s) => s.split(/\s+as\s+/)[0].trim())
      .map((s) => s.replace(/^type\s+/, "").trim())
      .filter((s) => s.length > 0);
    out.push({ from: m[3], names, wildcard: Boolean(m[1]) });
  }

  // Pure star alias:  import * as tools from "x";
  const star = /import\s+(?:type\s+)?\*\s+as\s+[A-Za-z_$][\w$]*\s+from\s+["']([^"']+)["']/g;
  while ((m = star.exec(source)) !== null) {
    out.push({ from: m[1], names: [], wildcard: true });
  }

  // Pure default:  import tools from "x";
  // Use a negative lookahead to avoid double-matching the `default + named`
  // form already captured above (those start with `import Foo, {`).
  const def = /import\s+(?:type\s+)?([A-Za-z_$][\w$]*)\s+from\s+["']([^"']+)["']/g;
  while ((m = def.exec(source)) !== null) {
    out.push({ from: m[2], names: [], wildcard: true });
  }

  return out;
}

describe("extractImports — lint primitive", () => {
  it("captures named imports including aliases and type modifier", () => {
    const src = `import { foo, bar as baz, type qux } from "x";`;
    const records = extractImports(src);
    expect(records).toHaveLength(1);
    expect(records[0].from).toBe("x");
    expect(records[0].names.sort()).toEqual(["bar", "foo", "qux"].sort());
    expect(records[0].wildcard).toBe(false);
  });

  it("flags star imports as wildcards (M2 from PR 2b review)", () => {
    const src = `import * as tools from "../src/tools.js";`;
    const records = extractImports(src);
    expect(records).toHaveLength(1);
    expect(records[0].wildcard).toBe(true);
    expect(records[0].names).toEqual([]);
  });

  it("flags default imports as wildcards", () => {
    const src = `import tools from "../src/tools.js";`;
    const records = extractImports(src);
    // The default-import regex may match — but the assertion only cares
    // that at least one record on `../src/tools.js` is flagged wildcard.
    const toolsImports = records.filter((r) => r.from === "../src/tools.js");
    expect(toolsImports.some((r) => r.wildcard)).toBe(true);
  });

  it("captures mixed default + named as both", () => {
    const src = `import tools, { foo } from "../src/tools.js";`;
    const records = extractImports(src);
    expect(records).toHaveLength(1);
    expect(records[0].wildcard).toBe(true);
    expect(records[0].names).toEqual(["foo"]);
  });
});

describe("benchmark/ → src/tools.ts import boundary", () => {
  it("benchmark/ does not import any reranker names from src/tools", () => {
    const files = walkTypeScriptFiles(BENCHMARK_DIR);
    const violations: Array<{ file: string; name: string }> = [];

    for (const file of files) {
      const src = readFileSync(file, "utf-8");
      const imports = extractImports(src);
      for (const imp of imports) {
        // Match the various relative paths benchmark/ uses to reach
        // src/tools(.js). Direct file imports only — package imports
        // never resolve into the tools module.
        const isToolsImport = /(?:^|\/)src\/tools(?:\.js)?$/.test(imp.from)
          || imp.from === "../src/tools.js"
          || imp.from === "../../src/tools.js"
          || imp.from === "../../../src/tools.js";
        if (!isToolsImport) continue;
        // Star and default imports are categorically forbidden.
        if (imp.wildcard) {
          violations.push({ file, name: "<star-or-default import>" });
        }
        // The reranker names must now be imported from src/internal/reranker.js,
        // not from src/tools.js. Any such import here is a boundary violation.
        for (const name of imp.names) {
          if (ALLOWED_RERANKER_IMPORTS.has(name)) {
            violations.push({ file, name });
          }
        }
      }
    }

    if (violations.length > 0) {
      const summary = violations
        .map((v) => `  ${v.file.replace(BENCHMARK_DIR, "benchmark")}: imports ${v.name}`)
        .join("\n");
      throw new Error(
        `Benchmark imports reranker names from src/tools.ts (should use src/internal/reranker.ts):\n${summary}\n\n` +
          `The reranker pipeline now lives in src/internal/reranker.ts (issue #59). ` +
          `Update the benchmark import to use "../src/internal/reranker.js".`,
      );
    }
    expect(violations).toEqual([]);
  });

  it("benchmark/ only imports the curated reranker surface from src/internal/reranker", () => {
    const files = walkTypeScriptFiles(BENCHMARK_DIR);
    const violations: Array<{ file: string; name: string }> = [];

    for (const file of files) {
      const src = readFileSync(file, "utf-8");
      const imports = extractImports(src);
      for (const imp of imports) {
        // Match paths that resolve to src/internal/reranker(.js).
        const isRerankerImport = /(?:^|\/)src\/internal\/reranker(?:\.js)?$/.test(imp.from)
          || imp.from === "../src/internal/reranker.js"
          || imp.from === "../../src/internal/reranker.js"
          || imp.from === "../../../src/internal/reranker.js";
        if (!isRerankerImport) continue;
        // Star and default imports are categorically forbidden: they
        // pull every export off the module and trivially bypass the allow-list.
        if (imp.wildcard) {
          violations.push({ file, name: "<star-or-default import>" });
        }
        for (const name of imp.names) {
          if (!ALLOWED_RERANKER_IMPORTS.has(name)) {
            violations.push({ file, name });
          }
        }
      }
    }

    if (violations.length > 0) {
      const summary = violations
        .map((v) => `  ${v.file.replace(BENCHMARK_DIR, "benchmark")}: imports ${v.name}`)
        .join("\n");
      throw new Error(
        `Benchmark surface imports unapproved names from src/internal/reranker.ts:\n${summary}\n\n` +
          `If the new dependency is legitimate, add the name to ALLOWED_RERANKER_IMPORTS ` +
          `in tests/benchmark-import-boundary.test.ts. If not, refactor the benchmark to not need it.`,
      );
    }
    expect(violations).toEqual([]);
  });
});
