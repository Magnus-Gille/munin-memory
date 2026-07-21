import { describe, expect, it, vi, afterEach } from "vitest";
import {
  CLASSIFICATION_LEVELS,
  compareClassificationLevels,
  getLibrarianConfigWarnings,
  parseExplicitClassification,
  resolveNamespaceClassificationFloorFromRows,
  resolveStoredClassification,
  buildRedactedEntryResponse,
  filterSourcesByClassification,
  summarizeRedactedSources,
  buildLibrarianRuntimeSummary,
  checkWriteVisibility,
  enforceClassification,
  type RedactableEntryMetadata,
} from "../src/librarian.js";
import { ownerContext, type AccessContext } from "../src/access.js";

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

  // security: a case-variation namespace must not evade a lower-case floor
  // pattern and fall through to the (less restrictive) default. Mirrors the #96
  // cross-zone guard hardening so the write-path floor agrees with it.
  it("does not let case-variation evade a lower-case floor pattern", () => {
    const sensitive = [
      { namespace_pattern: "clients/*", min_classification: "client-confidential" as const },
      { namespace_pattern: "people/*", min_classification: "client-confidential" as const },
    ];
    // exact match (baseline)
    expect(resolveNamespaceClassificationFloorFromRows("clients/acme", sensitive)).toBe("client-confidential");
    // case-variation must resolve to the SAME restrictive floor, not the default
    expect(resolveNamespaceClassificationFloorFromRows("Clients/acme", sensitive)).toBe("client-confidential");
    expect(resolveNamespaceClassificationFloorFromRows("CLIENTS/acme", sensitive)).toBe("client-confidential");
    expect(resolveNamespaceClassificationFloorFromRows("People/Alice", sensitive)).toBe("client-confidential");
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

// --- Tests requiring MUNIN_LIBRARIAN_ENABLED=true ---
//
// Many Librarian functions gate on isLibrarianEnabled() (reads process.env).
// We set/restore the env var inline to avoid leaking state.

function withLibrarianEnabled<T>(fn: () => T): T {
  const original = process.env.MUNIN_LIBRARIAN_ENABLED;
  process.env.MUNIN_LIBRARIAN_ENABLED = "true";
  try {
    return fn();
  } finally {
    if (original === undefined) {
      delete process.env.MUNIN_LIBRARIAN_ENABLED;
    } else {
      process.env.MUNIN_LIBRARIAN_ENABLED = original;
    }
  }
}

function makeConsumerCtx(maxClassification: "public" | "internal" = "internal"): AccessContext {
  return {
    principalId: "consumer-agent",
    principalType: "agent",
    accessibleNamespaces: [{ pattern: "*", permissions: "rw" }],
    maxClassification,
    transportType: "consumer",
  };
}

function makeEntry(classification: RedactableEntryMetadata["classification"]): RedactableEntryMetadata {
  return {
    id: "test-entry-id",
    namespace: "projects/test",
    key: "status",
    entry_type: "state",
    classification,
    tags: ["active"],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

describe("buildRedactedEntryResponse", () => {
  it("returns owner-visible response with redaction reason for owner context", () => {
    const ctx = ownerContext();
    const entry = makeEntry("client-confidential");
    // Override transportType to consumer so owner can't read it
    const consumerOwnerCtx: AccessContext = { ...ctx, transportType: "consumer", maxClassification: "internal" };
    const response = buildRedactedEntryResponse(consumerOwnerCtx, entry);
    expect(response.redacted).toBe(true);
    expect(response.namespace).toBe("projects/test");
    expect(response.id).toBe("test-entry-id");
    expect(typeof response.redaction_reason).toBe("string");
    expect(response.entry_type).toBe("state");
  });

  it("includes key and tags in owner response when present", () => {
    const consumerOwnerCtx: AccessContext = {
      principalId: "owner",
      principalType: "owner",
      accessibleNamespaces: [],
      maxClassification: "internal",
      transportType: "consumer",
    };
    const entry = makeEntry("client-confidential");
    const response = buildRedactedEntryResponse(consumerOwnerCtx, entry);
    expect(response.key).toBe("status");
    expect(response.tags).toEqual(["active"]);
  });

  it("returns minimal response for non-owner context", () => {
    const ctx = makeConsumerCtx("internal");
    const entry = makeEntry("client-confidential");
    const response = buildRedactedEntryResponse(ctx, entry);
    // Non-owner gets minimal response (no id, key, etc.)
    expect(response.redacted).toBe(true);
    expect(response.namespace).toBe("projects/test");
    expect(response.id).toBeUndefined();
    expect(typeof response.redaction_reason).toBe("string");
  });
});

describe("enforceClassification", () => {
  it("allows access when librarian is disabled", () => {
    // isLibrarianEnabled() returns false by default (env not set)
    const ctx = makeConsumerCtx("public");
    const entry = makeEntry("client-restricted");
    const result = enforceClassification(ctx, entry);
    expect(result.allowed).toBe(true);
  });

  it("allows access when classification is within limit (librarian enabled)", () => {
    withLibrarianEnabled(() => {
      const ctx = makeConsumerCtx("internal");
      const entry = makeEntry("internal");
      const result = enforceClassification(ctx, entry);
      expect(result.allowed).toBe(true);
    });
  });

  it("blocks access when classification exceeds limit (librarian enabled)", () => {
    withLibrarianEnabled(() => {
      const ctx = makeConsumerCtx("public");
      const entry = makeEntry("internal");
      const result = enforceClassification(ctx, entry);
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.response).toBeDefined();
      }
    });
  });
});

describe("filterSourcesByClassification", () => {
  it("passes through all sources when librarian is disabled", () => {
    const ctx = makeConsumerCtx("public");
    const sources = [
      makeEntry("public"),
      makeEntry("internal"),
      makeEntry("client-restricted"),
    ];
    const result = filterSourcesByClassification(ctx, sources, (s) => s);
    expect(result.allowed.length).toBe(3);
    expect(result.redacted.length).toBe(0);
  });

  it("filters sources by classification when librarian is enabled", () => {
    withLibrarianEnabled(() => {
      const ctx = makeConsumerCtx("internal");
      const publicEntry = makeEntry("public");
      const internalEntry = { ...makeEntry("internal"), id: "internal-id" };
      const restrictedEntry = { ...makeEntry("client-confidential"), id: "restricted-id" };
      const result = filterSourcesByClassification(
        ctx,
        [publicEntry, internalEntry, restrictedEntry],
        (s) => s,
      );
      expect(result.allowed.length).toBe(2);
      expect(result.redacted.length).toBe(1);
      expect(result.redacted[0].metadata.id).toBe("restricted-id");
    });
  });
});

describe("summarizeRedactedSources", () => {
  it("returns undefined when librarian is disabled", () => {
    const ctx = makeConsumerCtx();
    const entries = [makeEntry("client-confidential")];
    const result = summarizeRedactedSources(ctx, entries);
    expect(result).toBeUndefined();
  });

  it("returns undefined when entries array is empty", () => {
    withLibrarianEnabled(() => {
      const ctx = makeConsumerCtx();
      const result = summarizeRedactedSources(ctx, []);
      expect(result).toBeUndefined();
    });
  });

  it("returns owner-specific summary with reason for owner context", () => {
    withLibrarianEnabled(() => {
      const ownerCtxConsumer: AccessContext = {
        principalId: "owner",
        principalType: "owner",
        accessibleNamespaces: [],
        maxClassification: "internal",
        transportType: "consumer",
      };
      const entries = [makeEntry("client-confidential"), makeEntry("client-restricted")];
      const result = summarizeRedactedSources(ownerCtxConsumer, entries);
      expect(result).toBeDefined();
      expect(result!.count).toBe(2);
      expect(result!.namespaces).toBeDefined();
      expect(typeof result!.reason).toBe("string");
    });
  });

  it("returns minimal summary for non-owner context", () => {
    withLibrarianEnabled(() => {
      const ctx = makeConsumerCtx("public");
      const entries = [makeEntry("internal")];
      const result = summarizeRedactedSources(ctx, entries);
      expect(result).toBeDefined();
      expect(result!.count).toBe(1);
      // Non-owner gets generic reason without namespace list details
      expect(typeof result!.reason).toBe("string");
    });
  });
});

describe("buildLibrarianRuntimeSummary", () => {
  it("returns basic summary without counts", () => {
    const ctx = ownerContext();
    const summary = buildLibrarianRuntimeSummary(ctx);
    expect(typeof summary.enabled).toBe("boolean");
    expect(typeof summary.transport_type).toBe("string");
    expect(typeof summary.max_classification).toBe("string");
    expect(summary.redacted_dashboard_count).toBeUndefined();
    expect(summary.redacted_source_count).toBeUndefined();
  });

  it("includes redacted counts when provided and non-zero", () => {
    const ctx = ownerContext();
    const summary = buildLibrarianRuntimeSummary(ctx, {
      redactedDashboardCount: 3,
      redactedSourceCount: 2,
    });
    expect(summary.redacted_dashboard_count).toBe(3);
    expect(summary.redacted_source_count).toBe(2);
  });

  it("omits counts when they are zero", () => {
    const ctx = ownerContext();
    const summary = buildLibrarianRuntimeSummary(ctx, {
      redactedDashboardCount: 0,
      redactedSourceCount: 0,
    });
    expect(summary.redacted_dashboard_count).toBeUndefined();
    expect(summary.redacted_source_count).toBeUndefined();
  });

  it("includes access_guidance for owner context", () => {
    const ctx = ownerContext();
    const summary = buildLibrarianRuntimeSummary(ctx);
    expect(typeof summary.access_guidance).toBe("string");
    expect(summary.access_guidance).toBeTruthy();
  });

  it("does not include access_guidance for non-owner context", () => {
    const ctx = makeConsumerCtx();
    const summary = buildLibrarianRuntimeSummary(ctx);
    expect(summary.access_guidance).toBeUndefined();
  });
});

describe("checkWriteVisibility", () => {
  it("always allows when librarian is disabled", () => {
    const ctx = makeConsumerCtx("public");
    const result = checkWriteVisibility(ctx, "client-restricted", "clients/test");
    expect(result.allowed).toBe(true);
  });

  it("allows writes within classification limit (librarian enabled)", () => {
    withLibrarianEnabled(() => {
      const ctx = makeConsumerCtx("internal");
      const result = checkWriteVisibility(ctx, "internal", "projects/test");
      expect(result.allowed).toBe(true);
    });
  });

  it("blocks writes exceeding classification limit (librarian enabled)", () => {
    withLibrarianEnabled(() => {
      const ctx = makeConsumerCtx("public");
      const result = checkWriteVisibility(ctx, "internal", "projects/test");
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(typeof result.error).toBe("string");
        expect(result.error).toContain("internal");
      }
    });
  });
});
