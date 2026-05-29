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
  /** Deterministic checksum of the query set the baseline was measured on. */
  query_set_checksum: string;
  /** Number of queries evaluated. Informational; mismatch is surfaced as a warning. */
  query_count: number;
  /** The baseline aggregate scores the gate compares against. */
  overall: GatedScores;
}

/** The metric keys the gate enforces, in display order. */
export const GATED_METRICS: (keyof GatedScores)[] = [
  "recallAt1",
  "recallAt5",
  "recallAt10",
  "ndcgAt5",
  "mrr",
];

/** Default tolerance — absorbs FP noise only. See module doc. */
export const DEFAULT_GATE_TOLERANCE = 1e-6;

/** Per-metric comparison outcome. */
export interface MetricDelta {
  metric: keyof GatedScores;
  baseline: number;
  current: number;
  /** current - baseline. Negative means worse. */
  delta: number;
  /** True when delta < -tolerance. */
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
    lineage?: { corpus_sha256?: string; query_set_checksum?: string; query_count?: number };
  } = {},
): GateVerdict {
  const tolerance = options.tolerance ?? DEFAULT_GATE_TOLERANCE;
  const warnings: string[] = [];

  if (options.lineage) {
    const { corpus_sha256, query_set_checksum, query_count } = options.lineage;
    if (corpus_sha256 !== undefined && corpus_sha256 !== baseline.corpus_sha256) {
      warnings.push(
        `Corpus changed since baseline was blessed (baseline=${baseline.corpus_sha256.slice(0, 12)} current=${corpus_sha256.slice(0, 12)}). Re-bless with --update-baseline if intentional.`,
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
    return {
      metric,
      baseline: baselineVal,
      current: currentVal,
      delta,
      regressed: delta < -tolerance,
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
 * Format a verdict as a human-readable table for CI logs.
 */
export function formatVerdict(verdict: GateVerdict): string {
  const lines: string[] = [];
  lines.push("Retrieval CI gate — raw/lexical, deterministic");
  lines.push("");
  lines.push("  metric        baseline   current    delta      status");
  lines.push("  ------------  ---------  ---------  ---------  ------");
  for (const d of verdict.deltas) {
    const status = d.regressed ? "FAIL" : d.delta > verdict.tolerance ? "up" : "ok";
    lines.push(
      `  ${d.metric.padEnd(12)}  ${fmt(d.baseline)}  ${fmt(d.current)}  ${fmtSigned(d.delta)}  ${status}`,
    );
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
