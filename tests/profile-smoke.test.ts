import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initDatabase,
  writeState,
  appendLog,
  queryEntries,
  readState,
} from "../src/db.js";
import { resolveProfile, resolveKnob } from "../src/profiles.js";

/**
 * Constrained-profile CI smoke test (regression guard).
 *
 * Retires the munin-zero "sync core-only profile / deploy drift" pain: a
 * deterministic, OFFLINE test that brings up the core path under
 * MUNIN_PROFILE=zero-appliance and asserts:
 *   1. the server's core memory works: write/read a state entry, append a log,
 *      and run a lexical query — the operations a zero-appliance box must serve.
 *   2. the resolved memory knobs actually TAKE EFFECT — the SQLite page cache
 *      (cache_size) and mmap_size pragmas reflect the zero-appliance profile,
 *      not the library defaults.
 *
 * Deliberately does NOT load the embedding model (that needs the cached weights
 * and is not part of the "core path serves memory" guarantee). The profile's
 * semantic posture is asserted via the pure resolver, keeping this test fast,
 * offline, and deterministic — safe inside the coverage-ratchet floors.
 */

/** All env vars that MUNIN_PROFILE resolution can override. */
const PROFILE_CONTROLLED_KNOBS = [
  "MUNIN_SQLITE_CACHE_KIB",
  "MUNIN_SQLITE_MMAP_BYTES",
  "MUNIN_EMBEDDINGS_DTYPE",
  "MUNIN_EMBEDDINGS_BATCH_SIZE",
  "MUNIN_EMBEDDINGS_ENABLED",
] as const;

describe("MUNIN_PROFILE=zero-appliance — core path smoke test", () => {
  let tmpDir: string;
  let dbPath: string;
  let prevProfile: string | undefined;
  // Saved copies of any profile-controlled knobs that were set before the test.
  const savedKnobs: Partial<Record<string, string>> = {};

  beforeEach(() => {
    // 1. Save and delete all profile-controlled explicit knobs so the profile
    //    drives resolution — not whatever a dev/CI box happens to have set.
    for (const key of PROFILE_CONTROLLED_KNOBS) {
      savedKnobs[key] = process.env[key];
      delete process.env[key];
    }
    // 2. Set the profile.
    prevProfile = process.env.MUNIN_PROFILE;
    process.env.MUNIN_PROFILE = "zero-appliance";
    tmpDir = mkdtempSync(join(tmpdir(), "munin-profile-smoke-"));
    dbPath = join(tmpDir, "memory.db");
  });

  afterEach(() => {
    // Restore profile.
    if (prevProfile === undefined) delete process.env.MUNIN_PROFILE;
    else process.env.MUNIN_PROFILE = prevProfile;
    // Restore all profile-controlled knobs.
    for (const key of PROFILE_CONTROLLED_KNOBS) {
      if (savedKnobs[key] === undefined) delete process.env[key];
      else process.env[key] = savedKnobs[key];
    }
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });

  it("brings up the DB and serves core memory: write → read + lexical query", () => {
    const db = initDatabase(dbPath);
    try {
      // write/read a state entry
      writeState(db, "projects/zero", "status", "Zero appliance core path is live.", [
        "active",
      ]);
      const back = readState(db, "projects/zero", "status");
      expect(back?.content).toBe("Zero appliance core path is live.");

      // append a log entry (append-only history)
      appendLog(db, "projects/zero", "Deployed core-only profile to the appliance.", [
        "milestone",
      ]);

      // lexical query finds the content (no embeddings required)
      const hits = queryEntries(db, { query: "appliance", limit: 10 });
      const namespaces = hits.map((e) => e.namespace);
      expect(namespaces).toContain("projects/zero");
    } finally {
      db.close();
    }
  });

  it("resolved memory knobs take effect: cache_size + mmap_size match the profile", () => {
    const db = initDatabase(dbPath);
    try {
      // zero-appliance sets MUNIN_SQLITE_CACHE_KIB=1024 → cache_size = -1024
      // (SQLite stores a negative cache_size in KiB). Verify the pragma applied.
      const cacheSize = db.pragma("cache_size", { simple: true });
      expect(cacheSize).toBe(-1024);

      // zero-appliance sets MUNIN_SQLITE_MMAP_BYTES=0 → mmap disabled.
      const mmapSize = db.pragma("mmap_size", { simple: true });
      expect(mmapSize).toBe(0);
    } finally {
      db.close();
    }
  });

  it("explicit env var still overrides the profile (precedence preserved at runtime)", () => {
    const prevCache = process.env.MUNIN_SQLITE_CACHE_KIB;
    process.env.MUNIN_SQLITE_CACHE_KIB = "2048";
    try {
      const db = initDatabase(dbPath);
      try {
        // explicit env wins over the profile's 1024 → cache_size = -2048
        const cacheSize = db.pragma("cache_size", { simple: true });
        expect(cacheSize).toBe(-2048);
      } finally {
        db.close();
      }
    } finally {
      if (prevCache === undefined) delete process.env.MUNIN_SQLITE_CACHE_KIB;
      else process.env.MUNIN_SQLITE_CACHE_KIB = prevCache;
    }
  });

  it("profile posture: zero-appliance keeps semantic ON via q8 (resolver agrees)", () => {
    const p = resolveProfile("zero-appliance");
    expect(p.semantic).toBe(true);
    expect(resolveKnob("MUNIN_EMBEDDINGS_DTYPE", undefined)).toBe("q8");
    expect(resolveKnob("MUNIN_EMBEDDINGS_BATCH_SIZE", "25")).toBe("1");
  });
});
