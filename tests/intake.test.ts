import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ownerContext, type AccessContext } from "../src/access.js";
import {
  getNamespaceEntriesForIntake,
  getNamespaceStateEntries,
  initDatabase,
  readState,
  writeState,
} from "../src/db.js";
import {
  evaluateIntake,
  getPersistedIntake,
} from "../src/intake.js";
import { registerTools } from "../src/tools.js";

function parse(response: unknown): Record<string, unknown> {
  const result = response as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

function makeServer(
  db: Database.Database,
  ctx: AccessContext,
): (name: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>> {
  const server = new Server(
    { name: "test-munin-intake", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );
  registerTools(server, db, undefined, ctx);
  return async (name, args = {}) => {
    const handler = (
      server as unknown as { _requestHandlers: Map<string, Function> }
    )._requestHandlers?.get("tools/call");
    if (!handler) throw new Error("Cannot access tool handler");
    return parse(await handler({ method: "tools/call", params: { name, arguments: args } }));
  };
}

describe("advisory intake evaluator", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("accepts a meaningful first entry", () => {
    const result = evaluateIntake({
      namespace: "projects/new",
      key: "architecture",
      content:
        "Munin uses SQLite with FTS5 for local persistence and lexical retrieval.",
      tags: ["architecture"],
      candidates: [],
      now: "2026-07-23T07:00:00.000Z",
    });

    expect(result.status).toBe("accepted");
    expect(result.flags).toEqual([]);
    expect(result.metadata.intake_mode).toBe("advisory");
    expect(result.metadata.intake_timestamp).toBe("2026-07-23T07:00:00.000Z");
  });

  it("flags duplicate keys and deterministic near-duplicate content", () => {
    writeState(
      db,
      "projects/example",
      "architecture",
      "SQLite FTS5 provides local full text search and durable persistence for memory entries.",
      ["architecture"],
      "owner",
    );
    const candidates = getNamespaceStateEntries(db, "projects/example");

    const duplicate = evaluateIntake({
      namespace: "projects/example",
      key: "architecture",
      content:
        "SQLite FTS5 provides local full text search and durable persistence for memory entries.",
      tags: ["architecture"],
      candidates,
    });
    expect(duplicate.flags.map((flag) => flag.check)).toContain("duplicate_key");

    const overlap = evaluateIntake({
      namespace: "projects/example",
      key: "database",
      content:
        "SQLite FTS5 provides local full text search and durable persistence for memory entries.",
      tags: ["architecture"],
      candidates,
    });
    expect(overlap.flags.map((flag) => flag.check)).toEqual(
      expect.arrayContaining(["content_overlap", "consolidation_candidate"]),
    );
    expect(overlap.metadata.redundancy_flag?.existing_key).toBe("architecture");
  });

  /**
   * The tag-vocabulary check only runs once a namespace has an established
   * vocabulary, so seeding it takes more than a couple of entries.
   */
  function seedEstablishedNamespace(namespace = "projects/example"): void {
    const seeds: Array<[string, string, string[]]> = [
      ["architecture", "Architecture decision record with enough meaningful implementation context.", ["architecture", "decision"]],
      ["storage", "Storage design notes with durable persistence and recovery boundaries.", ["architecture", "storage"]],
      ["retrieval", "Retrieval design notes covering lexical ranking and fusion behaviour.", ["architecture", "storage"]],
      ["rollout", "Rollout notes describing staged deployment across the appliance fleet.", ["storage"]],
      ["operations", "Operational runbook covering backup verification and restore drills.", ["storage"]],
      ["review", "Review notes capturing the cross-model critique of the storage design.", ["architecture"]],
    ];
    for (const [key, content, tags] of seeds) {
      writeState(db, namespace, key, content, tags, "owner");
    }
  }

  it("flags sparse content, deep namespaces, and novel tag vocabularies", () => {
    seedEstablishedNamespace();

    const result = evaluateIntake({
      namespace: "projects/example/too/deep",
      key: "x",
      content: "hi",
      tags: ["zebra", "quantum"],
      candidates: getNamespaceStateEntries(db, "projects/example"),
    });

    expect(result.flags.map((flag) => flag.check)).toEqual(
      expect.arrayContaining(["low_relevance", "namespace_depth", "tag_inconsistency"]),
    );
    expect(result.status).toBe("flagged");
  });

  it("never reports a documented canonical tag as new to a namespace", () => {
    seedEstablishedNamespace();
    const candidates = getNamespaceStateEntries(db, "projects/example");

    // `milestone` is published in memory_log's own tag vocabulary, and no
    // seeded entry carries it — the old check called that an inconsistency.
    for (const tag of ["milestone", "decision", "blocker", "active", "research"]) {
      const result = evaluateIntake({
        namespace: "projects/example",
        key: null,
        content: "Shipped the offsite backup verification drill and recorded the outcome.",
        tags: [tag],
        candidates,
      });
      expect(
        result.flags.map((flag) => flag.check),
        `canonical tag "${tag}" must not be flagged`,
      ).not.toContain("tag_inconsistency");
    }
  });

  it("does not report tag inconsistency before a namespace has a vocabulary", () => {
    // Three entries: past the old threshold of 2, below the new minimum. A
    // handful of entries is not yet a convention worth policing.
    writeState(
      db,
      "projects/fresh",
      "status",
      "Phase: kickoff. Current work: standing up the initial project skeleton.",
      ["active"],
      "owner",
    );
    writeState(
      db,
      "projects/fresh",
      "architecture",
      "Initial architecture sketch covering storage and retrieval boundaries.",
      ["architecture"],
      "owner",
    );
    writeState(
      db,
      "projects/fresh",
      "plan",
      "Delivery plan describing the first two milestones and their exit criteria.",
      ["architecture"],
      "owner",
    );

    const result = evaluateIntake({
      namespace: "projects/fresh",
      key: null,
      content: "Chose SQLite over Postgres for the appliance profile after benchmarking.",
      tags: ["zebra", "quantum"],
      candidates: getNamespaceStateEntries(db, "projects/fresh"),
    });

    expect(result.flags.map((flag) => flag.check)).not.toContain("tag_inconsistency");
  });

  it("still flags genuinely novel freeform tags once a vocabulary exists", () => {
    seedEstablishedNamespace();

    const result = evaluateIntake({
      namespace: "projects/example",
      key: null,
      content: "Recorded the quarterly capacity planning outcome for the appliance fleet.",
      // One canonical tag alongside genuinely ad-hoc vocabulary: the canonical
      // tag must not dilute the ratio into silence.
      tags: ["milestone", "zebra", "quantum"],
      candidates: getNamespaceStateEntries(db, "projects/example"),
    });

    const inconsistency = result.flags.find((flag) => flag.check === "tag_inconsistency");
    expect(inconsistency).toBeDefined();
    expect(inconsistency?.message).toContain("zebra");
    expect(inconsistency?.message).toContain("quantum");
    expect(inconsistency?.message).not.toContain("milestone");
  });

  it("bounds candidate content before loading it from SQLite", () => {
    writeState(
      db,
      "projects/example",
      "large",
      "x".repeat(20_000),
      [],
      "owner",
    );

    const { entries } = getNamespaceEntriesForIntake(
      db,
      "projects/example",
      "client-restricted",
    );

    expect(entries[0].content).toHaveLength(8_000);
  });

  it("reports a capped sample and describes tag novelty relative to that sample", () => {
    const namespace = "projects/intake-capped";
    writeState(db, namespace, "old-tag", "Older content with a unique vocabulary.", ["zebra"], "owner");
    for (let index = 0; index < 101; index += 1) {
      writeState(db, namespace, `recent-${index}`, `Recent candidate ${index} has ordinary content.`, ["architecture"], "owner");
    }

    const sample = getNamespaceEntriesForIntake(db, namespace, "client-restricted");
    const result = evaluateIntake({
      namespace,
      key: null,
      content: "A useful durable description with adequate detail for future retrieval.",
      tags: ["zebra"],
      candidates: sample.entries,
      candidateSample: { truncated: sample.truncated },
    });

    expect(sample.entries).toHaveLength(100);
    expect(sample.truncated).toBe(true);
    expect(result.metadata).toMatchObject({
      candidate_count: 100,
      candidate_cap: 100,
      candidates_truncated: true,
    });
    const tagFlag = result.flags.find((flag) => flag.check === "tag_inconsistency");
    expect(tagFlag?.message).toContain("evaluated sample");
    expect(tagFlag?.message).toContain("sample is incomplete");
    expect(tagFlag?.message).not.toContain("new to namespace");
  });

  it("applies internal exclusions before the sample sentinel", () => {
    const namespace = "projects/intake-sentinel";
    const ids: string[] = [];
    for (let index = 0; index < 102; index += 1) {
      ids.push(writeState(db, namespace, `candidate-${index}`, `Candidate ${index} has durable useful content.`, [], "owner").id);
    }

    const sample = getNamespaceEntriesForIntake(
      db,
      namespace,
      "client-restricted",
      { excludeEntryIds: [ids[0]] },
    );
    expect(sample.entries).toHaveLength(100);
    expect(sample.truncated).toBe(true);

    const exact100 = getNamespaceEntriesForIntake(
      db,
      namespace,
      "client-restricted",
      { excludeEntryIds: ids.slice(0, 2) },
    );
    expect(exact100.entries).toHaveLength(100);
    expect(exact100.truncated).toBe(false);
  });

  it("counts only visible, current, non-expired entries when deciding truncation", () => {
    const namespace = "projects/intake-visible-count";
    writeState(db, namespace, "visible", "One visible current entry with useful content.", [], "owner");
    for (let index = 0; index < 101; index += 1) {
      writeState(
        db,
        namespace,
        `hidden-${index}`,
        "Hidden classification entry with useful content.",
        [],
        "owner",
        undefined,
        undefined,
        { classification: "client-restricted" },
      );
    }
    for (let index = 0; index < 101; index += 1) {
      writeState(
        db,
        namespace,
        `expired-${index}`,
        "Expired entry with useful content.",
        [],
        "owner",
        undefined,
        "2025-01-01T00:00:00.000Z",
      );
    }

    const sample = getNamespaceEntriesForIntake(db, namespace, "internal");
    expect(sample.entries.map((entry) => entry.key)).toEqual(["visible"]);
    expect(sample.truncated).toBe(false);
  });

  it("promotes an older eligible exact key while keeping its content bounded", async () => {
    const namespace = "projects/intake-exact-key";
    writeState(db, namespace, "old-key", "Older exact-key content with enough useful detail. " + "x".repeat(20_000), [], "owner");
    for (let index = 0; index < 101; index += 1) {
      writeState(db, namespace, `recent-${index}`, `Recent candidate ${index} has unrelated content.`, [], "owner");
    }

    const sample = getNamespaceEntriesForIntake(
      db,
      namespace,
      "client-restricted",
      { exactKey: "old-key" },
    );
    expect(sample.entries[0].key).toBe("old-key");
    expect(sample.entries[0].content).toHaveLength(8_000);
    expect(sample.entries).toHaveLength(100);
    expect(sample.truncated).toBe(true);

    const insideWindow = getNamespaceEntriesForIntake(
      db,
      namespace,
      "client-restricted",
      { exactKey: "recent-100" },
    );
    expect(insideWindow.entries[0].key).toBe("recent-100");
  });
});

describe("write-path intake integration", () => {
  let db: Database.Database;
  let ownerCall: ReturnType<typeof makeServer>;

  beforeEach(() => {
    db = initDatabase(":memory:");
    ownerCall = makeServer(db, ownerContext());
  });

  afterEach(() => {
    db.close();
  });

  it("returns and persists advisory findings without rejecting the write", async () => {
    const first = await ownerCall("memory_write", {
      namespace: "projects/intake",
      key: "architecture",
      content:
        "SQLite FTS5 provides local full text search and durable persistence for memory entries.",
      tags: ["architecture"],
    });
    const second = await ownerCall("memory_write", {
      namespace: "projects/intake",
      key: "database",
      content:
        "SQLite FTS5 provides local full text search and durable persistence for memory entries.",
      tags: ["architecture"],
    });

    expect(first.status).toBe("created");
    expect(second.status).toBe("created");
    expect((second.intake as { status: string }).status).toBe("flagged");
    expect(second.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("[intake:content_overlap]"),
      ]),
    );
    expect(readState(db, "projects/intake", "database")?.content).toContain(
      "durable persistence",
    );

    const persisted = getPersistedIntake(db, second.id as string);
    expect(persisted?.status).toBe("flagged");
    expect(persisted?.flags.map((flag) => flag.check)).toContain("content_overlap");
    expect(persisted?.evaluator_version).toBe(1);
  });

  it("keeps an older exact key in the capped, bounded intake sample", async () => {
    const namespace = "projects/intake-exact-write";
    writeState(
      db,
      namespace,
      "old-key",
      "Older exact-key content with enough useful detail. " + "x".repeat(20_000),
      [],
      "owner",
    );
    for (let index = 0; index < 101; index += 1) {
      writeState(db, namespace, `recent-${index}`, `Recent candidate ${index} has unrelated content.`, [], "owner");
    }

    const result = await ownerCall("memory_write", {
      namespace,
      key: "old-key",
      content: "Updated exact-key content with enough detail for durable memory.",
    });
    const intake = result.intake as {
      flags: Array<{ check: string }>;
      metadata: Record<string, unknown>;
    };

    expect(intake.flags.map((flag) => flag.check)).toContain("duplicate_key");
    expect(intake.metadata).toMatchObject({
      candidate_count: 100,
      candidate_cap: 100,
      candidates_truncated: true,
    });
  });

  it("reports a different-key content duplicate only while it is inside the recent sample", async () => {
    const namespace = "projects/intake-content-boundary";
    const duplicateContent =
      "SQLite FTS5 stores local full text search content with durable memory persistence and reliable retrieval.";
    writeState(db, namespace, "old-duplicate", duplicateContent, ["architecture"], "owner");
    for (let index = 0; index < 101; index += 1) {
      writeState(db, namespace, `recent-${index}`, `Unrelated recent candidate number ${index} about another topic.`, [], "owner");
    }

    const outsideWindow = await ownerCall("memory_write", {
      namespace,
      key: "outside-window-write",
      content: duplicateContent,
      tags: ["architecture"],
    });
    const outsideIntake = outsideWindow.intake as {
      flags: Array<{ check: string }>;
      metadata: Record<string, unknown>;
    };
    expect(outsideIntake.flags.map((flag) => flag.check)).not.toContain("content_overlap");
    expect(outsideIntake.metadata).toMatchObject({
      candidate_count: 100,
      candidate_cap: 100,
      candidates_truncated: true,
    });

    writeState(db, namespace, "recent-duplicate", duplicateContent, ["architecture"], "owner");
    const insideWindow = await ownerCall("memory_write", {
      namespace,
      key: "inside-window-write",
      content: duplicateContent,
      tags: ["architecture"],
    });
    const insideIntake = insideWindow.intake as {
      flags: Array<{ check: string }>;
      metadata: Record<string, unknown>;
    };
    expect(insideIntake.flags.map((flag) => flag.check)).toContain("content_overlap");
    expect(insideIntake.metadata.candidates_truncated).toBe(true);
  });

  it("upserts one intake record for mutable state and cascades on deletion", async () => {
    const first = await ownerCall("memory_write", {
      namespace: "projects/intake",
      key: "mutable",
      content:
        "A meaningful initial state entry with enough durable implementation context.",
    });
    const second = await ownerCall("memory_write", {
      namespace: "projects/intake",
      key: "mutable",
      content: "hi",
    });

    expect(second.id).toBe(first.id);
    expect(
      (getPersistedIntake(db, first.id as string)?.flags ?? [])
        .map((flag) => flag.check),
    ).toContain("low_relevance");
    const count = db.prepare(
      "SELECT COUNT(*) AS count FROM entry_intake WHERE entry_id = ?",
    ).get(first.id) as { count: number };
    expect(count.count).toBe(1);

    db.prepare("DELETE FROM entries WHERE id = ?").run(first.id);
    expect(getPersistedIntake(db, first.id as string)).toBeNull();
  });

  it("evaluates log writes and stores one bounded record per entry", async () => {
    await ownerCall("memory_log", {
      namespace: "projects/intake",
      content:
        "Decided to keep the write-time quality gate advisory so optional analysis can never block durable memory writes.",
      tags: ["decision"],
    });
    const result = await ownerCall("memory_log", {
      namespace: "projects/intake",
      content:
        "Decided to keep the write-time quality gate advisory so optional analysis can never block durable memory writes.",
      tags: ["decision"],
    });

    expect(result.status).toBe("logged");
    expect((result.intake as { status: string }).status).toBe("flagged");
    expect(getPersistedIntake(db, result.id as string)?.flags.map(
      (flag) => flag.check,
    )).toContain("content_overlap");
  });

  it("does not flag a corrected log against the predecessor it supersedes", async () => {
    const first = await ownerCall("memory_log", {
      namespace: "projects/intake",
      content:
        "Decided to keep the write-time quality gate advisory so optional analysis cannot block durable memory writes.",
      tags: ["decision"],
    });
    const correction = await ownerCall("memory_log", {
      namespace: "projects/intake",
      content:
        "Decided to keep the write-time quality gate advisory so optional analysis can never block durable memory writes.",
      tags: ["decision"],
      supersedes: first.id,
      expected_updated_at: first.timestamp,
    });
    const checks = (
      correction.intake as { flags: Array<{ check: string }> }
    ).flags.map((flag) => flag.check);

    expect(correction.status).toBe("superseded");
    expect(checks).not.toContain("content_overlap");
    expect(checks).not.toContain("consolidation_candidate");
  });

  it("does not leak higher-classification related entries through intake", async () => {
    const restricted = await ownerCall("memory_write", {
      namespace: "projects/isolated",
      key: "restricted-design",
      content:
        "Confidential architecture uses SQLite FTS5 for local full text search and durable persistence.",
      tags: ["architecture"],
      classification: "client-restricted",
    });
    const limitedCall = makeServer(db, {
      principalId: "agent:limited",
      principalType: "agent",
      accessibleNamespaces: [
        { pattern: "projects/isolated", permissions: "rw" },
      ],
      maxClassification: "internal",
      transportType: "consumer",
    });

    const result = await limitedCall("memory_write", {
      namespace: "projects/isolated",
      key: "public-design",
      content:
        "Confidential architecture uses SQLite FTS5 for local full text search and durable persistence.",
      tags: ["architecture"],
      classification: "internal",
    });
    const serializedIntake = JSON.stringify(result.intake);

    expect(result.status).toBe("created");
    expect(serializedIntake).not.toContain("restricted-design");
    expect(serializedIntake).not.toContain(restricted.id as string);
    expect(
      ((result.intake as { flags: Array<{ related_entry_id?: string }> }).flags)
        .some((flag) => flag.related_entry_id === restricted.id),
    ).toBe(false);
    expect((result.intake as { metadata: Record<string, unknown> }).metadata)
      .toMatchObject({ candidate_count: 0, candidate_cap: 100, candidates_truncated: false });
  });

  it("does not derive related-entry findings for a write-only principal", async () => {
    const hidden = await ownerCall("memory_write", {
      namespace: "projects/write-only-intake",
      key: "hidden",
      content:
        "SQLite FTS5 provides local full text search and durable persistence for memory entries.",
      tags: ["architecture"],
    });
    const writerCall = makeServer(db, {
      principalId: "writer:intake",
      principalType: "external",
      accessibleNamespaces: [
        { pattern: "projects/write-only-intake", permissions: "write" },
      ],
      maxClassification: "internal",
      transportType: "consumer",
    });

    const result = await writerCall("memory_write", {
      namespace: "projects/write-only-intake",
      key: "new",
      content:
        "SQLite FTS5 provides local full text search and durable persistence for memory entries.",
      tags: ["architecture"],
    });
    const serializedIntake = JSON.stringify(result.intake);

    expect(result.status).toBe("created");
    expect(serializedIntake).not.toContain(hidden.id as string);
    expect(serializedIntake).not.toContain("\"hidden\"");
    expect((result.intake as { metadata: Record<string, unknown> }).metadata)
      .not.toHaveProperty("candidate_count");
    expect((result.intake as { metadata: Record<string, unknown> }).metadata)
      .not.toHaveProperty("candidate_cap");
    expect((result.intake as { metadata: Record<string, unknown> }).metadata)
      .not.toHaveProperty("candidates_truncated");
  });

  it("does not let expired state influence related-entry analysis", async () => {
    const expired = await ownerCall("memory_write", {
      namespace: "projects/expired-intake",
      key: "old",
      content:
        "SQLite FTS5 provides local full text search and durable persistence for memory entries.",
      tags: ["architecture"],
      valid_until: "2025-01-01T00:00:00.000Z",
    });
    const result = await ownerCall("memory_write", {
      namespace: "projects/expired-intake",
      key: "current",
      content:
        "SQLite FTS5 provides local full text search and durable persistence for memory entries.",
      tags: ["architecture"],
    });
    const intake = result.intake as {
      flags: Array<{ related_entry_id?: string }>;
      metadata: { related_keys: unknown[] };
    };

    expect(intake.flags.some((flag) => flag.related_entry_id === expired.id)).toBe(false);
    expect(intake.metadata.related_keys).toEqual([]);
    expect(intake.metadata).toMatchObject({
      candidate_count: 0,
      candidate_cap: 100,
      candidates_truncated: false,
    });
  });

  it("does not treat reviving an expired state key as a duplicate overwrite", async () => {
    await ownerCall("memory_write", {
      namespace: "projects/expired-intake",
      key: "revived",
      content: "Old temporary state that has already expired.",
      valid_until: "2025-01-01T00:00:00.000Z",
    });
    const result = await ownerCall("memory_write", {
      namespace: "projects/expired-intake",
      key: "revived",
      content: "Fresh current state replacing the expired temporary value.",
    });
    const checks = (
      result.intake as { flags: Array<{ check: string }> }
    ).flags.map((flag) => flag.check);

    expect(result.status).toBe("updated");
    expect(checks).not.toContain("duplicate_key");
  });

  it("keeps writes successful when optional intake persistence is unavailable", async () => {
    db.exec("DROP TABLE entry_intake");

    const result = await ownerCall("memory_write", {
      namespace: "projects/intake",
      key: "survives",
      content:
        "This write must survive even if optional intake metadata cannot be persisted.",
    });

    expect(result.status).toBe("created");
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("[intake:persistence_unavailable]"),
      ]),
    );
    expect(readState(db, "projects/intake", "survives")).not.toBeNull();
  });
});
