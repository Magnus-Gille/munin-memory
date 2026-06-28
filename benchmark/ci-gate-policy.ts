/**
 * Pure pass/fail policy for the retrieval CI regression gate.
 *
 * No I/O, no DB — takes a current report's aggregate scores and a committed
 * baseline, returns a structured verdict. Kept separate from `ci-gate.ts` so
 * the comparison logic is unit-testable without building a fixture DB.
 *
 * Policy: a metric REGRESSES when `current < baseline - tolerance`. Any
 * regression on a gated metric fails the gate. Improvements (current above
 * baseline) always pass — they just mean the committed baseline is now
 * conservative and can be re-blessed with `--update-baseline`.
 *
 * The gate runs in `raw` + `lexical` mode against a fixed synthetic corpus,
 * so the numbers are deterministic across machines. The tolerance exists only
 * to absorb last-ULP floating-point drift, NOT to wave through real quality
 * drops — it is intentionally far smaller than the change a single query
 * flipping would produce in the small CI query set.
 */

/** The aggregate metrics the gate watches. Subset of ScoringResult. */
export interface GatedScores {
  recallAt1: number;
  recallAt5: number;
  recallAt10: number;
  ndcgAt5: number;
  mrr: number;
}

/** The committed baseline file shape. */
export interface GateBaseline {
  /** Schema version of this baseline file format. */
  baseline_schema_version: 1;
  /** When the baseline was last re-blessed (ISO 8601). Informational only. */
  generated_at: string;
  /** SHA-256 over the committed corpus file — detects corpus drift. */
  corpus_sha256: string;
  /**
   * SHA-256 over the committed frozen-embeddings fixture. Present only for the
   * hybrid gate (the lexical gate has no embeddings). Drift is a warning, not a
   * failure — re-bless with --update-baseline when the vectors change
   * intentionally (e.g. a new embedding model).
   */
  embeddings_sha256?: string;
  /** Deterministic checksum of the query set the baseline was measured on. */
  query_set_checksum: string;
  /** Number of queries evaluated. Informational; mismatch is surfaced as a warning. */
  query_count: number;
  /** The baseline aggregate scores the gate compares against. */
  overall: GatedScores;
}

/** The metric keys shown in the verdict table, in display order. */
export const GATED_METRICS: (keyof GatedScores)[] = [
  "recallAt1",
  "recallAt5",
  "recallAt10",
  "ndcgAt5",
  "mrr",
];

/**
 * Metrics the HYBRID gate actually ENFORCES (fails on). Deliberately the two
 * membership-recall metrics, not the rank-order ones.
 *
 * Why a subset: the hybrid baseline is blessed off the CI platform (a dev box),
 * but the gate runs on ubuntu-latest. Membership metrics (is the target in the
 * top K?) are stable across architectures — a within-window reordering from
 * float32 SIMD/FMA differences in sqlite-vec's KNN doesn't change them. The
 * rank-order metrics (recallAt1/ndcgAt5/mrr) CAN shift by a discrete ~1/12 on a
 * single cross-platform rank flip, which would false-fail unrelated PRs. They
 * are still reported (and committed in the baseline) for observability — just
 * not enforced. R@5/R@10 sit at a 1.0 ceiling with a ≥1-rank margin and a
 * measured ~4.7e-4 nearest-neighbour gap (~100x FP noise), so a real
 * vector/RRF regression (a target dropping out of the window) still trips them.
 */
export const HYBRID_GATED_METRICS: (keyof GatedScores)[] = ["recallAt5", "recallAt10"];

/** Default tolerance — absorbs FP noise only. See module doc. */
export const DEFAULT_GATE_TOLERANCE = 1e-6;

/**
 * Validate a parsed baseline object before it is trusted by the gate.
 *
 * A malformed baseline is dangerous: a missing or non-finite metric flows
 * through `current - baseline` as `NaN`, and `NaN < -tolerance` is `false`, so
 * a corrupt baseline would silently mask a real regression. We fail loud
 * instead. Throws with an actionable message; callers should treat a throw as
 * a hard gate failure, not a "no baseline" condition.
 */
