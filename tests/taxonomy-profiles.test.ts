import { describe, it, expect } from "vitest";
import {
  TAXONOMY_PROFILES,
  getTaxonomyProfile,
  listProfileNames,
  materializeProfile,
} from "../src/taxonomy-profiles.js";

describe("taxonomy profiles", () => {
  it("lists the seed-pack names", () => {
    expect(listProfileNames().sort()).toEqual([
      "freelancer",
      "household",
      "personal-knowledge",
      "researcher",
    ]);
  });

  it("getTaxonomyProfile returns a known profile and undefined for unknown", () => {
    expect(getTaxonomyProfile("household")?.name).toBe("household");
    expect(getTaxonomyProfile("nope")).toBeUndefined();
  });

  it("every profile's templates use the {home} token", () => {
    for (const p of Object.values(TAXONOMY_PROFILES)) {
      expect(p.conventions).toContain("{home}");
      expect(p.trackedPatterns.length).toBeGreaterThan(0);
      for (const tp of p.trackedPatterns) expect(tp).toContain("{home}");
    }
  });

  it("materializeProfile substitutes {home} with a scoped principal's prefix", () => {
    const m = materializeProfile(getTaxonomyProfile("household")!, "users/sara");
    expect(m.trackedPatterns).toContain("users/sara/home/*");
    expect(m.trackedPatterns.every((p) => !p.includes("{home}"))).toBe(true);
    expect(m.conventions).toContain("users/sara/home");
    expect(m.conventions).not.toContain("{home}");
  });

  it("materializeProfile with empty home yields root namespaces (owner instance)", () => {
    const m = materializeProfile(getTaxonomyProfile("freelancer")!, "");
    expect(m.trackedPatterns).toEqual(["projects/*", "clients/*"]);
    expect(m.conventions).not.toContain("{home}");
  });
});
