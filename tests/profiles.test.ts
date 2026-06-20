import { describe, it, expect } from "vitest";
import {
  resolveProfile,
  resolveKnob,
  PROFILE_NAMES,
  type ProfileName,
} from "../src/profiles.js";

/**
 * Profile resolver tests — written FIRST (red/green TDD).
 *
 * Asserts:
 *   1. Each tier resolves to the knob values + feature posture chosen from the
 *      2026-06-18 RAM-fit sweep (see benchmark/ramfit/FINDINGS.md).
 *   2. resolveKnob() precedence: explicit env var > profile default > hard default.
 *   3. An UNSET / unknown profile changes nothing — resolveKnob falls through to
 *      exactly `env ?? hardDefault`, preserving byte-for-byte current behavior.
 */

describe("resolveProfile — tier defaults from the RAM-fit sweep", () => {
  it("exposes exactly the three approved tier names", () => {
    expect([...PROFILE_NAMES].sort()).toEqual(
      ["full-node", "zero-appliance", "zero-plus"].sort(),
    );
  });

  it("zero-appliance: semantic ON via q8 MiniLM (fits 128m, anon ~85MB), lean knobs", () => {
    const p = resolveProfile("zero-appliance");
    // Tonight's sweep proved q8 MiniLM semantic fits well below the 320m floor
    // (anon ~74-87MB, fit at 128m for both query and write). So the cheapest
    // primary tier keeps semantic ON with quantised weights and lean memory.
    expect(p.knobs.MUNIN_EMBEDDINGS_ENABLED).toBe("true");
    expect(p.knobs.MUNIN_EMBEDDINGS_DTYPE).toBe("q8");
    expect(p.knobs.MUNIN_EMBEDDINGS_BATCH_SIZE).toBe("1");
    expect(p.knobs.MUNIN_SQLITE_CACHE_KIB).toBe("1024");
    expect(p.knobs.MUNIN_SQLITE_MMAP_BYTES).toBe("0");
    expect(p.semantic).toBe(true);
  });

  it("zero-plus: semantic ON, slightly more headroom (Pi 5 2GB class)", () => {
    const p = resolveProfile("zero-plus");
    expect(p.knobs.MUNIN_EMBEDDINGS_ENABLED).toBe("true");
    expect(p.knobs.MUNIN_EMBEDDINGS_DTYPE).toBe("q8");
    expect(p.knobs.MUNIN_EMBEDDINGS_BATCH_SIZE).toBe("4");
    expect(p.knobs.MUNIN_SQLITE_CACHE_KIB).toBe("4096");
    expect(p.knobs.MUNIN_SQLITE_MMAP_BYTES).toBe("0");
    expect(p.semantic).toBe(true);
  });

  it("full-node: full-fidelity fp32 semantic, no memory clamps (preserve defaults)", () => {
    const p = resolveProfile("full-node");
    expect(p.knobs.MUNIN_EMBEDDINGS_ENABLED).toBe("true");
    // full-node keeps library-default precision (fp32) — resolver leaves DTYPE
    // unset so the existing hard default wins.
    expect(p.knobs.MUNIN_EMBEDDINGS_DTYPE).toBeUndefined();
    // full-node does not clamp SQLite memory — leaves cache/mmap unset.
    expect(p.knobs.MUNIN_SQLITE_CACHE_KIB).toBeUndefined();
    expect(p.knobs.MUNIN_SQLITE_MMAP_BYTES).toBeUndefined();
    expect(p.semantic).toBe(true);
  });

  it("unknown / unset profile resolves to an empty knob set and no posture", () => {
    expect(resolveProfile(undefined)).toEqual({ knobs: {}, semantic: null });
    expect(resolveProfile("")).toEqual({ knobs: {}, semantic: null });
    expect(resolveProfile("not-a-profile")).toEqual({ knobs: {}, semantic: null });
  });
});

describe("resolveKnob — precedence: env var > profile default > hard default", () => {
  it("explicit env var wins over the profile default", () => {
    const env = { MUNIN_EMBEDDINGS_DTYPE: "int8", MUNIN_PROFILE: "zero-appliance" };
    expect(
      resolveKnob("MUNIN_EMBEDDINGS_DTYPE", "fp32-hard-default", env),
    ).toBe("int8");
  });

  it("profile default wins when the env var is unset", () => {
    const env = { MUNIN_PROFILE: "zero-appliance" };
    // zero-appliance sets DTYPE=q8
    expect(
      resolveKnob("MUNIN_EMBEDDINGS_DTYPE", undefined, env),
    ).toBe("q8");
  });

  it("hard default wins when neither env var nor profile sets the knob", () => {
    const env = { MUNIN_PROFILE: "full-node" };
    // full-node leaves DTYPE unset → hard default flows through
    expect(
      resolveKnob("MUNIN_EMBEDDINGS_DTYPE", "fallback", env),
    ).toBe("fallback");
  });

  it("UNSET profile is byte-for-byte the old `env ?? hardDefault` behavior", () => {
    // No MUNIN_PROFILE at all.
    const envWithVar = { MUNIN_SQLITE_CACHE_KIB: "2048" };
    expect(resolveKnob("MUNIN_SQLITE_CACHE_KIB", undefined, envWithVar)).toBe("2048");

    const envEmpty: Record<string, string | undefined> = {};
    expect(resolveKnob("MUNIN_SQLITE_CACHE_KIB", undefined, envEmpty)).toBeUndefined();
    expect(resolveKnob("MUNIN_SQLITE_CACHE_KIB", "4096", envEmpty)).toBe("4096");
  });

  it("empty-string env var is treated as set (matches existing `?? ` semantics only for undefined)", () => {
    // The existing code uses `process.env.X ?? default`, which treats "" as a
    // present value. resolveKnob must preserve that: an explicit empty string
    // from the environment is returned as-is (the caller decides how to handle it).
    const env = { MUNIN_EMBEDDINGS_DTYPE: "", MUNIN_PROFILE: "zero-appliance" };
    expect(resolveKnob("MUNIN_EMBEDDINGS_DTYPE", "hard", env)).toBe("");
  });

  it("falls back to process.env when no env object is passed", () => {
    const prev = process.env.MUNIN_PROFILE;
    const prevDtype = process.env.MUNIN_EMBEDDINGS_DTYPE;
    try {
      delete process.env.MUNIN_EMBEDDINGS_DTYPE;
      process.env.MUNIN_PROFILE = "zero-appliance";
      expect(resolveKnob("MUNIN_EMBEDDINGS_DTYPE", undefined)).toBe("q8");
    } finally {
      if (prev === undefined) delete process.env.MUNIN_PROFILE;
      else process.env.MUNIN_PROFILE = prev;
      if (prevDtype === undefined) delete process.env.MUNIN_EMBEDDINGS_DTYPE;
      else process.env.MUNIN_EMBEDDINGS_DTYPE = prevDtype;
    }
  });
});

describe("ProfileName type surface", () => {
  it("PROFILE_NAMES is the canonical list", () => {
    const names: readonly ProfileName[] = PROFILE_NAMES;
    expect(names).toContain("zero-appliance");
    expect(names).toContain("zero-plus");
    expect(names).toContain("full-node");
  });
});