export function validateBaseline(parsed: unknown): GateBaseline {
  const errs: string[] = [];
  const b = parsed as Record<string, unknown>;
  if (typeof b !== "object" || b === null) {
    throw new Error("baseline is not an object");
  }
  if (b.baseline_schema_version !== 1) {
    errs.push(`baseline_schema_version must be 1 (got ${JSON.stringify(b.baseline_schema_version)})`);
  }
  for (const k of ["generated_at", "corpus_sha256", "query_set_checksum"] as const) {
    if (typeof b[k] !== "string" || (b[k] as string).length === 0) {
      errs.push(`${k} must be a non-empty string`);
    }
  }
  if (typeof b.query_count !== "number" || !Number.isInteger(b.query_count) || b.query_count <= 0) {
    errs.push(`query_count must be a positive integer (got ${JSON.stringify(b.query_count)})`);
  }
  const overall = b.overall as Record<string, unknown> | undefined;
  if (typeof overall !== "object" || overall === null) {
    errs.push("overall must be an object");
  } else {
    for (const metric of GATED_METRICS) {
      const v = overall[metric];
      if (typeof v !== "number" || !Number.isFinite(v)) {
        errs.push(`overall.${metric} must be a finite number (got ${JSON.stringify(v)})`);
      }
    }
  }
  if (errs.length > 0) {
    throw new Error(`Invalid baseline.json: ${errs.join("; ")}`);
  }
  return parsed as GateBaseline;
}

/** Per-metric comparison outcome. */
export interface MetricDelta {
  metric: keyof GatedScores;
  baseline: number;
  current: number;
  /** current - baseline. Negative means worse. */
  delta: number;
  /** Whether this metric can fail the gate (vs. reported for observability only). */
  enforced: boolean;
  /** True when the metric is enforced AND delta < -tolerance. */
  regressed: boolean;
}

/** The gate verdict. */
export interface GateVerdict {
  pass: boolean;
  tolerance: number;
  deltas: MetricDelta[];
  /** Subset of `deltas` where `regressed` is true. */
  regressions: MetricDelta[];
  /** Non-fatal notes (e.g. corpus or query-set drift vs the baseline file). */
  warnings: string[];
}

/**
 * Compare a current run's aggregate scores against a committed baseline.
 *
 * `lineage` is optional; when provided, a mismatch in corpus hash or query-set
 * checksum is reported as a WARNING (not a failure) so an intentional corpus
 * change that is otherwise non-regressing still passes, but the operator is
 * told the baseline was measured on different inputs.
 */
