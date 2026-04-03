import { describe, expect, it } from "vitest";
import {
  CLASSIFICATION_LEVELS,
  compareClassificationLevels,
  getLibrarianConfigWarnings,
  parseExplicitClassification,
  resolveNamespaceClassificationFloorFromRows,
  resolveStoredClassification,
} from "../src/librarian.js";

describe("compareClassificationLevels", () => {
  it("covers all pairwise rank comparisons", () => {
    const expectedRanks = new Map(CLASSIFICATION_LEVELS.map((level, index) => [level, index]));

    for (const left of CLASSIFICATION_LEVELS) {
      for (const right of CLASSIFICATION_LEVELS) {
        expect(compareClassificationLevels(left, right)).toBe(
          expectedRanks.get(left)! - expectedRanks.get(right)!,
        );
      }
    }
  });
});

describe("resolveNamespaceClassificationFloorFromRows", () => {
  const rows = [
    { namespace_pattern: "projects/*", min_classification: "internal" as const },
    { namespace_pattern: "projects/client-work/*", min_classification: "client-confidential" as const },
    { namespace_pattern: "projects/restricted/*", min_classification: "client-confidential" as const },
    { namespace_pattern: "projects/very-private/*", min_classification: "client-restricted" as const },
  ];

  it("uses the longest matching prefix", () => {
    expect(resolveNamespaceClassificationFloorFromRows("projects/client-work/foo", rows)).toBe("client-confidential");
    expect(resolveNamespaceClassificationFloorFromRows("projects/random", rows)).toBe("internal");
  });

  it("fails closed when equally specific patterns disagree", () => {
    const ambiguous = [
      { namespace_pattern: "shared/a/*", min_classification: "internal" as const },
      { namespace_pattern: "shared/b/*", min_classification: "client-confidential" as const },
      { namespace_pattern: "shared/*", min_classification: "internal" as const },
      { namespace_pattern: "shared/x/*", min_classification: "client-confidential" as const },
      { namespace_pattern: "shared/y/*", min_classification: "client-restricted" as const },
    ];

    expect(resolveNamespaceClassificationFloorFromRows("shared/y/doc", ambiguous)).toBe("client-restricted");
  });
});

describe("parseExplicitClassification", () => {
  it("accepts matching parameter and tag", () => {
    expect(parseExplicitClassification({
      classification: "client-confidential",
      tags: ["decision", "classification:client-confidential"],
    })).toBe("client-confidential");
  });

  it("rejects conflicting explicit classification sources", () => {
    expect(() => parseExplicitClassification({
      classification: "internal",
      tags: ["classification:public"],
    })).toThrow(/conflicts/);
  });

  it("rejects multiple classification tags", () => {
    expect(() => parseExplicitClassification({
      tags: ["classification:internal", "classification:public"],
    })).toThrow(/Multiple classification tags/);
  });
});

describe("resolveStoredClassification", () => {
  it("preserves an existing higher classification when no explicit override is provided", () => {
    const resolved = resolveStoredClassification({
      namespace: "projects/demo",
      namespaceFloor: "internal",
      existingClassification: "client-confidential",
    });
    expect(resolved.classification).toBe("client-confidential");
    expect(resolved.source).toBe("existing");
  });

  it("rejects explicit classifications below the namespace floor without override", () => {
    expect(() => resolveStoredClassification({
      namespace: "clients/acme",
      namespaceFloor: "client-confidential",
      explicitClassification: "public",
    })).toThrow(/below namespace floor/);
  });

  it("allows explicit below-floor classification when override is enabled", () => {
    const resolved = resolveStoredClassification({
      namespace: "clients/acme",
      namespaceFloor: "client-confidential",
      explicitClassification: "public",
      allowBelowFloorOverride: true,
    });
    expect(resolved.classification).toBe("public");
    expect(resolved.usedOverride).toBe(true);
  });
});

describe("getLibrarianConfigWarnings", () => {
  it("reports disabled enforcement and missing dpa-covered bearer access", () => {
    expect(getLibrarianConfigWarnings({
      transportMode: "http",
      librarianEnabled: false,
      hasLegacyBearerCredential: false,
      hasDpaBearerCredential: false,
      legacyBearerTransportType: "dpa_covered",
    })).toEqual([
      "MUNIN_LIBRARIAN_ENABLED is false; classification enforcement is disabled.",
      "No HTTP bearer credential currently resolves to dpa_covered; configure MUNIN_API_KEY_DPA or set MUNIN_API_KEY with MUNIN_BEARER_TRANSPORT_TYPE=dpa_covered.",
    ]);
  });

  it("returns no warnings when legacy bearer already provides dpa-covered access", () => {
    expect(getLibrarianConfigWarnings({
      transportMode: "http",
      librarianEnabled: true,
      hasLegacyBearerCredential: true,
      hasDpaBearerCredential: false,
      legacyBearerTransportType: "dpa_covered",
    })).toEqual([]);
  });

  it("warns when legacy bearer is configured as consumer and no dpa key exists", () => {
    expect(getLibrarianConfigWarnings({
      transportMode: "http",
      librarianEnabled: true,
      hasLegacyBearerCredential: true,
      hasDpaBearerCredential: false,
      legacyBearerTransportType: "consumer",
    })).toEqual([
      "No HTTP bearer credential currently resolves to dpa_covered; configure MUNIN_API_KEY_DPA or set MUNIN_API_KEY with MUNIN_BEARER_TRANSPORT_TYPE=dpa_covered.",
    ]);
  });
});
