import { describe, it, expect } from "vitest";
import { readFileSync, statSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";

const REPO_ROOT = resolve(__dirname, "..");
const MANIFEST_PATH = join(
  REPO_ROOT,
  "benchmark/queries/retrieval-v1.manifest.json",
);

// Test-side mirror of the v1 freeze. The JSON manifest is the source of
// truth (see retrieval-v1.manifest.md §11); this list is a duplicated
// guard so a silent edit to the JSON can't pass review without also
// touching the test. If you intentionally add or remove a source, update
// this list AND bump the relevant counts below.
const EXPECTED_V1_SOURCE_IDS = [
  "munin-native-baseline",
  "munin-native-baseline-claude",
  "munin-native-example",
  "munin-zero-v2-intents",
  "munin-zero-v3-intents",
  "munin-zero-v3b-queries-sonnet",
  "munin-zero-v3c-intents",
  "munin-zero-v3c-queries-sonnet",
] as const;

const VALID_SOURCE_CLASS = new Set(["manual", "derived", "synthetic"]);
const VALID_TIER = new Set(["primary", "evidence", "deprecated"]);
const VALID_GROUND_TRUTH_KIND = new Set([
  "expected_ids",
  "expected_namespaces",
  "both",
  "targets_external",
]);
const VALID_GAP_STATUS = new Set([
  "open",
  "in_progress",
  "blocked",
  "deferred",
  "closed",
  "documented",
]);

const MUNIN_ZERO_COMMIT = "ad4baff8b906065679144185af3e02ee632d9d28";

interface SourceEntry {
  id: string;
  repo: string;
  path: string;
  sha256?: string;
  record_count: number;
  source_class: string;
  tier: string;
  shape: string;
  ground_truth_kind: string;
  ground_truth_breakdown?: Record<string, number>;
  target_set_id?: string;
  target_path?: string;
  target_sha256?: string;
  target_id_field?: string;
  target_count?: number;
  target_subset?: unknown[];
  target_uuid_subset?: string[];
  result_paths?: Array<{
    path: string;
    sha256?: string;
    search_mode: string;
    limit: number | null;
    metric: string;
    record_count: number;
  }>;
  evaluation_method?: Record<string, unknown>;
  strata_breakdown?: Record<string, unknown>;
  search_modes?: string[];
  notes?: string;
  anomalies?: unknown[];
}

interface Manifest {
  manifest_version: string;
  manifest_id: string;
  manifest_kind: string;
  created_at: string;
  created_by: string;
  purpose: string;
  citation_format: string;
  record_key_fields: Record<string, string>;
  source_repos: Array<{
    name: string;
    role: string;
    commit_sha: string;
  }>;
  sources: SourceEntry[];
  strata_definitions: Record<string, unknown>;
  dedupe_policy: { principle: string; rules: string[] };
  known_gaps: Array<{ id: string; summary: string; status: string }>;
  closed_issues: Record<
    string,
    {
      closing_commit: string;
      closing_commit_short?: string;
      closed_at: string;
      summary: string;
      evidence_paths: string[];
      evidence_sha256?: Record<string, string>;
    }
  >;
  omitted_artifacts: Array<{ path: string; reason: string }>;
  derived_total_record_count: number;
  derived_munin_native_record_count: number;
  derived_munin_zero_record_count: number;
}

interface Rule {
  id: string;
  message: string;
}

/**
 * Pure validation helper. Returns a list of rule violations. An empty
 * list means the manifest passes. Used by both the positive test (must
 * be empty) and the negative tests (clone, mutate, assert specific rule
 * fires).
 */
export function validateManifest(obj: unknown): Rule[] {
  const failures: Rule[] = [];
  const fail = (id: string, message: string) =>
    failures.push({ id, message });

  if (!obj || typeof obj !== "object") {
    fail("M-STRUCT", "manifest is not an object");
    return failures;
  }
  const m = obj as Manifest;

  // -- top-level required keys --------------------------------------
  const required: Array<keyof Manifest> = [
    "manifest_version",
    "manifest_id",
    "manifest_kind",
    "created_at",
    "purpose",
    "citation_format",
    "record_key_fields",
    "source_repos",
    "sources",
    "strata_definitions",
    "dedupe_policy",
    "known_gaps",
    "closed_issues",
    "omitted_artifacts",
    "derived_total_record_count",
    "derived_munin_native_record_count",
    "derived_munin_zero_record_count",
  ];
  for (const key of required) {
    if (!(key in m)) fail("M-REQ", `missing top-level key: ${String(key)}`);
  }

  // -- semver -------------------------------------------------------
  if (typeof m.manifest_version !== "string" || !/^\d+\.\d+\.\d+$/.test(m.manifest_version)) {
    fail("M-SEMVER", `manifest_version not semver: ${m.manifest_version}`);
  }
  if (m.manifest_id !== "retrieval-v1") {
    fail("M-ID", `manifest_id must be "retrieval-v1", got ${m.manifest_id}`);
  }
  if (m.manifest_kind !== "source_index") {
    fail("M-KIND", `manifest_kind must be "source_index", got ${m.manifest_kind}`);
  }

  // -- source_repos -------------------------------------------------
  if (!Array.isArray(m.source_repos)) {
    fail("R-ARRAY", "source_repos must be an array");
  } else {
    const zero = m.source_repos.find((r) => r.name === "munin-zero");
    if (!zero) fail("R-ZERO", "source_repos missing munin-zero");
    else if (zero.commit_sha !== MUNIN_ZERO_COMMIT) {
      fail(
        "R-ZERO-SHA",
        `munin-zero commit_sha must be ${MUNIN_ZERO_COMMIT}, got ${zero.commit_sha}`,
      );
    } else if (!/^[0-9a-f]{40}$/.test(zero.commit_sha)) {
      fail("R-ZERO-SHA-SHAPE", "munin-zero commit_sha is not a 40-char hex");
    }
    const native = m.source_repos.find((r) => r.name === "munin-memory");
    if (!native) fail("R-NATIVE", "source_repos missing munin-memory");
  }

  // -- sources[] ----------------------------------------------------
  if (!Array.isArray(m.sources) || m.sources.length === 0) {
    fail("S-EMPTY", "sources[] must be a non-empty array");
  } else {
    const ids = m.sources.map((s) => s.id);
    // exact set match for the v1 freeze
    const idSet = new Set(ids);
    for (const expected of EXPECTED_V1_SOURCE_IDS) {
      if (!idSet.has(expected)) {
        fail("S-MISSING", `sources[] missing expected v1 id: ${expected}`);
      }
    }
    for (const got of ids) {
      if (!EXPECTED_V1_SOURCE_IDS.includes(got as never)) {
        fail("S-EXTRA", `sources[] contains unexpected v1 id: ${got}`);
      }
    }
    // uniqueness
    if (new Set(ids).size !== ids.length) {
      fail("S-DUPE", "sources[].id values must be unique");
    }

    for (const s of m.sources) {
      const requiredKeys: Array<keyof SourceEntry> = [
        "id",
        "repo",
        "path",
        "record_count",
        "source_class",
        "tier",
        "shape",
        "ground_truth_kind",
        "notes",
      ];
      for (const k of requiredKeys) {
        if (s[k] === undefined || s[k] === null || s[k] === "") {
          fail("S-FIELD", `${s.id}: missing/empty ${String(k)}`);
        }
      }
      if (!VALID_SOURCE_CLASS.has(s.source_class)) {
        fail("S-CLASS", `${s.id}: invalid source_class=${s.source_class}`);
      }
      if (!VALID_TIER.has(s.tier)) {
        fail("S-TIER", `${s.id}: invalid tier=${s.tier}`);
      }
      if (!VALID_GROUND_TRUTH_KIND.has(s.ground_truth_kind)) {
        fail("S-GTK", `${s.id}: invalid ground_truth_kind=${s.ground_truth_kind}`);
      }
      // every source needs a sha256
      if (!s.sha256 || !/^[0-9a-f]{64}$/.test(s.sha256)) {
        fail("S-SHA", `${s.id}: missing or malformed sha256`);
      }
      // targets_external => target_path + target_sha256 + target_id_field + target_count
      if (s.ground_truth_kind === "targets_external") {
        if (!s.target_path) fail("S-TGT-PATH", `${s.id}: targets_external requires target_path`);
        if (!s.target_sha256 || !/^[0-9a-f]{64}$/.test(s.target_sha256 ?? "")) {
          fail("S-TGT-SHA", `${s.id}: targets_external requires target_sha256`);
        }
        if (!s.target_id_field) {
          fail("S-TGT-FIELD", `${s.id}: targets_external requires target_id_field`);
        }
        if (typeof s.target_count !== "number" || s.target_count <= 0) {
          fail("S-TGT-COUNT", `${s.id}: targets_external requires positive target_count`);
        }
      }
      // result_paths[] integrity
      if (s.result_paths) {
        for (const rp of s.result_paths) {
          if (!rp.path || !rp.search_mode || !rp.metric) {
            fail("S-RP-FIELD", `${s.id}: result_paths entry missing required field`);
          }
          if (!rp.sha256 || !/^[0-9a-f]{64}$/.test(rp.sha256)) {
            fail("S-RP-SHA", `${s.id}: result_paths entry missing sha256`);
          }
          if (typeof rp.record_count !== "number" || rp.record_count < 0) {
            fail("S-RP-COUNT", `${s.id}: result_paths entry needs record_count`);
          }
        }
      }
    }
  }

  // -- record_key_fields covers every source ------------------------
  if (m.sources && m.record_key_fields) {
    for (const s of m.sources) {
      if (!m.record_key_fields[s.id]) {
        fail("M-RKF", `record_key_fields missing entry for ${s.id}`);
      }
    }
  }

  // -- derived totals ----------------------------------------------
  if (Array.isArray(m.sources)) {
    const total = m.sources.reduce((acc, s) => acc + (s.record_count || 0), 0);
    if (total !== m.derived_total_record_count) {
      fail(
        "D-TOTAL",
        `derived_total_record_count=${m.derived_total_record_count}, computed=${total}`,
      );
    }
    const nativeTotal = m.sources
      .filter((s) => s.repo === "munin-memory")
      .reduce((acc, s) => acc + (s.record_count || 0), 0);
    if (nativeTotal !== m.derived_munin_native_record_count) {
      fail(
        "D-NATIVE",
        `derived_munin_native_record_count=${m.derived_munin_native_record_count}, computed=${nativeTotal}`,
      );
    }
    if (nativeTotal !== 34) {
      fail("D-NATIVE-34", `munin-native total must be 34, got ${nativeTotal}`);
    }
    const zeroTotal = m.sources
      .filter((s) => s.repo === "munin-zero")
      .reduce((acc, s) => acc + (s.record_count || 0), 0);
    if (zeroTotal !== m.derived_munin_zero_record_count) {
      fail(
        "D-ZERO",
        `derived_munin_zero_record_count=${m.derived_munin_zero_record_count}, computed=${zeroTotal}`,
      );
    }
  }

  // -- closed_issues ------------------------------------------------
  const issue = m.closed_issues?.["munin-zero#6"];
  if (!issue) {
    fail("C-ISSUE", "closed_issues missing munin-zero#6");
  } else {
    if (!/^[0-9a-f]{40}$/.test(issue.closing_commit ?? "")) {
      fail("C-SHA", `closed_issues[munin-zero#6].closing_commit must be 40-char hex`);
    }
    if (issue.closing_commit_short && issue.closing_commit?.slice(0, 7) !== issue.closing_commit_short) {
      fail("C-SHORT", "closing_commit_short must equal first 7 chars of closing_commit");
    }
    if (!Array.isArray(issue.evidence_paths) || issue.evidence_paths.length === 0) {
      fail("C-EV", "closed_issues evidence_paths must be a non-empty array");
    } else {
      const need = [
        "pilot-report-v3c.md",
        "pilot-intents-v3c.jsonl",
        "pilot-queries-v3c-sonnet.jsonl",
        "pilot-results-v3c-lexical.jsonl",
        "pilot-targets-v3.jsonl",
      ];
      for (const tail of need) {
        if (!issue.evidence_paths.some((p) => p.endsWith(tail))) {
          fail("C-EV-MISSING", `closed_issues evidence_paths missing artifact ending in ${tail}`);
        }
      }
      if (issue.evidence_sha256) {
        for (const p of issue.evidence_paths) {
          if (!issue.evidence_sha256[p] || !/^[0-9a-f]{64}$/.test(issue.evidence_sha256[p])) {
            fail("C-EV-SHA", `closed_issues evidence_sha256 missing or malformed for ${p}`);
          }
        }
      } else {
        fail("C-EV-SHA-MAP", "closed_issues missing evidence_sha256 map");
      }
    }
  }

  // -- known_gaps ---------------------------------------------------
  if (Array.isArray(m.known_gaps)) {
    if (m.known_gaps.length === 0) {
      fail("G-EMPTY", "known_gaps[] must not be empty (v1 has documented gaps)");
    }
    for (const g of m.known_gaps) {
      if (!g.id || !g.summary) fail("G-FIELD", `known_gap ${g.id ?? "?"} missing fields`);
      if (!VALID_GAP_STATUS.has(g.status)) {
        fail("G-STATUS", `known_gap ${g.id}: invalid status=${g.status}`);
      }
    }
  }

  return failures;
}

function sha256OfFile(absPath: string): string {
  const buf = readFileSync(absPath);
  return createHash("sha256").update(buf).digest("hex");
}

function countLines(absPath: string): number {
  const buf = readFileSync(absPath, "utf8");
  if (buf.length === 0) return 0;
  // Treat trailing newline as line terminator, not extra line.
  const trimmed = buf.endsWith("\n") ? buf.slice(0, -1) : buf;
  if (trimmed.length === 0) return 0;
  return trimmed.split("\n").length;
}

describe("retrieval-v1 manifest", () => {
  const raw = readFileSync(MANIFEST_PATH, "utf8");
  const manifest = JSON.parse(raw) as Manifest;

  it("parses as JSON", () => {
    expect(manifest).toBeTruthy();
    expect(manifest.manifest_id).toBe("retrieval-v1");
  });

  it("passes all validation rules", () => {
    const failures = validateManifest(manifest);
    expect(failures, JSON.stringify(failures, null, 2)).toEqual([]);
  });

  it("contains exactly the eight v1 sources", () => {
    const ids = manifest.sources.map((s) => s.id).sort();
    expect(ids).toEqual([...EXPECTED_V1_SOURCE_IDS].sort());
  });

  it("derived totals are correct", () => {
    expect(manifest.derived_total_record_count).toBe(176);
    expect(manifest.derived_munin_native_record_count).toBe(34);
    expect(manifest.derived_munin_zero_record_count).toBe(142);
  });

  it("v3c closure evidence covers report + intents + queries + results + targets", () => {
    const ev = manifest.closed_issues["munin-zero#6"].evidence_paths;
    expect(ev.some((p) => p.endsWith("pilot-report-v3c.md"))).toBe(true);
    expect(ev.some((p) => p.endsWith("pilot-intents-v3c.jsonl"))).toBe(true);
    expect(ev.some((p) => p.endsWith("pilot-queries-v3c-sonnet.jsonl"))).toBe(true);
    expect(ev.some((p) => p.endsWith("pilot-results-v3c-lexical.jsonl"))).toBe(true);
    expect(ev.some((p) => p.endsWith("pilot-targets-v3.jsonl"))).toBe(true);
  });

  describe("native JSONL on-disk verification", () => {
    // Native sources are pinned in the manifest but most are gitignored
    // (see `.gitignore`: `benchmark/queries/*.jsonl` excludes everything
    // except `example.jsonl`). Skip per-source when the file is absent
    // from this checkout — the manifest declaration is still validated by
    // the structural rules above; this block only adds a "if the file IS
    // present, its bytes match the manifest" guarantee. CI deliberately
    // runs against the public surface.
    const nativeSources = (m: Manifest) =>
      m.sources.filter(
        (s) => s.repo === "munin-memory" && existsSync(join(REPO_ROOT, s.path)),
      );

    it("at least one native source is present in the checkout", () => {
      // Sanity guard: if every native source vanished we'd silently skip
      // all three on-disk checks below. example.jsonl is committed, so
      // this must always find at least one file.
      expect(nativeSources(manifest).length).toBeGreaterThan(0);
    });

    it("line count matches record_count for every native source present on disk", () => {
      for (const s of nativeSources(manifest)) {
        const abs = join(REPO_ROOT, s.path);
        expect(statSync(abs).isFile(), `${s.path} not a file`).toBe(true);
        const lines = countLines(abs);
        expect(lines, `${s.id} line count`).toBe(s.record_count);
      }
    });

    it("sha256 matches actual file contents for every native source present on disk", () => {
      for (const s of nativeSources(manifest)) {
        const abs = join(REPO_ROOT, s.path);
        expect(sha256OfFile(abs), `${s.id} sha256`).toBe(s.sha256);
      }
    });

    it("every native record present on disk parses as BenchmarkQuery with matching source field", () => {
      for (const s of nativeSources(manifest)) {
        const abs = join(REPO_ROOT, s.path);
        const text = readFileSync(abs, "utf8").trim();
        const records = text.split("\n").map((line) => JSON.parse(line));
        for (const r of records) {
          // BenchmarkQuery shape (subset of required fields).
          expect(typeof r.id, `${s.id} id`).toBe("string");
          expect(typeof r.query, `${s.id} ${r.id} query`).toBe("string");
          expect(["manual", "derived", "synthetic"]).toContain(r.source);
          expect(typeof r.category, `${s.id} ${r.id} category`).toBe("string");
          expect(typeof r.search_mode, `${s.id} ${r.id} search_mode`).toBe("string");
          // record-level source must match manifest's declared source_class.
          expect(r.source, `${s.id} ${r.id} source mismatch`).toBe(s.source_class);
          // ground truth field must match manifest's ground_truth_kind.
          const hasIds = Array.isArray(r.expected_ids) && r.expected_ids.length > 0;
          const hasNs = Array.isArray(r.expected_namespaces) && r.expected_namespaces.length > 0;
          if (s.ground_truth_kind === "expected_ids") {
            expect(hasIds, `${s.id} ${r.id} expected_ids required`).toBe(true);
          } else if (s.ground_truth_kind === "expected_namespaces") {
            expect(hasNs, `${s.id} ${r.id} expected_namespaces required`).toBe(true);
          } else if (s.ground_truth_kind === "both") {
            expect(hasIds || hasNs, `${s.id} ${r.id} needs either expected_ids or expected_namespaces`).toBe(true);
          }
        }
      }
    });
  });

  // Negative tests: clone the manifest, mutate it, confirm the right
  // rule fires. Each test must produce at least one failure that names
  // the corresponding rule prefix.
  describe("validateManifest catches violations", () => {
    function clone(): Manifest {
      return JSON.parse(JSON.stringify(manifest)) as Manifest;
    }

    it("rejects invalid source_class", () => {
      const m = clone();
      (m.sources[0] as SourceEntry).source_class = "evidence";
      const f = validateManifest(m);
      expect(f.some((r) => r.id === "S-CLASS")).toBe(true);
    });

    it("rejects duplicate source ids", () => {
      const m = clone();
      m.sources[1].id = m.sources[0].id;
      const f = validateManifest(m);
      expect(f.some((r) => r.id === "S-DUPE")).toBe(true);
    });

    it("rejects derived_total_record_count drift", () => {
      const m = clone();
      m.derived_total_record_count = m.derived_total_record_count + 1;
      const f = validateManifest(m);
      expect(f.some((r) => r.id === "D-TOTAL")).toBe(true);
    });

    it("rejects missing v3c result evidence", () => {
      const m = clone();
      m.closed_issues["munin-zero#6"].evidence_paths = m.closed_issues[
        "munin-zero#6"
      ].evidence_paths.filter((p) => !p.endsWith("pilot-results-v3c-lexical.jsonl"));
      const f = validateManifest(m);
      expect(f.some((r) => r.id === "C-EV-MISSING")).toBe(true);
    });

    it("rejects missing target_path on a targets_external source", () => {
      const m = clone();
      const ext = m.sources.find((s) => s.ground_truth_kind === "targets_external");
      if (!ext) throw new Error("test fixture: no targets_external source");
      delete ext.target_path;
      const f = validateManifest(m);
      expect(f.some((r) => r.id === "S-TGT-PATH")).toBe(true);
    });

    it("rejects wrong munin-zero commit SHA", () => {
      const m = clone();
      const z = m.source_repos.find((r) => r.name === "munin-zero")!;
      z.commit_sha = "0".repeat(40);
      const f = validateManifest(m);
      expect(f.some((r) => r.id === "R-ZERO-SHA")).toBe(true);
    });

    it("rejects an unknown gap status", () => {
      const m = clone();
      m.known_gaps[0].status = "lol";
      const f = validateManifest(m);
      expect(f.some((r) => r.id === "G-STATUS")).toBe(true);
    });

    it("rejects an extra source id beyond the v1 freeze", () => {
      const m = clone();
      m.sources.push({
        ...m.sources[0],
        id: "munin-zero-something-else",
      });
      // Re-jig derived totals so we isolate S-EXTRA.
      m.derived_total_record_count += m.sources[0].record_count;
      m.derived_munin_zero_record_count = m.sources
        .filter((s) => s.repo === "munin-zero")
        .reduce((a, s) => a + s.record_count, 0);
      m.derived_munin_native_record_count = m.sources
        .filter((s) => s.repo === "munin-memory")
        .reduce((a, s) => a + s.record_count, 0);
      const f = validateManifest(m);
      expect(f.some((r) => r.id === "S-EXTRA")).toBe(true);
    });
  });
});