export function compareToBaseline(
  current: GatedScores,
  baseline: GateBaseline,
  options: {
    tolerance?: number;
    /**
     * Which metrics fail the gate. Defaults to all GATED_METRICS (the lexical
     * gate). The hybrid gate passes HYBRID_GATED_METRICS so off-platform rank
     * noise in the unenforced metrics can't false-fail. All GATED_METRICS are
     * still shown in the verdict; only these can trip it.
     */
    enforcedMetrics?: (keyof GatedScores)[];
    lineage?: {
      corpus_sha256?: string;
      embeddings_sha256?: string;
      query_set_checksum?: string;
      query_count?: number;
    };
  } = {},
): GateVerdict {
  const tolerance = options.tolerance ?? DEFAULT_GATE_TOLERANCE;
  const enforced = new Set(options.enforcedMetrics ?? GATED_METRICS);
  const warnings: string[] = [];

  if (options.lineage) {
    const { corpus_sha256, embeddings_sha256, query_set_checksum, query_count } = options.lineage;
    if (corpus_sha256 !== undefined && corpus_sha256 !== baseline.corpus_sha256) {
      warnings.push(
        `Corpus changed since baseline was blessed (baseline=${baseline.corpus_sha256.slice(0, 12)} current=${corpus_sha256.slice(0, 12)}). Re-bless with --update-baseline if intentional.`,
      );
    }
    if (
      embeddings_sha256 !== undefined &&
      embeddings_sha256 !== (baseline.embeddings_sha256 ?? undefined)
    ) {
      warnings.push(
        `Embeddings fixture changed since baseline was blessed (baseline=${(baseline.embeddings_sha256 ?? "none").slice(0, 12)} current=${embeddings_sha256.slice(0, 12)}). Re-bless with --update-baseline if intentional.`,
      );
    }
    if (
      query_set_checksum !== undefined &&
      query_set_checksum !== baseline.query_set_checksum
    ) {
      warnings.push(
        `Query set changed since baseline was blessed (baseline=${baseline.query_set_checksum.slice(0, 12)} current=${query_set_checksum.slice(0, 12)}). Re-bless with --update-baseline if intentional.`,
      );
    }
    if (query_count !== undefined && query_count !== baseline.query_count) {
      warnings.push(
        `Query count changed since baseline (baseline=${baseline.query_count} current=${query_count}).`,
      );
    }
  }

  const deltas: MetricDelta[] = GATED_METRICS.map((metric) => {
    const baselineVal = baseline.overall[metric];
    const currentVal = current[metric];
    const delta = currentVal - baselineVal;
    const isEnforced = enforced.has(metric);
    return {
      metric,
      baseline: baselineVal,
      current: currentVal,
      delta,
      enforced: isEnforced,
      regressed: isEnforced && delta < -tolerance,
    };
  });

  const regressions = deltas.filter((d) => d.regressed);
  return {
    pass: regressions.length === 0,
    tolerance,
    deltas,
    regressions,
    warnings,
  };
}

/**
 * Format a verdict as a human-readable table for CI logs. `mode` only changes
 * the header line so lexical and hybrid runs are distinguishable in logs.
 */
export function formatVerdict(verdict: GateVerdict, mode: "lexical" | "hybrid" = "lexical"): string {
  const lines: string[] = [];
  lines.push(
    mode === "hybrid"
      ? "Retrieval CI gate — hybrid (FTS5 + vector RRF), frozen vectors"
      : "Retrieval CI gate — raw/lexical, deterministic",
  );
  lines.push("");
  lines.push("  metric        baseline   current    delta      status");
  lines.push("  ------------  ---------  ---------  ---------  ------");
  for (const d of verdict.deltas) {
    // Non-enforced metrics are informational only (e.g. rank-order metrics on
    // the hybrid gate): show "info", or "info↓" when they slipped, so a drop is
    // visible without failing the build.
    const status = d.regressed
      ? "FAIL"
      : !d.enforced
        ? d.delta < -verdict.tolerance
          ? "info↓"
          : "info"
        : d.delta > verdict.tolerance
          ? "up"
          : "ok";
    lines.push(
      `  ${d.metric.padEnd(12)}  ${fmt(d.baseline)}  ${fmt(d.current)}  ${fmtSigned(d.delta)}  ${status}`,
    );
  }
  const enforcedNames = verdict.deltas.filter((d) => d.enforced).map((d) => d.metric);
  if (enforcedNames.length < verdict.deltas.length) {
    lines.push(`  enforced: ${enforcedNames.join(", ")} (others informational)`);
  }
  for (const w of verdict.warnings) {
    lines.push(`  WARNING: ${w}`);
  }
  lines.push("");
  lines.push(
    verdict.pass
      ? "  RESULT: PASS — no metric regressed beyond tolerance."
      : `  RESULT: FAIL — ${verdict.regressions.length} metric(s) regressed: ${verdict.regressions.map((r) => r.metric).join(", ")}.`,
  );
  return lines.join("\n");
}

function fmt(n: number): string {
  return (n * 100).toFixed(2).padStart(7) + "%";
}

function fmtSigned(n: number): string {
  const pct = (n * 100).toFixed(2);
  const signed = n >= 0 ? `+${pct}` : pct;
  return (signed + "%").padStart(9);
}
