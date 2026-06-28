/**
 * Tests that scope_namespace in BenchmarkQuery restricts retrieval to
 * the specified namespace for lexical search. Validates the per-question
 * haystack isolation added for LongMemEval.
 */

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase, writeState } from "../src/db.js";
import { executeQuery } from "../benchmark/runner.js";

describe("executeQuery — scope_namespace isolation", () => {
  let tmp: string;
  let dbPath: string;
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "runner-scope-"));
    dbPath = join(tmp, "scope-test.db");
    const dbInstance = initDatabase(dbPath);

    // Two namespaces with distinct content words.
    // haystack-a: "cat", "feline"
    // haystack-b: "dogs", "canine"
    writeState(dbInstance, "haystack-a", "s1", "The cat sat on the mat", []);
    writeState(dbInstance, "haystack-a", "s2", "Feline behaviour studies conducted", []);
    writeState(dbInstance, "haystack-b", "s3", "Dogs are loyal companions always", []);
    writeState(dbInstance, "haystack-b", "s4", "Canine training techniques explained", []);

    dbInstance.close();

    // Re-open read-only — executeQuery accepts an open db handle directly.
    db = new Database(dbPath, { readonly: true });
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("without scope_namespace returns results from both namespaces", async () => {
    // "cat" matches haystack-a; "dogs" matches haystack-b — two separate
    // unscoped queries confirm both namespaces are searchable.
    const { entries: ea } = await executeQuery(db, "cat", "lexical", 10);
    const { entries: eb } = await executeQuery(db, "dogs", "lexical", 10);
    expect(ea.length).toBeGreaterThan(0);
    expect(eb.length).toBeGreaterThan(0);
    const allNs = new Set([...ea.map((e) => e.namespace), ...eb.map((e) => e.namespace)]);
    expect(allNs.has("haystack-a")).toBe(true);
    expect(allNs.has("haystack-b")).toBe(true);
  });

  it("with scope_namespace restricts lexical results to haystack-a", async () => {
    // "cat" normally matches haystack-a; even querying "dogs" with scope haystack-a
    // should return nothing from haystack-b.
    const { entries: catHits } = await executeQuery(db, "cat", "lexical", 10, undefined, "haystack-a");
    expect(catHits.length).toBeGreaterThan(0);
    expect(catHits.every((e) => e.namespace === "haystack-a")).toBe(true);

    // "dogs" with scope haystack-a → 0 results (dogs not in haystack-a)
    const { entries: dogHits } = await executeQuery(db, "dogs", "lexical", 10, undefined, "haystack-a");
    expect(dogHits.every((e) => e.namespace === "haystack-a")).toBe(true);
    expect(dogHits.length).toBe(0);
  });

  it("scope_namespace of haystack-b excludes haystack-a entries", async () => {
    const { entries } = await executeQuery(db, "dogs", "lexical", 10, undefined, "haystack-b");
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.namespace === "haystack-b")).toBe(true);

    // "cat" with scope haystack-b → 0 results (cat not in haystack-b)
    const { entries: catHits } = await executeQuery(db, "cat", "lexical", 10, undefined, "haystack-b");
    expect(catHits.length).toBe(0);
  });
});
